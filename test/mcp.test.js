import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { run } from '../src/cli.js'
import { runMcpServer } from '../src/mcp.js'
import * as Q from '../src/queries.js'

// Same op-name mapping cli.test.js uses, trimmed to what mcp.js's tools touch.
const NAME_BY_QUERY = new Map([
  [Q.Q_ACCOUNT, 'userMy'], [Q.Q_ACCOUNT_FULL, 'userMy'],
  [Q.Q_PRODUCTS, 'productMy'], [Q.M_PRODUCT_SET, 'productSet'],
  [Q.Q_PRODUCT_DETAIL, 'productId'], [Q.Q_PRODUCT_MON, 'productMon'],
  [Q.Q_PRODUCT_OS, 'productOS'], [Q.Q_CALC_PRICE_TABLE, 'calcPrice'],
  [Q.Q_TRANSACTIONS, 'userTrans'], [Q.M_PRODUCT_ORDER, 'productOrder'], [Q.Q_CALC_PRICE, 'productCalcPrice'],
])

function harness({ data = {}, token = 't' } = {}) {
  const calls = []
  const client = {
    request: async (query, vars) => {
      const name = NAME_BY_QUERY.get(query)
      if (!name) throw new Error('test: unmapped query string')
      calls.push({ name, vars })
      if (!(name in data) && name === 'productOS') return { productOS: [{ id: 26, name: 'Ubuntu 26.04' }] }
      if (!(name in data)) throw new Error(`test: unexpected op "${name}" (add it to fixtures)`)
      const v = data[name]
      if (v instanceof Error) throw v
      return { [name]: typeof v === 'function' ? await v(vars) : v }
    },
  }
  const config = {
    loadConfig: () => ({ token, url: 'https://dcxv.com', profile: 'default', source: token ? 'profile:default' : 'none', sub: false }),
  }
  // clientArgs records the { url, token } every tool call builds its client from - that
  // is the thing the argv-injection finding was ultimately about (a bearer sent to an
  // attacker-chosen host), so it has to be observable, not just the GraphQL ops.
  const clientArgs = []
  const deps = { config, makeClient: (a) => { clientArgs.push(a); return client }, stdout: () => {}, stderr: () => {} }
  return { deps, calls, clientArgs }
}

// Feeds canned JSON-RPC request lines through runMcpServer() and collects the response
// objects it writes - the same shape a real MCP client would send/receive over stdio.
async function callMcp(deps, flags, requests) {
  const responses = []
  const io = {
    out: (line) => responses.push(JSON.parse(line)),
    lines: async function* () { for (const r of requests) yield JSON.stringify(r) },
  }
  await runMcpServer(deps, flags, io)
  return responses
}

let realFetch
beforeEach(() => { realFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = realFetch })

describe('dcxv mcp — protocol basics', () => {
  test('initialize declares only the tools capability', async () => {
    const { deps } = harness()
    const [res] = await callMcp(deps, {}, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }])
    expect(res.result.capabilities).toEqual({ tools: {} })
    expect(res.result.serverInfo.name).toBe('dcxv')
  })

  test('notifications/initialized gets no response', async () => {
    const { deps } = harness()
    const responses = await callMcp(deps, {}, [{ jsonrpc: '2.0', method: 'notifications/initialized' }])
    expect(responses).toEqual([])
  })

  test('ping returns an empty result', async () => {
    const { deps } = harness()
    const [res] = await callMcp(deps, {}, [{ jsonrpc: '2.0', id: 5, method: 'ping' }])
    expect(res.result).toEqual({})
  })

  test('an unknown method is a JSON-RPC method-not-found error', async () => {
    const { deps } = harness()
    const [res] = await callMcp(deps, {}, [{ jsonrpc: '2.0', id: 1, method: 'nope' }])
    expect(res.error.code).toBe(-32601)
  })

  test('malformed JSON on a line is a parse error, and does not crash the loop', async () => {
    const { deps } = harness()
    const responses = []
    const io = {
      out: (line) => responses.push(JSON.parse(line)),
      lines: async function* () { yield 'not json'; yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) },
    }
    await runMcpServer(deps, {}, io)
    expect(responses[0].error.code).toBe(-32700)
    expect(responses[1].result).toEqual({})
  })
})

describe('dcxv mcp — tool tiers', () => {
  test('default tools/list has only public + read-only tools', async () => {
    const { deps } = harness()
    const [res] = await callMcp(deps, {}, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
    const names = res.result.tools.map((t) => t.name)
    expect(names).toContain('search_products')
    expect(names).toContain('whoami')
    expect(names).not.toContain('set_power')
    expect(names).not.toContain('create_order')
  })

  test('--allow-write adds the write tier, not billing', async () => {
    const { deps } = harness()
    const [res] = await callMcp(deps, { allowWrite: true }, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
    const names = res.result.tools.map((t) => t.name)
    expect(names).toContain('set_power')
    expect(names).not.toContain('create_order')
  })

  test('--allow-billing WITHOUT the env var does not add billing tools', async () => {
    delete process.env.DCXV_MCP_ALLOW_BILLING
    const { deps } = harness()
    const [res] = await callMcp(deps, { allowWrite: true, allowBilling: true }, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
    expect(res.result.tools.map((t) => t.name)).not.toContain('create_order')
  })

  test('--allow-billing WITH the env var adds billing tools', async () => {
    process.env.DCXV_MCP_ALLOW_BILLING = '1'
    const { deps } = harness()
    const [res] = await callMcp(deps, { allowWrite: true, allowBilling: true }, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
    expect(res.result.tools.map((t) => t.name)).toContain('create_order')
    expect(res.result.tools.map((t) => t.name)).toContain('renew_order')
    delete process.env.DCXV_MCP_ALLOW_BILLING
  })

  test('rm/pay/account-set/account-export/sub-login/watch never appear, at any flag combination', async () => {
    process.env.DCXV_MCP_ALLOW_BILLING = '1'
    const { deps } = harness()
    const [res] = await callMcp(deps, { allowWrite: true, allowBilling: true }, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
    const names = res.result.tools.map((t) => t.name)
    for (const forbidden of ['rm', 'pay', 'account_set', 'account_export', 'sub_login', 'watch']) {
      expect(names).not.toContain(forbidden)
    }
    delete process.env.DCXV_MCP_ALLOW_BILLING
  })
})

describe('dcxv mcp — public tools (no login required)', () => {
  test('search_products fetches the public catalog, not GraphQL', async () => {
    globalThis.fetch = async (url) => {
      expect(String(url)).toBe('https://dcxv.com/catalog.json')
      return { ok: true, json: async () => ({ products: [{ name: 'Cloud Server', category: 'Cloud VPS', description: '' }] }) }
    }
    const { deps, calls } = harness({ token: '' }) // no login at all
    const [res] = await callMcp(deps, {}, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_products', arguments: {} } }])
    expect(res.result.isError).toBeUndefined()
    expect(JSON.parse(res.result.content[0].text)[0].name).toBe('Cloud Server')
    expect(calls.length).toBe(0) // no GraphQL call made at all
  })

  test('get_product 404s cleanly as an MCP tool error, not a crash', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404 })
    const { deps } = harness({ token: '' })
    const [res] = await callMcp(deps, {}, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_product', arguments: { id: 'nope' } } }])
    expect(res.result.isError).toBe(true)
  })
})

describe('dcxv mcp — authenticated tools', () => {
  test('an authenticated tool with no token returns a clear error, not a crash', async () => {
    const { deps } = harness({ token: '' })
    const [res] = await callMcp(deps, {}, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }])
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toMatch(/not logged in/i)
  })

  test('whoami returns the account, driven through the same run() dispatch the CLI uses', async () => {
    const { deps, calls } = harness({ data: { userMy: { id: 1, fname: 'Ada', email: 'ada@example.com', rest: '10', sign: '€' } } })
    const [res] = await callMcp(deps, {}, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }])
    const body = JSON.parse(res.result.content[0].text)
    expect(body.email).toBe('ada@example.com')
    expect(calls[0].name).toBe('userMy')
  })

  test('a missing required argument is a clean local error, not a network call', async () => {
    const { deps, calls } = harness()
    const [res] = await callMcp(deps, {}, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_order', arguments: {} } }])
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toMatch(/missing required argument/i)
    expect(calls.length).toBe(0)
  })

  test('get_order action:kubeconfig returns the kubeconfig as structured JSON, not a parse error', async () => {
    // Regression: handleGet's kubeconfig case used to ignore --json entirely and always
    // write the raw YAML, which runJson() (always --json, always JSON.parse()s) turned
    // into a misleading "JSON Parse error: Unexpected identifier" for every MCP caller.
    const { deps } = harness({ data: { productId: { k8sKubeconfig: 'apiVersion: v1\nclusters: []\n' } } })
    const [res] = await callMcp(deps, {}, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_order', arguments: { id: '1', action: 'kubeconfig' } } },
    ])
    expect(res.result.isError).toBeUndefined()
    const body = JSON.parse(res.result.content[0].text)
    expect(body.kubeconfig).toContain('apiVersion: v1')
  })

  test('set_power is unavailable (and errors, not silently no-ops) without --allow-write', async () => {
    const { deps } = harness()
    const [res] = await callMcp(deps, {}, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_power', arguments: { id: '1', action: 'reboot' } } }])
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toMatch(/unknown tool/i)
  })

  test('set_power with --allow-write calls productSet with the RESET verb for reboot', async () => {
    const { deps, calls } = harness({ data: { productSet: { id: 1, err: null, ret: 'ok' } } })
    const [res] = await callMcp(deps, { allowWrite: true }, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_power', arguments: { id: '1', action: 'reboot' } } },
    ])
    expect(res.result.isError).toBeUndefined()
    expect(calls[0].name).toBe('productSet')
    expect(calls[0].vars.inp.cmd).toBe('RESET')
  })

  test('create_order without confirm:true only checks price, does not order', async () => {
    process.env.DCXV_MCP_ALLOW_BILLING = '1'
    const { deps, calls } = harness({
      data: {
        calcPrice: JSON.stringify([{ vid: 16, type: 'cloud', sell: true, cpu: 'Xeon E5 [Portugal]' }]),
        productOS: [{ id: 26, name: 'Ubuntu 24.04' }],
        productCalcPrice: { price: '15', ok: true, reason: null, promo: null },
      },
    })
    const [res] = await callMcp(deps, { allowWrite: true, allowBilling: true }, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_order', arguments: { cluster: '16', vcpu: '4', ram: '8', disk: '80', ip: '1', os: 'Ubuntu' } } },
    ])
    expect(res.result.isError).toBeUndefined()
    expect(calls.some((c) => c.name === 'productOrder')).toBe(false)
    expect(calls.some((c) => c.name === 'productCalcPrice')).toBe(true)
    delete process.env.DCXV_MCP_ALLOW_BILLING
  })
})

// The AUDIT H1 finding: model-supplied values went into argv as positionals, and
// cli.js's parse() (parseArgs with allowPositionals + strict:false) honors an option
// wherever it appears. So `id: "--url=https://attacker"` was not an id at all - it set
// the global --url flag, and dispatch() built the client against that host with the
// account's real bearer token.
describe('dcxv mcp — model arguments can never become flags', () => {
  const call = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

  test('the exploit itself: get_order id="--url=<attacker>" is refused before any request', async () => {
    const { deps, calls, clientArgs } = harness()
    const [res] = await callMcp(deps, {}, [call('get_order', { id: '--url=https://attacker.example', action: 'ips' })])
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toMatch(/invalid argument "id"/i)
    expect(calls.length).toBe(0)
    expect(clientArgs.length).toBe(0) // no client built at all, so no token anywhere
  })

  test('an id that is a bare boolean flag cannot shift the argv positions', async () => {
    // ['set','--json','power','start'] would have parsed as positionals
    // ['set','power','start'] - id becomes "power" and the action word slides over.
    const { deps, calls } = harness()
    const [res] = await callMcp(deps, { allowWrite: true }, [call('set_power', { id: '--json', action: 'start' })])
    expect(res.result.isError).toBe(true)
    expect(calls.length).toBe(0)
  })

  test('enum is enforced, not merely declared: set_power action cannot be a flag', async () => {
    const { deps, calls } = harness()
    const [res] = await callMcp(deps, { allowWrite: true }, [call('set_power', { id: '1', action: '--url=https://attacker.example' })])
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toMatch(/must be one of/i)
    expect(calls.length).toBe(0)
  })

  test('get_order action is enum-checked too', async () => {
    const { deps, calls } = harness()
    const [res] = await callMcp(deps, {}, [call('get_order', { id: '1', action: '--profile=other' })])
    expect(res.result.isError).toBe(true)
    expect(calls.length).toBe(0)
  })

  test('rename_order hostname cannot start with a dash', async () => {
    const { deps, calls } = harness()
    const [res] = await callMcp(deps, { allowWrite: true }, [call('rename_order', { id: '1', hostname: '--url=https://attacker.example' })])
    expect(res.result.isError).toBe(true)
    expect(calls.length).toBe(0)
  })

  test('create_order values are flag-bound, and a flag-shaped one is rejected outright', async () => {
    // Defence in depth: parseArgs consumes the token after --cluster as that flag's
    // value even when it looks like an option (so '--yes' could never have flipped the
    // price-check into a real charge), but the schema refuses it before that matters.
    process.env.DCXV_MCP_ALLOW_BILLING = '1'
    const { deps, calls } = harness()
    const [res] = await callMcp(deps, { allowWrite: true, allowBilling: true }, [
      call('create_order', { cluster: '--yes', vcpu: '4', ram: '8', disk: '80', ip: '1', os: 'Ubuntu' }),
    ])
    expect(res.result.isError).toBe(true)
    expect(calls.some((c) => c.name === 'productOrder')).toBe(false)
    delete process.env.DCXV_MCP_ALLOW_BILLING
  })

  test('confirm must be a real boolean, so a stringy "true" fails loudly instead of silently price-checking', async () => {
    process.env.DCXV_MCP_ALLOW_BILLING = '1'
    const { deps, calls } = harness()
    const [res] = await callMcp(deps, { allowWrite: true, allowBilling: true }, [
      call('create_order', { cluster: '16', vcpu: '4', ram: '8', disk: '80', ip: '1', os: 'Ubuntu', confirm: 'true' }),
    ])
    expect(res.result.isError).toBe(true)
    expect(calls.some((c) => c.name === 'productOrder')).toBe(false)
    delete process.env.DCXV_MCP_ALLOW_BILLING
  })

  test('the host is pinned to the one the server started against, on every tool call', async () => {
    const { deps, clientArgs } = harness({ data: { productId: { id: 123, hostname: 'web1' }, productMon: null } })
    const [res] = await callMcp(deps, {}, [call('get_order', { id: '123' })])
    expect(res.result.isError).toBeUndefined()
    expect(clientArgs.length).toBe(1)
    expect(clientArgs[0].url).toBe('https://dcxv.com')
    expect(clientArgs[0].token).toBe('t')
  })

  test('a numeric id is coerced, not rejected — the schema says string, agents send numbers', async () => {
    const { deps, calls } = harness({ data: { productId: { id: 123, hostname: 'web1' }, productMon: null } })
    const [res] = await callMcp(deps, {}, [call('get_order', { id: 123 })])
    expect(res.result.isError).toBeUndefined()
    expect(calls[0].vars.id).toBe(123)
  })

  test('legitimate values still reach the handler unchanged, after the -- separator', async () => {
    const { deps, calls } = harness({ data: { productSet: { id: 1, err: null, ret: 'ok' } } })
    const [res] = await callMcp(deps, { allowWrite: true }, [call('rename_order', { id: '1', hostname: 'web-1.example.com' })])
    expect(res.result.isError).toBeUndefined()
    expect(calls[0].name).toBe('productSet')
    expect(calls[0].vars.inp.hostname).toBe('web-1.example.com')
  })
})
