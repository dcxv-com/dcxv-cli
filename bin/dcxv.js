#!/usr/bin/env node
// DCXV CLI entrypoint — thin wrapper that wires real dependencies into the
// injectable core in src/cli.js. Runs on Bun or Node >= 18 (built-in fetch).
import { run } from '../src/cli.js'
import { makeClient } from '../src/client.js'
import * as config from '../src/config.js'

const deps = {
  config,
  makeClient,
  stdout: (line) => process.stdout.write(line + '\n'),
  stderr: (line) => process.stderr.write(line + '\n'),
}

// setImmediate defers the hard exit by one event-loop tick so libuv finishes closing
// handles already mid-teardown (e.g. the fetch() socket from the just-completed request)
// before the forced exit fires — without it, process.exit() right after a fetch() call
// crashes on Windows with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)".
run(process.argv.slice(2), deps).then((code) => {
  process.exitCode = code
  setImmediate(() => process.exit(code))
})
