import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { WebSocketServer } from 'ws'
import { PassThrough } from 'node:stream'
import {
  parseSetCookie, parseKvmLocation, frameData, frameResize, FRAME_PING,
  mintKvmUrl, mintKvmSession, termproxy, wsUrl, attachTerm,
} from '../src/console.js'
import { DcxvError } from '../src/client.js'

let originalFetch
beforeEach(() => { originalFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = originalFetch })

describe('frameData / frameResize', () => {
  test('frames use BYTE length, not character count', () => {
    expect(frameData(Buffer.from('é', 'utf8'))).toBe('0:2:é')
    expect(frameData(Buffer.from('日本', 'utf8'))).toBe('0:6:日本')
    expect(frameData(Buffer.from('🚀', 'utf8'))).toBe('0:4:🚀')
    expect(frameData(Buffer.from('hi', 'utf8'))).toBe('0:2:hi')
  })
  test('frameResize / FRAME_PING match the Proxmox wire protocol', () => {
    expect(frameResize(80, 24)).toBe('1:80:24:')
    expect(FRAME_PING).toBe('2')
  })
})

describe('parseSetCookie', () => {
  test('builds a jar preserving percent-encoding and extracts Path', () => {
    const { jar, path } = parseSetCookie([
      'PVEAuthCookie=PVE%3A...%3A%2Bsig==; Path=/api2/json/nodes/cc1/qemu/1313; HttpOnly; Secure; SameSite=Lax',
      'cs=1234.abcdef; Path=/api2/json/nodes/cc1/qemu/1313; HttpOnly; Secure; SameSite=Lax',
      'pvecsrf=TOKEN; Path=/api2/json/nodes/cc1/qemu/1313; HttpOnly; Secure; SameSite=Lax',
    ])
    expect(jar).toBe('PVEAuthCookie=PVE%3A...%3A%2Bsig==; cs=1234.abcdef; pvecsrf=TOKEN')
    expect(path).toBe('/api2/json/nodes/cc1/qemu/1313')
  })
  test('throws on an empty Set-Cookie list', () => {
    expect(() => parseSetCookie([])).toThrow(DcxvError)
  })
})

describe('parseKvmLocation', () => {
  test('parses the unprefixed console redirect', () => {
    expect(parseKvmLocation('/my/orders/9/console?node=cc1&vmid=1313&type=term'))
      .toEqual({ sid: '9', node: 'cc1', vmid: '1313', type: 'term' })
  })
  test('parses a language-prefixed console redirect', () => {
    expect(parseKvmLocation('/uk/my/orders/9/console?node=cc1&vmid=1313&type=novnc'))
      .toEqual({ sid: '9', node: 'cc1', vmid: '1313', type: 'novnc' })
  })
  test('defaults type to term when omitted', () => {
    expect(parseKvmLocation('/my/orders/9/console?node=cc1&vmid=1313').type).toBe('term')
  })
  test('rejects a missing node', () => {
    expect(() => parseKvmLocation('/my/orders/9/console?vmid=1313')).toThrow(DcxvError)
  })
  test('rejects an empty Location', () => {
    expect(() => parseKvmLocation('')).toThrow(DcxvError)
  })
})

describe('wsUrl', () => {
  test('uses the query-param form, never a path segment', () => {
    const u = wsUrl('https://dcxv.com', '/api2/json/nodes/cc1/qemu/1313', 5901, 'PVEVNC:68A:+x/y==')
    expect(u).toBe('wss://dcxv.com/api2/json/nodes/cc1/qemu/1313/vncwebsocket?port=5901&vncticket=PVEVNC%3A68A%3A%2Bx%2Fy%3D%3D')
  })
})

const jsonRes = (status, data, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null, getSetCookie: () => headers['set-cookie'] || [] },
  json: async () => ({ data }),
})

describe('mintKvmUrl', () => {
  const client = { url: 'https://dcxv.com', request: async () => ({ productSet: { ret: 'B64PAYLOAD' } }) }
  test('builds the /api/kvm/ URL from productSet.ret', async () => {
    const url = await mintKvmUrl(client, { id: 1313, type: 'TERM' })
    expect(url).toBe('https://dcxv.com/api/kvm/?payload=B64PAYLOAD')
  })
  test('propagates productSet.err', async () => {
    const c = { url: 'https://dcxv.com', request: async () => ({ productSet: { err: 'not yours' } }) }
    expect(mintKvmUrl(c, { id: 1 })).rejects.toThrow('not yours')
  })
  test('errors when ret is empty (VM not running / not a cloud product)', async () => {
    const c = { url: 'https://dcxv.com', request: async () => ({ productSet: null }) }
    expect(mintKvmUrl(c, { id: 1 })).rejects.toThrow(/Console unavailable/)
  })
})

describe('mintKvmSession error mapping', () => {
  const client = { url: 'https://dcxv.com', request: async () => ({ productSet: { ret: 'B64PAYLOAD' } }) }
  test('403 -> gateway refused message', async () => {
    globalThis.fetch = async () => ({ status: 403, ok: false })
    await expect(mintKvmSession(client, { id: 1313 })).rejects.toThrow(/refused the session token/)
  })
  test('non-302 -> unexpected status message', async () => {
    globalThis.fetch = async () => ({ status: 500, ok: false })
    await expect(mintKvmSession(client, { id: 1313 })).rejects.toThrow(/HTTP 500/)
  })
  test('network failure -> could-not-reach message', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
    await expect(mintKvmSession(client, { id: 1313 })).rejects.toThrow(/Could not reach the console gateway/)
  })
  test('happy path returns node/vmid/jar/base', async () => {
    globalThis.fetch = async () => jsonRes(302, null, {
      location: '/my/orders/9/console?node=cc1&vmid=1313&type=term',
      'set-cookie': [
        'PVEAuthCookie=TICKET; Path=/api2/json/nodes/cc1/qemu/1313',
        'cs=1234.sig; Path=/api2/json/nodes/cc1/qemu/1313',
        'pvecsrf=CSRF; Path=/api2/json/nodes/cc1/qemu/1313',
      ],
    })
    const s = await mintKvmSession(client, { id: 1313 })
    expect(s).toEqual({
      node: 'cc1', vmid: '1313', sid: '9', type: 'term',
      jar: 'PVEAuthCookie=TICKET; cs=1234.sig; pvecsrf=CSRF',
      base: '/api2/json/nodes/cc1/qemu/1313',
    })
  })
})

describe('termproxy error mapping', () => {
  const args = { url: 'https://dcxv.com', base: '/api2/json/nodes/cc1/qemu/1313', jar: 'x=y' }
  test('401 -> session expired message', async () => {
    globalThis.fetch = async () => ({ status: 401, ok: false })
    await expect(termproxy(args)).rejects.toThrow(/session expired/)
  })
  test('500 -> no serial console / --vnc hint', async () => {
    globalThis.fetch = async () => ({ status: 500, ok: false })
    await expect(termproxy(args)).rejects.toThrow(/--vnc/)
  })
  test('happy path returns ticket/port/user', async () => {
    globalThis.fetch = async () => jsonRes(200, { ticket: 'PVEVNC:x', port: 5901, user: 'root@pam' })
    const r = await termproxy(args)
    expect(r).toEqual({ ticket: 'PVEVNC:x', port: 5901, user: 'root@pam' })
  })
})

describe('attachTerm', () => {
  let wss, port
  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 })
    await new Promise((r) => wss.once('listening', r))
    port = wss.address().port
  })
  afterEach(() => wss.close())

  function fakeTty() {
    const stdin = new PassThrough()
    stdin.isTTY = true
    stdin.setRawMode = (v) => { stdin.rawMode = v }
    const stdout = new PassThrough()
    stdout.isTTY = true
    stdout.columns = 100
    stdout.rows = 30
    const written = []
    stdout.on('data', (b) => written.push(b))
    return { stdin, stdout, written: () => Buffer.concat(written).toString() }
  }

  test('handshake, OK-gated write-through, resize, ping, and Ctrl-] detach', async () => {
    let handshakeLine = null
    let sawResize = false
    let sawPing = false
    wss.on('connection', (sock) => {
      sock.once('message', (msg) => {
        handshakeLine = msg.toString()
        sock.send(Buffer.from('OKhello '))
        sock.on('message', (m) => {
          const s = m.toString()
          if (s.startsWith('1:')) sawResize = true
          else if (s === '2') sawPing = true
          else sock.send(Buffer.concat([Buffer.from('echo:'), m]))
        })
      })
    })

    const { stdin, stdout, written } = fakeTty()
    const donePromise = attachTerm({
      wsUrl: `ws://127.0.0.1:${port}`, jar: 'PVEAuthCookie=T', user: 'root@pam', ticket: 'TICK',
      stdin, stdout, io: { err: () => {} },
    })

    const waitFor = (pred, timeoutMs = 5000) => new Promise((resolve, reject) => {
      const start = Date.now()
      const t = setInterval(() => {
        if (pred()) { clearInterval(t); resolve() }
        else if (Date.now() - start > timeoutMs) { clearInterval(t); reject(new Error('timed out waiting for condition')) }
      }, 5)
    })

    // Wait for the OK handshake to land (stdout gets "hello " once connected).
    await waitFor(() => written().includes('hello '))
    expect(handshakeLine).toBe('root@pam:TICK\n')
    expect(stdin.rawMode).toBe(true)
    // The initial resize frame is sent right after OK, but it's a real network round
    // trip to the fake server (unlike the local stdout write above), so it needs its
    // own wait rather than being asserted the instant "hello " lands.
    await waitFor(() => sawResize)

    // Typed input round-trips through the "echo:" handler.
    stdin.write('ls\n')
    await waitFor(() => written().includes('echo:0:3:ls\n'))

    // Ctrl-] detaches locally and restores raw mode without the promise rejecting.
    stdin.write(Buffer.from([0x1d]))
    const reason = await donePromise
    expect(reason).toBe('detached')
    expect(stdin.rawMode).toBe(false)
  })

  test('a non-OK first frame rejects with a clear message', async () => {
    wss.on('connection', (sock) => sock.once('message', () => sock.send(Buffer.from('ERROR'))))
    const { stdin, stdout } = fakeTty()
    await expect(attachTerm({
      wsUrl: `ws://127.0.0.1:${port}`, jar: 'x=y', user: 'root@pam', ticket: 'BAD',
      stdin, stdout, io: { err: () => {} },
    })).rejects.toThrow(/rejected the terminal credentials/)
    expect(stdin.rawMode).toBe(false)
  })
})
