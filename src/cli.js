// DCXV CLI core. Dependency-injected and side-effect-free apart from the injected
// `stdout`/`stderr` sinks and the injected `config`/`makeClient`, so every command
// is unit-testable with a fake client and captured output.
import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { DcxvError } from './client.js'
import { VERSION } from './version.js'
import { tryOpenBrowser } from './browser.js'
import {
  color, money, ts, formatJson, formatTable, formatKeyVals, progressBar, parseProgress, endLine,
  parseStat, formatUptime, bytesHuman, sparkline, seriesStats,
} from './output.js'
import {
  Q_ACCOUNT, Q_ACCOUNT_FULL, Q_USER_DOWNLOAD, M_USER_MOD,
  Q_PRODUCTS, Q_PRODUCT_DETAIL, Q_PRODUCT_MON, Q_PRODUCT_GRAPH, Q_PRODUCT_OS, Q_CALC_PRICE_TABLE, M_PRODUCT_SET, CONTROLS,
  Q_TRANSACTIONS, Q_TRANSACTION, M_TRANS_INVOICE, M_USER_PAY, M_PRODUCT_ORDER, Q_CALC_PRICE, S_PRODUCT,
  M_PRODUCT_REM, Q_SNAP_LIST, M_SNAP_RESTORE, Q_BACKUP_LIST, M_BACKUP_RESTORE,
  Q_ISO_LIST, M_ISO_MOUNT, M_ISO_REM,
  Q_SUB_ACCOUNTS, M_SUB_ADD, M_SUB_LOGIN, M_SUB_EXIT,
  M_CLI_AUTH_START, S_CLI_AUTH,
} from './queries.js'

export const HELP = `dcxv — DCXV command-line client (v${VERSION})

Usage:
  dcxv login [<token>] [--profile p] [--url u] With no token: opens your browser to approve
                                                this device and saves the token automatically.
                                                With a token: saves it directly (create one at
                                                /my/api).
  dcxv config                                  Show active config (token masked)
  dcxv profile ls | use <name> | rm <name>     Manage named account profiles
  dcxv whoami                                  Show the authenticated account
  dcxv account                                 Show full profile (org/address/lang/currency/SSH key)
  dcxv account set <field> <value>             Update a profile field (fname/lname/org/city/addr/
                                                tel/sshkey/currency/lang/invoice-email/notify-bill;
                                                sshkey accepts @file)
  dcxv account export [outfile]                Download your account data (JSON)
  dcxv balance                                 Balance + accepted payment methods
  dcxv orders | products | ls | list           List servers/products
  dcxv os [filter...]                          List available OS images; every extra word
                                                narrows ("dcxv os windows 2022 en std")
  dcxv clusters [filter...]                    List available clusters/price tiers for --cluster
  dcxv order --cluster <name|id> --vcpu <n> --ram <n> --disk <n> --ip <n>
              [--os <name|id>] [--backup <0-7>] Order a cloud server; dry-run unless --yes
                                                (add --price to check price only; --watch
                                                to stream progress after --yes; --set
                                                k=v/--spec <json> for advanced fields)
  dcxv order --type k8s [--k8s K3S|K0S|K8S|RKE2] ... (cluster/vcpu/ram/disk/ip/--yes as above)
                                                Order a k8s cluster (type is still "cloud"
                                                under the hood; --k8s defaults to K3S;
                                                vcpu/ram/disk auto-bumped to the k8s minimum)
  dcxv get <id>                                Full details: specs, status, resource
                                                usage, IP/MAC/PTR table, access info
  dcxv get <id> ips                            IP / MAC / PTR table only
  dcxv get <id> stats                          Resource usage charts (CPU/RAM/Net/Disk)
  dcxv get <id> snapshots|backups|iso          List snapshots / backups / ISOs
  dcxv get <id> kubeconfig [outfile]           Download kubeconfig (k8s clusters)
  dcxv set <id> power <cmd>                    start|stop|shutdown|reset|pass
  dcxv set <id> renew                          Renew now (charges balance)
  dcxv set <id> autoprolong <on|off>           Toggle auto-renew
  dcxv set <id> lock | unlock                  Lock/unlock the server
  dcxv set <id> rename <hostname>              Rename the server
  dcxv set <id> notify-emails <emails>         Set expiration-notice e-mails
  dcxv set <id> password [<pass>]              Set a custom password (generates if omitted)
  dcxv set <id> mac <ip> <mac>                 Set MAC for an IP
  dcxv set <id> ptr <ip> <ptr>                 Set PTR (rDNS) for an IP
  dcxv set <id> snap-restore <name>            Restore snapshot            (--yes)
  dcxv set <id> snap-add [name]                Create a snapshot
  dcxv set <id> snap-rem <name>                Delete a snapshot           (--yes)
  dcxv set <id> backup-restore <bid>           Restore backup              (--yes)
  dcxv set <id> backup-add                     Create a backup now
  dcxv set <id> backup-rem <bid>               Delete a backup             (--yes)
  dcxv set <id> iso-mount <url> [file]         Attach an ISO
  dcxv set <id> iso-rm                         Remove attached ISO         (--yes)
  dcxv set <id> upgrade <item> <value>         Change a resource/add-on
  dcxv set <id> reinstall <os|id> [k8s]        Reinstall the OS       (--yes, --watch)
                                                (os name or id, see "dcxv os")
  dcxv rm <id>                                 Delete the product          (--yes)
  dcxv tx [<id>]                               Recent transactions, or detail for <id>
                                                (payment link/QR)   (alias: transactions,
                                                txns, history)
  dcxv tx <id> invoice [outfile]               Get the PDF invoice for a transaction
                                                (prints the URL; saves the PDF if outfile given)
  dcxv pay [<method> <amount>]                 Show methods, or create a payment
  dcxv sub [ls]                                List sub-accounts
  dcxv sub add <email> <fname>                 Create a sub-account
  dcxv sub login <id> | exit                   Switch into / out of a sub-account
  dcxv watch [<id>]                            Stream live deploy/task progress
  dcxv completion <bash|zsh|fish>              Print a shell completion script
  dcxv version                                 Print the CLI version

Global flags:
  --json         Machine-readable JSON output
  --profile <p>  Use a named profile (or DCXV_PROFILE)
  --url <u>      Override base URL (or DCXV_URL; default https://dcxv.com)
  --yes, -y      Confirm destructive/billing actions
  --watch        With --yes on order/reinstall: stream progress right after (like
                 running "dcxv watch <id>" immediately afterward)
  -h, --help     Show this help

Auth: DCXV_TOKEN env var, or "dcxv login <token>".`

// -------------------------------------------------------------- entrypoint

export async function run(argv, deps) {
  const io = { out: deps.stdout, err: deps.stderr }
  try {
    const code = await dispatch(argv, deps, io)
    return code ?? 0
  } catch (err) {
    io.err(color.red(err instanceof DcxvError ? err.message : (err.stack || String(err))))
    return 1
  }
}

function parse(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: 'boolean', default: false },
      url: { type: 'string' },
      profile: { type: 'string' },
      set: { type: 'string', multiple: true },
      spec: { type: 'string' },
      // Friendly flags for `dcxv order` (sugar over --set; see buildOrderInput).
      type: { type: 'string' },
      cluster: { type: 'string' },
      vcpu: { type: 'string' },
      ram: { type: 'string' },
      disk: { type: 'string' },
      ip: { type: 'string' },
      os: { type: 'string' },
      backup: { type: 'string' },
      hostname: { type: 'string' },
      k8s: { type: 'string' },
      price: { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      version: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
}

async function dispatch(argv, deps, io) {
  const { values: flags, positionals } = parse(argv)
  const { config, makeClient } = deps
  const cmd = positionals[0]

  if (flags.version || cmd === 'version') { io.out(VERSION); return 0 }
  if (!cmd || flags.help || cmd === 'help') { io.out(HELP); return 0 }

  // --- commands that need no authenticated client ---
  switch (cmd) {
    case 'login': {
      const argToken = positionals[1]
      if (argToken) {
        // Clear any active sub-account token so re-authenticating a profile can't
        // silently leave you inside a previously-entered sub-account.
        const path = config.saveConfig({ token: argToken, url: flags.url, subToken: null }, { profile: flags.profile })
        io.out(color.green(`Saved token to ${path}` + (flags.profile ? ` (profile ${flags.profile})` : '')))
        return 0
      }
      return handleLoginDevice(config, makeClient, flags, io)
    }
    case 'config': {
      const cfg = config.loadConfig({ profile: flags.profile })
      const masked = cfg.token ? cfg.token.slice(0, 4) + '…' + cfg.token.slice(-4) : '(none)'
      if (flags.json) { io.out(formatJson({ profile: cfg.profile, url: cfg.url, token: masked, source: cfg.source })); return 0 }
      io.out(`config file: ${config.configPath()}`)
      io.out(`profile:     ${cfg.profile}`)
      io.out(`url:         ${cfg.url}`)
      io.out(`token:       ${masked} (${cfg.source})`)
      return 0
    }
    case 'profile': return handleProfile(config, positionals, flags, io)
    case 'completion': {
      const script = completionScript(positionals[1])
      if (!script) throw new DcxvError('Usage: dcxv completion <bash|zsh|fish>')
      io.out(script)
      return 0
    }
  }

  const cfg = config.loadConfig({ profile: flags.profile })
  const client = makeClient({ url: flags.url ? flags.url.replace(/\/+$/, '') : cfg.url, token: cfg.token })

  switch (cmd) {
    case 'whoami': return handleWhoami(client, flags, io)
    case 'account': return handleAccount(client, positionals, flags, io)
    case 'balance': return handleBalance(client, flags, io)
    case 'orders':
    case 'products':
    case 'ls':
    case 'list': return handleProducts(client, flags, io)
    case 'order': return handleOrder(client, positionals, flags, io)
    case 'get': return handleGet(client, positionals, flags, io)
    case 'set': return handleSet(client, positionals, flags, io)
    case 'rm': return handleRm(client, positionals, flags, io)
    case 'os': return handleOS(client, positionals, flags, io)
    case 'clusters': return handleClusters(client, positionals, flags, io)
    case 'transactions':
    case 'txns':
    case 'history': return handleTransactions(client, flags, io)
    case 'tx': return positionals[1] ? handleTx(client, positionals, flags, io) : handleTransactions(client, flags, io)
    case 'pay': return handlePay(client, positionals, flags, io)
    case 'sub': return handleSub(client, config, positionals, flags, io)
    case 'watch': return handleWatch(client, positionals[1], flags.json, io)
    default:
      io.out(HELP)
      throw new DcxvError(`Unknown command "${cmd}".`)
  }
}

// -------------------------------------------------------------- helpers

async function getAccount(client) {
  const { userMy } = await client.request(Q_ACCOUNT)
  if (!userMy) throw new DcxvError('Not authenticated (userMy is null). Check your token.')
  return userMy
}

// `dcxv login` with no token: device-authorization flow. Requests a code, opens the
// browser to approve it, then waits for exactly one push event on the deviceCode-scoped
// SSE subscription (no polling — see client.js subscribePublic / api-my cliAuthSub).
async function handleLoginDevice(config, makeClient, flags, io) {
  const url = flags.url ? flags.url.replace(/\/+$/, '') : config.loadConfig({ profile: flags.profile }).url
  const client = makeClient({ url, token: '' })

  const { cliAuthStart: start } = await client.requestPublic(M_CLI_AUTH_START, { name: `CLI login (${hostname()})` })
  io.out(`First, visit: ${color.cyan(start.verifyUrl)}`)
  io.out(`Your code: ${color.bold(start.userCode)}`)
  tryOpenBrowser(start.verifyUrl)

  const result = await waitForApproval(client, start.deviceCode, start.expiresIn)
  // Clear any active sub-account token (see the token-login path above).
  const path = config.saveConfig({ token: result.token, url: flags.url, subToken: null }, { profile: flags.profile })
  io.out(color.green(`Logged in. Saved to ${path}` + (flags.profile ? ` (profile ${flags.profile})` : '')))
  return 0
}

function waitForApproval(client, deviceCode, expiresIn) {
  return new Promise((resolve, reject) => {
    let dispose
    const timer = setTimeout(() => {
      dispose?.()
      reject(new DcxvError('Login timed out — run "dcxv login" again'))
    }, Math.max(1, expiresIn || 600) * 1000)

    dispose = client.subscribePublic(S_CLI_AUTH, { deviceCode }, {
      onNext: (data) => {
        const ev = data.cliAuthSub
        if (ev?.status === 'approved' && ev.token) {
          clearTimeout(timer)
          dispose?.()
          resolve(ev)
        }
      },
      onError: (err) => {
        clearTimeout(timer)
        dispose?.()
        reject(err instanceof DcxvError ? err : new DcxvError(String(err)))
      },
    })
  })
}

// Coerce a --set string value: numbers -> Number, true/false -> boolean, else string.
export function coerce(v) {
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

function requireYes(flags, action) {
  if (!flags.yes) throw new DcxvError(`Refusing to ${action} without --yes.`)
}

// Throws a standard "Usage: ..." error when a required arg is missing/empty.
// `example`, when given, is appended as a second line showing real values.
function need(value, usage, example) {
  if (!value) throw new DcxvError(`Usage: ${usage}` + (example ? `\nExample: ${example}` : ''))
  return value
}

// Like need(), but only rejects `undefined` — lets an explicit '' through (e.g.
// clearing notify-emails, or a blank PTR value).
function needDefined(value, usage, example) {
  if (value === undefined) throw new DcxvError(`Usage: ${usage}` + (example ? `\nExample: ${example}` : ''))
  return value
}

// Fetch a list field and render it as a table (or --json). Used by every plain
// "fetch this array, print a table" read: orders, transactions, sub ls, and the
// per-product snapshots/backups/iso lists.
async function listCommand(client, query, key, variables, flags, io, columns) {
  const { [key]: rows } = await client.request(query, variables)
  if (flags.json) return void io.out(formatJson(rows))
  io.out(formatTable(rows || [], columns))
}

function statusOf(p) {
  if (p.blocked) return color.red('blocked')
  if (!p.active) return color.yellow('inactive')
  if (p.intest) return color.cyan('trial')
  return color.green('active')
}

function formatTransaction(t) {
  return color.bold(`Transaction ${t.id}`) + color.dim(`  ${ts(t.dt)}`) + '\n' + formatKeyVals([
    ['Reason', t.reason],
    ['Info', t.info],
    ['Amount', money(t.amount)],
    ['Total due', money(t.total)],
    ['Rate', t.rate],
    ['Invoice', t.invoice],
    ['Tx id', t.txid],
    ['Confirms', t.confirms],
    ['Pay link', t.url ? color.cyan(t.url) : null],
    ['QR', t.qr ? color.dim('(QR payload available; open the pay link)') : null],
  ])
}

// -------------------------------------------------------------- handlers

async function handleWhoami(client, flags, io) {
  const u = await getAccount(client)
  if (flags.json) return void io.out(formatJson(u))
  io.out(`${color.bold(`${u.fname || ''} ${u.lname || ''}`.trim() || '(no name)')}  <${u.email}>`)
  io.out(color.dim(`id ${u.id} · balance ${money(u.rest, u.sign)}`))
}

// Settable profile fields: friendly CLI name -> inpUserMod field (SDL/User.gql:52-73).
// currency/lang are enum-typed server-side (Currency/Language) — passed through verbatim,
// the backend validates. notify_bill is an Int. sshkey accepts an @file reference.
const ACCOUNT_FIELDS = {
  fname: 'fname', lname: 'lname', org: 'org', city: 'city', addr: 'addr',
  tel: 'tel', sshkey: 'sshkey', currency: 'curr', lang: 'lng',
  'invoice-email': 'mail_invoice', 'notify-bill': 'notify_bill',
}

async function handleAccount(client, positionals, flags, io) {
  const sub = (positionals[1] || 'show').toLowerCase()
  switch (sub) {
    case 'show': {
      const { userMy: u } = await client.request(Q_ACCOUNT_FULL)
      if (!u) throw new DcxvError('Not authenticated (userMy is null). Check your token.')
      if (flags.json) return void io.out(formatJson(u))
      io.out(color.bold(`${u.fname || ''} ${u.lname || ''}`.trim() || '(no name)') + `  <${u.email}>`)
      io.out(formatKeyVals([
        ['Account id', u.id],
        ['Organization', u.org],
        ['Address', u.addr],
        ['Phone', u.tel],
        ['Country id', u.id_country],
        ['Language', u.lng],
        ['Currency', u.curr],
        ['Balance', money(u.rest, u.sign)],
        ['Discount', u.discount > 0 ? `${u.discount}%` : null],
        ['Payment methods', (u.can_pay || []).join(', ') || null],
        ['E-mail aliases', (u.alias || []).join(', ') || null],
        ['Bill notifications', u.notify_bill != null ? String(u.notify_bill) : null],
        ['SSH key', u.sshkey ? u.sshkey.slice(0, 40) + (u.sshkey.length > 40 ? '…' : '') : '(none)'],
      ]))
      return
    }
    case 'export': {
      const { userDownload } = await client.request(Q_USER_DOWNLOAD)
      const text = typeof userDownload === 'string' ? userDownload : formatJson(userDownload)
      const outfile = positionals[2]
      if (outfile) { writeFileSync(outfile, text); io.out(color.green(`Account data written to ${outfile}`)); return }
      io.out(text)
      return
    }
    case 'set': {
      const field = need(positionals[2], 'dcxv account set <field> <value>', 'dcxv account set org "Acme Ltd"')
      const key = ACCOUNT_FIELDS[field.toLowerCase()]
      if (!key) throw new DcxvError(`Unknown field "${field}". Settable: ${Object.keys(ACCOUNT_FIELDS).join(', ')}.`)
      let value = needDefined(positionals[3], `dcxv account set ${field} <value>`, `dcxv account set org "Acme Ltd"`)
      // Long SSH public keys are awkward to paste — accept @path to read from a file.
      if (key === 'sshkey' && value.startsWith('@')) value = readFileSync(value.slice(1), 'utf8').trim()
      const inp = { [key]: key === 'notify_bill' ? Number(value) : value }
      const { userMod: r } = await client.request(M_USER_MOD, { inp })
      if (flags.json) return void io.out(formatJson(r))
      if (!r) throw new DcxvError(`Update failed: ${NULL_RESULT_HINT}`)
      if (r.err) throw new DcxvError(`Update failed: ${r.err}`)
      io.out(color.green(`Updated ${field}.`))
      return
    }
    default:
      throw new DcxvError(`Unknown account command "${sub}". Use: show, set, export.`)
  }
}

async function handleBalance(client, flags, io) {
  const u = await getAccount(client)
  if (flags.json) return void io.out(formatJson({ rest: u.rest, curr: u.curr, sign: u.sign, need_pay: u.need_pay, overdraft: u.overdraft, can_pay: u.can_pay }))
  io.out(`Balance: ${color.bold(money(u.rest, u.sign))}${u.curr ? color.dim(' ' + u.curr) : ''}`)
  io.out(formatKeyVals([
    ['Recommended top-up', u.need_pay > 0 ? money(u.need_pay, u.sign) : null],
    ['Overdraft', u.overdraft ? 'enabled' : null],
    ['Payment methods', (u.can_pay || []).join(', ') || null],
  ]))
}

function handleProducts(client, flags, io) {
  return listCommand(client, Q_PRODUCTS, 'productMy', undefined, flags, io, [
    { key: 'id', label: 'ID' },
    { key: 'hostname', label: 'HOSTNAME' },
    { key: 'ip', label: 'IP' },
    { key: 'type', label: 'TYPE' },
    { key: 'os', label: 'OS' },
    { key: 'cpu', label: 'CPU' },
    { key: 'ram', label: 'RAM' },
    { key: 'price', label: 'PRICE' },
    { key: 'status', label: 'STATUS', fmt: (_, p) => statusOf(p) },
  ])
}

// Shared worked example for ordering — see cli/README.md "Ordering" for the full
// walkthrough (dcxv os -> order --price -> order --yes -> watch).
const ORDER_EXAMPLE = 'dcxv order --cluster 16 --vcpu 4 --ram 8 --disk 80 --ip 1 --os "Ubuntu 24.04" --yes'

// `dcxv order [flags]` creates a new order; `dcxv order [flags] --price` checks the
// authoritative price only (no order created). Acting on an existing product lives
// under `dcxv get <id> ...` / `dcxv set <id> ...` / `dcxv rm <id>` instead —
// `dcxv order <id> ...` and the old `order new`/`order price` subcommands are gone.
async function handleOrder(client, positionals, flags, io) {
  const arg = positionals[1]
  if (arg) throw new DcxvError(`Unknown "dcxv order ${arg}". Ordering no longer takes a subcommand/id — use flags instead.\n` +
    `Example: ${ORDER_EXAMPLE}\n` +
    `(Did you mean "dcxv get ${arg} ..." or "dcxv set ${arg} ..."?)`)
  return handleOrderFlags(client, flags, io)
}

// Read-only: full detail, or a specific view (ips/stats/snapshots/backups/iso/kubeconfig).
async function handleGet(client, positionals, flags, io) {
  const id = positionals[1]
  if (!id) throw new DcxvError('Usage: dcxv get <id> [action]\nExample: dcxv get 123 ips')

  const action = positionals[2]
  const idNum = Number(id)

  if (!action) return handleOrderDetail(client, id, flags, io)

  switch (action.toLowerCase()) {
    case 'ips': return handleOrderIps(client, idNum, flags, io)
    case 'stats': return handleOrderStats(client, idNum, flags, io)
    case 'snapshots':
      return listCommand(client, Q_SNAP_LIST, 'productSnapList', { id: idNum }, flags, io, [
        { key: 'name', label: 'NAME' }, { key: 'date', label: 'DATE' }, { key: 'description', label: 'DESCRIPTION' },
      ])
    case 'backups':
      return listCommand(client, Q_BACKUP_LIST, 'productBackupList', { id: idNum }, flags, io, [
        // ProductBackup.date is epoch SECONDS and .size is raw bytes (Product.gql:247-251;
        // same rendering the web panel uses) — both were printed unformatted.
        { key: 'id', label: 'BID' },
        { key: 'date', label: 'DATE', fmt: (v) => ts(v) },
        { key: 'size', label: 'SIZE', fmt: (v) => bytesHuman(v) },
      ])
    case 'iso':
      return listCommand(client, Q_ISO_LIST, 'productCloudISOList', { id: idNum }, flags, io, [
        { key: 'id', label: 'ID' }, { key: 'filename', label: 'FILENAME' }, { key: 'size', label: 'SIZE' },
        { key: 'ready', label: 'READY', fmt: (v) => v ? 'yes' : 'no' },
      ])
    case 'kubeconfig': {
      const { productId } = await client.request(Q_PRODUCT_DETAIL, { id: idNum })
      if (!productId?.k8sKubeconfig) throw new DcxvError(`No kubeconfig available for ${id} (not a ready k8s cluster).`)
      const outfile = positionals[3]
      if (outfile) {
        writeFileSync(outfile, productId.k8sKubeconfig)
        io.out(color.green(`Kubeconfig written to ${outfile}`))
      } else {
        io.out(productId.k8sKubeconfig)
      }
      return
    }
    default:
      throw new DcxvError(`Unknown action "${action}". See "dcxv --help".`)
  }
}

// Mutations: power control + every productSet-driven change.
async function handleSet(client, positionals, flags, io) {
  const id = need(positionals[1], 'dcxv set <id> <action> [args]', 'dcxv set 123 power start')
  const action = need(positionals[2], 'dcxv set <id> <action> [args]', 'dcxv set 123 power start')
  const idNum = Number(id)
  const a = action.toLowerCase()

  if (SIMPLE_ACTIONS[a]) {
    const { fields, msg } = SIMPLE_ACTIONS[a]
    return productSetAction(client, idNum, fields, flags, io, msg(id))
  }

  switch (a) {
    case 'power': {
      const cmd = need(positionals[3], 'dcxv set <id> power <start|stop|shutdown|reset|pass>', 'dcxv set 123 power start')
      const key = cmd.toLowerCase()
      if (!CONTROLS[key]) throw new DcxvError(`Unknown power command "${cmd}". Use start|stop|shutdown|reset|restart|reboot|pass.`)
      const { productSet } = await client.request(M_PRODUCT_SET, { inp: { id: idNum, cmd: CONTROLS[key] } })
      return finishMutation(productSet, flags, io, `${CONTROLS[key]} sent to product ${id}${productSet?.ret ? ' (' + productSet.ret + ')' : ''}`)
    }
    case 'autoprolong': {
      const val = (positionals[3] || '').toLowerCase()
      if (val !== 'on' && val !== 'off') throw new DcxvError('Usage: dcxv set <id> autoprolong <on|off>\nExample: dcxv set 123 autoprolong on')
      return productSetAction(client, idNum, { autoprolong: val === 'on' }, flags, io, `Auto-prolong turned ${val} for ${id}`)
    }
    case 'rename': {
      const hostname = need(positionals[3], 'dcxv set <id> rename <hostname>', 'dcxv set 123 rename web1')
      return productSetAction(client, idNum, { hostname }, flags, io, `Renamed ${id} to "${hostname}"`)
    }
    case 'notify-emails': {
      const emails = needDefined(positionals[3], 'dcxv set <id> notify-emails <emails>', 'dcxv set 123 notify-emails you@example.com')
      return productSetAction(client, idNum, { notify_emails: emails }, flags, io, `Notify e-mails updated for ${id}`)
    }
    case 'password': {
      const pass = positionals[3] || genPassword()
      const { productSet } = await client.request(M_PRODUCT_SET, { inp: { id: idNum, cmd: 'PASS', pass } })
      if (flags.json) return void io.out(formatJson({ ...productSet, pass }))
      if (!productSet) throw new DcxvError(`Failed: ${NULL_RESULT_HINT}`)
      if (productSet.err) throw new DcxvError(`Failed: ${productSet.err}`)
      io.out(color.green(`Password set for ${id}`))
      io.out(formatKeyVals([['Password', pass]]))
      return
    }
    case 'mac': {
      const ip = need(positionals[3], 'dcxv set <id> mac <ip> <mac>', 'dcxv set 123 mac 1.2.3.4 AA:BB:CC:DD:EE:FF')
      const mac = need(positionals[4], 'dcxv set <id> mac <ip> <mac>', 'dcxv set 123 mac 1.2.3.4 AA:BB:CC:DD:EE:FF')
      return productSetAction(client, idNum, { ip, mac }, flags, io, `MAC updated for ${ip} on ${id}`)
    }
    case 'ptr': {
      const ip = need(positionals[3], 'dcxv set <id> ptr <ip> <ptr>', 'dcxv set 123 ptr 1.2.3.4 host.example.com')
      const ptr = needDefined(positionals[4], 'dcxv set <id> ptr <ip> <ptr>', 'dcxv set 123 ptr 1.2.3.4 host.example.com')
      return productSetAction(client, idNum, { ip, ptr }, flags, io, `PTR updated for ${ip} on ${id}`)
    }
    case 'snap-restore': {
      const name = need(positionals[3], 'dcxv set <id> snap-restore <name>', 'dcxv set 123 snap-restore before-upgrade --yes')
      requireYes(flags, `restore snapshot "${name}"`)
      const { productSnapRestore: r } = await client.request(M_SNAP_RESTORE, { id: idNum, name })
      return finishMutation(r, flags, io, `Snapshot "${name}" restore started on ${id}`)
    }
    case 'snap-add': return upgradeCall(client, idNum, 'snap-add', positionals[3] || '', flags, io, `Snapshot add requested on ${id}`)
    case 'snap-rem': {
      const name = need(positionals[3], 'dcxv set <id> snap-rem <name>', 'dcxv set 123 snap-rem before-upgrade --yes')
      requireYes(flags, `remove snapshot "${name}"`)
      return upgradeCall(client, idNum, 'snap-rem', name, flags, io, `Snapshot "${name}" removed on ${id}`)
    }
    case 'backup-restore': {
      const bid = need(positionals[3], 'dcxv set <id> backup-restore <bid>', 'dcxv set 123 backup-restore 45 --yes')
      requireYes(flags, `restore backup ${bid}`)
      const { productBackupRestore: r } = await client.request(M_BACKUP_RESTORE, { id: idNum, bid: Number(bid) })
      return finishMutation(r, flags, io, `Backup ${bid} restore started on ${id}`)
    }
    case 'backup-add': return upgradeCall(client, idNum, 'backup-add', '', flags, io, `Backup add requested on ${id}`)
    case 'backup-rem': {
      const bid = need(positionals[3], 'dcxv set <id> backup-rem <bid>', 'dcxv set 123 backup-rem 45 --yes')
      requireYes(flags, `remove backup ${bid}`)
      return upgradeCall(client, idNum, 'backup-rem', `${bid}`, flags, io, `Backup ${bid} removed on ${id}`)
    }
    case 'iso-mount': {
      const url = need(positionals[3], 'dcxv set <id> iso-mount <url> [filename]', 'dcxv set 123 iso-mount https://example.com/ubuntu.iso')
      const { productCloudISO: r } = await client.request(M_ISO_MOUNT, { id: idNum, url, filename: positionals[4] || null })
      return finishMutation(r, flags, io, `ISO ${r?.filename || url} attached to ${id}`, 'ISO mount failed')
    }
    case 'iso-rm': {
      requireYes(flags, `remove the ISO on ${id}`)
      const { productCloudISORem: r } = await client.request(M_ISO_REM, { id: idNum })
      return finishMutation(r, flags, io, `ISO removed from ${id}`, 'ISO remove failed')
    }
    case 'upgrade': {
      const item = need(positionals[3], 'dcxv set <id> upgrade <item> <value>', 'dcxv set 123 upgrade ram 16')
      const value = needDefined(positionals[4], 'dcxv set <id> upgrade <item> <value>', 'dcxv set 123 upgrade ram 16')
      return upgradeCall(client, idNum, item, `${value}`, flags, io, `Upgrade ${item}=${value} applied to ${id}`)
    }
    case 'reinstall': {
      const osArg = need(positionals[3], 'dcxv set <id> reinstall <os|id> [k8s]', 'dcxv set 123 reinstall "Ubuntu 24.04" --yes   # or an id from "dcxv os"')
      requireYes(flags, `reinstall product ${id} (this wipes the server)`)
      // Accept an OS name as well as an id, exactly like `order --os` — the same
      // catalog lookup (resolveOS). A bare Number() here turned "Ubuntu 24.04" into
      // NaN, which JSON.stringify sends as `oid: null`; the backend then threw
      // invalid_os and (production masks resolver errors as null) the CLI reported
      // "Reinstall started" for a reinstall that never ran, so --watch hung forever.
      const os = await resolveOS(client, String(osArg))
      // Reinstalling wipes the server, so name the image we resolved BEFORE firing when the
      // argument wasn't the exact name/id — the success line comes too late to reconsider.
      if (!flags.json && String(osArg).toLowerCase() !== String(os.name).toLowerCase() && String(osArg) !== String(os.id)) {
        io.err(color.dim(`Matched OS "${os.name}" (id ${os.id}).`))
      }
      const { productSet: r } = await client.request(M_PRODUCT_SET,
        { inp: { id: idNum, cmd: 'REINSTALL', oid: os.id, k8s: positionals[4] || 'NONE' } })
      finishMutation(r, flags, io,
        `Reinstall of ${os.name} started on ${id}` + (flags.watch ? '' : ` (watch progress with "dcxv watch ${id}")`),
        'Reinstall failed')
      // Only cloud products implement REINSTALL server-side (it answers ret:'OK'); for other
      // product types the backend matches no command, changes nothing and reports nothing —
      // so say that instead of leaving a watcher waiting on progress that will never come.
      if (!flags.json && !r.ret) io.err(color.yellow(
        `Warning: the server did not acknowledge the reinstall — it may not be supported for this product type. Check "dcxv get ${id}".`))
      if (flags.watch && !flags.json) return handleWatch(client, idNum, false, io)
      return
    }
    default:
      throw new DcxvError(`Unknown action "${action}". See "dcxv --help".`)
  }
}

async function handleRm(client, positionals, flags, io) {
  const id = need(positionals[1], 'dcxv rm <id>', 'dcxv rm 123 --yes')
  const idNum = Number(id)
  requireYes(flags, `delete product ${id}`)
  const data = await client.request(M_PRODUCT_REM, { id: idNum })
  if (flags.json) io.out(formatJson(data))
  // productRem returns Boolean: `false` when the backend refuses (product suspended for a
  // reason other than unpaid/end-of-period, SDL/Product.js), and `null` when the resolver
  // threw — not yours, or not authenticated. Only `true` means it was actually deleted.
  if (data.productRem === false) {
    throw new DcxvError(`Product ${id} was NOT deleted — the service is suspended and cannot be removed while locked. Contact support.`)
  }
  if (!data.productRem) throw new DcxvError(`Product ${id} was NOT deleted: ${NULL_RESULT_HINT}`)
  if (flags.json) return
  return void io.out(color.green(`Product ${id} deleted`))
}

// Catalog names are long and multi-part ("Windows Server 2022 EN (Standard)"), so a filter
// is treated as a set of tokens that must ALL match — every extra word narrows the result.
// Tokens come from separate argv words and from spaces inside one quoted argument alike,
// so `dcxv os Windows 2022 EN` and `--os "Windows 2022 EN"` behave identically.
const tokenize = (args) => args
  .flatMap(a => String(a).split(/\s+/))
  .filter(Boolean)
  .map(t => t.toLowerCase())

// Name split into comparable words: "Windows Server 2022 EN (Standard)" -> windows, server,
// 2022, en, standard. Dots stay inside a word so "24.04" survives as one.
const wordsOf = (s) => String(s).toLowerCase()
  .split(/[^a-z0-9.]+/)
  .map(w => w.replace(/^\.+|\.+$/g, ''))
  .filter(Boolean)

// Leftmost-greedy subsequence test — leftmost is optimal, so a failure here is conclusive.
const isSubsequence = (needle, hay) => {
  let i = 0
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true
  return false
}

// An abbreviation keeps a word's first letter and drops letters from the inside, so it is a
// FIRST-LETTER-ANCHORED subsequence of one word: "std" -> "standard", "dc" -> "datacenter".
// Anything with a digit is excluded — version numbers must match literally, or "2022" would
// happily "abbreviate" 2012r2 (2,0,2,2 all appear in order).
const isAbbrevOf = (token, word) =>
  !/\d/.test(token) && word.startsWith(token[0]) && isSubsequence(token, word)

// Three tiers, each tried only when the previous one found nothing:
//   1. every token IS a word of the name — the precise case. Whole-word matching matters:
//      a plain substring would let "en" match "Datac-en-ter" and drag in the RU images.
//   2. every token is a substring of the name — partial words ("ubunt", "portug", "24.04").
//   3. every token abbreviates a word (digits still matched literally) — so "windows 2022 en
//      std" lands on exactly "Windows Server 2022 EN (Standard)".
// Only tier 3 is reported as `fuzzy`, so callers can say they fell back instead of guessing.
function filterByTokens(list, tokens) {
  if (!tokens.length) return { items: list, fuzzy: false }
  const tiers = [
    o => tokens.every(t => wordsOf(o.name).includes(t)),
    o => tokens.every(t => String(o.name).toLowerCase().includes(t)),
    o => tokens.every(t => /\d/.test(t)
      ? String(o.name).toLowerCase().includes(t)
      : wordsOf(o.name).some(w => isAbbrevOf(t, w))),
  ]
  for (const [i, match] of tiers.entries()) {
    const items = list.filter(match)
    if (items.length) return { items, fuzzy: i === tiers.length - 1 }
  }
  return { items: [], fuzzy: false }
}

async function handleOS(client, positionals, flags, io) {
  const { productOS } = await client.request(Q_PRODUCT_OS)
  const available = (productOS || []).filter(o => !/EOL/i.test(o.name))
  const { items, fuzzy } = filterByTokens(available, tokenize(positionals.slice(1)))
  if (flags.json) return void io.out(formatJson(items))
  if (fuzzy && items.length) io.err(color.dim('No exact match — showing closest names.'))
  io.out(formatTable(items, [{ key: 'id', label: 'ID' }, { key: 'name', label: 'NAME' }]))
}

// Cloud cluster/price-tier catalog for `--cluster`/`dcxv clusters`. `calcPrice` returns a
// JSON.stringify()d string (see Q_CALC_PRICE_TABLE), and only `sell: 1` rows are actually
// orderable (unsellable tiers rejected server-side as unknown_vid) — same filter/shape the
// web calculator's cluster dropdown uses (Calculators.svelte: {value: vid, label: cpu}).
async function fetchClusters(client) {
  const { calcPrice: raw } = await client.request(Q_CALC_PRICE_TABLE)
  const table = typeof raw === 'string' ? JSON.parse(raw) : (raw || [])
  return table.filter(i => i.type === 'cloud' && i.sell).map(i => ({ id: i.vid, name: i.cpu }))
}

async function handleClusters(client, positionals, flags, io) {
  const clusters = await fetchClusters(client)
  const { items, fuzzy } = filterByTokens(clusters, tokenize(positionals.slice(1)))
  if (flags.json) return void io.out(formatJson(items))
  if (fuzzy && items.length) io.err(color.dim('No exact match — showing closest names.'))
  io.out(formatTable(items, [{ key: 'id', label: 'ID' }, { key: 'name', label: 'NAME' }]))
}

// A `null` mutation payload always means the action did NOT happen: api-my masks
// resolver exceptions in production by returning null for the whole field (its
// wrapResolvers helper), getUID denials surface the same way, and productSet also
// returns null outright for a locked product. Reporting success on null is what made
// a failed reinstall print "Reinstall started" and then hang under --watch.
const NULL_RESULT_HINT = 'server returned no result — the request was rejected (invalid argument, product locked, or not permitted)'

function finishMutation(r, flags, io, okMsg, errPrefix = 'Failed') {
  if (flags.json) io.out(formatJson(r))
  if (!r) throw new DcxvError(`${errPrefix}: ${NULL_RESULT_HINT}`)
  if (r.err) throw new DcxvError(`${errPrefix}: ${r.err}`)
  if (flags.json) return
  io.out(color.green(okMsg))
}

// The productSet(inp:{id,...fields}) + finishMutation two-liner, shared by every
// power/lock/rename/upgrade/etc. action that just patches fields on the product.
async function productSetAction(client, idNum, fields, flags, io, okMsg) {
  const { productSet } = await client.request(M_PRODUCT_SET, { inp: { id: idNum, ...fields } })
  return finishMutation(productSet, flags, io, okMsg)
}

const upgradeCall = (client, idNum, item, value, flags, io, okMsg) =>
  productSetAction(client, idNum, { upgrade: [item, value] }, flags, io, okMsg)

// Simple no-extra-argument productSet toggles. Power verbs (start/stop/.../pass)
// stay in CONTROLS below since their message includes the backend's `ret` value.
const SIMPLE_ACTIONS = {
  renew: { fields: { renew: true }, msg: (id) => `Renewal requested for ${id}` },
  lock: { fields: { blocked: true }, msg: (id) => `Product ${id} locked` },
  unlock: { fields: { blocked: false }, msg: (id) => `Product ${id} unlocked` },
}

// Same charset/length as the web app's genPassword (Calculators.svelte-adjacent
// order page), reimplemented with node:crypto instead of Web Crypto for Node 18 support.
function genPassword(len = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_'
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length]
  return out
}

// Fetch full static detail (productId) + live status/progress (productMon) and
// merge, matching the web page's control-panel behavior (productMon overlays productId).
async function fetchProductDetail(client, idNum) {
  const [{ productId: detail }, { productMon: mon }] = await Promise.all([
    client.request(Q_PRODUCT_DETAIL, { id: idNum }),
    client.request(Q_PRODUCT_MON, { id: idNum }),
  ])
  if (!detail) return null
  return { ...detail, ...(mon || {}) }
}

// A product's IP/MAC/PTR table — shared by the "Network" section in the full
// detail view and the standalone `order <id> ips` command.
function ipRows(p) {
  return p.ips?.length ? p.ips : (p.ip ? [{ ip: p.ip, mac: p.mac, ptr: '' }] : [])
}
const IP_COLUMNS = (p) => [
  { key: 'ip', label: 'IP' }, { key: 'mac', label: 'MAC', fmt: (v) => v || p.mac || '-' }, { key: 'ptr', label: 'PTR' },
]

function accessLines(p) {
  if (p.type === 'vpn') return [['VPN Server (PPTP)', 'vpn.dcxv.com'], ['Login', p.login || '-'], ['Password', p.pass || '-']]
  if (p.type === 'storage') {
    return [
      ['Login', p.login || '-'], ['Password', p.pass || '-'],
      ['NextCloud', 'https://storage.dcxv.com'],
      ['WebDAV', `https://s${p.id}.storage.dcxv.com/webdav`],
      ['Web Client', 'https://web.storage.dcxv.com/ui/web/client/login'],
      ['FTP', `ftp://s${p.id}@storage.dcxv.com`],
      ['FTPs', `ftps://s${p.id}@storage.dcxv.com`],
      ['sFTP', `sftp://s${p.id}@storage.dcxv.com`],
      ['Rsync over SSH', `rsync -a ./ s${p.id}@storage.dcxv.com:/`],
      ['Windows Share (SMB/CIFS)', '\\\\storage.dcxv.com\\disk'],
    ]
  }
  return [['IP', p.ip || '-'], ['Login', p.login || '-'], ['Password', p.pass || '-']]
}

function connectionLine(p) {
  if (!p.ip || !p.login) return null
  if (/windows/i.test(p.os || '')) return ['RDP', `xfreerdp /v:${p.ip} /u:${p.login}`]
  return ['SSH', `ssh ${p.login}@${p.ip}`]
}

// An order response arrives before provisioning finishes. Once --watch sees
// completion, re-read the product to obtain the final connection-ready fields.
async function showOrderAccessInfo(client, id, io) {
  try {
    const p = await fetchProductDetail(client, Number(id))
    if (!p) return io.err(color.yellow(`Deployment completed, but product ${id} could not be reloaded for access details.`))
    const lines = accessLines(p)
    const command = connectionLine(p)
    if (command) lines.push(command)
    io.out('')
    io.out(color.bold('Access'))
    io.out(formatKeyVals(lines))
  } catch (e) {
    io.err(color.yellow(`Deployment completed, but access details could not be loaded: ${e.message || e}`))
  }
}

async function handleOrderDetail(client, id, flags, io) {
  const p = await fetchProductDetail(client, Number(id))
  if (!p) throw new DcxvError(`Product ${id} not found in your account.`)
  if (flags.json) return void io.out(formatJson(p))

  const isK8s = p.k8s && p.k8s !== 'NONE'
  const stat = parseStat(p.stat)

  io.out(color.bold(`Product ${p.id} — ${p.hostname || p.name || '(no hostname)'}`) + '  ' + statusOf(p))
  io.out(color.dim(`Type: ${isK8s ? 'k8s' : (p.type || '-').toUpperCase()}`))

  if (p.blocked && p.blocked_reason && p.blocked_reason !== 'client_lock') {
    io.out(color.red(`Service suspended: ${p.blocked_reason}`))
  }
  if (p.notice_to_client) io.out(color.yellow(p.notice_to_client))
  if (isK8s && p.k8sStatus) {
    const k8sMsg = { INSTALLING: `Kubernetes (${p.k8s}) is installing on first boot`, READY: `Kubernetes (${p.k8s}) is ready`, FAILED: `Kubernetes (${p.k8s}) install failed — try reinstall` }[p.k8sStatus]
    if (k8sMsg) io.out(color.cyan(k8sMsg))
  }

  // Live status line
  if (stat.status) {
    const label = stat.status === 'UP' ? color.green(stat.status) : color.red(stat.status)
    io.out(`Status: ${label}${stat.uptime > 0 ? color.dim(`  (up ${formatUptime(stat.uptime)})`) : ''}`)
  } else if (p.id && p.next_pay && p.next_pay - Date.now() / 1000 < 0) {
    io.out(color.yellow('Status: awaiting payment'))
  } else if (p.created && !p.installed) {
    io.out(color.cyan('Status: deploying'))
  }

  const prog = parseProgress(p.progress)
  if (p.progress) io.out(`Progress: ${prog.pct}%${prog.stage ? ' ' + prog.stage : ''}`)

  io.out('')
  io.out(color.bold('Specs'))
  io.out(formatKeyVals([
    ['OS', p.os],
    ['CPU', p.cpu ? `${p.cpu}${p.cores ? ` (${p.cores} ${p.type === 'cloud' ? 'cores' : 'qty'})` : ''}` : null],
    ['RAM', p.ram],
    ['Disk', [p.hdd, p.hdd2, p.hdd3, p.hdd4].filter(Boolean).join(' + ')],
    ['Bandwidth', p.type !== 'storage' ? (p.bw || 'Unlimited Shared') : null],
    ['IP count', p.ipcnt],
    ['Backups', p.backup != null ? `${p.backup} (${p.backup === 7 ? 'daily' : 'weekly'})` : null],
    ['Snapshots', p.snaps],
    ['Storage usage', p.meta?.used ? `${Math.round(p.meta.used / 10.24) / 100} GB` : null],
    ['Admin hours', p.admin_packet > 0 ? `${(+p.admin_used || 0).toFixed(2)} of ${(+p.admin_packet).toFixed(2)}` : null],
  ]))

  io.out('')
  io.out(color.bold('Billing'))
  io.out(formatKeyVals([
    ['Price', money(p.price)],
    ['Discount', p.discount > 0 ? `${p.discount}%` : null],
    ['Next payment', ts(p.next_pay)],
    ['Auto-prolong', p.autoprolong ? 'on' : 'off'],
    ['Min months', p.min_months],
  ]))

  if (stat.status || stat.mem || stat.disk || stat.net) {
    io.out('')
    io.out(color.bold('Resources (live)'))
    io.out(formatKeyVals([
      ['CPU', typeof stat.cpu === 'number' ? `${stat.cpu.toFixed(1)}%` : null],
      ['Memory', stat.mem ? `${bytesHuman(stat.mem[0])} / ${bytesHuman(stat.mem[1])}` : null],
      ['Disk', stat.disk ? `${bytesHuman(stat.disk[0])} / ${bytesHuman(stat.disk[1])}` : null],
      ['Network', stat.net ? `in ${bytesHuman(stat.net[0])} / out ${bytesHuman(stat.net[1])}` : null],
    ]))
  }

  if (p.ips?.length || p.ip) {
    io.out('')
    io.out(color.bold('Network'))
    io.out(formatTable(ipRows(p), IP_COLUMNS(p)))
  }

  if (p.installed && (!p.blocked || p.blocked_reason === 'client_lock')) {
    io.out('')
    io.out(color.bold('Access'))
    // Include the ready-to-paste ssh/xfreerdp line, same as the post-deploy Access block
    // in showOrderAccessInfo — `dcxv get` is where you look this up after the deploy.
    const connect = connectionLine(p)
    io.out(formatKeyVals(connect ? [...accessLines(p), connect] : accessLines(p)))
    if (p.ipmi) {
      io.out('')
      io.out(color.bold('IPMI over VPN'))
      io.out(formatKeyVals([
        ['VPN Server (PPTP)', p.ipmi[0]], ['VPN Login', p.ipmi[1]], ['VPN Password', p.ipmi[2]],
        ['IPMI Web', p.ipmi[3] ? `http://${p.ipmi[3]}` : null], ['IPMI Login', p.ipmi[4]], ['IPMI Password', p.ipmi[5]],
      ]))
    }
    if (isK8s && p.k8sStatus === 'READY' && p.k8sKubeconfig) {
      io.out(color.dim(`Kubeconfig ready — download with: dcxv get ${p.id} kubeconfig`))
    }
  }

  if (p.client_notes) { io.out(''); io.out(color.bold('Notes')); io.out(`  ${p.client_notes}`) }
}

async function handleOrderIps(client, idNum, flags, io) {
  const { productId: p } = await client.request(Q_PRODUCT_DETAIL, { id: idNum })
  if (!p) throw new DcxvError(`Product ${idNum} not found in your account.`)
  const rows = ipRows(p)
  if (flags.json) return void io.out(formatJson(rows))
  io.out(formatTable(rows, IP_COLUMNS(p)))
}

async function handleOrderStats(client, idNum, flags, io) {
  const { productGraph } = await client.request(Q_PRODUCT_GRAPH, { id: idNum })
  let samples = []
  if (productGraph) {
    try { samples = JSON.parse(productGraph) } catch { samples = [] }
  }
  if (flags.json) return void io.out(formatJson(samples))
  if (!samples.length) { io.out(color.dim('(no resource usage history yet)')); return }

  const metrics = [
    ['CPU %', samples.map(s => s.cpu)],
    ['Memory', samples.map(s => s.mem)],
    ['Net in', samples.map(s => s.netin)],
    ['Net out', samples.map(s => s.netout)],
    ['Disk read', samples.map(s => s.diskread)],
    ['Disk write', samples.map(s => s.diskwrite)],
    ['Storage', samples.map(s => s.used)],
  ]
  let printed = false
  for (const [label, series] of metrics) {
    const stats = seriesStats(series)
    if (!stats) continue
    printed = true
    io.out(`${label.padEnd(11)} ${sparkline(series)}  ${color.dim(`min ${stats.min} · avg ${stats.avg} · max ${stats.max} · last ${stats.last}`)}`)
  }
  // The backend can return history rows before any metric has real data (values
  // serialize as the string "NaN" rather than null/omitted) — don't print a blank screen.
  if (!printed) io.out(color.dim(`(${samples.length} history point(s), but no numeric data yet)`))
}

// Build an inpProdOrder-shaped object from --spec (JSON or @file) merged with
// repeatable --set key=value overrides, then friendly per-field flags on top
// (friendly flags win on conflict). --cluster/--os/default Ubuntu are resolved separately
// (async) by the caller since they need a catalog lookup.
const FRIENDLY_ORDER_FLAGS = { vcpu: 'cores', ram: 'ram', disk: 'hdd', ip: 'ip', backup: 'backup' }
// inpProdOrder has ram/hdd typed as String (not Int) despite being numeric quantities —
// confirmed against SDL/Product.gql. cores/ip/backup/vid are real Ints. Sending a Number
// for ram/hdd trips a GraphQL "String cannot represent a non string value" error.
const STRING_ORDER_FIELDS = new Set(['ram', 'hdd'])

// Kubernetes is not a real product `type` — the web calculator always submits
// `type: 'cloud'` plus a `k8s` distro preset (dcxv-www Calculators.svelte:896,956-957);
// the backend pins the OS and enforces these same minimums server-side
// (api-my lib/priceVerify.js K8S_MIN_CORES/RAM/SSD, K8S_FEE — added to price automatically,
// same as any other cloud order's auto-fetched price).
const K8S_TYPES = ['NONE', 'K3S', 'K0S', 'K8S', 'RKE2']
const K8S_MIN = { cores: 4, ram: 8, hdd: 60 }

function buildOrderInput(flags, io) {
  let inp = {}
  if (flags.spec) {
    const raw = flags.spec.startsWith('@') ? readFileSync(flags.spec.slice(1), 'utf8') : flags.spec
    try { inp = JSON.parse(raw) } catch (e) { throw new DcxvError('--spec is not valid JSON: ' + e.message) }
  }
  for (const kv of [].concat(flags.set || [])) {
    const eq = kv.indexOf('=')
    if (eq < 0) throw new DcxvError(`--set expects key=value, got "${kv}"`)
    inp[kv.slice(0, eq)] = coerce(kv.slice(eq + 1))
  }

  let usedFriendly = flags.cluster !== undefined
  for (const [flag, field] of Object.entries(FRIENDLY_ORDER_FLAGS)) {
    if (flags[flag] !== undefined) {
      inp[field] = STRING_ORDER_FIELDS.has(field) ? String(flags[flag]) : coerce(flags[flag])
      usedFriendly = true
    }
  }
  if (flags.type !== undefined) inp.type = flags.type
  if (flags.hostname !== undefined) inp.hostname = flags.hostname

  // --type k8s (or bare --k8s <preset>) -> type: cloud, k8s: <preset>. Defaults to K3S
  // (a non-NONE preset) since asking for k8s implies actually installing it.
  const wantsK8s = (flags.type && flags.type.toLowerCase() === 'k8s') || flags.k8s !== undefined
  if (wantsK8s) {
    const preset = (flags.k8s || 'K3S').toUpperCase()
    if (!K8S_TYPES.includes(preset)) throw new DcxvError(`Unknown --k8s preset "${flags.k8s}". Use one of: K3S, K0S, K8S, RKE2.`)
    inp.type = 'cloud'
    inp.k8s = preset
    usedFriendly = true
    for (const [field, min] of Object.entries(K8S_MIN)) {
      if (inp[field] !== undefined && Number(inp[field]) < min) {
        io.err(color.dim(`Note: bumped --${field === 'hdd' ? 'disk' : field === 'cores' ? 'vcpu' : field} from ${inp[field]} to the k8s minimum (${min}).`))
        inp[field] = STRING_ORDER_FIELDS.has(field) ? String(min) : min
      }
    }
  }

  // Friendly flags describe a cloud order — default type/backup so the common case
  // ("dcxv order --cluster 16 --vcpu 4 --ram 8 --disk 80 --ip 1 --os ...") needs
  // nothing else. --set type=... always wins if given explicitly.
  if (usedFriendly) {
    if (!inp.type) inp.type = 'cloud'
    if (inp.type === 'cloud' && inp.backup === undefined) inp.backup = 0
    // Every cloud/k8s tier's ip range has a min of 1 (lib/calcPrice.js) — an omitted
    // --ip fails server-side validation as out_of_range:ip instead of just defaulting.
    if (inp.type === 'cloud' && inp.ip === undefined) inp.ip = 1
  }

  return inp
}

// Shared id/name resolver for --os, --cluster and `set <id> reinstall`. A purely-numeric
// `arg` is an id; otherwise an exact (case-insensitive) full-name match wins, then the same
// all-tokens-must-match rule the `dcxv os`/`dcxv clusters` filters use — so extra words
// narrow instead of breaking ("Windows 2022 EN Std" -> "Windows Server 2022 EN (Standard)",
// where a single-substring match found nothing at all). Ambiguity is still an error, never
// a guess. Returns the entry with `fuzzy` set when only the subsequence tier matched.
function resolveByNameOrId(list, arg, { singular, plural, hint }) {
  if (/^\d+$/.test(arg)) {
    const match = list.find(o => String(o.id) === arg)
    if (!match) throw new DcxvError(`Unknown ${singular} id "${arg}". Run "${hint}" to list valid ids.`)
    return match
  }
  const exact = list.filter(o => o.name.toLowerCase() === arg.toLowerCase())
  if (exact.length === 1) return exact[0]
  const { items, fuzzy } = filterByTokens(list, tokenize([arg]))
  if (items.length === 0) throw new DcxvError(`No ${singular} matches "${arg}". Run "${hint}" to see available names.`)
  if (items.length > 1) throw new DcxvError(`"${arg}" matches multiple ${plural} (${items.map(o => o.name).join(', ')}). Add another word to narrow it, use the full name, or use an id (see "${hint} ${arg}").`)
  return { ...items[0], fuzzy }
}

// Resolve --os <name-or-id> against the real productOS catalog (same EOL-filtered
// list `dcxv os` shows).
async function resolveOS(client, osArg) {
  const { productOS } = await client.request(Q_PRODUCT_OS)
  const list = (productOS || []).filter(o => !/EOL/i.test(o.name))
  return resolveByNameOrId(list, osArg, { singular: 'OS', plural: 'OSes', hint: 'dcxv os' })
}

// Choose from the live catalog instead of baking a template ID into the CLI.  This
// makes a plain cloud order follow the newest supported Ubuntu release as images
// are added, while an explicit --os (or --spec/--set os/oid) remains authoritative.
async function resolveLatestUbuntu(client) {
  const { productOS } = await client.request(Q_PRODUCT_OS)
  const candidates = (productOS || [])
    .filter(o => !/EOL/i.test(o.name))
    .map(o => {
      const m = String(o.name).match(/^ubuntu\s+(\d+)(?:\.(\d+))?/i)
      return m ? { ...o, major: Number(m[1]), minor: Number(m[2] || 0) } : null
    })
    .filter(Boolean)
    .sort((a, b) => b.major - a.major || b.minor - a.minor)
  if (!candidates.length) throw new DcxvError('No supported Ubuntu OS is available. Choose one explicitly with --os (see "dcxv os").')
  return candidates[0]
}

// Resolve --cluster <name-or-id> against the real calcPrice cloud-cluster catalog
// (same list `dcxv clusters` shows).
async function resolveCluster(client, arg) {
  const list = await fetchClusters(client)
  return resolveByNameOrId(list, arg, { singular: 'cluster', plural: 'clusters', hint: 'dcxv clusters' })
}

async function handleOrderFlags(client, flags, io) {
  const inp = buildOrderInput(flags, io)

  if (flags.cluster !== undefined) {
    inp.vid = (await resolveCluster(client, String(flags.cluster))).id
  }
  if (flags.os !== undefined) {
    const match = await resolveOS(client, String(flags.os))
    inp.os = match.name
    inp.oid = match.id
  } else if (inp.type === 'cloud' && inp.os == null && inp.oid == null && (!inp.k8s || inp.k8s === 'NONE')) {
    const match = await resolveLatestUbuntu(client)
    inp.os = match.name
    inp.oid = match.id
    io.err(color.dim(`No --os specified; using latest Ubuntu image: ${match.name} (${match.id}).`))
  }

  if (!Object.keys(inp).length) throw new DcxvError('Nothing specified. Provide friendly flags ' +
    '(--cluster/--vcpu/--ram/--disk/--ip/--os/--backup/--type/--k8s) and/or --set key=value / --spec <json>.\n' +
    `Example: ${ORDER_EXAMPLE}\n` +
    'Run "dcxv clusters"/"dcxv os" first to see valid --cluster/--os names or ids.')

  // --price: check the authoritative price only, no order created. Fetches
  // productCalcPrice unless --set/--spec already gave an explicit price.
  if (flags.price) {
    if (inp.price !== undefined) {
      if (flags.json) return void io.out(formatJson({ ok: true, price: inp.price }))
      io.out(color.green(`Price: ${money(inp.price)}`))
      return
    }
    const { productCalcPrice: calc } = await client.request(Q_CALC_PRICE, { inp })
    if (flags.json) return void io.out(formatJson(calc))
    if (!calc || !calc.ok) throw new DcxvError(`Price check failed: ${calc?.reason || 'unknown error'}`)
    io.out(color.green(`Price: ${money(calc.price)}`) + (calc.promo ? color.dim(`  (promo: ${calc.promo})`) : ''))
    return
  }

  if (!flags.yes) {
    io.err(color.yellow('Dry run — this would order (re-run with --yes to submit and bill your account):'))
    io.out(formatJson(inp))
    return 0
  }

  // productOrder requires a submitted price (recomputed/verified server-side anyway) —
  // auto-fetch the authoritative one via productCalcPrice unless --set/--spec already
  // gave an explicit price. A fresh object (not a mutation of `inp`) keeps the
  // productCalcPrice request body distinct from the productOrder one that follows.
  let orderInp = inp
  if (inp.price === undefined) {
    const { productCalcPrice: calc } = await client.request(Q_CALC_PRICE, { inp })
    if (!calc || !calc.ok) throw new DcxvError(`Price check failed: ${calc?.reason || 'unknown error'}`)
    orderInp = { ...inp, price: calc.price }
  }

  const { productOrder } = await client.request(M_PRODUCT_ORDER, { inp: orderInp })
  if (flags.json) return void io.out(formatJson(productOrder))
  if (!productOrder || productOrder.err) throw new DcxvError('Order failed: ' + (productOrder?.err || 'unknown error'))
  io.out(color.green(`Ordered product ${productOrder.id} (${productOrder.type})`))
  io.out(formatKeyVals([
    ['Hostname', productOrder.hostname],
    ['OS', productOrder.os],
    ['Price', money(productOrder.price)],
    ['Next payment', ts(productOrder.next_pay)],
    ['Login', productOrder.login ? `${productOrder.login} / ${productOrder.pass}` : null],
  ]))
  if (flags.watch) return handleWatch(client, productOrder.id, false, io, {
    onDone: () => showOrderAccessInfo(client, productOrder.id, io),
  })
  io.out(color.dim(`Track provisioning:  dcxv watch ${productOrder.id}`))
}

function handleTransactions(client, flags, io) {
  return listCommand(client, Q_TRANSACTIONS, 'userTrans', undefined, flags, io, [
    { key: 'id', label: 'ID' },
    { key: 'dt', label: 'DATE', fmt: (v) => ts(v) },
    { key: 'reason', label: 'REASON' },
    { key: 'info', label: 'INFO', fmt: (v) => v ? String(v).slice(0, 40) : '' },
    { key: 'delta', label: 'AMOUNT', fmt: (v) => (Number(v) >= 0 ? color.green('+' + money(v)) : color.red(money(v))) },
    { key: 'rest', label: 'BALANCE', fmt: (v) => money(v) },
    { key: 'invoice', label: 'INVOICE' },
  ])
}

async function handleTx(client, positionals, flags, io) {
  const id = positionals[1]
  if (!id) throw new DcxvError('Usage: dcxv tx <id>')
  if ((positionals[2] || '').toLowerCase() === 'invoice') {
    return handleTxInvoice(client, id, positionals[3], flags, io)
  }
  const { userTransId } = await client.request(Q_TRANSACTION, { id: Number(id) })
  if (flags.json) return void io.out(formatJson(userTransId))
  if (!userTransId) throw new DcxvError(`Transaction ${id} not found.`)
  io.out(formatTransaction(userTransId))
}

// `dcxv tx <id> invoice [outfile]`: mints/fetches the transaction's PDF invoice
// (userTransIdInvoice -> { pdf_url }). Always prints the URL; when an outfile is given,
// additionally downloads the PDF bytes, falling back to the URL if the fetch fails
// (the link may be signed, or require the browser session).
async function handleTxInvoice(client, id, outfile, flags, io) {
  const { userTransIdInvoice: r } = await client.request(M_TRANS_INVOICE, { id: Number(id) })
  if (flags.json) return void io.out(formatJson(r))
  if (!r?.pdf_url) throw new DcxvError(`No invoice available for transaction ${id}.`)
  const url = /^https?:/i.test(r.pdf_url) ? r.pdf_url : client.url + r.pdf_url
  if (!outfile) {
    io.out(color.green(`Invoice for transaction ${id}:`))
    io.out(color.cyan(url))
    return
  }
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(outfile, buf)
    io.out(color.green(`Invoice written to ${outfile} (${buf.length} bytes)`))
  } catch (e) {
    io.err(color.yellow(`Could not download the PDF (${e.message}). Open it directly:`))
    io.out(color.cyan(url))
  }
}

async function handlePay(client, positionals, flags, io) {
  const method = positionals[1]
  const amountArg = positionals[2]
  const u = await getAccount(client)
  const methods = u.can_pay || []

  if (!method) {
    if (flags.json) return void io.out(formatJson({ balance: u.rest, sign: u.sign, methods }))
    io.out(`Balance: ${color.bold(money(u.rest, u.sign))}`)
    io.out(`Methods: ${methods.join(', ') || '(none available)'}`)
    io.out(color.dim('Usage: dcxv pay <method> <amount>   e.g. dcxv pay usdt 10'))
    return 0
  }
  if (!methods.includes(method)) {
    throw new DcxvError(`Payment method "${method}" not accepted. Available: ${methods.join(', ') || '(none)'}`)
  }
  const amount = Number(String(amountArg ?? '').replace(',', '.'))
  if (!Number.isFinite(amount) || amount < 1) throw new DcxvError(`Amount must be a number >= 1, e.g. dcxv pay ${method} 10`)

  const data = await client.request(M_USER_PAY, { inp: { reason: method, amount } })
  const txId = data.userPay
  if (!txId || txId <= 0) throw new DcxvError('Payment could not be created (userPay returned no transaction id).')

  const { userTransId } = await client.request(Q_TRANSACTION, { id: Number(txId) })
  if (flags.json) return void io.out(formatJson({ id: txId, ...userTransId }))
  io.out(color.green(`Payment #${txId} created — ${money(amount, u.sign)} via ${method}`))
  io.out(userTransId ? formatTransaction(userTransId) : color.dim(`Open ${u.url || 'https://dcxv.com'}/my/payment/${txId} to complete.`))
}

async function handleSub(client, config, positionals, flags, io) {
  const sub = (positionals[1] || 'ls').toLowerCase()
  switch (sub) {
    case 'ls':
      return listCommand(client, Q_SUB_ACCOUNTS, 'userSubAccounts', undefined, flags, io, [
        { key: 'id', label: 'ID' },
        { key: 'email', label: 'EMAIL' },
        { key: 'fname', label: 'NAME' },
        { key: 'rest', label: 'BALANCE', fmt: (v) => money(v) },
        { key: 'servers', label: 'SERVERS', fmt: (v) => String((v || []).length) },
      ])
    case 'add': {
      const [, , email, fname] = positionals
      if (!email || !fname) throw new DcxvError('Usage: dcxv sub add <email> <fname>')
      const { userSubAdd: r } = await client.request(M_SUB_ADD, { email, fname })
      if (flags.json) return void io.out(formatJson(r))
      if (!r) throw new DcxvError(`Sub-account create failed: ${NULL_RESULT_HINT}`)
      if (r.err) throw new DcxvError(`Sub-account create failed: ${r.err}`)
      return void io.out(color.green(`Created sub-account ${r.id} <${r.email}>`))
    }
    case 'login': {
      const id = positionals[2]
      if (!id) throw new DcxvError('Usage: dcxv sub login <id>')
      const { userSubLogin: r } = await client.request(M_SUB_LOGIN, { id: Number(id) })
      if (r?.err || !r?.token) throw new DcxvError(`Sub-account login failed: ${r?.err || 'no token returned'}`)
      config.saveConfig({ subToken: r.token }, { profile: flags.profile })
      return void io.out(color.green(`Switched into sub-account ${r.id} <${r.email}>. Run "dcxv sub exit" to return.`))
    }
    case 'exit': {
      await client.request(M_SUB_EXIT)
      config.saveConfig({ subToken: null }, { profile: flags.profile })
      return void io.out(color.green('Returned to your main account.'))
    }
    default:
      throw new DcxvError(`Unknown sub command "${sub}". Use: ls, add, login, exit.`)
  }
}

function handleProfile(config, positionals, flags, io) {
  const sub = (positionals[1] || 'ls').toLowerCase()
  if (sub === 'ls') {
    const { current, names } = config.listProfiles()
    if (flags.json) return void io.out(formatJson({ current, profiles: names }))
    return void io.out(names.map(n => `${n === current ? '* ' : '  '}${n}`).join('\n') || '(none)')
  }
  if (sub === 'use') {
    const name = positionals[2]
    if (!name) throw new DcxvError('Usage: dcxv profile use <name>')
    config.useProfile(name)
    return void io.out(color.green(`Active profile: ${name}`))
  }
  if (sub === 'rm') {
    const name = positionals[2]
    if (!name) throw new DcxvError('Usage: dcxv profile rm <name>')
    config.removeProfile(name)
    return void io.out(color.green(`Removed profile: ${name}`))
  }
  throw new DcxvError(`Unknown profile command "${sub}". Use: ls, use, rm.`)
}

// Grace periods (seconds) before telling the user that nothing is being reported: the
// short one only fires when the row snapshot has *confirmed* no task is running, the long
// one covers the case where we couldn't tell (snapshot unavailable, or watching all).
// Read per call (not at import) so the env override applies to an already-loaded module.
const WATCH_IDLE_SEC = () => Number(process.env.DCXV_WATCH_IDLE_SEC || 5)
const WATCH_SILENT_SEC = () => Number(process.env.DCXV_WATCH_SILENT_SEC || 60)

function handleWatch(client, filterId, json, io, { onDone } = {}) {
  return new Promise((resolve, reject) => {
    let finished = false
    let seen = 0            // live events accepted (after the id filter)
    let snapPct             // undefined = unknown, 0 = nothing running, >0 = task in flight
    let dispose
    const timers = []
    const after = (sec, fn) => {
      const t = setTimeout(fn, sec * 1000)
      t.unref?.()
      timers.push(t)
    }
    // Remove the signal handlers on every exit path so repeated watch calls in one
    // process (e.g. order --watch then a later watch) don't accumulate listeners.
    const cleanup = () => {
      while (timers.length) clearTimeout(timers.pop())
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
    const stop = () => { endLine(); dispose?.(); cleanup(); resolve(0) }
    io.err(color.dim(filterId
      ? `Watching product ${filterId} (Ctrl-C to stop)…`
      : 'Watching all products (Ctrl-C to stop)…'))

    // Progress exists ONLY as push events, so a watcher that attaches between two emits —
    // or after the task already finished, or when it never started (a rejected mutation) —
    // otherwise sits blank indefinitely with no way to tell which case it is. Prime the
    // display from the row's current progress, and say so when there is nothing to show.
    // Armed before subscribe() so a synchronous first event still cancels them.
    const silentSec = WATCH_SILENT_SEC()
    after(WATCH_IDLE_SEC(), () => {
      if (finished || seen || snapPct !== 0) return
      io.err(color.dim(`No task currently running on ${filterId} — waiting for updates…`))
    })
    after(silentSec, () => {
      if (finished || seen || snapPct === 0) return
      io.err(color.yellow(`No progress reported after ${silentSec}s — the task may not have started.` +
        (filterId ? ` Check "dcxv get ${filterId}".` : '')))
    })

    if (filterId) {
      // Best-effort: a failed snapshot must never break the live stream.
      client.request(Q_PRODUCT_MON, { id: Number(filterId) }).then(({ productMon: p }) => {
        if (finished || seen || !p) return
        snapPct = parseProgress(p.progress).pct
        if (json) return void io.out(formatJson(p))
        if (snapPct > 0) progressBar(`#${p.id} ${p.stat || ''}`.trim(), p.progress)
      }).catch(() => {})
    }

    dispose = client.subscribe(S_PRODUCT, {
      onNext: (data) => {
        const p = data.productSub
        if (!p) return
        if (filterId && String(p.id) !== String(filterId)) return
        seen++
        if (json) return io.out(formatJson(p))
        const label = `#${p.id} ${p.stat || ''}`.trim()
        progressBar(label, p.progress)
        if (p.err) { endLine(); io.err(color.red(`error: ${p.err}`)) }
        if ((parseProgress(p.progress).pct >= 100 || p.ret) && !finished) {
          finished = true
          endLine()
          io.err(color.green(`#${p.id} done${p.ret ? ' (' + p.ret + ')' : ''}`))
          if (filterId) {
            dispose()
            cleanup()
            Promise.resolve(onDone?.(p)).then(() => resolve(0), reject)
          }
        }
      },
      // Once completion is detected we own the resolution: dispose() below makes the
      // transport fire `complete` (and can surface a teardown error), and resolving here
      // would settle the promise while onDone is still awaiting — run() returns, the
      // entrypoint calls process.exit, and the in-flight work is dropped. That silently
      // ate the post-provisioning "Access" block on `order --watch`.
      onError: (err) => { if (finished) return; endLine(); dispose(); cleanup(); reject(err) },
      onComplete: () => { if (finished) return; endLine(); cleanup(); resolve(0) },
    })
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

// -------------------------------------------------------------- completions

const COMMANDS = 'login config profile whoami account balance orders products ls list os clusters order get set rm transactions txns history tx pay sub watch completion version help'

export function completionScript(shell) {
  switch (shell) {
    case 'bash':
      return `# dcxv bash completion — add to ~/.bashrc:  source <(dcxv completion bash)
_dcxv() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${COMMANDS}" -- "$cur") )
  fi
}
complete -F _dcxv dcxv`
    case 'zsh':
      return `# dcxv zsh completion — add to ~/.zshrc:  source <(dcxv completion zsh)
_dcxv() { compadd ${COMMANDS} }
compdef _dcxv dcxv`
    case 'fish':
      return `# dcxv fish completion — save to ~/.config/fish/completions/dcxv.fish
complete -c dcxv -f
for c in ${COMMANDS}
  complete -c dcxv -n '__fish_use_subcommand' -a $c
end`
    default:
      return ''
  }
}
