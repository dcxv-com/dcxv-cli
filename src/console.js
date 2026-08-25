// `dcxv console <id>` — attach to a VM's Proxmox serial console (termproxy) from a
// terminal. This is a port of dcxv-www's browser client (src/lib/console/pve.js,
// TermConsole.svelte) onto a TTY: same capability-minting path (productSet cmd:'TERM'),
// same api-kvm gateway (/api/kvm/ -> 302 + cookies -> termproxy -> vncwebsocket), same
// wire framing. No api-my/api-kvm change is needed — the CLI just has to keep its own
// cookie jar instead of getting one for free from the browser's 302 handling.
//
// Everything except attachTerm() is a pure function so it can be unit-tested without a
// live socket. attachTerm() owns the raw-TTY bridge and is the one place process-level
// side effects happen.
import WebSocket from 'ws'
import { DcxvError } from './client.js'
import { M_PRODUCT_SET } from './queries.js'

export class ConsoleError extends DcxvError {}

// api-kvm's Set-Cookie headers (cs = the signed node|vmid capability, ks = an opaque
// handle into its session vault) -> a Cookie request header value. Keep values exactly
// as sent — api-kvm's readCookie() compares raw strings, so touching them would break
// the signature check on the other end. Take whatever it sends and forward it: the set
// has changed once already (it used to include the PVE ticket itself) and the empty
// Max-Age=0 scrub cookies it currently emits are harmless to carry.
export function parseSetCookie(list) {
  if (!list?.length) throw new ConsoleError('Console gateway did not set any session cookies (empty Set-Cookie).')
  let path = null
  const pairs = list.map(entry => {
    const parts = entry.split(';').map(p => p.trim())
    const pathAttr = parts.find(p => /^path=/i.test(p))
    if (pathAttr) path = pathAttr.slice(5)
    return parts[0]
  })
  return { jar: pairs.join('; '), path }
}

// '/de/my/orders/9/console?node=cc1&vmid=1313&type=term' -> { node, vmid, sid, type }
// Also accepts the unprefixed form ('/my/orders/9/console?...').
export function parseKvmLocation(loc) {
  if (!loc) throw new ConsoleError('Console gateway did not return a redirect Location.')
  const [pathname, qs] = loc.split('?')
  const m = pathname.match(/\/my\/orders\/(\d+)\/console\/?$/)
  const params = new URLSearchParams(qs || '')
  const node = params.get('node')
  const vmid = params.get('vmid')
  if (!m || !node || !vmid) {
    throw new ConsoleError(`Console gateway returned an unexpected redirect (${loc}).`)
  }
  return { sid: m[1], node, vmid, type: params.get('type') || 'term' }
}

// Proxmox termproxy/vncwebsocket frame protocol (Proxmox's own /xtermjs/main.js;
// mirrored in dcxv-www's TermConsole.svelte:20-32). `<len>` is the BYTE length of the
// data, not its character count — a multibyte character framed with its UTF-16/char
// length desynchronises the stream for everything that follows.
export const frameData = (buf) => `0:${buf.length}:${buf}`
export const frameResize = (cols, rows) => `1:${cols}:${rows}:`
export const FRAME_PING = '2'

// Step 1: mint the capability via productSet(cmd:'TERM'|'KVM') and build the api-kvm
// entry URL. Shared by the terminal flow below and `--vnc` (which just opens this URL
// in a browser — same entry point the panel uses, so cookie handling stays the browser's
// problem for that path).
export async function mintKvmUrl(client, { id, type = 'TERM' }) {
  const { productSet } = await client.request(M_PRODUCT_SET, { inp: { id, cmd: type } })
  if (productSet?.err) throw new ConsoleError(productSet.err)
  if (!productSet?.ret) throw new ConsoleError('Console unavailable — is the VM running? Try "dcxv set <id> power start".')
  return `${client.url}/api/kvm/?payload=${encodeURIComponent(productSet.ret)}`
}

// Step 1-2: mint the capability, then trade it for a session cookie jar + node/vmid at
// api-kvm's entry point. Returns everything termproxy needs. Throws ConsoleError with a
// user-facing message on every failure path.
export async function mintKvmSession(client, { id, type = 'TERM' }) {
  const url = await mintKvmUrl(client, { id, type })
  let res
  try {
    res = await fetch(url, { redirect: 'manual' })
  } catch (e) {
    throw new ConsoleError(`Could not reach the console gateway (network, or the node is down): ${e.message}`)
  }
  if (res.status === 403) {
    throw new ConsoleError('Console gateway refused the session token (expired, clock skew, or a gateway restart). Retry; if it persists, report it.')
  }
  if (res.status !== 302) {
    throw new ConsoleError(`Console gateway returned HTTP ${res.status} (expected a redirect).`)
  }

  const { jar, path } = parseSetCookie(res.headers.getSetCookie ? res.headers.getSetCookie() : splitSetCookie(res.headers))
  const loc = parseKvmLocation(res.headers.get('location'))
  // The cookie Path (Path=/api2/json/nodes/<node>/qemu/<vmid>) and the redirect's
  // node/vmid are minted from the same payload but travel separately — cross-check them
  // as a defence against a garbled/stale response before trusting either.
  if (path && !path.includes(`/qemu/${loc.vmid}`)) {
    throw new ConsoleError('Console gateway response is inconsistent (cookie scope does not match the target VM). Retry.')
  }
  return { node: loc.node, vmid: loc.vmid, sid: loc.sid, type: loc.type, jar, base: `/api2/json/nodes/${loc.node}/qemu/${loc.vmid}` }
}

// Fallback for a fetch() polyfill without Headers.getSetCookie() (Node < 19.7). Not
// expected to trigger given engines >= 20, but fails loudly rather than silently
// dropping cookies if it ever does.
function splitSetCookie(headers) {
  const raw = headers.get('set-cookie')
  if (!raw) return []
  throw new ConsoleError('This runtime\'s fetch() cannot report multiple Set-Cookie headers separately (Headers.getSetCookie is missing) — upgrade to Node >= 20.')
}

// Step 3: trade the session cookie for a one-shot termproxy ticket.
export async function termproxy({ url, base, jar }) {
  let res
  try {
    res = await fetch(`${url}${base}/termproxy`, {
      method: 'POST',
      headers: { Cookie: jar, 'Content-Type': 'application/x-www-form-urlencoded' },
    })
  } catch (e) {
    throw new ConsoleError(`Could not reach the console gateway (network, or the node is down): ${e.message}`)
  }
  if (res.status === 401) {
    throw new ConsoleError('Proxmox session expired (tickets last ~2h). Run the command again.')
  }
  if (res.status === 500 || res.status === 501) {
    throw new ConsoleError('This guest has no serial console. Windows VMs must use the graphical console: "dcxv console <id> --vnc".')
  }
  if (!res.ok) {
    throw new ConsoleError(`Console gateway returned HTTP ${res.status} from termproxy.`)
  }
  let json
  try {
    json = await res.json()
  } catch (e) {
    throw new ConsoleError(`Invalid response from termproxy: ${e.message}`)
  }
  const data = json?.data
  if (!data?.ticket || !data?.port || !data?.user) {
    throw new ConsoleError('termproxy did not return a ticket/port/user.')
  }
  return data
}

// wss URL for vncwebsocket. Query-param form is deliberate: api-kvm's checkACL keys off
// the last path segment, so a path-form ".../vncwebsocket/port/5900" is denied.
export function wsUrl(url, base, port, ticket) {
  const host = url.replace(/^https?:\/\//, '')
  return `wss://${host}${base}/vncwebsocket?port=${port}&vncticket=${encodeURIComponent(ticket)}`
}

// Step 4: open the websocket, do the termproxy handshake, and bridge it to a TTY.
// Resolves with an exit reason string once the session ends (detach key, socket close,
// or an unrecoverable error) — never rejects for a clean detach, so the caller doesn't
// have to distinguish "user pressed Ctrl-]" from a real failure.
export function attachTerm({ wsUrl: target, jar, user, ticket, stdin, stdout, io }) {
  return new Promise((resolve, reject) => {
    // TLS is verified here, like every other leg of this flow. This socket carries the
    // api-kvm cookie jar (cs = the signed node|vmid capability, ks = the session handle)
    // and the one-shot termproxy ticket sent on open below — and it goes to the SAME host
    // mintKvmSession() and termproxy() already reached with a plain fetch(). Those verify
    // and work, so there was never a certificate this had to tolerate; the flag that used
    // to sit here (`rejectUnauthorized: false`) was inconsistency, not a design choice.
    // Do not add it back: the host is pinned to https://dcxv.com (config.js), so a
    // certificate that fails to verify on this path can only be someone else's.
    const socket = new WebSocket(target, 'binary', { headers: { cookie: jar } })
    let connected = false
    let done = false
    let ping = null
    let resizeTimer = null

    const sendResize = () => {
      if (connected && socket.readyState === WebSocket.OPEN) {
        socket.send(frameResize(stdout.columns || 80, stdout.rows || 24))
      }
    }
    const onResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(sendResize, 100)
    }
    const onStdin = (chunk) => {
      // Ctrl-] (0x1d) detaches locally; Ctrl-C/D/Z are NOT intercepted here (raw mode
      // already suppresses SIGINT generation) so they reach the guest, which is the
      // whole point of an interactive console.
      const idx = chunk.indexOf(0x1d)
      if (idx !== -1) {
        if (idx > 0 && connected) socket.send(frameData(chunk.subarray(0, idx)))
        finish('detached')
        return
      }
      if (connected && socket.readyState === WebSocket.OPEN) socket.send(frameData(chunk))
    }

    const finish = (reason, err) => {
      if (done) return
      done = true
      clearInterval(ping)
      clearTimeout(resizeTimer)
      stdin.removeListener('data', onStdin)
      process.removeListener('SIGWINCH', onResize)
      if (stdin.isTTY) stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\r\n')
      try { socket.terminate() } catch { /* already closed */ }
      if (err) reject(err); else resolve(reason)
    }

    socket.on('open', () => {
      socket.send(`${user}:${ticket}\n`)
    })

    socket.on('message', (data) => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (connected) { stdout.write(bytes); return }
      if (bytes[0] === 0x4f && bytes[1] === 0x4b) { // "OK"
        connected = true
        stdout.write(bytes.subarray(2))
        if (stdin.isTTY) stdin.setRawMode(true)
        stdin.resume()
        stdin.on('data', onStdin)
        process.on('SIGWINCH', onResize)
        sendResize()
        ping = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(FRAME_PING)
        }, 30_000)
      } else {
        finish(null, new ConsoleError('Proxmox rejected the terminal credentials.'))
      }
    })

    socket.on('close', () => finish(connected ? 'closed' : null, connected ? null : new ConsoleError('Console gateway closed the connection before authenticating.')))
    socket.on('error', (e) => finish(null, new ConsoleError(`Console connection error: ${e.message}`)))
  })
}

// Full end-to-end flow used by cli.js's `console` handler.
export async function openConsole(client, { id, io, stdin, stdout }) {
  const session = await mintKvmSession(client, { id, type: 'TERM' })
  const { ticket, port, user } = await termproxy({ url: client.url, base: session.base, jar: session.jar })
  // A serial getty (agetty on ttyS0/serial0) doesn't print its login banner until it
  // sees a byte come in — it has no way to know a terminal is attached until then. A
  // freshly-attached session that shows nothing is normal, not stuck; confirmed live
  // (against this same test path) that pressing Enter immediately produces the prompt.
  io.err(`Attached to console for #${id} (node ${session.node}, vmid ${session.vmid}). Detach with Ctrl-].`)
  io.err('If the screen stays blank, press Enter — the guest\'s console often waits for input before printing anything.')
  return attachTerm({ wsUrl: wsUrl(client.url, session.base, port, ticket), jar: session.jar, user, ticket, stdin, stdout, io })
}
