import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { makeClient, DcxvError } from '../src/client.js'

let originalFetch
beforeEach(() => { originalFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = originalFetch })

const okJson = (data) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(data) })

describe('request', () => {
  test('sends POST to /api/graphql with Bearer auth and returns data', async () => {
    let captured
    globalThis.fetch = async (url, opts) => { captured = { url, opts }; return okJson({ data: { ok: 1 } }) }
    const client = makeClient({ url: 'https://dcxv.com', token: 'TOK' })
    const data = await client.request('query { ok }', { a: 1 })

    expect(data).toEqual({ ok: 1 })
    expect(captured.url).toBe('https://dcxv.com/api/graphql')
    expect(captured.opts.method).toBe('POST')
    expect(captured.opts.headers.Authorization).toBe('Bearer TOK')
    expect(captured.opts.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(captured.opts.body)).toEqual({ query: 'query { ok }', variables: { a: 1 } })
  })

  test('omits variables key when none given', async () => {
    let body
    globalThis.fetch = async (_u, opts) => { body = JSON.parse(opts.body); return okJson({ data: {} }) }
    await makeClient({ url: 'https://x', token: 'T' }).request('query { ok }')
    expect(body).toEqual({ query: 'query { ok }' })
  })

  test('GraphQL errors[] -> DcxvError', async () => {
    globalThis.fetch = async () => okJson({ errors: [{ message: 'boom' }, { message: 'bad' }] })
    const client = makeClient({ url: 'https://x', token: 'T' })
    expect(client.request('q')).rejects.toThrow(/boom; bad/)
  })

  test('non-2xx HTTP -> DcxvError', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) })
    const client = makeClient({ url: 'https://x', token: 'T' })
    expect(client.request('q')).rejects.toThrow(/HTTP 500/)
  })

  test('network throw -> wrapped DcxvError', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
    const client = makeClient({ url: 'https://x', token: 'T' })
    expect(client.request('q')).rejects.toThrow(/Network error.*ECONNREFUSED/)
  })

  test('missing token -> throws before fetch', async () => {
    let called = false
    globalThis.fetch = async () => { called = true; return okJson({ data: {} }) }
    const client = makeClient({ url: 'https://x', token: '' })
    await expect(client.request('q')).rejects.toThrow(DcxvError)
    await expect(client.request('q')).rejects.toThrow(/No API token/)
    expect(called).toBe(false)
  })

  // The backend returns HTTP 200 with a completely empty body (not a GraphQL
  // errors[] response) for some malformed requests — most often a variable type
  // mismatch (e.g. Int sent where the schema expects String). See
  // docs/NOTE_FOR_BACKEND_API.md section 11.3.
  test('empty 200 body -> clear DcxvError, not a raw JSON.parse crash', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '' })
    const client = makeClient({ url: 'https://x', token: 'T' })
    await expect(client.request('q')).rejects.toThrow(DcxvError)
    await expect(client.request('q')).rejects.toThrow(/type mismatch/)
  })

  test('non-empty but non-JSON 200 body -> clear DcxvError', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '<html>not json</html>' })
    const client = makeClient({ url: 'https://x', token: 'T' })
    await expect(client.request('q')).rejects.toThrow(DcxvError)
    await expect(client.request('q')).rejects.toThrow(/Invalid \(non-JSON\) response/)
  })
})

describe('subscribe', () => {
  test('missing token -> throws before connecting', () => {
    const client = makeClient({ url: 'https://x', token: '' })
    expect(() => client.subscribe('subscription { x }', { onNext() {} })).toThrow(/No API token/)
  })
})
