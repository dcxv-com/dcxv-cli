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

run(process.argv.slice(2), deps).then((code) => process.exit(code))
