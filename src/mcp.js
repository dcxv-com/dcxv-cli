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
// bin/dcxv.js uses — no command logic is duplicated, and no model-supplied argument
// ever reaches a handler as raw argv; each tool builds its own fixed-shape argv array
// from validated arguments and always appends --json, so the result is parsed JSON, not
// a screen-scrape of colored text.
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

// Runs one CLI command in-process and returns its parsed --json output (or throws the
// message dcxv would have printed to stderr on failure).
//
// ctx carries --url/--profile (if `dcxv mcp` was itself invoked with them) so every tool
// call resolves the SAME account/host the server started against - otherwise each of
// these recursive run() calls re-parses its own bare argv with no --url/--profile flag,
// silently falling back to the default profile/host regardless of what `dcxv mcp` was
// given. Bug caught live: `dcxv mcp --url <other-host>` still answered from the default
// profile's account.
async function runJson(ctx, argv) {
  const out = []
  const err = []
  const fullArgv = [...argv]
  if (ctx.url) fullArgv.push('--url', ctx.url)
  if (ctx.profile) fullArgv.push('--profile', ctx.profile)
  fullArgv.push('--json')
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
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
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
        id: { type: 'string', description: 'Product id, from list_orders' },
        action: { type: 'string', enum: ['ips', 'stats', 'snapshots', 'backups', 'iso', 'kubeconfig'] },
      },
      required: ['id'],
    },
    run: async (args, ctx) => textResult(await runJson(ctx, ['get', String(args.id), ...(args.action ? [args.action] : [])])),
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
        id: { type: 'string' },
        action: { type: 'string', enum: ['start', 'stop', 'shutdown', 'reset', 'restart', 'reboot', 'pass'] },
      },
      required: ['id', 'action'],
    },
    run: async (args, ctx) => textResult(await runJson(ctx, ['set', String(args.id), 'power', args.action])),
  },
  {
    name: 'rename_order',
    description: "Change a server's hostname label. Cosmetic only, does not charge the account.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, hostname: { type: 'string' } }, required: ['id', 'hostname'] },
    run: async (args, ctx) => textResult(await runJson(ctx, ['set', String(args.id), 'rename', args.hostname])),
  },
  {
    name: 'lock_order',
    description: 'Lock a server against changes (client-side lock, reversible with unlock_order).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async (args, ctx) => textResult(await runJson(ctx, ['set', String(args.id), 'lock'])),
  },
  {
    name: 'unlock_order',
    description: 'Reverse lock_order.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async (args, ctx) => textResult(await runJson(ctx, ['set', String(args.id), 'unlock'])),
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
        cluster: { type: 'string', description: 'Location id from list_clusters' },
        vcpu: { type: 'string' },
        ram: { type: 'string' },
        disk: { type: 'string' },
        ip: { type: 'string' },
        os: { type: 'string', description: 'OS name from list_os' },
        hostname: { type: 'string' },
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
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async (args, ctx) => textResult(await runJson(ctx, ['set', String(args.id), 'renew'])),
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
  // url/profile threaded through to every runJson() call below (see its own comment) -
  // without this, --url/--profile given to `dcxv mcp` only affected the token-presence
  // check here and silently reverted to the default profile/host for every tool call.
  const ctx = { deps, baseUrl, url: flags.url, profile: flags.profile }
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
      // inputSchema.required is otherwise descriptive-only - an agent that violates its own
      // tool's declared schema (e.g. calls get_product with no id) would previously reach
      // a real network request built from `undefined`, rather than failing fast locally.
      const args = params?.arguments || {}
      const missing = (tool.inputSchema.required || []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '')
      if (missing.length) {
        return write(jsonRpcResult(id, errorResult(`Missing required argument(s): ${missing.join(', ')}.`)))
      }
      try {
        return write(jsonRpcResult(id, await tool.run(params?.arguments || {}, ctx)))
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
