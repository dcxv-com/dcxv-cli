import { test, expect, describe } from 'bun:test'
import { run } from '../src/cli.js'
import * as Q from '../src/queries.js'
import { ts } from '../src/output.js'
import { VERSION } from '../src/version.js'

// Map each query string to its top-level operation name so the fake client can
// return the right { opName: fixture } shape and record calls.
const NAME_BY_QUERY = new Map([
  [Q.Q_ACCOUNT, 'userMy'], [Q.Q_ACCOUNT_FULL, 'userMy'], [Q.Q_USER_DOWNLOAD, 'userDownload'],
  [Q.M_USER_MOD, 'userMod'], [Q.M_TRANS_INVOICE, 'userTransIdInvoice'],
  [Q.Q_PRODUCTS, 'productMy'], [Q.M_PRODUCT_SET, 'productSet'],
  [Q.Q_PRODUCT_DETAIL, 'productId'], [Q.Q_PRODUCT_MON, 'productMon'], [Q.Q_PRODUCT_GRAPH, 'productGraph'],
  [Q.Q_PRODUCT_OS, 'productOS'], [Q.Q_CALC_PRICE_TABLE, 'calcPrice'],
  [Q.Q_TRANSACTIONS, 'userTrans'], [Q.Q_TRANSACTION, 'userTransId'], [Q.M_USER_PAY, 'userPay'],
  [Q.M_PRODUCT_ORDER, 'productOrder'], [Q.Q_CALC_PRICE, 'productCalcPrice'], [Q.M_PRODUCT_REM, 'productRem'],
  [Q.Q_SNAP_LIST, 'productSnapList'], [Q.M_SNAP_RESTORE, 'productSnapRestore'],
  [Q.Q_BACKUP_LIST, 'productBackupList'], [Q.M_BACKUP_RESTORE, 'productBackupRestore'],
  [Q.Q_ISO_LIST, 'productCloudISOList'], [Q.M_ISO_MOUNT, 'productCloudISO'], [Q.M_ISO_REM, 'productCloudISORem'],
  [Q.Q_SUB_ACCOUNTS, 'userSubAccounts'], [Q.M_SUB_ADD, 'userSubAdd'],
  [Q.M_SUB_LOGIN, 'userSubLogin'], [Q.M_SUB_EXIT, 'userSubExit'],
])

function harness({ data = {}, subscribe } = {}) {
  const out = [], err = [], calls = [], saved = []
  const client = {
    request: async (query, vars) => {
      const name = NAME_BY_QUERY.get(query)
      if (!name) throw new Error('test: unmapped query string')
      calls.push({ name, vars })
      // Plain cloud orders now resolve their default OS from the live catalog.
      // Keep generic CLI fixtures focused on their command under test.
      if (!(name in data) && name === 'productOS') return { productOS: [{ id: 26, name: 'Ubuntu 26.04' }] }
      if (!(name in data)) throw new Error(`test: unexpected op "${name}" (add it to fixtures)`)
      const v = data[name]
      if (v instanceof Error) throw v
      // awaited, so a fixture may return a promise to model real network latency —
      // needed wherever ordering against another async path is what's under test.
      return { [name]: typeof v === 'function' ? await v(vars) : v }
    },
    subscribe,
  }
  const config = {
    loadConfig: () => ({ token: 't', url: 'https://dcxv.com', profile: 'default', source: 'profile:default', sub: false }),
    saveConfig: (patch, opts) => { saved.push({ patch, opts }); return '/tmp/cfg.json' },
    configPath: () => '/tmp/cfg.json',
    listProfiles: () => ({ current: 'default', names: ['default', 'work'] }),
    useProfile: (n) => n,
    removeProfile: () => {},
  }
  const deps = { config, makeClient: () => client, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }
  return { deps, out, err, calls, saved }
}

const outStr = (h) => h.out.join('\n')
const errStr = (h) => h.err.join('\n')
const called = (h, name) => h.calls.some(c => c.name === name)
const callOf = (h, name) => h.calls.find(c => c.name === name)
const exec = (h, ...argv) => run(argv, h.deps)

describe('meta commands', () => {
  // Asserted against the constant, not a literal: scripts/build.sh regenerates src/version.js
  // from package.json, so a hardcoded value here fails on every release bump.
  test('version', async () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    const h = harness()
    expect(await exec(h, 'version')).toBe(0)
    expect(h.out[0]).toBe(VERSION)
    const h2 = harness()
    await exec(h2, '--version')
    expect(h2.out[0]).toBe(VERSION)
  })
  test('version matches package.json (build.sh keeps src/version.js in sync)', async () => {
    expect(VERSION).toBe(require('../package.json').version)
  })
  test('help on no args and --help', async () => {
    const h = harness(); expect(await exec(h)).toBe(0); expect(outStr(h)).toContain('Usage:')
    const h2 = harness(); await exec(h2, '--help'); expect(outStr(h2)).toContain('Usage:')
  })
  test('unknown command -> exit 1 + help', async () => {
    const h = harness()
    expect(await exec(h, 'frobnicate')).toBe(1)
    expect(errStr(h)).toContain('Unknown command')
    expect(outStr(h)).toContain('Usage:')
  })
  test('login writes token via saveConfig', async () => {
    const h = harness()
    expect(await exec(h, 'login', 'TOKV')).toBe(0)
    expect(h.saved[0].patch).toEqual({ token: 'TOKV', url: undefined, subToken: null })
    expect(outStr(h)).toContain('Saved token')
  })
  // `dcxv login` with no token now starts the device-authorization flow instead of
  // erroring — see test/login.test.js for full coverage of that path.
  test('completion scripts + missing shell', async () => {
    const b = harness(); await exec(b, 'completion', 'bash'); expect(outStr(b)).toContain('complete -F _dcxv')
    const z = harness(); await exec(z, 'completion', 'zsh'); expect(outStr(z)).toContain('compdef')
    const f = harness(); await exec(f, 'completion', 'fish'); expect(outStr(f)).toContain('complete -c dcxv')
    const n = harness(); expect(await exec(n, 'completion')).toBe(1); expect(errStr(n)).toContain('Usage: dcxv completion')
  })
  test('profile ls / use / rm', async () => {
    const h = harness(); await exec(h, 'profile', 'ls'); expect(outStr(h)).toContain('* default')
    const u = harness(); expect(await exec(u, 'profile', 'use', 'work')).toBe(0); expect(outStr(u)).toContain('work')
    const r = harness(); expect(await exec(r, 'profile', 'use')).toBe(1)
  })
})

describe('whoami / balance', () => {
  const acct = { id: 7, fname: 'Ann', lname: 'Lee', email: 'a@b.co', rest: 12.5, sign: '$', can_pay: ['usdt', 'stripe'] }
  test('whoami positive', async () => {
    const h = harness({ data: { userMy: acct } })
    expect(await exec(h, 'whoami')).toBe(0)
    expect(outStr(h)).toContain('Ann Lee')
    expect(outStr(h)).toContain('<a@b.co>')
  })
  test('whoami null -> exit 1', async () => {
    const h = harness({ data: { userMy: null } })
    expect(await exec(h, 'whoami')).toBe(1)
    expect(errStr(h)).toContain('Not authenticated')
  })
  test('whoami --json', async () => {
    const h = harness({ data: { userMy: acct } })
    await exec(h, 'whoami', '--json')
    expect(JSON.parse(outStr(h)).email).toBe('a@b.co')
  })
  test('balance lists methods', async () => {
    const h = harness({ data: { userMy: acct } })
    await exec(h, 'balance')
    expect(outStr(h)).toContain('Balance:')
    expect(outStr(h)).toContain('usdt, stripe')
  })
})

describe('account', () => {
  const full = {
    id: 7, fname: 'Ann', lname: 'Lee', email: 'a@b.co', org: 'Acme', addr: '1 St',
    tel: '+1', id_country: 3, rest: 12.5, curr: 'USD', sign: '$', discount: 5,
    can_pay: ['usdt'], alias: ['ops@b.co'], lng: 'EN', notify_bill: 2, sshkey: 'ssh-ed25519 AAAA',
  }
  test('account show renders the full profile', async () => {
    const h = harness({ data: { userMy: full } })
    expect(await exec(h, 'account')).toBe(0)
    const s = outStr(h)
    expect(s).toContain('Ann Lee')
    expect(s).toContain('Acme')
    expect(s).toContain('USD')
    expect(s).toContain('ops@b.co')
    expect(s).toContain('ssh-ed25519')
  })
  test('account --json emits the raw userMy', async () => {
    const h = harness({ data: { userMy: full } })
    await exec(h, 'account', '--json')
    expect(JSON.parse(outStr(h)).org).toBe('Acme')
  })
  test('account null -> exit 1', async () => {
    const h = harness({ data: { userMy: null } })
    expect(await exec(h, 'account')).toBe(1)
    expect(errStr(h)).toContain('Not authenticated')
  })
  test('account set maps a friendly field to its inpUserMod key', async () => {
    const h = harness({ data: { userMod: (vars) => ({ id: 7, ...vars.inp }) } })
    expect(await exec(h, 'account', 'set', 'currency', 'EUR')).toBe(0)
    expect(callOf(h, 'userMod').vars.inp).toEqual({ curr: 'EUR' })
    expect(outStr(h)).toContain('Updated currency')
  })
  test('account set notify-bill coerces to an Int', async () => {
    const h = harness({ data: { userMod: (vars) => ({ id: 7, ...vars.inp }) } })
    await exec(h, 'account', 'set', 'notify-bill', '3')
    expect(callOf(h, 'userMod').vars.inp).toEqual({ notify_bill: 3 })
  })
  test('account set unknown field -> exit 1, no mutation', async () => {
    const h = harness({ data: {} })
    expect(await exec(h, 'account', 'set', 'nope', 'x')).toBe(1)
    expect(errStr(h)).toContain('Unknown field')
    expect(called(h, 'userMod')).toBe(false)
  })
  test('account set surfaces a backend err -> exit 1', async () => {
    const h = harness({ data: { userMod: { err: 'bad currency' } } })
    expect(await exec(h, 'account', 'set', 'currency', 'ZZZ')).toBe(1)
    expect(errStr(h)).toContain('bad currency')
  })
  test('account export prints the JSON blob', async () => {
    const h = harness({ data: { userDownload: '{"account":7}' } })
    expect(await exec(h, 'account', 'export')).toBe(0)
    expect(outStr(h)).toContain('"account":7')
  })
  test('unknown account subcommand -> exit 1', async () => {
    const h = harness({ data: {} })
    expect(await exec(h, 'account', 'frob')).toBe(1)
    expect(errStr(h)).toContain('Unknown account command')
  })
})

describe('products / order detail', () => {
  const prod = { id: 1, hostname: 'web', ip: '1.1.1.1', type: 'vps', os: 'Ubuntu', cpu: '2', ram: '4', price: 5, active: true, login: 'root', pass: 'pw' }
  test('orders table', async () => {
    const h = harness({ data: { productMy: [prod] } })
    await exec(h, 'orders')
    expect(outStr(h)).toContain('HOSTNAME')
    expect(outStr(h)).toContain('web')
  })
  test('orders alias products + empty', async () => {
    const h = harness({ data: { productMy: [] } })
    await exec(h, 'products')
    expect(outStr(h)).toContain('(none)')
  })
  test('orders alias ls / list', async () => {
    const h1 = harness({ data: { productMy: [prod] } })
    await exec(h1, 'ls')
    expect(outStr(h1)).toContain('web')

    const h2 = harness({ data: { productMy: [prod] } })
    await exec(h2, 'list')
    expect(outStr(h2)).toContain('web')
  })
  test('orders --json', async () => {
    const h = harness({ data: { productMy: [prod] } })
    await exec(h, 'orders', '--json')
    expect(JSON.parse(outStr(h))[0].hostname).toBe('web')
  })
  const detail = { id: 1, hostname: 'web', type: 'vps', os: 'Ubuntu', cpu: '2', ram: '4', price: 5, active: true, installed: 1700000000, login: 'root', pass: 'pw', ip: '9.9.9.9', ips: [{ ip: '9.9.9.9', mac: 'AA:BB', ptr: '' }], next_pay: 1787564176 }
  test('get <id> detail shows login/password and IP/MAC/PTR table', async () => {
    const h = harness({ data: { productId: detail, productMon: {} } })
    await exec(h, 'get', '1')
    const out = outStr(h)
    expect(out).toContain('Product 1')
    expect(out).toContain('Login')
    expect(out).toContain('root')
    expect(out).toContain('Password')
    expect(out).toContain('pw')
    expect(out).toContain('Network')
    expect(out).toContain('9.9.9.9')
    expect(out).toContain('MAC')
    expect(out).toContain('PTR')
  })
  // The Access block is where you look up how to connect after a deploy — it listed
  // ip/login/password but omitted the ready-to-paste command that order --watch prints.
  test('get <id> Access block includes the connect command (ssh / rdp by OS)', async () => {
    const lin = harness({ data: { productId: detail, productMon: {} } })
    await exec(lin, 'get', '1')
    expect(outStr(lin)).toContain('ssh root@9.9.9.9')

    const win = harness({ data: { productId: { ...detail, os: 'Windows Server 2022 EN (Standard)' }, productMon: {} } })
    await exec(win, 'get', '1')
    expect(outStr(win)).toContain('xfreerdp /v:9.9.9.9 /u:root')
  })
  test('get <id> detail shows one Network table row (not one per duplicate ip source) and formats next_pay as a date', async () => {
    const h = harness({ data: { productId: detail, productMon: {} } })
    await exec(h, 'get', '1')
    const out = outStr(h)
    // Network table renders from p.ips only (not ip+ips combined) -> exactly one table row for 9.9.9.9
    const networkSection = out.split('Network')[1].split('Access')[0]
    expect((networkSection.match(/9\.9\.9\.9/g) || []).length).toBe(1)
    expect(out).toMatch(/Next payment:\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })
  test('get <id> detail merges live productMon stat/progress', async () => {
    const h = harness({ data: { productId: detail, productMon: { stat: '{"status":"UP","uptime":3661,"cpu":12.5,"mem":[1000,2000]}' } } })
    await exec(h, 'get', '1')
    const out = outStr(h)
    expect(out).toContain('UP')
    expect(out).toContain('1h 1m')
    expect(out).toContain('Resources (live)')
    expect(out).toContain('12.5%')
  })
  test('get <id> not found -> exit 1', async () => {
    const h = harness({ data: { productId: null, productMon: null } })
    expect(await exec(h, 'get', '2')).toBe(1)
    expect(errStr(h)).toContain('not found')
  })
  test('get <id> ips shows a standalone IP/MAC/PTR table', async () => {
    const h = harness({ data: { productId: detail } })
    await exec(h, 'get', '1', 'ips')
    expect(outStr(h)).toContain('9.9.9.9')
    expect(outStr(h)).toContain('MAC')
  })
  test('get <id> stats: empty history', async () => {
    const h = harness({ data: { productGraph: null } })
    await exec(h, 'get', '1', 'stats')
    expect(outStr(h)).toContain('no resource usage history')
  })
  test('get <id> stats: renders sparkline + min/avg/max/last', async () => {
    const samples = [{ time: 1, cpu: 10, mem: 100 }, { time: 2, cpu: 20, mem: 200 }, { time: 3, cpu: 30, mem: 300 }]
    const h = harness({ data: { productGraph: JSON.stringify(samples) } })
    await exec(h, 'get', '1', 'stats')
    const out = outStr(h)
    expect(out).toContain('CPU %')
    expect(out).toContain('min 10')
    expect(out).toContain('max 30')
    expect(out).toContain('last 30')
  })
  test('get <id> stats: history exists but every metric is "NaN"/missing (real backend early-history shape)', async () => {
    const samples = [{ time: 1, mem: 'NaN', netin: 'NaN', netout: 'NaN', diskread: 'NaN', diskwrite: 'NaN' }]
    const h = harness({ data: { productGraph: JSON.stringify(samples) } })
    await exec(h, 'get', '1', 'stats')
    expect(outStr(h)).toContain('1 history point')
    expect(outStr(h)).toContain('no numeric data yet')
  })
})

describe('set <id> web-parity mutations', () => {
  test('renew', async () => {
    const h = harness({ data: { productSet: { id: 1 } } })
    expect(await exec(h, 'set', '1', 'renew')).toBe(0)
    expect(callOf(h, 'productSet').vars).toEqual({ inp: { id: 1, renew: true } })
  })
  test('autoprolong on/off', async () => {
    const on = harness({ data: { productSet: { id: 1 } } })
    await exec(on, 'set', '1', 'autoprolong', 'on')
    expect(callOf(on, 'productSet').vars).toEqual({ inp: { id: 1, autoprolong: true } })
    const off = harness({ data: { productSet: { id: 1 } } })
    await exec(off, 'set', '1', 'autoprolong', 'off')
    expect(callOf(off, 'productSet').vars).toEqual({ inp: { id: 1, autoprolong: false } })
    const bad = harness({ data: {} })
    expect(await exec(bad, 'set', '1', 'autoprolong', 'maybe')).toBe(1)
  })
  test('lock / unlock', async () => {
    const lock = harness({ data: { productSet: { id: 1 } } })
    await exec(lock, 'set', '1', 'lock')
    expect(callOf(lock, 'productSet').vars).toEqual({ inp: { id: 1, blocked: true } })
    const unlock = harness({ data: { productSet: { id: 1 } } })
    await exec(unlock, 'set', '1', 'unlock')
    expect(callOf(unlock, 'productSet').vars).toEqual({ inp: { id: 1, blocked: false } })
  })
  test('rename', async () => {
    const h = harness({ data: { productSet: { id: 1 } } })
    expect(await exec(h, 'set', '1', 'rename', 'new-name')).toBe(0)
    expect(callOf(h, 'productSet').vars).toEqual({ inp: { id: 1, hostname: 'new-name' } })
    const missing = harness({ data: {} })
    expect(await exec(missing, 'set', '1', 'rename')).toBe(1)
  })
  test('notify-emails', async () => {
    const h = harness({ data: { productSet: { id: 1 } } })
    await exec(h, 'set', '1', 'notify-emails', 'a@b.com')
    expect(callOf(h, 'productSet').vars).toEqual({ inp: { id: 1, notify_emails: 'a@b.com' } })
  })
  test('password explicit', async () => {
    const h = harness({ data: { productSet: { id: 1 } } })
    await exec(h, 'set', '1', 'password', 'MyPass123')
    expect(callOf(h, 'productSet').vars).toEqual({ inp: { id: 1, cmd: 'PASS', pass: 'MyPass123' } })
    expect(outStr(h)).toContain('MyPass123')
  })
  test('password generated when omitted', async () => {
    const h = harness({ data: { productSet: { id: 1 } } })
    await exec(h, 'set', '1', 'password')
    const sent = callOf(h, 'productSet').vars.inp.pass
    expect(typeof sent).toBe('string')
    expect(sent.length).toBe(16)
  })
  test('mac / ptr', async () => {
    const mac = harness({ data: { productSet: { id: 1 } } })
    await exec(mac, 'set', '1', 'mac', '1.2.3.4', 'AA:BB:CC:DD:EE:FF')
    expect(callOf(mac, 'productSet').vars).toEqual({ inp: { id: 1, ip: '1.2.3.4', mac: 'AA:BB:CC:DD:EE:FF' } })
    const ptr = harness({ data: { productSet: { id: 1 } } })
    await exec(ptr, 'set', '1', 'ptr', '1.2.3.4', 'host.example.com')
    expect(callOf(ptr, 'productSet').vars).toEqual({ inp: { id: 1, ip: '1.2.3.4', ptr: 'host.example.com' } })
  })
  test('get <id> kubeconfig prints to stdout or writes to a file', async () => {
    const h = harness({ data: { productId: { id: 1, k8sKubeconfig: 'apiVersion: v1' } } })
    await exec(h, 'get', '1', 'kubeconfig')
    expect(outStr(h)).toContain('apiVersion: v1')

    const noK8s = harness({ data: { productId: { id: 1, k8sKubeconfig: null } } })
    expect(await exec(noK8s, 'get', '1', 'kubeconfig')).toBe(1)
  })
})

describe('power control', () => {
  test('power start -> productSet {id,cmd:START}', async () => {
    const h = harness({ data: { productSet: { id: 1, ret: 'ok' } } })
    expect(await exec(h, 'set', '1', 'power', 'start')).toBe(0)
    expect(callOf(h, 'productSet').vars).toEqual({ inp: { id: 1, cmd: 'START' } })
    expect(outStr(h)).toContain('START sent')
  })
  test('unknown power verb -> exit 1', async () => {
    const h = harness({ data: {} })
    expect(await exec(h, 'set', '1', 'power', 'frobnicate')).toBe(1)
    expect(errStr(h)).toContain('Unknown power command')
    expect(called(h, 'productSet')).toBe(false)
  })
  test('unknown set action -> exit 1', async () => {
    const h = harness({ data: {} })
    expect(await exec(h, 'set', '1', 'frobnicate')).toBe(1)
    expect(errStr(h)).toContain('Unknown action')
  })
  test('backend err -> exit 1', async () => {
    const h = harness({ data: { productSet: { err: 'nope' } } })
    expect(await exec(h, 'set', '1', 'power', 'stop')).toBe(1)
    expect(errStr(h)).toContain('Failed: nope')
  })
})

describe('order (--set/--spec escape hatch)', () => {
  test('--set coercion, dry-run, no calc/order call', async () => {
    const h = harness({ data: {} })
    expect(await exec(h, 'order', '--set', 'type=vps', '--set', 'cpu=4')).toBe(0)
    const inp = JSON.parse(outStr(h))
    expect(inp).toEqual({ type: 'vps', cpu: 4 })
    expect(errStr(h)).toContain('Dry run')
    expect(called(h, 'productOrder')).toBe(false)
    expect(called(h, 'productCalcPrice')).toBe(false)
  })
  test('--spec merged with --set', async () => {
    const h = harness({ data: {} })
    await exec(h, 'order', '--spec', '{"type":"vps","min_months":3}', '--set', 'cpu=2')
    expect(JSON.parse(outStr(h))).toEqual({ type: 'vps', min_months: 3, cpu: 2 })
  })
  test('--set without = -> exit 1', async () => {
    const h = harness({ data: {} })
    expect(await exec(h, 'order', '--set', 'bad')).toBe(1)
    expect(errStr(h)).toContain('expects key=value')
  })
  test('empty -> exit 1', async () => {
    const h = harness({ data: {} })
    expect(await exec(h, 'order')).toBe(1)
    expect(errStr(h)).toContain('Nothing specified')
  })
  test('invalid --spec JSON -> exit 1', async () => {
    const h = harness({ data: {} })
    expect(await exec(h, 'order', '--spec', '{bad')).toBe(1)
    expect(errStr(h)).toContain('not valid JSON')
  })
  test('--yes auto-fetches price via productCalcPrice, then submits productOrder', async () => {
    const h = harness({ data: {
      productCalcPrice: { price: 19.5, ok: true, reason: null, promo: null },
      productOrder: { id: 9, type: 'vps', hostname: 'h' },
    } })
    expect(await exec(h, 'order', '--set', 'type=vps', '--yes')).toBe(0)
    expect(callOf(h, 'productCalcPrice').vars).toEqual({ inp: { type: 'vps' } })
    expect(callOf(h, 'productOrder').vars).toEqual({ inp: { type: 'vps', price: 19.5 } })
    expect(outStr(h)).toContain('Ordered product 9')
  })
  test('an explicit --set price=... skips the auto price-fetch', async () => {
    const h = harness({ data: { productOrder: { id: 9, type: 'vps', hostname: 'h' } } })
    expect(await exec(h, 'order', '--set', 'type=vps', '--set', 'price=5', '--yes')).toBe(0)
    expect(called(h, 'productCalcPrice')).toBe(false)
    expect(callOf(h, 'productOrder').vars).toEqual({ inp: { type: 'vps', price: 5 } })
  })
  test('order stops with an unknown positional (old order/product <id> forms are gone)', async () => {
    const h = harness({ data: {} })
    expect(await exec(h, 'order', '1', 'ips')).toBe(1)
    expect(errStr(h)).toContain('Did you mean "dcxv get 1 ..." or "dcxv set 1 ..."')
  })
})

describe('order (friendly flags)', () => {
  const osList = { productOS: [{ id: 16, name: 'Ubuntu 24.04' }, { id: 10, name: 'CentOS 8' }] }
  const clusterTable = { calcPrice: JSON.stringify([
    { type: 'cloud', sell: 1, vid: 16, cpu: 'Platinum 2.4-3.9 GHz [Portugal]' },
    { type: 'cloud', sell: 1, vid: 10, cpu: 'Silver 2.1-3.0 GHz [Czechia]' },
    { type: 'cloud', sell: 0, vid: 99, cpu: 'Hidden Tier' },
  ]) }

  test('--vcpu/--ram/--disk/--ip map to cores/ram/hdd/ip, type/backup default for cloud, and select Ubuntu by default', async () => {
    const h = harness({ data: {} })
    await exec(h, 'order', '--vcpu', '4', '--ram', '8', '--disk', '80', '--ip', '1')
    expect(JSON.parse(outStr(h))).toEqual({ type: 'cloud', cores: 4, ram: '8', hdd: '80', ip: 1, backup: 0, os: 'Ubuntu 26.04', oid: 26 })
    expect(called(h, 'calcPrice')).toBe(false)
  })
  test('--cluster resolves a name to vid via calcPrice (unsellable rows excluded)', async () => {
    const h = harness({ data: clusterTable })
    await exec(h, 'order', '--cluster', 'Portugal', '--vcpu', '4')
    expect(JSON.parse(outStr(h)).vid).toBe(16)
  })
  test('--cluster accepts a numeric id directly', async () => {
    const h = harness({ data: clusterTable })
    await exec(h, 'order', '--cluster', '10')
    expect(JSON.parse(outStr(h)).vid).toBe(10)
  })
  test('--cluster unknown id -> exit 1', async () => {
    const h = harness({ data: clusterTable })
    expect(await exec(h, 'order', '--cluster', '999')).toBe(1)
    expect(errStr(h)).toContain('Unknown cluster id')
  })
  test('--cluster ambiguous substring -> exit 1', async () => {
    const many = { calcPrice: JSON.stringify([
      { type: 'cloud', sell: 1, vid: 1, cpu: 'Gold Tier A' },
      { type: 'cloud', sell: 1, vid: 2, cpu: 'Gold Tier B' },
    ]) }
    const h = harness({ data: many })
    expect(await exec(h, 'order', '--cluster', 'gold')).toBe(1)
    expect(errStr(h)).toContain('matches multiple clusters')
  })
  test('--cluster no match (unsellable tier is invisible) -> exit 1', async () => {
    const h = harness({ data: clusterTable })
    expect(await exec(h, 'order', '--cluster', 'Hidden Tier')).toBe(1)
    expect(errStr(h)).toContain('No cluster matches')
  })
  test('--backup overrides the cloud default of 0', async () => {
    const h = harness({ data: {} })
    await exec(h, 'order', '--vcpu', '4', '--backup', '7')
    expect(JSON.parse(outStr(h)).backup).toBe(7)
  })
  test('--os resolves a name to {os, oid} via productOS (EOL filtered)', async () => {
    const h = harness({ data: osList })
    await exec(h, 'order', '--vcpu', '4', '--ram', '8', '--disk', '80', '--ip', '1', '--os', 'Ubuntu 24.04')
    const inp = JSON.parse(outStr(h))
    expect(inp.os).toBe('Ubuntu 24.04')
    expect(inp.oid).toBe(16)
  })
  test('omitted --os selects the newest non-EOL Ubuntu catalog image', async () => {
    const h = harness({ data: { productOS: [
      { id: 16, name: 'Ubuntu 24.04' },
      { id: 26, name: 'Ubuntu 26.04 Resolute Raccoon' },
      { id: 99, name: 'Ubuntu 30.04 (EOL)' },
      { id: 10, name: 'CentOS 8' },
    ] } })
    await exec(h, 'order', '--vcpu', '4', '--ram', '8', '--disk', '80', '--ip', '1')
    const inp = JSON.parse(outStr(h))
    expect(inp.os).toBe('Ubuntu 26.04 Resolute Raccoon')
    expect(inp.oid).toBe(26)
    expect(errStr(h)).toContain('No --os specified; using latest Ubuntu image')
  })
  test('--os accepts a numeric id directly', async () => {
    const h = harness({ data: osList })
    await exec(h, 'order', '--vcpu', '4', '--ram', '8', '--disk', '80', '--ip', '1', '--os', '10')
    const inp = JSON.parse(outStr(h))
    expect(inp.os).toBe('CentOS 8')
    expect(inp.oid).toBe(10)
  })
  test('--os unknown id -> exit 1', async () => {
    const h = harness({ data: osList })
    expect(await exec(h, 'order', '--os', '999')).toBe(1)
    expect(errStr(h)).toContain('Unknown OS id')
  })
  test('--os ambiguous substring -> exit 1', async () => {
    const many = { productOS: [{ id: 1, name: 'Ubuntu 22.04' }, { id: 2, name: 'Ubuntu 24.04' }] }
    const h = harness({ data: many })
    expect(await exec(h, 'order', '--os', 'ubuntu')).toBe(1)
    expect(errStr(h)).toContain('matches multiple OSes')
  })
  test('--os no match -> exit 1', async () => {
    const h = harness({ data: osList })
    expect(await exec(h, 'order', '--os', 'freebsd')).toBe(1)
    expect(errStr(h)).toContain('No OS matches')
  })
  test('--price checks the authoritative price, no order created', async () => {
    const h = harness({ data: { productCalcPrice: { price: 24, ok: true, reason: null, promo: null } } })
    expect(await exec(h, 'order', '--vcpu', '4', '--ram', '8', '--disk', '80', '--ip', '1', '--price')).toBe(0)
    expect(outStr(h)).toContain('24.00')
    expect(called(h, 'productOrder')).toBe(false)
  })
  test('--price rejection (ok:false) -> exit 1 with reason', async () => {
    const h = harness({ data: { ...clusterTable, productCalcPrice: { price: 0, ok: false, reason: 'unknown_vid', promo: null } } })
    expect(await exec(h, 'order', '--cluster', '10', '--price')).toBe(1)
    expect(errStr(h)).toContain('unknown_vid')
  })
  test('--price --json returns the raw calc result', async () => {
    const h = harness({ data: { productCalcPrice: { price: 15, ok: true, reason: null, promo: null } } })
    await exec(h, 'order', '--vcpu', '4', '--price', '--json')
    expect(JSON.parse(outStr(h))).toEqual({ price: 15, ok: true, reason: null, promo: null })
  })
  test('--yes places the order using the friendly flags + resolved cluster/OS + auto price', async () => {
    const h = harness({ data: {
      ...osList,
      ...clusterTable,
      productCalcPrice: { price: 24, ok: true, reason: null, promo: null },
      productOrder: { id: 42, type: 'cloud', hostname: 'auto-name' },
    } })
    expect(await exec(h, 'order', '--cluster', 'Portugal', '--vcpu', '4', '--ram', '8', '--disk', '80', '--ip', '1', '--os', 'Ubuntu 24.04', '--yes')).toBe(0)
    expect(callOf(h, 'productOrder').vars).toEqual({
      inp: { type: 'cloud', vid: 16, cores: 4, ram: '8', hdd: '80', ip: 1, backup: 0, os: 'Ubuntu 24.04', oid: 16, price: 24 },
    })
    expect(outStr(h)).toContain('Ordered product 42')
  })
  test('--yes --watch chains straight into watching the new order (no "dcxv watch" hint printed)', async () => {
    const h = harness({
      data: {
        productCalcPrice: { price: 24, ok: true, reason: null, promo: null },
        productOrder: { id: 42, type: 'cloud', hostname: 'auto-name' },
        productId: { id: 42, type: 'cloud', os: 'Ubuntu 26.04', ip: '203.0.113.42', login: 'root', pass: 'secret' },
        productMon: {},
      },
      subscribe: (_q, hs) => {
        queueMicrotask(() => hs.onNext({ productSub: { id: 42, progress: 100, ret: 'ok' } }))
        return () => {}
      },
    })
    expect(await exec(h, 'order', '--vcpu', '4', '--ram', '8', '--disk', '80', '--ip', '1', '--yes', '--watch')).toBe(0)
    expect(outStr(h)).toContain('Ordered product 42')
    expect(outStr(h)).not.toContain('dcxv watch')
    expect(outStr(h)).toContain('Access')
    expect(outStr(h)).toContain('ssh root@203.0.113.42')
    expect(errStr(h)).toContain('Watching product 42')
    expect(errStr(h)).toContain('done')
  })
  test('--yes --watch prints an RDP command for Windows', async () => {
    const h = harness({
      data: {
        productCalcPrice: { price: 24, ok: true, reason: null, promo: null },
        productOrder: { id: 43, type: 'cloud', hostname: 'win' },
        productId: { id: 43, type: 'cloud', os: 'Windows Server 2025', ip: '203.0.113.43', login: 'Administrator', pass: 'secret' },
        productMon: {},
      },
      subscribe: (_q, hs) => {
        queueMicrotask(() => hs.onNext({ productSub: { id: 43, progress: 100, ret: 'ok' } }))
        return () => {}
      },
    })
    expect(await exec(h, 'order', '--vcpu', '4', '--ram', '8', '--disk', '80', '--ip', '1', '--yes', '--watch')).toBe(0)
    expect(outStr(h)).toContain('xfreerdp /v:203.0.113.43 /u:Administrator')
  })

  test('--type k8s -> type stays "cloud", k8s defaults to K3S', async () => {
    const h = harness({ data: {} })
    await exec(h, 'order', '--type', 'k8s', '--vcpu', '4', '--ram', '8', '--disk', '60')
    expect(JSON.parse(outStr(h))).toEqual({ type: 'cloud', cores: 4, ram: '8', hdd: '60', ip: 1, backup: 0, k8s: 'K3S' })
  })
  test('bare --k8s <preset> implies a k8s order without --type', async () => {
    const h = harness({ data: {} })
    await exec(h, 'order', '--k8s', 'rke2', '--vcpu', '4', '--ram', '8', '--disk', '60')
    const inp = JSON.parse(outStr(h))
    expect(inp.type).toBe('cloud')
    expect(inp.k8s).toBe('RKE2')
  })
  test('--k8s auto-bumps vcpu/ram/disk below the k8s minimums, with a stderr note', async () => {
    const h = harness({ data: {} })
    await exec(h, 'order', '--type', 'k8s', '--vcpu', '1', '--ram', '2', '--disk', '10')
    const inp = JSON.parse(outStr(h))
    expect(inp.cores).toBe(4)
    expect(inp.ram).toBe('8')
    expect(inp.hdd).toBe('60')
    expect(errStr(h)).toContain('k8s minimum')
  })
  test('unknown --k8s preset -> exit 1', async () => {
    const h = harness({ data: {} })
    expect(await exec(h, 'order', '--k8s', 'nope')).toBe(1)
    expect(errStr(h)).toContain('Unknown --k8s preset')
  })
})

describe('clusters', () => {
  const clusterTable = { calcPrice: JSON.stringify([
    { type: 'cloud', sell: 1, vid: 16, cpu: 'Platinum 2.4-3.9 GHz [Portugal]' },
    { type: 'cloud', sell: 1, vid: 10, cpu: 'Silver 2.1-3.0 GHz [Czechia]' },
    { type: 'cloud', sell: 0, vid: 99, cpu: 'Hidden Tier' },
  ]) }
  test('lists sellable cloud clusters, excluding unsellable rows', async () => {
    const h = harness({ data: clusterTable })
    await exec(h, 'clusters')
    const out = outStr(h)
    expect(out).toContain('Portugal')
    expect(out).toContain('Czechia')
    expect(out).not.toContain('Hidden Tier')
  })
  test('filter argument is a case-insensitive substring match', async () => {
    const h = harness({ data: clusterTable })
    await exec(h, 'clusters', 'portugal')
    const out = outStr(h)
    expect(out).toContain('Portugal')
    expect(out).not.toContain('Czechia')
  })
})

describe('destructive gating', () => {
  test('rm without --yes -> refuse, no call', async () => {
    const h = harness({ data: {} })
    expect(await exec(h, 'rm', '1')).toBe(1)
    expect(errStr(h)).toContain('Refusing to delete')
    expect(called(h, 'productRem')).toBe(false)
  })
  test('rm --yes calls productRem', async () => {
    const h = harness({ data: { productRem: true } })
    expect(await exec(h, 'rm', '1', '--yes')).toBe(0)
    expect(callOf(h, 'productRem').vars).toEqual({ id: 1 })
    expect(outStr(h)).toContain('deleted')
  })
  // productRem is a Boolean: false = backend refused (suspended product), null = masked
  // resolver error. Neither deleted anything, so neither may report success.
  test('rm reports a refused delete (productRem false) as a failure', async () => {
    const h = harness({ data: { productRem: false } })
    expect(await exec(h, 'rm', '1', '--yes')).toBe(1)
    expect(errStr(h)).toContain('was NOT deleted')
    expect(outStr(h)).not.toContain('Product 1 deleted')
  })
  test('rm reports a null result as a failure', async () => {
    const h = harness({ data: { productRem: null } })
    expect(await exec(h, 'rm', '1', '--yes')).toBe(1)
    expect(errStr(h)).toContain('was NOT deleted')
  })
  test('snap-restore without --yes -> refuse', async () => {
    const h = harness({ data: {} })
    expect(await exec(h, 'set', '1', 'snap-restore', 's1')).toBe(1)
    expect(called(h, 'productSnapRestore')).toBe(false)
  })
})

describe('product extras', () => {
  test('upgrade -> productSet {id,upgrade:[item,value]}', async () => {
    const h = harness({ data: { productSet: { id: 1 } } })
    expect(await exec(h, 'set', '1', 'upgrade', 'cpu', '8')).toBe(0)
    expect(callOf(h, 'productSet').vars).toEqual({ inp: { id: 1, upgrade: ['cpu', '8'] } })
    expect(outStr(h)).toContain('Upgrade cpu=8')
  })
  test('snapshots list', async () => {
    const h = harness({ data: { productSnapList: [{ name: 's1', date: 'd', description: 'x' }] } })
    await exec(h, 'get', '1', 'snapshots')
    expect(outStr(h)).toContain('s1')
  })
  test('snap-restore --yes', async () => {
    const h = harness({ data: { productSnapRestore: { id: 1, ret: 'ok' } } })
    expect(await exec(h, 'set', '1', 'snap-restore', 's1', '--yes')).toBe(0)
    expect(callOf(h, 'productSnapRestore').vars).toEqual({ id: 1, name: 's1' })
    expect(outStr(h)).toContain('restore started')
  })
  // ProductBackup.date is epoch seconds and .size is raw bytes (Product.gql) — both were
  // printed unformatted, so the table showed "1754524800" and "12884901888".
  test('backups list formats the epoch date and byte size', async () => {
    const h = harness({ data: { productBackupList: [{ id: 7, date: 1754524800, size: 12884901888 }] } })
    await exec(h, 'get', '1', 'backups')
    const out = outStr(h)
    expect(out).toContain('7')
    expect(out).toContain('12 GB')
    expect(out).not.toContain('12884901888')
    expect(out).toContain(ts(1754524800))
    expect(out).not.toContain('1754524800')
  })
  test('iso-mount', async () => {
    const h = harness({ data: { productCloudISO: { filename: 'x.iso' } } })
    await exec(h, 'set', '1', 'iso-mount', 'http://u/x.iso')
    expect(callOf(h, 'productCloudISO').vars).toEqual({ id: 1, url: 'http://u/x.iso', filename: null })
    expect(outStr(h)).toContain('attached')
  })
  test('reinstall without --yes -> refuse, no call', async () => {
    const h = harness({ data: {} })
    expect(await exec(h, 'set', '1', 'reinstall', '30')).toBe(1)
    expect(errStr(h)).toContain('Refusing to reinstall')
    expect(called(h, 'productSet')).toBe(false)
  })
  const OS_CATALOG = [{ id: 30, name: 'Ubuntu 24.04' }, { id: 26, name: 'Ubuntu 26.04' }]
  test('reinstall --yes -> productSet {id,cmd:REINSTALL,oid,k8s}', async () => {
    const h = harness({ data: { productSet: { id: 1, ret: 'ok' }, productOS: OS_CATALOG } })
    expect(await exec(h, 'set', '1', 'reinstall', '30', '--yes')).toBe(0)
    expect(callOf(h, 'productSet').vars).toEqual({ inp: { id: 1, cmd: 'REINSTALL', oid: 30, k8s: 'NONE' } })
    expect(outStr(h)).toContain('Reinstall of Ubuntu 24.04 started')
  })
  // The reported bug: an OS *name* went through Number() -> NaN -> JSON `oid: null`, the
  // backend threw invalid_os, and production error-masking turned that into a null result
  // the CLI reported as success — so nothing was reinstalled and --watch hung forever.
  test('reinstall accepts an OS name (not just an id) and resolves it to oid', async () => {
    const h = harness({ data: { productSet: { id: 1, ret: 'ok' }, productOS: OS_CATALOG } })
    expect(await exec(h, 'set', '1', 'reinstall', 'Ubuntu 24.04', '--yes')).toBe(0)
    expect(callOf(h, 'productSet').vars).toEqual({ inp: { id: 1, cmd: 'REINSTALL', oid: 30, k8s: 'NONE' } })
  })
  // Only cloud products implement REINSTALL server-side; other types match no command and
  // answer without a `ret`, so the CLI must not claim the reinstall silently succeeded.
  test('reinstall warns when the server does not acknowledge it (no ret)', async () => {
    const h = harness({ data: { productSet: { id: 1 }, productOS: OS_CATALOG } })
    expect(await exec(h, 'set', '1', 'reinstall', '30', '--yes')).toBe(0)
    expect(errStr(h)).toContain('did not acknowledge the reinstall')
  })
  test('reinstall does not warn when the server answers ret', async () => {
    const h = harness({ data: { productSet: { id: 1, ret: 'OK' }, productOS: OS_CATALOG } })
    expect(await exec(h, 'set', '1', 'reinstall', '30', '--yes')).toBe(0)
    expect(errStr(h)).not.toContain('did not acknowledge')
  })
  test('reinstall with an unknown OS fails before productSet is called', async () => {
    const h = harness({ data: { productSet: { id: 1 }, productOS: OS_CATALOG } })
    expect(await exec(h, 'set', '1', 'reinstall', 'Plan9', '--yes')).toBe(1)
    expect(errStr(h)).toContain('No OS matches "Plan9"')
    expect(called(h, 'productSet')).toBe(false)
  })
  // A multi-word OS name is not a single substring of anything in the catalog; it only
  // resolves once each word is matched independently.
  const WIN_CATALOG = [
    { id: 56, name: 'Windows Server 2022 EN (Datacenter)' },
    { id: 64, name: 'Windows Server 2022 EN (Standard)' },
    { id: 65, name: 'Windows Server 2022 RU (Standard)' },
    { id: 62, name: 'Windows Server 2019 EN (Standard)' },
  ]
  test('reinstall resolves a multi-word OS name with an abbreviation', async () => {
    const h = harness({ data: { productSet: { id: 1, ret: 'OK' }, productOS: WIN_CATALOG } })
    expect(await exec(h, 'set', '1', 'reinstall', 'Windows 2022 EN Std', '--yes')).toBe(0)
    expect(callOf(h, 'productSet').vars.inp.oid).toBe(64)
    expect(errStr(h)).toContain('Matched OS "Windows Server 2022 EN (Standard)" (id 64)')
  })
  test('an ambiguous OS name errors and lists the candidates instead of guessing', async () => {
    const h = harness({ data: { productSet: { id: 1 }, productOS: WIN_CATALOG } })
    expect(await exec(h, 'set', '1', 'reinstall', 'Windows 2022', '--yes')).toBe(1)
    expect(errStr(h)).toContain('matches multiple OSes')
    expect(errStr(h)).toContain('Windows Server 2022 EN (Standard)')
    expect(called(h, 'productSet')).toBe(false)
  })
  test('reinstall --yes --watch chains straight into watching the same id', async () => {
    const h = harness({
      data: { productSet: { id: 1, ret: 'ok' }, productOS: OS_CATALOG },
      subscribe: (_q, hs) => {
        queueMicrotask(() => hs.onNext({ productSub: { id: 1, progress: 100, ret: 'ok' } }))
        return () => {}
      },
    })
    expect(await exec(h, 'set', '1', 'reinstall', '30', '--yes', '--watch')).toBe(0)
    expect(errStr(h)).toContain('Watching product 1')
    expect(errStr(h)).toContain('done')
  })
  test('reinstall requires an os id', async () => {
    const h = harness({ data: {} })
    expect(await exec(h, 'set', '1', 'reinstall')).toBe(1)
    expect(errStr(h)).toContain('Usage: dcxv set <id> reinstall')
  })
  test('"dcxv order <id> ..." and "dcxv product <id> ..." are no longer supported', async () => {
    const order = harness({ data: {} })
    expect(await exec(order, 'order', '1', 'ips')).toBe(1)
    expect(errStr(order)).toContain('Did you mean "dcxv get 1 ..." or "dcxv set 1 ..."')

    const product = harness({ data: {} })
    expect(await exec(product, 'product', '1', 'ips')).toBe(1)
    expect(errStr(product)).toContain('Unknown command')
  })
})

describe('os', () => {
  const oses = { productOS: [{ id: 1, name: 'Ubuntu 24.04' }, { id: 2, name: 'Debian 12' }, { id: 3, name: 'CentOS 7 (EOL)' }] }
  test('lists available OS images, filtering EOL entries', async () => {
    const h = harness({ data: oses })
    await exec(h, 'os')
    expect(outStr(h)).toContain('Ubuntu 24.04')
    expect(outStr(h)).toContain('Debian 12')
    expect(outStr(h)).not.toContain('CentOS 7')
  })
  test('filter argument is a case-insensitive substring match', async () => {
    const h = harness({ data: oses })
    await exec(h, 'os', 'ubuntu')
    const out = outStr(h)
    expect(out).toContain('Ubuntu 24.04')
    expect(out).not.toContain('Debian 12')
  })
  test('filter with no matches -> empty table, exit 0', async () => {
    const h = harness({ data: oses })
    expect(await exec(h, 'os', 'nonexistent')).toBe(0)
    expect(outStr(h)).toContain('(none)')
  })

  // Real catalog shape: long multi-part names where one substring can never be enough.
  const WIN = {
    productOS: [
      { id: 54, name: 'Windows Server 2019 EN (Datacenter)' },
      { id: 56, name: 'Windows Server 2022 EN (Datacenter)' },
      { id: 57, name: 'Windows Server 2022 RU (Datacenter)' },
      { id: 62, name: 'Windows Server 2019 EN (Standard)' },
      { id: 64, name: 'Windows Server 2022 EN (Standard)' },
      { id: 65, name: 'Windows Server 2022 RU (Standard)' },
      { id: 30, name: 'Ubuntu 24.04' },
    ],
  }
  test('every extra filter word narrows the list', async () => {
    const all = harness({ data: WIN })
    await exec(all, 'os', 'windows')
    expect(outStr(all)).toContain('2019')

    const h = harness({ data: WIN })
    expect(await exec(h, 'os', 'windows', '2022')).toBe(0)
    const out = outStr(h)
    expect(out).not.toContain('2019')
    expect(out).not.toContain('Ubuntu')
    expect(out).toContain('Windows Server 2022 EN (Datacenter)')
    expect(out).toContain('Windows Server 2022 RU (Standard)')
  })
  test('words inside one quoted argument filter the same as separate words', async () => {
    const a = harness({ data: WIN }); await exec(a, 'os', 'windows 2022 en')
    const b = harness({ data: WIN }); await exec(b, 'os', 'windows', '2022', 'en')
    expect(outStr(a)).toBe(outStr(b))
    expect(outStr(a)).not.toContain('RU')
  })
  test('abbreviations fall back to word-abbreviation matching, flagged as inexact', async () => {
    const h = harness({ data: WIN })
    expect(await exec(h, 'os', 'windows', '2022', 'en', 'std')).toBe(0)
    expect(outStr(h)).toContain('Windows Server 2022 EN (Standard)')
    expect(outStr(h)).not.toContain('Datacenter')
    expect(errStr(h)).toContain('closest names')
  })
  // "2022" is an in-order subsequence of "2012r2" (2,0,2,2), so version numbers must never
  // be treated as abbreviations — only alphabetic words are.
  test('version numbers are matched literally, never abbreviated', async () => {
    const h = harness({
      data: { productOS: [
        { id: 58, name: 'Windows Server 2012r2 EN (Standard)' },
        { id: 64, name: 'Windows Server 2022 EN (Standard)' },
      ] },
    })
    expect(await exec(h, 'os', 'windows', '2022', 'std')).toBe(0)
    expect(outStr(h)).toContain('Windows Server 2022 EN (Standard)')
    expect(outStr(h)).not.toContain('2012r2')
  })
  // A short token must not match inside an unrelated word ("en" in "Datac-en-ter").
  test('a word token does not match inside a longer word', async () => {
    const h = harness({
      data: { productOS: [
        { id: 56, name: 'Windows Server 2022 EN (Datacenter)' },
        { id: 57, name: 'Windows Server 2022 RU (Datacenter)' },
      ] },
    })
    expect(await exec(h, 'os', 'windows', 'en')).toBe(0)
    expect(outStr(h)).toContain('EN (Datacenter)')
    expect(outStr(h)).not.toContain('RU')
  })
})

describe('pay', () => {
  const acct = { rest: 0, sign: '$', can_pay: ['usdt'] }
  test('no method -> shows methods', async () => {
    const h = harness({ data: { userMy: { ...acct, can_pay: ['usdt', 'stripe'] } } })
    await exec(h, 'pay')
    expect(outStr(h)).toContain('usdt, stripe')
    expect(called(h, 'userPay')).toBe(false)
  })
  test('invalid method -> exit 1, no userPay', async () => {
    const h = harness({ data: { userMy: acct } })
    expect(await exec(h, 'pay', 'stripe', '10')).toBe(1)
    expect(errStr(h)).toContain('not accepted')
    expect(called(h, 'userPay')).toBe(false)
  })
  test('bad amount -> exit 1, no userPay', async () => {
    const zero = harness({ data: { userMy: acct } })
    expect(await exec(zero, 'pay', 'usdt', '0')).toBe(1)
    expect(called(zero, 'userPay')).toBe(false)
    const nan = harness({ data: { userMy: acct } })
    expect(await exec(nan, 'pay', 'usdt', 'abc')).toBe(1)
    expect(errStr(nan)).toContain('Amount must be')
    expect(called(nan, 'userPay')).toBe(false)
  })
  test('happy path -> userPay then userTransId, prints link', async () => {
    const h = harness({ data: { userMy: acct, userPay: 55, userTransId: { id: 55, url: 'http://pay/55' } } })
    expect(await exec(h, 'pay', 'usdt', '10')).toBe(0)
    expect(callOf(h, 'userPay').vars).toEqual({ inp: { reason: 'usdt', amount: 10 } })
    expect(callOf(h, 'userTransId').vars).toEqual({ id: 55 })
    expect(outStr(h)).toContain('Payment #55')
    expect(outStr(h)).toContain('http://pay/55')
  })
  test('userPay returns 0 -> exit 1, no tx lookup', async () => {
    const h = harness({ data: { userMy: acct, userPay: 0 } })
    expect(await exec(h, 'pay', 'usdt', '10')).toBe(1)
    expect(errStr(h)).toContain('could not be created')
    expect(called(h, 'userTransId')).toBe(false)
  })
})

describe('transactions / tx', () => {
  test('transactions table', async () => {
    const h = harness({ data: { userTrans: [{ id: 1, dt: 0, reason: 'topup', info: '', delta: 5, rest: 5, invoice: '' }] } })
    await exec(h, 'transactions')
    expect(outStr(h)).toContain('topup')
  })
  test('history alias + empty', async () => {
    const h = harness({ data: { userTrans: [] } })
    await exec(h, 'history')
    expect(outStr(h)).toContain('(none)')
  })
  test('bare tx (no id) lists transactions', async () => {
    const h = harness({ data: { userTrans: [{ id: 1, dt: 0, reason: 'topup', info: '', delta: 5, rest: 5, invoice: '' }] } })
    await exec(h, 'tx')
    expect(outStr(h)).toContain('topup')
  })
  test('tx found', async () => {
    const h = harness({ data: { userTransId: { id: 3, dt: 0, url: 'u' } } })
    await exec(h, 'tx', '3')
    expect(outStr(h)).toContain('Transaction 3')
  })
  test('tx not found -> exit 1', async () => {
    const h = harness({ data: { userTransId: null } })
    expect(await exec(h, 'tx', '3')).toBe(1)
    expect(errStr(h)).toContain('not found')
  })
  test('tx <id> invoice (no outfile) prints the PDF url, no userTransId read', async () => {
    const h = harness({ data: { userTransIdInvoice: { id: 3, pdf_url: 'https://dcxv.com/inv/3.pdf' } } })
    expect(await exec(h, 'tx', '3', 'invoice')).toBe(0)
    expect(callOf(h, 'userTransIdInvoice').vars).toEqual({ id: 3 })
    expect(called(h, 'userTransId')).toBe(false)
    expect(outStr(h)).toContain('https://dcxv.com/inv/3.pdf')
  })
  test('tx <id> invoice --json emits the raw invoice', async () => {
    const h = harness({ data: { userTransIdInvoice: { id: 3, pdf_url: 'https://dcxv.com/inv/3.pdf' } } })
    await exec(h, 'tx', '3', 'invoice', '--json')
    expect(JSON.parse(outStr(h)).pdf_url).toBe('https://dcxv.com/inv/3.pdf')
  })
  test('tx <id> invoice with no pdf_url -> exit 1', async () => {
    const h = harness({ data: { userTransIdInvoice: { id: 3, pdf_url: null } } })
    expect(await exec(h, 'tx', '3', 'invoice')).toBe(1)
    expect(errStr(h)).toContain('No invoice available')
  })
})

describe('sub-accounts', () => {
  test('ls table', async () => {
    const h = harness({ data: { userSubAccounts: [{ id: 2, email: 's@x', fname: 'S', rest: 0, servers: [] }] } })
    await exec(h, 'sub', 'ls')
    expect(outStr(h)).toContain('s@x')
  })
  test('add', async () => {
    const h = harness({ data: { userSubAdd: { id: 3, email: 'n@x' } } })
    await exec(h, 'sub', 'add', 'n@x', 'Name')
    expect(callOf(h, 'userSubAdd').vars).toEqual({ email: 'n@x', fname: 'Name' })
    expect(outStr(h)).toContain('Created sub-account 3')
  })
  test('login stores subToken', async () => {
    const h = harness({ data: { userSubLogin: { id: 2, email: 's@x', token: 'SUBTOK' } } })
    expect(await exec(h, 'sub', 'login', '2')).toBe(0)
    expect(h.saved.some(s => s.patch.subToken === 'SUBTOK')).toBe(true)
    expect(outStr(h)).toContain('Switched into')
  })
  test('login failure does not store token', async () => {
    const h = harness({ data: { userSubLogin: { err: 'denied' } } })
    expect(await exec(h, 'sub', 'login', '2')).toBe(1)
    expect(h.saved).toHaveLength(0)
  })
  test('exit clears subToken', async () => {
    const h = harness({ data: { userSubExit: {} } })
    expect(await exec(h, 'sub', 'exit')).toBe(0)
    expect(h.saved[0].patch.subToken).toBeNull()
    expect(outStr(h)).toContain('Returned')
  })
})

// api-my masks resolver exceptions in production by returning null for the whole field,
// and productSet returns null outright for a locked product. Null therefore always means
// "the action did not happen" — the CLI used to print its green success line anyway.
describe('null mutation result is a failure, not a success', () => {
  test('productSet null -> exit 1, no success message', async () => {
    const h = harness({ data: { productSet: null } })
    expect(await exec(h, 'set', '1', 'renew')).toBe(1)
    expect(errStr(h)).toContain('server returned no result')
    expect(outStr(h)).not.toContain('Renewal requested')
  })
  test('reinstall with a null result does not claim it started', async () => {
    const h = harness({ data: { productSet: null, productOS: [{ id: 30, name: 'Ubuntu 24.04' }] } })
    expect(await exec(h, 'set', '1', 'reinstall', 'Ubuntu 24.04', '--yes')).toBe(1)
    expect(outStr(h)).not.toContain('started')
  })
  test('userMod null -> exit 1', async () => {
    const h = harness({ data: { userMod: null } })
    expect(await exec(h, 'account', 'set', 'org', 'Acme')).toBe(1)
    expect(errStr(h)).toContain('Update failed')
  })
  test('password null -> exit 1', async () => {
    const h = harness({ data: { productSet: null } })
    expect(await exec(h, 'set', '1', 'password')).toBe(1)
    expect(outStr(h)).not.toContain('Password set')
  })
  test('userSubAdd null -> exit 1', async () => {
    const h = harness({ data: { userSubAdd: null } })
    expect(await exec(h, 'sub', 'add', 'a@b.c', 'Ann')).toBe(1)
    expect(errStr(h)).toContain('Sub-account create failed')
  })
  test('--json still prints the null payload, but exits 1', async () => {
    const h = harness({ data: { productSet: null } })
    expect(await exec(h, 'set', '1', 'renew', '--json')).toBe(1)
    expect(outStr(h)).toContain('null')
  })
})

describe('watch', () => {
  // Progress is push-only, so a watcher attaching between emits (or to an idle product)
  // used to show nothing at all, with no way to tell "nothing running" from "broken".
  test('primes the display from the productMon snapshot (--json)', async () => {
    const h = harness({
      data: { productMon: { id: 1, progress: '55%|cloudinit' } },
      subscribe: (_q, hs) => { setTimeout(() => hs.onComplete(), 15); return () => {} },
    })
    expect(await exec(h, 'watch', '1', '--json')).toBe(0)
    expect(callOf(h, 'productMon').vars).toEqual({ id: 1 })
    expect(outStr(h)).toContain('55%|cloudinit')
  })
  test('says so when the snapshot confirms nothing is running', async () => {
    process.env.DCXV_WATCH_IDLE_SEC = '0.01'
    try {
      const h = harness({
        data: { productMon: { id: 1, progress: '', stat: null } },
        subscribe: (_q, hs) => { setTimeout(() => hs.onComplete(), 60); return () => {} },
      })
      expect(await exec(h, 'watch', '1')).toBe(0)
      expect(errStr(h)).toContain('No task currently running on 1')
    } finally { delete process.env.DCXV_WATCH_IDLE_SEC }
  })
  test('a live event cancels the idle notice', async () => {
    process.env.DCXV_WATCH_IDLE_SEC = '0.01'
    try {
      const h = harness({
        data: { productMon: { id: 1, progress: '' } },
        subscribe: (_q, hs) => {
          queueMicrotask(() => hs.onNext({ productSub: { id: 1, progress: 100, ret: 'ok' } }))
          return () => {}
        },
      })
      expect(await exec(h, 'watch', '1')).toBe(0)
      expect(errStr(h)).not.toContain('No task currently running')
      expect(errStr(h)).toContain('done')
    } finally { delete process.env.DCXV_WATCH_IDLE_SEC }
  })
  // dispose() makes the transport fire `complete`; if that resolved the watch promise the
  // process exited before onDone finished, silently dropping `order --watch`'s Access block.
  test('an async onDone runs to completion before watch resolves', async () => {
    // Driven through `order --yes --watch`, whose onDone re-reads the product: the Access
    // block prints only if the watch promise waited for that async work.
    const slow = (v) => () => new Promise(r => setTimeout(() => r(v), 10))
    const o = harness({
      data: {
        productCalcPrice: { ok: true, price: 10 },
        productOrder: { id: 1, type: 'cloud', hostname: 'h', os: 'Ubuntu', price: 10 },
        // onDone's re-read must take longer than a microtask, or the race this guards
        // against cannot happen in-harness and the test would pass either way.
        productId: slow({ id: 1, installed: 1, ip: '1.2.3.4', login: 'root', pass: 'p', type: 'cloud', os: 'Ubuntu' }),
        productMon: slow({ id: 1, progress: '' }),
      },
      subscribe: (_q, hs) => {
        queueMicrotask(() => {
          hs.onNext({ productSub: { id: 1, progress: 100, ret: 'ok' } })
          hs.onComplete()
        })
        return () => {}
      },
    })
    expect(await exec(o, 'order', '--vcpu', '4', '--ram', '8', '--disk', '80', '--ip', '1', '--yes', '--watch')).toBe(0)
    expect(outStr(o)).toContain('Access')
    expect(outStr(o)).toContain('ssh root@1.2.3.4')
  })
  test('a failing snapshot never breaks the stream', async () => {
    const h = harness({
      data: { productMon: new Error('boom') },
      subscribe: (_q, hs) => {
        queueMicrotask(() => hs.onNext({ productSub: { id: 1, progress: 100, ret: 'ok' } }))
        return () => {}
      },
    })
    expect(await exec(h, 'watch', '1')).toBe(0)
    expect(errStr(h)).toContain('done')
  })
  test('filtered watch resolves on completion', async () => {
    const h = harness({
      subscribe: (_q, hs) => {
        queueMicrotask(() => hs.onNext({ productSub: { id: 1, progress: 100, ret: 'ok' } }))
        return () => {}
      },
    })
    expect(await exec(h, 'watch', '1')).toBe(0)
    expect(errStr(h)).toContain('done')
  })
  test('resolves on "100%|stage" string progress (real backend format)', async () => {
    // progressBar writes straight to process.stderr (not the injected io), so this
    // only asserts the completion/resolve path recognizes the "NN%|stage" format
    // (see parseProgress tests in format.test.js for the parsing itself).
    const h = harness({
      subscribe: (_q, hs) => {
        queueMicrotask(() => hs.onNext({ productSub: { id: 1, progress: '90%|booting' } }))
        queueMicrotask(() => hs.onNext({ productSub: { id: 1, progress: '100%|done' } }))
        return () => {}
      },
    })
    expect(await exec(h, 'watch', '1')).toBe(0)
    expect(errStr(h)).toContain('done')
  })
})
