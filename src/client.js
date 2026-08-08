// GraphQL HTTP + SSE client for DCXV.
// Auth matches the web app (src/routes/+layout.svelte): Authorization: Bearer <token>
// on both the /api/graphql POST and the /sse subscription stream.
import { createClient } from 'graphql-sse'

export class DcxvError extends Error {}

export function makeClient({ url, token }) {
  const gqlUrl = `${url}/api/graphql`
  const authHeader = { Authorization: `Bearer ${token}` }

  function requireToken() {
    if (!token) {
      throw new DcxvError('No API token. Run "dcxv login <token>" or set DCXV_TOKEN. Create a token at ' + url + '/my/api')
    }
  }

  async function postGraphQL(headers, query, variables) {
    let res
    try {
      res = await fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      })
    } catch (e) {
      throw new DcxvError(`Network error contacting ${gqlUrl}: ${e.message}`)
    }
    if (!res.ok) {
      throw new DcxvError(`HTTP ${res.status} ${res.statusText} from ${gqlUrl}`)
    }
    const text = await res.text()
    if (!text) {
      // The backend returns an empty (non-JSON) 200 body for some malformed
      // requests instead of a standard GraphQL errors[] response — most often
      // a variable type mismatch (e.g. a string sent where the schema expects
      // an Int, or vice versa). See docs/NOTE_FOR_BACKEND_API.md section 11.
      throw new DcxvError('Empty response from server — likely a variable type mismatch in the request (e.g. a number sent as a string, or vice versa).')
    }
    let json
    try {
      json = JSON.parse(text)
    } catch (e) {
      throw new DcxvError(`Invalid (non-JSON) response from ${gqlUrl}: ${e.message}`)
    }
    if (json.errors?.length) {
      throw new DcxvError('GraphQL error: ' + json.errors.map(e => e.message).join('; '))
    }
    return json.data
  }

  async function request(query, variables) {
    requireToken()
    return postGraphQL(authHeader, query, variables)
  }

  // No Authorization header — used only for the device-login bootstrap call
  // (cliAuthStart), which runs before a token exists.
  async function requestPublic(query, variables) {
    return postGraphQL({}, query, variables)
  }

  function subscribeWith(headers, query, variables, { onNext, onError, onComplete }) {
    const sse = createClient({ url: `${url}/sse`, headers: () => headers })
    const unsubscribe = sse.subscribe(
      { query, variables },
      {
        next: (msg) => { if (msg.data) onNext(msg.data) },
        error: (err) => onError?.(err instanceof Error ? err : new DcxvError(String(err))),
        complete: () => onComplete?.(),
      }
    )
    return () => { unsubscribe(); sse.dispose() }
  }

  // Returns an async iterator-friendly subscriber. onNext(data) per event.
  function subscribe(query, callbacks) {
    requireToken()
    return subscribeWith(authHeader, query, undefined, callbacks)
  }

  // No Authorization header — used only for the device-login cliAuthSub
  // subscription, which runs before a token exists. The server-side resolver
  // scopes events by the (secret) deviceCode variable instead of ctx.uid.
  function subscribePublic(query, variables, callbacks) {
    return subscribeWith({}, query, variables, callbacks)
  }

  return { request, requestPublic, subscribe, subscribePublic, url, gqlUrl }
}
