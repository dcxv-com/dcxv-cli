import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as config from '../src/config.js'

// config.js reads process.env at call time, so pointing XDG_CONFIG_HOME at a fresh
// temp dir per test fully isolates the on-disk config.
const ENV_KEYS = ['XDG_CONFIG_HOME', 'DCXV_TOKEN', 'DCXV_URL', 'DCXV_PROFILE']
let saved, dir

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  dir = mkdtempSync(join(tmpdir(), 'dcxv-cfg-'))
  process.env.XDG_CONFIG_HOME = dir
})
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  rmSync(dir, { recursive: true, force: true })
})

describe('save / load round-trip', () => {
  test('persists the token to the active profile', () => {
    config.saveConfig({ token: 'abc' })
    const cfg = config.loadConfig()
    expect(cfg.token).toBe('abc')
    expect(cfg.profile).toBe('default')
    expect(cfg.source).toBe('profile:default')
  })
  test('a url in the patch is ignored - the host is not configurable', () => {
    config.saveConfig({ token: 'abc', url: 'https://x.y' })
    expect(config.loadConfig().url).toBe('https://dcxv.com')
    expect(config.listProfiles().profiles.default.url).toBeUndefined()
  })
  test('missing file -> empty, source none', () => {
    const cfg = config.loadConfig()
    expect(cfg.token).toBe('')
    expect(cfg.source).toBe('none')
    expect(cfg.url).toBe('https://dcxv.com')
  })
})

describe('env precedence', () => {
  test('DCXV_TOKEN overrides file token', () => {
    config.saveConfig({ token: 'filetok' })
    process.env.DCXV_TOKEN = 'envtok'
    const cfg = config.loadConfig()
    expect(cfg.token).toBe('envtok')
    expect(cfg.source).toBe('env')
  })
  test('DCXV_URL cannot move the host', () => {
    // It used to. The bearer token, the KVM console URL and the payment link all follow
    // whatever this resolves to, so it is no longer an override at all - and cli.js
    // refuses to run at all while it is set, rather than silently ignoring it.
    config.saveConfig({ token: 't' })
    process.env.DCXV_URL = 'https://override.tld'
    expect(config.loadConfig().url).toBe('https://dcxv.com')
  })
})

describe('subToken', () => {
  test('subToken takes precedence and can be cleared', () => {
    config.saveConfig({ token: 'main' })
    config.saveConfig({ subToken: 'sub' })
    let cfg = config.loadConfig()
    expect(cfg.token).toBe('sub')
    expect(cfg.source).toBe('sub')
    expect(cfg.sub).toBe(true)

    config.saveConfig({ subToken: null })
    cfg = config.loadConfig()
    expect(cfg.token).toBe('main')
    expect(cfg.sub).toBe(false)
    expect(cfg.source).toBe('profile:default')
  })
})

describe('v1 migration', () => {
  test('flat {token} file is read as default profile, and a stale url is dropped', () => {
    mkdirSync(join(dir, 'dcxv'), { recursive: true })
    writeFileSync(join(dir, 'dcxv', 'config.json'), JSON.stringify({ token: 'old', url: 'https://old.tld' }))
    const cfg = config.loadConfig()
    expect(cfg.token).toBe('old')
    expect(cfg.url).toBe('https://dcxv.com')
    expect(config.listProfiles().names).toContain('default')
  })

  test('a v2 profile with a saved url from an older version is ignored, not honored', () => {
    mkdirSync(join(dir, 'dcxv'), { recursive: true })
    writeFileSync(join(dir, 'dcxv', 'config.json'),
      JSON.stringify({ current: 'default', profiles: { default: { token: 'tk', url: 'https://stale.tld' } } }))
    expect(config.loadConfig().url).toBe('https://dcxv.com')
    expect(config.loadConfig().token).toBe('tk')
  })
})

describe('corrupt config', () => {
  test('invalid JSON is non-fatal', () => {
    mkdirSync(join(dir, 'dcxv'), { recursive: true })
    writeFileSync(join(dir, 'dcxv', 'config.json'), 'not json {')
    const cfg = config.loadConfig()
    expect(cfg.token).toBe('')
    expect(cfg.source).toBe('none')
  })
})

describe('profiles', () => {
  test('named profile isolation + selection', () => {
    config.saveConfig({ token: 'deftok' })
    config.saveConfig({ token: 'worktok' }, { profile: 'work' })
    expect(config.loadConfig({ profile: 'work' }).token).toBe('worktok')
    expect(config.loadConfig({ profile: 'default' }).token).toBe('deftok')
  })
  test('DCXV_PROFILE env selects active profile', () => {
    config.saveConfig({ token: 'worktok' }, { profile: 'work' })
    process.env.DCXV_PROFILE = 'work'
    expect(config.loadConfig().token).toBe('worktok')
  })
  test('use / rm / ls', () => {
    config.saveConfig({ token: 'a' }, { profile: 'work' })
    config.useProfile('work')
    expect(config.listProfiles().current).toBe('work')
    config.removeProfile('work')
    const p = config.listProfiles()
    expect(p.names).not.toContain('work')
    expect(p.current).toBe('default')
  })
})

describe('file permissions', () => {
  test('config written with mode 600', () => {
    config.saveConfig({ token: 't' })
    const mode = statSync(config.configPath()).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
