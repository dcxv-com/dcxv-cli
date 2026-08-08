// Best-effort "open a URL in the default browser" helper for `dcxv login`.
// Never throws — a headless session (SSH box, CI) just relies on the URL we
// already printed to stdout, matching `gh auth login`'s fallback behavior.
import { spawn } from 'node:child_process'

const OPENERS = {
  darwin: 'open',
  win32: 'start',
  linux: 'xdg-open',
}

export function tryOpenBrowser(url) {
  const cmd = OPENERS[process.platform] || OPENERS.linux
  try {
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true })
      : spawn(cmd, [url], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // ignore — the caller already printed the URL
  }
}
