// Config + token resolution for the DCXV CLI.
//
// File schema (v2):
//   { "current": "default", "profiles": { "default": { token, subToken } } }
// A v1 flat file ({ token }) is migrated into profiles.default on read.
//
// Token precedence:  DCXV_TOKEN env > active profile subToken > active profile token
// Active profile:    opts.profile   > DCXV_PROFILE env        > file.current > "default"
//
// The API host is NOT configurable. It was, through --url, DCXV_URL and a per-profile
// `url` - three ways to point an authenticated CLI at an arbitrary host, and the bearer
// token, the KVM console URL and the payment link all follow wherever it points. A `url`
// left in an existing config file is ignored, not honored (see readFile).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const DEFAULT_URL = 'https://dcxv.com'

function configDir() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'dcxv')
}

export function configPath() {
  return join(configDir(), 'config.json')
}

// Read + migrate to v2 shape. Never throws (corrupt/missing -> fresh skeleton).
function readFile() {
  const path = configPath()
  let raw = {}
  if (existsSync(path)) {
    try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { raw = {} }
  }
  if (raw && typeof raw === 'object' && raw.profiles && typeof raw.profiles === 'object') {
    return { current: raw.current || 'default', profiles: raw.profiles }
  }
  // v1 flat migration (or empty). A v1 `url` is deliberately dropped rather than carried
  // forward - the host is fixed now, so migrating it would only preserve a dead setting.
  const def = {}
  if (raw && raw.token) def.token = raw.token
  return { current: 'default', profiles: { default: def } }
}

function writeFile(obj) {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  return path
}

function activeName(file, opts = {}) {
  return opts.profile || process.env.DCXV_PROFILE || file.current || 'default'
}

// Resolve the effective { token, url, source, profile, sub } for the active profile.
// url is always DEFAULT_URL - it stays in the shape because every caller reads it, but
// nothing can change it.
export function loadConfig(opts = {}) {
  const file = readFile()
  const name = activeName(file, opts)
  const prof = file.profiles[name] || {}
  const token = process.env.DCXV_TOKEN || prof.subToken || prof.token || ''
  const url = DEFAULT_URL
  const source = process.env.DCXV_TOKEN
    ? 'env'
    : (prof.subToken ? 'sub' : (prof.token ? `profile:${name}` : 'none'))
  return { token, url, source, profile: name, sub: !!prof.subToken }
}

// Merge a patch ({ token?, subToken? }) into the active profile.
// subToken: pass null to clear it. There is deliberately no `url` - see the header.
export function saveConfig(patch = {}, opts = {}) {
  const file = readFile()
  const name = activeName(file, opts)
  const prof = file.profiles[name] || (file.profiles[name] = {})
  if (patch.token !== undefined) prof.token = patch.token
  if (patch.subToken !== undefined) {
    if (patch.subToken == null) delete prof.subToken
    else prof.subToken = patch.subToken
  }
  file.current = name
  return writeFile(file)
}

export function listProfiles() {
  const file = readFile()
  return { current: file.current, names: Object.keys(file.profiles), profiles: file.profiles }
}

export function useProfile(name) {
  const file = readFile()
  if (!file.profiles[name]) file.profiles[name] = {}
  file.current = name
  writeFile(file)
  return name
}

export function removeProfile(name) {
  const file = readFile()
  delete file.profiles[name]
  if (!Object.keys(file.profiles).length) file.profiles.default = {}
  if (file.current === name) file.current = 'default'
  writeFile(file)
}
