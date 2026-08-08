import { test, expect, describe } from 'bun:test'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as Q from '../src/queries.js'

// Validate EVERY operation the CLI can send against api-my's REAL GraphQL schema.
//
// This is the test that would have caught the reinstall bug at build time. The backend nulls the
// whole response when an unknown field is requested, and in production it masks resolver errors
// as null too — so a wrong field name, a wrong argument type, or `input:` where the schema wants
// `inp:` does not surface as an error. It surfaces as a silent null the CLI used to report as
// success. Type-checking the documents against the schema turns all of that into a red test.
//
// The schema is assembled from SDL text only (SDL/*.gql + the inline defType block in
// schema.js). Importing api-my's resolver modules is deliberately avoided: they run side effects
// at require time (registering a PayPal webhook, constructing Telegram bots) and hard-throw
// without a dozen secrets in the environment.
//
// Skips itself when api-my is not checked out beside the CLI, so a standalone `cli/` clone still
// has a green suite.

const API = new URL('../../api-my/', import.meta.url).pathname
const HAVE_API = existsSync(API + 'schema.js') && existsSync(API + 'SDL')

const OPERATIONS = Object.entries(Q)
  .filter(([, v]) => typeof v === 'string' && /^\s*(query|mutation|subscription)\b/.test(v))

describe('schema sync — CLI operations vs api-my SDL', () => {
  test('queries.js exports a plausible number of operations', () => {
    // Guards against the filter silently matching nothing and the suite passing vacuously.
    expect(OPERATIONS.length).toBeGreaterThan(25)
  })

  if (!HAVE_API) {
    test.skip(`api-my not found at ${API} — schema validation skipped`, () => {})
    return
  }

  const require_ = createRequire(API + 'package.json')
  const { buildSchema, parse, validate, specifiedRules } = require_('graphql')

  const defType = readFileSync(API + 'schema.js', 'utf8').match(/const defType = `([\s\S]*?)`/)?.[1]
  const sdlFiles = readdirSync(API + 'SDL').filter(f => f.endsWith('.gql'))
  const schema = buildSchema([defType, ...sdlFiles.map(f => readFileSync(API + 'SDL/' + f, 'utf8'))].join('\n'))

  test('the schema assembled from SDL is non-trivial', () => {
    expect(defType).toBeTruthy()
    expect(sdlFiles.length).toBeGreaterThan(5)
    expect(schema.getQueryType()).toBeTruthy()
    expect(schema.getMutationType()).toBeTruthy()
    expect(schema.getSubscriptionType()).toBeTruthy()
  })

  // One test per operation so a failure names the offending constant instead of the whole file.
  for (const [name, op] of OPERATIONS) {
    test(`${name} is valid against the live schema`, () => {
      const errors = validate(schema, parse(op), specifiedRules)
      expect(errors.map(e => e.message)).toEqual([])
    })
  }

  // The trap documented at the top of src/queries.js: the real schema uses `inp:`, while some
  // backend docs say `input:`. Sending the wrong one yields an empty 200 body, not an error.
  test('every operation taking an input object names the argument `inp`', () => {
    for (const [name, op] of OPERATIONS) {
      if (/\binput\s*:/.test(op)) throw new Error(`${name} uses "input:" — the real schema wants "inp:"`)
    }
  })

  // Negative control: the validator must actually reject things. Without this, a broken schema
  // build (e.g. defType regex stops matching) would make every test above pass trivially.
  test('the validator rejects an unknown field, argument and input-type name', () => {
    const bad = [
      'query { userMy { id nosuchfield } }',
      'query { productId(nosucharg: 1) { id } }',
      'mutation($inp: nosuchinput) { userMod(inp: $inp) { id } }',
      'query { nosuchquery }',
    ]
    for (const doc of bad) {
      const errors = validate(schema, parse(doc), specifiedRules)
      expect(errors.length).toBeGreaterThan(0)
    }
  })

  // The reinstall bug in one assertion: productSet's `oid` is an Int, so a name string sent
  // there is a type error the schema can catch — which is why the CLI must resolve the name to
  // an id before building the mutation.
  test('inpProdSet.oid is an Int, so an OS name must be resolved to an id first', () => {
    const inpProdSet = schema.getType('inpProdSet')
    expect(inpProdSet).toBeTruthy()
    const oid = inpProdSet.getFields().oid
    expect(oid).toBeTruthy()
    expect(String(oid.type)).toBe('Int')
  })
})
