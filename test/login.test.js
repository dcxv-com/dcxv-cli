import { test, expect, describe } from 'bun:test'
import { run } from '../src/cli.js'

// `dcxv login` (no token arg): device-authorization flow. cliAuthStart is public
// (requestPublic), then the CLI opens an unauthenticated SSE subscription
// (subscribePublic) scoped by deviceCode and waits for exactly one push event —
// no polling. See src/cli.js handleLoginDevice/waitForApproval.

function harness({ start, onSubscribe } = {}) {
  const out = [], err = [], saved = []
  const client = {
    requestPublic: async (_query, vars) => {
      return { cliAuthStart: typeof start === 'function' ? start(vars) : start }
    },
    subscribePublic: (_query, vars, callbacks) => {
      onSubscribe?.(vars, callbacks)
      return () => {}
    },
  }
  const config = {
    loadConfig: () => ({ token: '', url: 'https://dcxv.com', profile: 'default', source: 'none' }),
    saveConfig: (patch, opts) => { saved.push({ patch, opts }); return '/tmp/cfg.json' },
  }
  const deps = { config, makeClient: () => client, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }
  return { deps, out, err, saved }
}

const outStr = (h) => h.out.join('\n')
const exec = (h, ...argv) => run(argv, h.deps)

describe('dcxv login (device flow)', () => {
  test('prints the verify URL/code and saves the token on approval', async () => {
    const h = harness({
      start: { deviceCode: 'dc123', userCode: 'ABCD-1234', verifyUrl: 'https://dcxv.com/my/cli/ABCD-1234', expiresIn: 600 },
      onSubscribe: (vars, callbacks) => {
        expect(vars).toEqual({ deviceCode: 'dc123' })
        // simulate the browser-approval push arriving asynchronously
        queueMicrotask(() => callbacks.onNext({ cliAuthSub: { status: 'approved', token: 'MINTED_TOKEN' } }))
      },
    })

    const code = await exec(h, 'login')

    expect(code).toBe(0)
    expect(outStr(h)).toContain('https://dcxv.com/my/cli/ABCD-1234')
    expect(outStr(h)).toContain('ABCD-1234')
    expect(h.saved).toHaveLength(1)
    expect(h.saved[0].patch.token).toBe('MINTED_TOKEN')
  })

  test('times out if nothing approves before expiresIn', async () => {
    const h = harness({
      start: { deviceCode: 'dc123', userCode: 'ABCD-1234', verifyUrl: 'https://dcxv.com/my/cli/ABCD-1234', expiresIn: 0.01 },
      onSubscribe: () => {}, // never calls onNext
    })

    const code = await exec(h, 'login')

    expect(code).toBe(1)
    expect(h.saved).toHaveLength(0)
  })
})
