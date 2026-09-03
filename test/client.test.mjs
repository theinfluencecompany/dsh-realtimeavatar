import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request, classifyFailure, RtaApiError, retryDelayMs, MAX_RETRY_DELAY_MS } from '../lib/client.js'
import { USER_AGENT } from '../lib/config.js'

const KEY = 'tic_test_' + 'x'.repeat(40)
const AVATAR_ID = '00000000-0000-0000-0000-000000000000'
const IDEMPOTENCY_KEY = 'idem-' + '0'.repeat(24)

/** Install a fake fetch that returns `response` (or calls it) and records the request. */
function stubFetch(response) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (typeof response === 'function') return response(url, init)
    return response
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function abortError() {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

/** Minimal request options; every test overrides what it cares about. */
function opts(overrides = {}) {
  return { method: 'GET', path: '/v1/avatars', timeoutMs: 5000, apiKey: KEY, ...overrides }
}

/** assert.rejects / assert.throws validator for a coded RtaApiError whose message never carries the key. */
function rtaError(kind, extra) {
  return (err) => {
    assert.ok(err instanceof RtaApiError, 'expected an RtaApiError, got ' + String(err))
    assert.equal(err.name, 'RtaApiError')
    assert.equal(err.kind, kind)
    assert.ok(!err.message.includes(KEY), 'message must not carry the key: ' + err.message)
    assert.doesNotMatch(err.message, /x{8}/, 'message must not carry a fragment of the key')
    if (extra !== undefined) extra(err)
    return true
  }
}

// ------------------------------------------------------------- request()

test('GET builds the URL from the API base, sets the three headers, forwards a signal and forbids redirects', async () => {
  const stub = stubFetch(jsonResponse({ avatars: [] }))
  try {
    const result = await request(opts())
    assert.deepEqual(result, { status: 200, json: { avatars: [] } })
    assert.equal(stub.calls.length, 1)
    const { url, init } = stub.calls[0]
    assert.equal(String(url), 'https://realtimeavatar.ai/api/v1/avatars')
    assert.equal(init.method, 'GET')
    assert.equal(init.headers.Authorization, 'Bearer ' + KEY)
    assert.equal(init.headers.Accept, 'application/json')
    assert.equal(init.headers['User-Agent'], USER_AGENT)
    assert.ok(!('Content-Type' in init.headers), 'no Content-Type without a body')
    assert.ok(!('Idempotency-Key' in init.headers), 'no Idempotency-Key unless given')
    assert.equal(init.body, undefined)
    assert.ok(init.signal instanceof AbortSignal, 'fetch always receives an AbortSignal')
    assert.equal(init.redirect, 'error')
  } finally {
    stub.restore()
  }
})

test('POST serialises the body as JSON, sets Content-Type and the Idempotency-Key header when given', async () => {
  const stub = stubFetch(jsonResponse({ id: AVATAR_ID }, 201))
  try {
    const body = { name: 'Nova', portraitAssetId: AVATAR_ID, voice: { pitch: 'mid' } }
    const result = await request(opts({ method: 'POST', path: '/v1/avatars', body, idempotencyKey: IDEMPOTENCY_KEY }))
    assert.deepEqual(result, { status: 201, json: { id: AVATAR_ID } })
    const { init } = stub.calls[0]
    assert.equal(init.method, 'POST')
    assert.equal(init.headers['Content-Type'], 'application/json')
    assert.equal(init.headers['Idempotency-Key'], IDEMPOTENCY_KEY)
    assert.deepEqual(JSON.parse(init.body), body)
  } finally {
    stub.restore()
  }
})

test('every method is forwarded verbatim', async () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const stub = stubFetch(jsonResponse({ ok: true }))
    try {
      await request(opts({ method, path: '/v1/avatars/' + AVATAR_ID }))
      assert.equal(stub.calls[0].init.method, method)
      assert.equal(String(stub.calls[0].url), 'https://realtimeavatar.ai/api/v1/avatars/' + AVATAR_ID)
    } finally {
      stub.restore()
    }
  }
})

test('query params are encoded with URLSearchParams and undefined / empty values are skipped', async () => {
  const stub = stubFetch(jsonResponse({ sessions: [] }))
  try {
    await request(opts({ path: '/v1/usage/sessions', query: { limit: 10, cursor: undefined, endUserId: '', from: 'a b&c=d', page: 0 } }))
    const { url } = stub.calls[0]
    assert.equal(url.search, '?limit=10&from=a+b%26c%3Dd&page=0')
    assert.equal(url.searchParams.get('limit'), '10')
    assert.equal(url.searchParams.get('page'), '0', 'zero is a value, not "empty"')
    assert.ok(!url.searchParams.has('cursor'))
    assert.ok(!url.searchParams.has('endUserId'))
  } finally {
    stub.restore()
  }
})

test('no query object means no query string', async () => {
  const stub = stubFetch(() => jsonResponse({}))
  try {
    await request(opts({ query: {} }))
    assert.equal(stub.calls[0].url.search, '')
    await request(opts())
    assert.equal(stub.calls[1].url.search, '')
  } finally {
    stub.restore()
  }
})

test('204 and empty bodies resolve with json null', async () => {
  const cases = [
    [new Response(null, { status: 204 }), 204],
    [new Response('', { status: 200 }), 200],
    [new Response('  \n\t', { status: 200 }), 200],
  ]
  for (const [response, status] of cases) {
    const stub = stubFetch(response)
    try {
      assert.deepEqual(await request(opts({ method: 'DELETE' })), { status, json: null })
    } finally {
      stub.restore()
    }
  }
})

test('a non-JSON 2xx body is an http error that names the status', async () => {
  const stub = stubFetch(new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
  try {
    await assert.rejects(
      request(opts()),
      rtaError('http', (err) => {
        assert.equal(err.status, 200)
        assert.match(err.message, /non-JSON body \(HTTP 200\)/)
      }),
    )
  } finally {
    stub.restore()
  }
})

test('a non-JSON error body is still classified by status', async () => {
  const stub = stubFetch(new Response('<html>Bad Gateway</html>', { status: 502 }))
  try {
    await assert.rejects(
      request(opts({ retry: false })),
      rtaError('upstream', (err) => {
        assert.equal(err.status, 502)
        assert.match(err.message, /non-JSON error body/)
        assert.match(err.message, /HTTP 502/)
      }),
    )
  } finally {
    stub.restore()
  }
})

test('a non-2xx JSON body goes through classifyFailure with the key as a known secret', async () => {
  const stub = stubFetch(jsonResponse({ error: 'invalid key ' + KEY + ' (Bearer ' + KEY + ')', code: 'insufficient_scope' }, 403))
  try {
    await assert.rejects(
      request(opts()),
      rtaError('scope', (err) => {
        assert.equal(err.status, 403)
        assert.equal(err.code, 'insufficient_scope')
        assert.match(err.message, /<redacted>/)
        assert.match(err.message, /HTTP 403, insufficient_scope/)
      }),
    )
  } finally {
    stub.restore()
  }
})

// ------------------------------------------------------- classifyFailure()

test('classifyFailure maps every documented status to its kind', () => {
  const matrix = [
    [401, 'auth'],
    [402, 'billing'],
    [403, 'scope'],
    [404, 'not_found'],
    [409, 'conflict'],
    [413, 'too_large'],
    [422, 'validation'],
    [429, 'rate_limit'],
    [502, 'upstream'],
    [503, 'unavailable'],
    [400, 'http'],
    [418, 'http'],
    [500, 'http'],
    [504, 'http'],
  ]
  for (const [status, kind] of matrix) {
    const err = classifyFailure(status, { error: 'boom', code: 'some_code' }, [KEY])
    assert.ok(err instanceof RtaApiError)
    assert.equal(err.kind, kind, 'HTTP ' + status)
    assert.equal(err.status, status)
    assert.equal(err.code, 'some_code')
    assert.match(err.message, new RegExp('\\(HTTP ' + status + ', some_code\\)'), 'HTTP ' + status)
  }
})

test('401 is auth and points at /rta status without echoing the body', () => {
  const err = classifyFailure(401, { error: 'bad key ' + KEY }, [KEY])
  assert.equal(err.kind, 'auth')
  assert.match(err.message, /rejected: missing, malformed, revoked or expired/)
  assert.match(err.message, /\/rta status/)
  assert.ok(!err.message.includes(KEY))
})

test('402 is billing and carries billingUrl in the message and on the error', () => {
  const billingUrl = 'https://realtimeavatar.ai/platform/billing'
  const err = classifyFailure(402, { error: 'insufficient_credits', code: 'insufficient_credits', billingUrl }, [KEY])
  assert.equal(err.kind, 'billing')
  assert.equal(err.billingUrl, billingUrl)
  assert.match(err.message, /insufficient_credits \(HTTP 402, insufficient_credits\)\. Top up at https:\/\/realtimeavatar\.ai\/platform\/billing/)
  const noUrl = classifyFailure(402, { error: 'spend_limit_exceeded' }, [KEY])
  assert.equal(noUrl.billingUrl, undefined)
  assert.match(noUrl.message, /Top up or raise the per-key spend limit/)
  const badUrl = classifyFailure(402, { error: 'x', billingUrl: 42 }, [KEY])
  assert.equal(badUrl.billingUrl, undefined)
})

test('403 / 404 / 409 / 413 / 422 carry the documented guidance', () => {
  assert.match(classifyFailure(403, { error: 'forbidden' }, [KEY]).message, /lacks the scope.*do not widen to \*/)
  assert.match(classifyFailure(404, { error: 'no such avatar' }, [KEY]).message, /wrong or deleted id.*not a permission problem/)
  assert.equal(classifyFailure(409, { error: 'idempotency conflict', code: 'idempotency_conflict' }, [KEY]).message, 'idempotency conflict (HTTP 409, idempotency_conflict)')
  assert.match(classifyFailure(413, { error: 'too big' }, [KEY]).message, /Send media by URL, not inline/)
  assert.match(classifyFailure(422, { error: 'unknown field' }, [KEY]).message, /wire schemas are strict/)
})

test('403 distinguishes the clip-library rollout gate and an inactive workspace from a missing scope', () => {
  const gate = classifyFailure(403, { error: 'clip library not enabled', code: 'clip_library_not_enabled' }, [KEY])
  assert.equal(gate.kind, 'scope')
  assert.equal(gate.code, 'clip_library_not_enabled')
  assert.match(gate.message, /per-workspace rollout gate; contact support/)
  assert.doesNotMatch(gate.message, /lacks the scope/)
  const inactive = classifyFailure(403, { error: 'Workspace is not active', code: 'workspace_inactive' }, [KEY])
  assert.equal(inactive.kind, 'scope')
  assert.match(inactive.message, /The workspace is not active; it has to be reactivated in the dashboard/)
  assert.doesNotMatch(inactive.message, /lacks the scope/)
  assert.match(classifyFailure(403, { error: 'NOT ACTIVE' }, [KEY]).message, /not active/, 'case-insensitive on the upstream text')
  assert.match(classifyFailure(403, { error: 'forbidden' }, [KEY]).message, /lacks the scope/)
})

test('409 names the current revision when the body carries a numeric one', () => {
  const withRevision = classifyFailure(409, { error: 'revision mismatch', code: 'revision_conflict', revision: 7 }, [KEY])
  assert.equal(withRevision.kind, 'conflict')
  assert.equal(withRevision.message, 'revision mismatch (HTTP 409, revision_conflict). The current revision is 7; retry with expectedRevision 7.')
  assert.equal(classifyFailure(409, { error: 'x', revision: '7' }, [KEY]).message, 'x (HTTP 409)', 'a non-numeric revision adds nothing')
  assert.equal(classifyFailure(409, { error: 'x', revision: 0 }, [KEY]).message, 'x (HTTP 409). The current revision is 0; retry with expectedRevision 0.')
})

test('upstream error text is capped at 500 characters (plus an ellipsis) in every message', () => {
  const long = 'e'.repeat(600)
  const err = classifyFailure(500, { error: long, code: 'c'.repeat(100) }, [KEY])
  assert.ok(err.message.startsWith('e'.repeat(500) + '…'), 'text is cut at 500')
  assert.ok(!err.message.includes('e'.repeat(501)))
  assert.equal(err.code, 'c'.repeat(80), 'codes are cut at 80')
  assert.match(err.message, /\(HTTP 500, c{80}\)$/)
  const billing = classifyFailure(402, { error: 'x', billingUrl: 'https://realtimeavatar.ai/' + 'p'.repeat(600) }, [KEY])
  assert.ok(billing.billingUrl.length <= 501)
  assert.ok(billing.billingUrl.endsWith('…'))
  const surrogate = classifyFailure(500, { error: 'e'.repeat(499) + '😀' + 'tail' }, [KEY])
  assert.ok(surrogate.message.isWellFormed(), 'the cut never leaves a lone surrogate')
})

test('429 with code concurrency_limit_reached is concurrency, even when queue fields are present', () => {
  const err = classifyFailure(429, { error: 'ceiling', code: 'concurrency_limit_reached', queue_size: 3, recommended_retry_ms: 1000 }, [KEY])
  assert.equal(err.kind, 'concurrency')
  assert.equal(err.code, 'concurrency_limit_reached')
  assert.equal(err.queue, undefined)
  assert.match(err.message, /concurrency ceiling.*close a session or upgrade/)
  assert.match(err.message, /HTTP 429, concurrency_limit_reached/)
})

test('429 with queue_size + recommended_retry_ms is queue and exposes the queue contract', () => {
  const full = classifyFailure(429, { error: 'capacity full', queue_size: 7, recommended_retry_ms: 2500, queue_ticket_id: 'ticket-' + '0'.repeat(16), queue_position: 4 }, [KEY])
  assert.equal(full.kind, 'queue')
  assert.equal(full.retryable, true)
  assert.deepEqual(full.queue, { queueSize: 7, recommendedRetryMs: 2500, queueTicketId: 'ticket-' + '0'.repeat(16), queuePosition: 4 })
  assert.match(full.message, /hold a place in line/)

  const bare = classifyFailure(429, { queue_size: 1, recommended_retry_ms: 500 }, [KEY])
  assert.equal(bare.kind, 'queue')
  assert.deepEqual(bare.queue, { queueSize: 1, recommendedRetryMs: 500 }, 'optional ticket/position keys are absent, not undefined')

  const wrongTypes = classifyFailure(429, { queue_size: 2, recommended_retry_ms: 500, queue_ticket_id: 99, queue_position: '3' }, [KEY])
  assert.deepEqual(wrongTypes.queue, { queueSize: 2, recommendedRetryMs: 500 })
})

test('a bare 429 (or one with only half the queue contract) is rate_limit and retryable', () => {
  for (const body of [{}, { error: 'slow down' }, { queue_size: 5 }, { recommended_retry_ms: 100 }, { queue_size: '5', recommended_retry_ms: 100 }, null, 'oops']) {
    const err = classifyFailure(429, body, [KEY])
    assert.equal(err.kind, 'rate_limit', JSON.stringify(body))
    assert.equal(err.retryable, true)
    assert.equal(err.queue, undefined)
    assert.match(err.message, /120 requests per 60 seconds/)
  }
})

test('502 / 503 default to retryable but honour an explicit retryable:false', () => {
  const upstream = classifyFailure(502, { error: 'render failed' }, [KEY])
  assert.equal(upstream.kind, 'upstream')
  assert.equal(upstream.retryable, true)
  assert.match(upstream.message, /upstream generation or render failed; retry/)
  const unavailable = classifyFailure(503, { error: 'dependency down' }, [KEY])
  assert.equal(unavailable.kind, 'unavailable')
  assert.equal(unavailable.retryable, true)
  assert.match(unavailable.message, /nothing was written; retry with backoff/)
  assert.equal(classifyFailure(502, { error: 'x', retryable: false }, [KEY]).retryable, false)
  assert.equal(classifyFailure(503, { error: 'x', retryable: false }, [KEY]).retryable, false)
  // other statuses pass retryable through untouched (undefined when absent or not a boolean)
  assert.equal(classifyFailure(409, { error: 'x' }, [KEY]).retryable, undefined)
  assert.equal(classifyFailure(409, { error: 'x', retryable: 'yes' }, [KEY]).retryable, undefined)
  assert.equal(classifyFailure(409, { error: 'x', retryable: true }, [KEY]).retryable, true)
})

test('the message text prefers body.error, then body.message, then a fixed fallback', () => {
  assert.equal(classifyFailure(500, { error: 'from error', message: 'from message' }, [KEY]).message, 'from error (HTTP 500)')
  assert.equal(classifyFailure(500, { message: 'from message' }, [KEY]).message, 'from message (HTTP 500)')
  assert.equal(classifyFailure(500, { error: 42, message: ['no'] }, [KEY]).message, 'request failed (HTTP 500)')
  assert.equal(classifyFailure(500, {}, [KEY]).message, 'request failed (HTTP 500)')
  assert.equal(classifyFailure(500, null, [KEY]).message, 'request failed (HTTP 500)')
  assert.equal(classifyFailure(500, 'a string body', [KEY]).message, 'request failed (HTTP 500)')
  assert.equal(classifyFailure(500, { error: 'x', code: 7 }, [KEY]).code, undefined, 'a non-string code is ignored')
})

test('the key never appears in any error message even when the error body echoes it', () => {
  const statuses = [400, 401, 402, 403, 404, 409, 413, 422, 429, 500, 502, 503]
  for (const status of statuses) {
    const body = { error: 'rejected key ' + KEY + ' header Bearer ' + KEY, message: KEY, billingUrl: 'https://realtimeavatar.ai/platform/billing' }
    for (const known of [[KEY], []]) {
      const err = classifyFailure(status, body, known)
      assert.ok(!err.message.includes(KEY), 'HTTP ' + status + ' leaked the key with known=' + JSON.stringify(known.length))
      assert.doesNotMatch(err.message, /x{8}/, 'HTTP ' + status + ' leaked a key fragment')
      assert.doesNotMatch(err.message, /Bearer (?!<redacted>)/, 'HTTP ' + status + ' leaked a bearer value')
    }
  }
})

// --------------------------------------------------------- failure paths

test('a network error is kind network, names cause.code and scrubs the key from the underlying message', async () => {
  const stub = stubFetch(() => {
    const err = new TypeError('fetch failed: header "Bearer ' + KEY + '" rejected')
    err.cause = { code: 'ECONNREFUSED', errno: -111 }
    throw err
  })
  try {
    await assert.rejects(
      request(opts({ retry: false })),
      rtaError('network', (err) => {
        assert.equal(err.message, 'network error (ECONNREFUSED): fetch failed: header "Bearer <redacted>" rejected')
        assert.equal(err.status, undefined)
      }),
    )
  } finally {
    stub.restore()
  }
})

test('a network error appends cause.message in parentheses, redacted and capped at 200 chars', async () => {
  const withMessage = stubFetch(() => {
    const err = new TypeError('fetch failed')
    err.cause = { code: 'ECONNRESET', message: 'socket hang up while sending ' + KEY }
    throw err
  })
  try {
    await assert.rejects(
      request(opts({ retry: false })),
      rtaError('network', (err) => assert.equal(err.message, 'network error (ECONNRESET): fetch failed (socket hang up while sending <redacted>)')),
    )
  } finally {
    withMessage.restore()
  }
  const long = stubFetch(() => {
    const err = new TypeError('fetch failed')
    err.cause = { message: 'm'.repeat(300) }
    throw err
  })
  try {
    await assert.rejects(request(opts({ retry: false })), rtaError('network', (err) => assert.equal(err.message, 'network error: fetch failed (' + 'm'.repeat(200) + '…)')))
  } finally {
    long.restore()
  }
  const noMessage = stubFetch(() => {
    const err = new TypeError('fetch failed')
    err.cause = { code: 'ENOTFOUND', message: 42 }
    throw err
  })
  try {
    await assert.rejects(request(opts({ retry: false })), rtaError('network', (err) => assert.equal(err.message, 'network error (ENOTFOUND): fetch failed', 'a non-string cause.message adds nothing')))
  } finally {
    noMessage.restore()
  }
})

test('a network error without a cause code, or a non-Error throw, is still kind network', async () => {
  const plain = stubFetch(() => {
    throw new TypeError('fetch failed')
  })
  try {
    await assert.rejects(request(opts({ retry: false })), rtaError('network', (err) => assert.equal(err.message, 'network error: fetch failed')))
  } finally {
    plain.restore()
  }
  const weird = stubFetch(() => {
    throw 'socket hang up ' + KEY
  })
  try {
    await assert.rejects(request(opts({ retry: false })), rtaError('network', (err) => assert.equal(err.message, 'network error: network failure')))
  } finally {
    weird.restore()
  }
})

test('an already-aborted caller signal issues no request at all', async () => {
  const stub = stubFetch(jsonResponse({}))
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(request(opts({ signal: controller.signal })), rtaError('cancelled', (err) => assert.match(err.message, /cancelled before it started/)))
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test("the caller's signal is forwarded: aborting mid-flight cancels the fetch", async () => {
  let sawAbort = false
  const stub = stubFetch(
    (url, init) =>
      new Promise((resolve, reject) => {
        const slow = setTimeout(() => resolve(jsonResponse({})), 2000)
        init.signal.addEventListener('abort', () => {
          sawAbort = true
          clearTimeout(slow)
          reject(abortError())
        })
      }),
  )
  try {
    const controller = new AbortController()
    const started = Date.now()
    const pending = request(opts({ signal: controller.signal }))
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(pending, rtaError('cancelled', (err) => assert.match(err.message, /cancelled by the caller/)))
    assert.ok(sawAbort, 'fetch observed the abort')
    assert.ok(Date.now() - started < 1500, 'did not wait for the slow response')
  } finally {
    stub.restore()
  }
})

test('an abort with a non-Error reason is still reported as a cancellation (classified by signal state)', async () => {
  const stub = stubFetch(
    (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason))
      }),
  )
  try {
    const controller = new AbortController()
    const pending = request(opts({ signal: controller.signal }))
    setTimeout(() => controller.abort({ kind: 'TOOL_TIMEOUT', ms: 5 }), 10)
    await assert.rejects(pending, rtaError('cancelled'))
  } finally {
    stub.restore()
  }
})

test('the request timeout fires while waiting for headers', async () => {
  const stub = stubFetch(
    (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(abortError()))
      }),
  )
  try {
    const started = Date.now()
    await assert.rejects(
      request(opts({ timeoutMs: 100 })),
      rtaError('timeout', (err) => assert.equal(err.message, 'request timed out after 100ms')),
    )
    assert.ok(Date.now() - started < 1500)
  } finally {
    stub.restore()
  }
})

test('the request timeout covers the body phase, not only the headers', async () => {
  const stub = stubFetch((url, init) => {
    // Headers arrive immediately; the body never finishes unless the signal fires.
    const body = new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(abortError()))
      },
    })
    return new Response(body, { status: 200 })
  })
  try {
    const started = Date.now()
    await assert.rejects(
      request(opts({ timeoutMs: 100 })),
      rtaError('timeout', (err) => assert.match(err.message, /timed out after 100ms/)),
    )
    assert.ok(Date.now() - started < 1500)
  } finally {
    stub.restore()
  }
})

test('a caller abort during the body phase is a cancellation, not a timeout', async () => {
  const stub = stubFetch((url, init) => {
    const body = new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(abortError()))
      },
    })
    return new Response(body, { status: 200 })
  })
  try {
    const controller = new AbortController()
    const pending = request(opts({ signal: controller.signal, timeoutMs: 5000 }))
    setTimeout(() => controller.abort(), 20)
    await assert.rejects(pending, rtaError('cancelled', (err) => assert.match(err.message, /cancelled by the caller/)))
  } finally {
    stub.restore()
  }
})

// --------------------------------------------------------------- retries

/** A fetch stub that answers from a queue of responses (or throwers) and records every call. */
function sequenceFetch(...responses) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, at: Date.now() })
    const next = responses.shift()
    if (next === undefined) throw new Error('sequenceFetch: no response left for call ' + calls.length)
    if (typeof next === 'function') return next(url, init)
    return next
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

const retryAfter = (status, seconds, body = { error: 'busy' }) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'retry-after': String(seconds) } })

test('retryDelayMs reads Retry-After as delay-seconds or an HTTP-date, then recommended_retry_ms, then defaults to one second', () => {
  const now = Date.UTC(2026, 8, 3, 12, 0, 0)
  assert.equal(retryDelayMs('2', null, now), 2000)
  assert.equal(retryDelayMs(' 0 ', null, now), 0)
  assert.equal(retryDelayMs(new Date(now + 3000).toUTCString(), null, now), 3000)
  assert.equal(retryDelayMs(new Date(now - 3000).toUTCString(), null, now), 0, 'a date in the past means now')
  assert.equal(retryDelayMs('garbage', { recommended_retry_ms: 750 }, now), 750)
  assert.equal(retryDelayMs(null, { recommended_retry_ms: 750 }, now), 750)
  assert.equal(retryDelayMs(null, { recommended_retry_ms: -1 }, now), 1000)
  assert.equal(retryDelayMs(null, null, now), 1000)
  assert.equal(retryDelayMs(null, 'text', now), 1000)
  assert.equal(MAX_RETRY_DELAY_MS, 5000)
})

test('a GET that hits a 503 with Retry-After: 0 is retried once and succeeds', async () => {
  const stub = sequenceFetch(retryAfter(503, 0), jsonResponse({ avatars: [] }))
  try {
    const result = await request(opts())
    assert.deepEqual(result, { status: 200, json: { avatars: [] } })
    assert.equal(stub.calls.length, 2)
    assert.equal(stub.calls[1].init.headers.Authorization, 'Bearer ' + KEY, 'the retry carries the same headers')
  } finally {
    stub.restore()
  }
})

test('a bare 429 (per-key rate limit) and a 502 are retried; the queue and concurrency 429s are not', async () => {
  let stub = sequenceFetch(retryAfter(429, 0), jsonResponse({ ok: true }))
  try {
    assert.deepEqual(await request(opts()), { status: 200, json: { ok: true } })
    assert.equal(stub.calls.length, 2)
  } finally {
    stub.restore()
  }
  stub = sequenceFetch(jsonResponse({ error: 'render failed' }, 502), jsonResponse({ ok: true }))
  try {
    // no Retry-After and no recommended_retry_ms: the default one-second wait applies, so give it room
    assert.deepEqual(await request(opts({ timeoutMs: 5000 })), { status: 200, json: { ok: true } })
    assert.equal(stub.calls.length, 2)
    assert.ok(stub.calls[1].at - stub.calls[0].at >= 900, 'waited the default second')
  } finally {
    stub.restore()
  }
  stub = sequenceFetch(jsonResponse({ error: 'full', queue_size: 3, recommended_retry_ms: 0, queue_ticket_id: 'qt_1' }, 429))
  try {
    await assert.rejects(() => request(opts()), rtaError('queue'))
    assert.equal(stub.calls.length, 1, 'a queue answer is a contract, not a failure to retry')
  } finally {
    stub.restore()
  }
  stub = sequenceFetch(jsonResponse({ error: 'ceiling', code: 'concurrency_limit_reached' }, 429))
  try {
    await assert.rejects(() => request(opts()), rtaError('concurrency'))
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})

test('only one retry: a second transient failure surfaces with a note', async () => {
  const stub = sequenceFetch(retryAfter(503, 0), retryAfter(503, 0), jsonResponse({ ok: true }))
  try {
    await assert.rejects(() => request(opts()), rtaError('unavailable', (err) => assert.match(err.message, /\(retried once\)$/)))
    assert.equal(stub.calls.length, 2)
  } finally {
    stub.restore()
  }
})

test('non-idempotent methods are never retried unless they opt in', async () => {
  let stub = sequenceFetch(retryAfter(503, 0), jsonResponse({ ok: true }))
  try {
    await assert.rejects(() => request(opts({ method: 'POST', path: '/v1/avatars', body: { displayName: 'x' } })), rtaError('unavailable', (err) => assert.doesNotMatch(err.message, /retried/)))
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
  stub = sequenceFetch(retryAfter(503, 0), jsonResponse({ ok: true }))
  try {
    assert.deepEqual(await request(opts({ method: 'POST', path: '/v1/realtime/livekit/session/release', body: { reason: 'manual' }, retry: true })), { status: 200, json: { ok: true } })
    assert.equal(stub.calls.length, 2, 'an idempotent POST that opts in is retried')
  } finally {
    stub.restore()
  }
  stub = sequenceFetch(retryAfter(503, 0), jsonResponse({ ok: true }))
  try {
    await assert.rejects(() => request(opts({ retry: false })), rtaError('unavailable'))
    assert.equal(stub.calls.length, 1, 'a GET can opt out')
  } finally {
    stub.restore()
  }
})

test('a Retry-After beyond the cap or beyond the remaining timeout is handed back instead of waited for', async () => {
  let stub = sequenceFetch(retryAfter(503, 30), jsonResponse({ ok: true }))
  try {
    await assert.rejects(() => request(opts()), rtaError('unavailable', (err) => assert.doesNotMatch(err.message, /retried/)))
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
  stub = sequenceFetch(retryAfter(503, 1), jsonResponse({ ok: true }))
  try {
    await assert.rejects(() => request(opts({ timeoutMs: 1200 })), rtaError('unavailable'))
    assert.equal(stub.calls.length, 1, 'one second of waiting would leave under 500 ms of a 1200 ms budget')
  } finally {
    stub.restore()
  }
})

test('a caller abort during the retry wait is reported as cancelled and issues no second request', async () => {
  const controller = new AbortController()
  const stub = sequenceFetch(retryAfter(503, 1), jsonResponse({ ok: true }))
  try {
    const pending = request(opts({ signal: controller.signal, timeoutMs: 5000 }))
    setTimeout(() => controller.abort(), 20)
    await assert.rejects(() => pending, rtaError('cancelled'))
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})

test('a network error on a GET is retried once after a short pause', async () => {
  const stub = sequenceFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'socket hang up' } }) }, jsonResponse({ ok: true }))
  try {
    assert.deepEqual(await request(opts()), { status: 200, json: { ok: true } })
    assert.equal(stub.calls.length, 2)
    assert.ok(stub.calls[1].at - stub.calls[0].at >= 200, 'paused before the retry')
  } finally {
    stub.restore()
  }
  const twice = sequenceFetch(() => { throw new TypeError('fetch failed') }, () => { throw new TypeError('fetch failed') })
  try {
    await assert.rejects(() => request(opts()), rtaError('network', (err) => assert.match(err.message, /\(retried once\)$/)))
    assert.equal(twice.calls.length, 2)
  } finally {
    twice.restore()
  }
})

test('the retry shares the original timeout: the second attempt gets only what is left', async () => {
  const stub = sequenceFetch(retryAfter(503, 0), (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(abortError()), { once: true })))
  try {
    const started = Date.now()
    await assert.rejects(() => request(opts({ timeoutMs: 700 })), rtaError('timeout', (err) => assert.match(err.message, /\(retried once\)$/)))
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 600 && elapsed < 1500, 'timed out after ' + elapsed + ' ms, not 2 × 700')
    assert.equal(stub.calls.length, 2)
  } finally {
    stub.restore()
  }
})
