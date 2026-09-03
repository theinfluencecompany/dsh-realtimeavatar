// Read-tool tests: the tool inventory, rta_status posture, the read wrappers'
// paths / headers / shape normalisation, argument validation before any
// request, cancellation (pre-aborted signal → empty value, no fetch) and
// exec-signal forwarding. No network: globalThis.fetch is stubbed per test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { buildRtaTools } from '../lib/tools/index.js'
import { resolveConfig } from '../lib/config.js'

const KEY = 'tic_test_' + 'x'.repeat(40)
const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))
const withKey = () => ({ credentials: undefined, env: { REALTIME_AVATAR_API_KEY: KEY } })
const noKey = () => ({ credentials: undefined, env: {} })
const deps = (overrides = {}, keySource = withKey) => ({ cfg: resolveConfig(overrides), keySource, randomUUID: () => 'uuid-fixed', skillsDir: SKILLS_DIR })

const ALL_TOOLS = [
  'rta_status', 'rta_balance', 'rta_capacity', 'rta_avatars', 'rta_avatar', 'rta_clips', 'rta_assets', 'rta_usage', 'rta_session_release',
  'rta_asset_remote', 'rta_avatar_update', 'rta_avatar_delete', 'rta_avatar_create', 'rta_loop_set', 'rta_clips_set', 'rta_session_mint',
  'rta_docs', 'rta_quickstart',
]
const WRITE_TOOLS = ['rta_asset_remote', 'rta_avatar_update', 'rta_avatar_delete', 'rta_avatar_create', 'rta_loop_set', 'rta_clips_set', 'rta_session_mint']
const READ_TOOLS = ALL_TOOLS.filter((n) => !WRITE_TOOLS.includes(n))

/** Wire fixtures (placeholders only). tenantId and fleet-internal fields must be dropped by the wrappers. */
const BALANCE = { availableCreditMicros: 1234000000, balanceCreditMicros: 1500000000, reservedCreditMicros: 266000000, lifetimeGrantedCreditMicros: 2000000000, lifetimeUsedCreditMicros: 500000000, updatedAt: '2026-09-01T00:00:00Z', tenantId: 'ten_test1' }
const CAPACITY = { max_sessions: 5, active_sessions: 1, reserved_sessions: 1, available_sessions: 3, queue_size: 0, admission_open: true, recommended_retry_ms: 2000, load: 0.4, capacity_pool: 'primary', agent_name: 'agent-x', worker_count: 2 }
const AVATAR = { id: 'ava_test1', displayName: 'Rin', status: 'ready', idleVideoStatus: 'ready', sourceKind: 'image', sourceAssetId: 'ast_test1', modelId: 'model-1', defaultVoiceId: 'voice-1', llm: { provider: 'gemini', model: 'model-x', extra: 'dropped' }, error: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', tenantId: 'ten_test1' }
const ASSET = { id: 'ast_test1', kind: 'image', status: 'ready', contentType: 'image/png', sizeBytes: 1024, publicUrl: 'https://example.com/a.png', createdAt: '2026-09-01T00:00:00Z', tenantId: 'ten_test1' }
/** Spec-shaped clip rows: `source` is a string, the prompt / upload asset / duration / error / poseCheck are top-level. */
const CLIPS = {
  avatarId: 'ava_test1',
  revision: 4,
  anchorVersion: 1,
  clipLibraryEligible: true,
  tenantId: 'ten_test1',
  data: [
    { clipId: 'idle-1', role: 'idle', status: 'ready', url: 'https://example.com/c.mp4', whenHint: null, source: 'generated', motionPrompt: 'rest', uploadAssetId: null, durationSeconds: 6, error: null, poseCheck: { ok: true } },
    { clipId: 'listen-1', role: 'listen', status: 'failed', url: null, whenHint: 'while the user talks', source: 'uploaded', motionPrompt: null, uploadAssetId: 'ast_test2', durationSeconds: null, error: { code: 'pose_mismatch', message: 'head turned away' } },
    { clipId: 'gesture-1', role: 'gesture', status: 'failed', url: null, whenHint: null, source: 'generated', motionPrompt: 'wave', durationSeconds: 5, error: 'render failed' },
  ],
}
const DOC_PAGE = '# Quickstart\n\n- Updated: 2026-09-01\n\n## Server half\n\n```ts\nconst server = 1\n```\n\n## Client half\n\n```tsx\nconst client = 1\n```\n\n---\nRealtime Avatar — Docs: https://realtimeavatar.ai/docs · Agent guide: https://realtimeavatar.ai/llms.txt'
const REACT_PAGE = '# React\n\n- Updated: 2026-09-01\n\n## Install\n\n```sh\nnpm install realtime-avatar\n```\n\n## The component\n\nprose\n\n```tsx\nconst component = 1\n```\n\n## React Native\n\n```tsx\nconst native = 1\n```\n\n---\nRealtime Avatar — Docs: https://realtimeavatar.ai/docs · Agent guide: https://realtimeavatar.ai/llms.txt'

/**
 * Route fetch by URL path + method. The handler receives { path, method, body, query, calls }
 * and returns { status?, body? } (JSON) or { status?, text } (raw). No body → empty response.
 * Every call is recorded as { url, path, method, headers, body, signal }.
 */
function routeFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    const parsed = new URL(href)
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ url: href, path: parsed.pathname, query: parsed.searchParams, method, headers: init.headers ?? {}, body, signal: init.signal })
    const out = (await handler({ path: parsed.pathname, method, body, query: parsed.searchParams, calls })) ?? {}
    const status = out.status ?? 200
    if (typeof out.text === 'string') return new Response(out.text, { status })
    if (out.body === undefined) return new Response(null, { status })
    return new Response(JSON.stringify(out.body), { status })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** A stub that must never be reached. */
function forbidFetch() {
  const original = globalThis.fetch
  let count = 0
  globalThis.fetch = async () => {
    count += 1
    throw new Error('fetch must not be reached in this test')
  }
  return { get count() { return count }, restore: () => { globalThis.fetch = original } }
}

function findTool(tools, name) {
  const tool = tools.find((t) => t.name === name)
  assert.ok(tool, 'missing tool ' + name)
  return tool
}

function abortedSignal() {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

test('buildRtaTools returns exactly the 18 rta_* tools, each with the full definition shape', () => {
  const tools = buildRtaTools(deps())
  assert.deepEqual(tools.map((t) => t.name), ALL_TOOLS)
  assert.equal(new Set(tools.map((t) => t.name)).size, 18)
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string', tool.name + ' description')
    assert.ok(tool.description.length > 0, tool.name + ' description is non-empty')
    assert.equal(tool.parameters.type, 'object', tool.name + ' parameters is object-rooted')
    assert.equal(typeof tool.parameters.properties, 'object', tool.name + ' parameters.properties')
    assert.equal(typeof tool.output.schema, 'object', tool.name + ' output.schema')
    assert.equal(typeof tool.output.render, 'function', tool.name + ' output.render')
    assert.equal(typeof tool.execute, 'function', tool.name + ' execute')
    assert.equal(typeof tool.timeoutMs, 'number', tool.name + ' timeoutMs')
    assert.ok(tool.timeoutMs > 0, tool.name + ' timeoutMs is positive')
  }
})

test('the 11 read tools (incl. the idempotent release) are concurrency-safe; the 7 writes stay exclusive', () => {
  const tools = buildRtaTools(deps())
  assert.equal(READ_TOOLS.length, 11)
  for (const name of READ_TOOLS) assert.equal(findTool(tools, name).isConcurrencySafe({}), true, name + ' is concurrency-safe')
  for (const name of WRITE_TOOLS) assert.equal(findTool(tools, name).isConcurrencySafe, undefined, name + ' declares no classifier')
})

test('timeouts derive from config: request timeout for API tools, ×2 for rta_status, docs timeout for the docs tools', () => {
  const tools = buildRtaTools(deps({ requestTimeoutMs: 7000, docsTimeoutMs: 9000 }))
  assert.equal(findTool(tools, 'rta_balance').timeoutMs, 7000)
  assert.equal(findTool(tools, 'rta_status').timeoutMs, 14000)
  assert.equal(findTool(tools, 'rta_session_release').timeoutMs, 7000)
  assert.equal(findTool(tools, 'rta_docs').timeoutMs, 9000)
  assert.equal(findTool(tools, 'rta_quickstart').timeoutMs, 9000)
})

test('rta_status without a key reports the posture, points at /rta setup and never fetches', async () => {
  const stub = forbidFetch()
  try {
    const tool = findTool(buildRtaTools(deps({}, noKey)), 'rta_status')
    const report = await tool.execute({}, {})
    assert.equal(report.plugin, 'dsh-realtimeavatar')
    assert.equal(report.key.configured, false)
    assert.equal(report.key.environment, 'none')
    assert.equal(report.key.ref, 'REALTIME_AVATAR_API_KEY')
    assert.match(report.errors.key, /no API key behind REALTIME_AVATAR_API_KEY/)
    assert.ok(report.next.some((hint) => hint.includes('/rta setup')), 'next[] points at /rta setup')
    assert.equal(report.balance, null)
    assert.equal(report.capacity, null)
    assert.equal(report.readOnly, false)
    assert.equal(report.writeApproval, true)
    assert.equal(report.maxSessionSeconds, 300)
    assert.equal(report.configError, undefined)
    assert.equal(stub.count, 0, 'no fetch without a key')
    const text = tool.output.render({}, report)[0].text
    assert.match(text, /NOT configured/)
    assert.match(text, /next: .*\/rta setup/)
  } finally {
    stub.restore()
  }
})

test('rta_status with a key fetches balance and capacity in parallel and maps micros → credits, snake → camel', async () => {
  let balanceIssuedWhile = 0
  const stub = routeFetch(async ({ path, calls }) => {
    if (path === '/api/v1/credits/balance') {
      await new Promise((resolve) => setImmediate(resolve))
      balanceIssuedWhile = calls.length
      return { body: BALANCE }
    }
    if (path === '/api/v1/realtime/livekit/capacity') return { body: CAPACITY }
    return { status: 404, body: { error: 'no route ' + path } }
  })
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_status')
    const report = await tool.execute({}, {})
    assert.equal(stub.calls.length, 2)
    assert.deepEqual(stub.calls.map((c) => c.path).sort(), ['/api/v1/credits/balance', '/api/v1/realtime/livekit/capacity'])
    assert.equal(balanceIssuedWhile, 2, 'both requests were in flight before the first one answered')
    for (const call of stub.calls) {
      assert.equal(call.method, 'GET')
      assert.equal(call.headers.Authorization, 'Bearer ' + KEY)
      assert.equal(call.body, undefined)
    }
    assert.equal(report.key.configured, true)
    assert.equal(report.key.environment, 'test')
    assert.equal(report.key.source, 'process-env')
    assert.equal(report.balance.availableCredits, 1234)
    assert.equal(report.balance.approxMinutesAvailable, 20)
    assert.equal(report.balance.balanceCredits, 1500)
    assert.equal(report.balance.reservedCredits, 266)
    assert.equal(report.balance.lifetimeGrantedCredits, 2000)
    assert.equal(report.balance.lifetimeUsedCredits, 500)
    assert.deepEqual(report.capacity, { maxSessions: 5, activeSessions: 1, reservedSessions: 1, availableSessions: 3, queueSize: 0, admissionOpen: true, recommendedRetryMs: 2000, load: 0.4 })
    const serialised = JSON.stringify(report)
    for (const forbidden of ['capacity_pool', 'agent_name', 'worker_count', 'tenantId', 'primary', 'agent-x', KEY]) {
      assert.ok(!serialised.includes(forbidden), 'report never carries ' + forbidden)
    }
    assert.deepEqual(report.errors, {})
    assert.match(report.next[0], /Ready/)
    const text = tool.output.render({}, report)[0].text
    assert.match(text, /credits: 1234 available \(266 reserved of 1500\), ≈ 20 min on air/)
    assert.match(text, /capacity: 3 free of 5 slots, queue 0, admission open/)
    assert.match(text, /environment tag test/)
    assert.ok(!text.includes(KEY), 'rendered status never contains the key')
  } finally {
    stub.restore()
  }
})

test('rta_status isolates a failing balance call into errors.balance while capacity still returns', async () => {
  const stub = routeFetch(({ path }) => {
    if (path === '/api/v1/credits/balance') return { status: 401, body: { error: 'rejected ' + KEY } }
    return { body: CAPACITY }
  })
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_status')
    const report = await tool.execute({}, {})
    assert.equal(report.balance, null)
    assert.match(report.errors.balance, /rejected/)
    assert.match(report.errors.balance, /HTTP 401/)
    assert.ok(!report.errors.balance.includes(KEY), 'the error is redacted')
    assert.equal(report.errors.capacity, undefined)
    assert.equal(report.capacity.availableSessions, 3)
    assert.match(report.next[0], /key was rejected/)
    const text = tool.output.render({}, report)[0].text
    assert.match(text, /credits: unavailable/)
    assert.ok(!text.includes(KEY))
  } finally {
    stub.restore()
  }
})

test('rta_status with zero credits points at the pricing page; a failing capacity call is isolated too', async () => {
  const stub = routeFetch(({ path }) => {
    if (path === '/api/v1/credits/balance') return { body: { ...BALANCE, availableCreditMicros: 0 } }
    return { status: 503, body: { error: 'down' } }
  })
  try {
    const report = await findTool(buildRtaTools(deps()), 'rta_status').execute({}, {})
    assert.equal(report.balance.availableCredits, 0)
    assert.equal(report.capacity, null)
    assert.match(report.errors.capacity, /HTTP 503/)
    assert.match(report.next[0], /No credits available/)
  } finally {
    stub.restore()
  }
})

test('rta_status reports a throwing credential store as errors.key and points at the store, without fetching', async () => {
  const stub = forbidFetch()
  try {
    const store = () => ({
      credentials: {
        async resolve() {
          throw new Error('keyring daemon unreachable for ' + KEY)
        },
        async describe() {
          throw new Error('keyring daemon unreachable for ' + KEY)
        },
        async set() {},
        async unset() {},
      },
      env: { REALTIME_AVATAR_API_KEY: KEY },
    })
    const tool = findTool(buildRtaTools(deps({}, store)), 'rta_status')
    const report = await tool.execute({}, {})
    assert.deepEqual(report.key, { ref: 'REALTIME_AVATAR_API_KEY', configured: false, source: 'unknown', environment: 'none' })
    assert.equal(report.errors.key, 'the credential store failed: keyring daemon unreachable for tic_test_<redacted>')
    assert.equal(report.next.length, 1)
    assert.match(report.next[0], /Check the harness credential store, or export REALTIME_AVATAR_API_KEY/)
    assert.equal(report.balance, null)
    assert.equal(report.capacity, null)
    assert.equal(stub.count, 0, 'a broken store never leads to a request')
    assert.ok(!JSON.stringify(report).includes(KEY))
    const text = tool.output.render({}, report)[0].text
    assert.match(text, /- key problem: the credential store failed: keyring daemon unreachable/)
    assert.match(text, /- next: Check the harness credential store/)
  } finally {
    stub.restore()
  }
})

test('rta_status with a balance that lacks availableCreditMicros says the balance is unavailable rather than "No credits"', async () => {
  const stub = routeFetch(({ path }) => (path === '/api/v1/credits/balance' ? { body: { updatedAt: '2026-09-01T00:00:00Z' } } : { body: CAPACITY }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_status')
    const report = await tool.execute({}, {})
    assert.equal(report.balance.availableCredits, null)
    assert.equal(report.balance.approxMinutesAvailable, null)
    assert.equal(report.errors.balance, undefined)
    assert.equal(report.next.length, 1)
    assert.match(report.next[0], /^Balance unavailable \(unexpected response shape\); the key works/)
    assert.doesNotMatch(report.next[0], /No credits/)
    assert.match(tool.output.render({}, report)[0].text, /- credits: unknown available \(unknown reserved of unknown\), ≈ unknown min on air/)
  } finally {
    stub.restore()
  }
})

test('the rta_status render is total for partial or malformed values', () => {
  const tool = findTool(buildRtaTools(deps()), 'rta_status')
  const text = (value) => tool.output.render({}, value)[0].text
  assert.match(text({ version: 7, key: { ref: 'R', configured: true, source: 'file', environment: 'live' }, balance: { availableCredits: 'many', reservedCredits: null }, capacity: { availableSessions: 'three', admissionOpen: 'yes' }, readOnly: 'no', writeApproval: false, maxSessionSeconds: '300', next: 'not an array' }), /^Realtime Avatar status \(dsh-realtimeavatar 7\)\n- API key \(R\): configured via file, environment tag live\n- credits: unknown available \(unknown reserved of unknown\), ≈ unknown min on air\n- capacity: unknown free of unknown slots, queue unknown, admission unknown\n- writes: free writes ungated; credit-spending tools still ask; session cap unknown s$/)
  assert.match(text({ key: null, errors: { key: 'k', balance: 'b', capacity: 'c' }, balance: 'nope', capacity: 42, readOnly: true }), /^Realtime Avatar status \(dsh-realtimeavatar \?\)\n- API key \(\?\): NOT configured\n- key problem: k\n- credits: unavailable — b\n- capacity: unavailable — c\n- writes: disabled \(readOnly\); session cap unknown s$/)
  assert.match(text({ configError: 'bad', errors: {}, next: [1, null, 'go'] }), /- config error: bad \(defaults in effect\)[\s\S]*- next: 1\n- next: null\n- next: go$/)
  for (const value of [undefined, null, 'x', 0, [], { balance: [], capacity: [] }]) assert.equal(typeof text(value), 'string')
})

test('read tool contracts: rta_capacity is informational only and the balance / capacity / avatar schemas declare their required keys', () => {
  const tools = buildRtaTools(deps())
  assert.match(findTool(tools, 'rta_capacity').description, /Informational only/)
  assert.match(findTool(tools, 'rta_capacity').description, /never gate a call on it/)
  assert.deepEqual(findTool(tools, 'rta_balance').output.schema.required, ['availableCredits', 'approxMinutesAvailable'])
  assert.deepEqual(findTool(tools, 'rta_capacity').output.schema.required, ['availableSessions', 'queueSize', 'admissionOpen'])
  assert.deepEqual(findTool(tools, 'rta_avatar').output.schema.required, ['id', 'displayName', 'status', 'idleVideoStatus'])
  assert.deepEqual(findTool(tools, 'rta_avatars').output.schema.properties.avatars.items.required, ['id', 'displayName', 'status', 'idleVideoStatus'])
  assert.deepEqual(findTool(tools, 'rta_avatars').output.schema.required, ['count', 'avatars'])
  assert.deepEqual(findTool(tools, 'rta_status').output.schema.required, ['plugin', 'version', 'key', 'readOnly', 'writeApproval', 'maxSessionSeconds', 'balance', 'capacity', 'errors', 'next'])
  assert.deepEqual(findTool(tools, 'rta_usage').output.schema.required, ['sessions', 'totals'])
  assert.deepEqual(findTool(tools, 'rta_clips').output.schema.required, ['avatarId', 'clips'])
})

test('rta_status surfaces a configError from deps and renders it', async () => {
  const stub = forbidFetch()
  try {
    const tool = findTool(buildRtaTools({ ...deps({}, noKey), configError: 'maxSessionSeconds must be a positive number.' }), 'rta_status')
    const report = await tool.execute({}, {})
    assert.equal(report.configError, 'maxSessionSeconds must be a positive number.')
    assert.match(tool.output.render({}, report)[0].text, /config error: maxSessionSeconds/)
  } finally {
    stub.restore()
  }
})

test('the simple GET tools hit the documented paths with the bearer key and drop tenantId', async () => {
  const stub = routeFetch(({ path }) => {
    switch (path) {
      case '/api/v1/credits/balance': return { body: BALANCE }
      case '/api/v1/realtime/livekit/capacity': return { body: CAPACITY }
      case '/api/v1/avatars': return { body: { data: [AVATAR, { ...AVATAR, id: 'ava_test2', status: 'failed', error: 'bad portrait', llm: undefined }] } }
      case '/api/v1/avatars/ava_test1': return { body: AVATAR }
      case '/api/v1/avatars/ava_test1/clips': return { body: CLIPS }
      case '/api/v1/assets': return { body: { data: [ASSET] } }
      default: return { status: 404, body: { error: 'no route ' + path } }
    }
  })
  try {
    const tools = buildRtaTools(deps())
    const cases = [
      ['rta_balance', {}, '/api/v1/credits/balance'],
      ['rta_capacity', {}, '/api/v1/realtime/livekit/capacity'],
      ['rta_avatars', {}, '/api/v1/avatars'],
      ['rta_avatar', { avatarId: 'ava_test1' }, '/api/v1/avatars/ava_test1'],
      ['rta_clips', { avatarId: 'ava_test1' }, '/api/v1/avatars/ava_test1/clips'],
      ['rta_assets', {}, '/api/v1/assets'],
    ]
    const results = {}
    for (const [name, args, path] of cases) {
      const before = stub.calls.length
      results[name] = await findTool(tools, name).execute(args, {})
      assert.equal(stub.calls.length, before + 1, name + ' issues exactly one request')
      const call = stub.calls[before]
      assert.equal(call.path, path, name + ' path')
      assert.equal(call.method, 'GET', name + ' method')
      assert.equal(call.headers.Authorization, 'Bearer ' + KEY, name + ' bearer')
      assert.equal(call.headers.Accept, 'application/json')
      assert.equal(call.headers['User-Agent'], 'dsh-realtimeavatar/0.1.0')
      assert.equal(call.body, undefined, name + ' sends no body')
      assert.ok(!JSON.stringify(results[name]).includes('tenantId'), name + ' drops tenantId')
    }
    assert.equal(results.rta_balance.availableCredits, 1234)
    assert.equal(results.rta_balance.updatedAt, '2026-09-01T00:00:00Z')
    assert.equal(results.rta_capacity.availableSessions, 3)
    assert.equal(results.rta_avatars.count, 2)
    assert.equal(results.rta_avatars.avatars[0].id, 'ava_test1')
    assert.equal(results.rta_avatars.avatars[1].error, 'bad portrait')
    assert.deepEqual(results.rta_avatars.avatars[0].llm, { provider: 'gemini', model: 'model-x' }, 'llm is narrowed to provider + model')
    assert.equal(results.rta_avatars.avatars[1].llm, null, 'no llm on the wire → null')
    assert.equal(results.rta_avatar.id, 'ava_test1')
    assert.equal(results.rta_avatar.defaultVoiceId, 'voice-1')
    assert.deepEqual(results.rta_avatar.llm, { provider: 'gemini', model: 'model-x' })
    assert.equal(results.rta_clips.avatarId, 'ava_test1')
    assert.equal(results.rta_clips.revision, 4)
    assert.equal(results.rta_clips.anchorVersion, 1)
    assert.equal(results.rta_clips.clipLibraryEligible, true)
    assert.equal(results.rta_clips.clips.length, 3)
    assert.deepEqual(results.rta_clips.clips[0], { clipId: 'idle-1', role: 'idle', status: 'ready', url: 'https://example.com/c.mp4', whenHint: null, source: 'generated', motionPrompt: 'rest', uploadAssetId: null, durationSeconds: 6, error: null, poseCheck: { ok: true } })
    assert.deepEqual(results.rta_clips.clips[1], { clipId: 'listen-1', role: 'listen', status: 'failed', url: null, whenHint: 'while the user talks', source: 'uploaded', motionPrompt: null, uploadAssetId: 'ast_test2', durationSeconds: null, error: { code: 'pose_mismatch', message: 'head turned away' }, poseCheck: null })
    assert.deepEqual(results.rta_clips.clips[2].error, { code: null, message: 'render failed' }, 'a string error becomes { code: null, message }')
    assert.equal(results.rta_clips.clips[2].poseCheck, null, 'absent poseCheck → null')
    assert.equal(results.rta_assets.count, 1)
    assert.equal(results.rta_assets.assets[0].publicUrl, 'https://example.com/a.png')
    assert.match(findTool(tools, 'rta_avatars').output.render({}, results.rta_avatars)[0].text, /2 avatar\(s\):\n- ava_test1 "Rin" status=ready/)
    assert.match(findTool(tools, 'rta_clips').output.render({}, results.rta_clips)[0].text, /clip library of ava_test1 \(revision 4\): 3 clip\(s\)\n- idle-1 role=idle status=ready\n- listen-1 role=listen status=failed when="while the user talks"/)
    assert.match(findTool(tools, 'rta_assets').output.render({}, results.rta_assets)[0].text, /ast_test1 image ready image\/png 1024 B/)
    assert.match(findTool(tools, 'rta_balance').output.render({}, results.rta_balance)[0].text, /credits: 1234 available, 266 reserved, balance 1500/)
  } finally {
    stub.restore()
  }
})

test('rta_avatar adds a status-dependent hint', async () => {
  let status = 'ready'
  const stub = routeFetch(() => ({ body: { ...AVATAR, status, error: status === 'failed' ? 'portrait rejected' : null } }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_avatar')
    const ready = await tool.execute({ avatarId: 'ava_test1' }, {})
    assert.match(ready.hint, /ready: mint calls against it/)
    status = 'preprocessing'
    const pending = await tool.execute({ avatarId: 'ava_test1' }, {})
    assert.match(pending.hint, /still generating: poll rta_avatar/)
    status = 'failed'
    const failed = await tool.execute({ avatarId: 'ava_test1' }, {})
    assert.match(failed.hint, /generation failed/)
    assert.equal(failed.error, 'portrait rejected')
    assert.match(tool.output.render({}, failed)[0].text, /status=failed.*error=portrait rejected\ngeneration failed/s)
    status = 'draft'
    const draft = await tool.execute({ avatarId: 'ava_test1' }, {})
    assert.equal(draft.hint, 'status draft')
  } finally {
    stub.restore()
  }
})

test('rta_avatar and rta_clips reject an invalid or missing avatarId before any request', async () => {
  const stub = forbidFetch()
  try {
    const tools = buildRtaTools(deps())
    for (const name of ['rta_avatar', 'rta_clips']) {
      const tool = findTool(tools, name)
      await assert.rejects(() => tool.execute({ avatarId: '../x' }, {}), /avatarId is invalid/, name + ' rejects a path-traversal id')
      await assert.rejects(() => tool.execute({ avatarId: 'ava test1' }, {}), /avatarId is invalid/, name + ' rejects spaces')
      await assert.rejects(() => tool.execute({ avatarId: 'ava/test1' }, {}), /avatarId is invalid/, name + ' rejects a slash')
      await assert.rejects(() => tool.execute({}, {}), /avatarId is required/, name + ' requires avatarId')
      await assert.rejects(() => tool.execute({ avatarId: 42 }, {}), /avatarId must be a string/, name + ' rejects a non-string')
    }
    assert.equal(stub.count, 0)
  } finally {
    stub.restore()
  }
})

test('read tools need a usable key: a missing or malformed key is a coded error, never echoed, and never fetched', async () => {
  const stub = forbidFetch()
  try {
    await assert.rejects(() => findTool(buildRtaTools(deps({}, noKey)), 'rta_balance').execute({}, {}), (error) => error.code === 'RTA_KEY_MISSING' && /no Realtime Avatar API key behind REALTIME_AVATAR_API_KEY/.test(error.message))
    const badKey = () => ({ credentials: undefined, env: { REALTIME_AVATAR_API_KEY: 'not-a-key-value' } })
    await assert.rejects(() => findTool(buildRtaTools(deps({}, badKey)), 'rta_avatars').execute({}, {}), (error) => error.code === 'RTA_KEY_INVALID' && !error.message.includes('not-a-key-value'))
    assert.equal(stub.count, 0)
  } finally {
    stub.restore()
  }
})

test('API failures surface as coded, redacted errors (401 → auth, 404 → not_found)', async () => {
  const stub = routeFetch(({ path }) => (path.endsWith('/balance') ? { status: 401, body: { error: 'denied for ' + KEY } } : { status: 404, body: { error: 'no such avatar', code: 'avatar_not_found' } }))
  try {
    const tools = buildRtaTools(deps())
    await assert.rejects(() => findTool(tools, 'rta_balance').execute({}, {}), (error) => error.kind === 'auth' && error.status === 401 && !error.message.includes(KEY) && /run \/rta status/.test(error.message))
    await assert.rejects(() => findTool(tools, 'rta_avatar').execute({ avatarId: 'ava_test1' }, {}), (error) => error.kind === 'not_found' && error.code === 'avatar_not_found' && /wrong or deleted id/.test(error.message))
  } finally {
    stub.restore()
  }
})

test('rta_usage builds the query string, maps the spec rows, settles totals on released/failed rows only and notes the 90-day clamp', async () => {
  // Spec rows (camelCase): sessionId, avatarId, avatarName, status, startedAt, endedAt, activeSeconds,
  // billedCreditMicros, metadata (the user tag lives in metadata.user_id), createdAt.
  const stub = routeFetch(() => ({
    body: {
      data: [
        { sessionId: 'ses_test1', avatarId: 'ava_test1', avatarName: 'Rin', status: 'released', startedAt: '2026-08-01T00:00:00Z', endedAt: '2026-08-01T00:05:00Z', activeSeconds: 300, billedCreditMicros: 300000000, metadata: { user_id: 'u1', plan: 'free' }, createdAt: '2026-08-01T00:00:00Z', tenantId: 'ten_test1' },
        { sessionId: 'ses_test2', avatarId: 'ava_test1', avatarName: 'Rin', status: 'failed', startedAt: '2026-08-02T00:00:00Z', endedAt: null, activeSeconds: 12, billedCreditMicros: 12500000, metadata: { userId: 'u1' } },
        { sessionId: 'ses_test3', avatarId: 'ava_test1', avatarName: 'Rin', status: 'started', startedAt: '2026-08-03T00:00:00Z', endedAt: null, activeSeconds: 999, billedCreditMicros: 999000000, metadata: { user_id: 'u1' } },
        { sessionId: 'ses_test4', avatarId: 'ava_test1', avatarName: null, status: 'reserved', startedAt: null, endedAt: null, activeSeconds: null, billedCreditMicros: null },
      ],
      nextCursor: 'cur_next',
      from: '2026-07-01T00:00:00Z',
      to: '2026-09-01T00:00:00Z',
    },
  }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_usage')
    const out = await tool.execute({ from: '2026-07-01T00:00:00Z', to: '2026-09-01T00:00:00Z', limit: 50, cursor: 'cur_prev', endUserId: 'u1' }, {})
    const call = stub.calls[0]
    assert.equal(call.path, '/api/v1/usage/sessions')
    assert.equal(call.method, 'GET')
    assert.deepEqual(Object.fromEntries(call.query), { from: '2026-07-01T00:00:00Z', to: '2026-09-01T00:00:00Z', limit: '50', cursor: 'cur_prev', endUserId: 'u1' })
    assert.equal(out.sessions.length, 4)
    assert.deepEqual(out.sessions[0], { sessionId: 'ses_test1', avatarId: 'ava_test1', avatarName: 'Rin', status: 'released', startedAt: '2026-08-01T00:00:00Z', endedAt: '2026-08-01T00:05:00Z', activeSeconds: 300, billedCredits: 300, endUserId: 'u1', metadata: { user_id: 'u1', plan: 'free' } })
    assert.equal(out.sessions[1].billedCredits, 12.5, 'micros → credits, three decimals')
    assert.equal(out.sessions[1].endUserId, 'u1', 'metadata.userId is accepted as a fallback for the user tag')
    assert.deepEqual(out.sessions[3], { sessionId: 'ses_test4', avatarId: 'ava_test1', avatarName: null, status: 'reserved', startedAt: null, endedAt: null, activeSeconds: null, billedCredits: null, endUserId: null, metadata: {} })
    assert.ok(!JSON.stringify(out).includes('tenantId'))
    assert.ok(!JSON.stringify(out).includes('billableSeconds'), 'the old billableSeconds field is gone from the rows')
    assert.deepEqual(out.totals, { count: 4, settledCount: 2, activeSeconds: 312, billedCredits: 312.5 })
    assert.equal(out.nextCursor, 'cur_next')
    assert.match(out.note, /clamped to 90 days/)
    assert.match(out.note, /released\/failed rows only/)
    assert.match(tool.output.render({}, out)[0].text, /4 session\(s\) from 2026-07-01T00:00:00Z to 2026-09-01T00:00:00Z: 312 active s, 312.5 credits \(settled rows only\); more pages/)

    await tool.execute({}, {})
    assert.equal([...stub.calls[1].query.keys()].length, 0, 'no query params when nothing is given')
    await assert.rejects(() => tool.execute({ limit: 0 }, {}), /limit must be between 1 and 200/)
    await assert.rejects(() => tool.execute({ limit: 201 }, {}), /limit must be between 1 and 200/)
    await assert.rejects(() => tool.execute({ limit: '5' }, {}), /limit must be an integer/)
    assert.equal(stub.calls.length, 2)
  } finally {
    stub.restore()
  }
})

test('rta_session_release needs sessionId or queueTicketId, defaults reason to manual and posts snake_case', async () => {
  const stub = routeFetch(() => ({ status: 204 }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_session_release')
    await assert.rejects(() => tool.execute({}, {}), /needs sessionId or queueTicketId/)
    await assert.rejects(() => tool.execute({ sessionId: 'ses_test1', reason: 'because' }, {}), /reason must be one of: page_hide, disconnected, superseded, unmount, manual, idle_timeout/)
    await assert.rejects(() => tool.execute({ sessionId: 'ses test1' }, {}), /sessionId is invalid/)
    await assert.rejects(() => tool.execute({ queueTicketId: '../x' }, {}), /queueTicketId is invalid/)
    assert.equal(stub.calls.length, 0, 'validation happens before any request')

    const bySession = await tool.execute({ sessionId: 'ses_test1' }, {})
    assert.equal(stub.calls[0].path, '/api/v1/realtime/livekit/session/release')
    assert.equal(stub.calls[0].method, 'POST')
    assert.equal(stub.calls[0].headers['Content-Type'], 'application/json')
    assert.deepEqual(stub.calls[0].body, { session_id: 'ses_test1', reason: 'manual' })
    assert.equal(bySession.ok, true)
    assert.equal(bySession.sessionId, 'ses_test1')
    assert.equal(bySession.reason, 'manual')
    assert.equal(bySession.queueTicketId, undefined)
    assert.equal(tool.output.render({}, bySession)[0].text, 'released ses_test1')

    const byTicket = await tool.execute({ queueTicketId: 'qt_test1', reason: 'page_hide' }, {})
    assert.deepEqual(stub.calls[1].body, { queue_ticket_id: 'qt_test1', reason: 'page_hide' })
    assert.equal(byTicket.reason, 'page_hide')
    assert.equal(tool.output.render({}, byTicket)[0].text, 'released qt_test1')
    assert.equal(tool.output.render({}, { ok: false })[0].text, 'release not confirmed')
  } finally {
    stub.restore()
  }
})

test('a pre-aborted exec signal makes every read tool settle with its empty value and issue no request', async () => {
  const stub = forbidFetch()
  try {
    const tools = buildRtaTools(deps())
    const exec = { signal: abortedSignal() }
    const cases = [
      ['rta_balance', {}, { availableCredits: null, reservedCredits: null, balanceCredits: null, approxMinutesAvailable: null }],
      ['rta_capacity', {}, { availableSessions: null, queueSize: null, admissionOpen: null }],
      ['rta_avatars', {}, { count: 0, avatars: [] }],
      ['rta_avatar', { avatarId: 'ava_test1' }, { id: 'ava_test1', displayName: null, status: null, idleVideoStatus: null }],
      ['rta_clips', { avatarId: 'ava_test1' }, { avatarId: 'ava_test1', revision: null, clips: [] }],
      ['rta_assets', {}, { count: 0, assets: [] }],
      ['rta_usage', { limit: 5 }, { sessions: [], nextCursor: null, from: null, to: null, totals: { count: 0, settledCount: 0, activeSeconds: 0, billedCredits: 0 } }],
    ]
    for (const [name, args, empty] of cases) {
      assert.deepEqual(await findTool(tools, name).execute(args, exec), empty, name + ' settles with its empty value')
    }
    const release = await findTool(tools, 'rta_session_release').execute({ sessionId: 'ses_test1' }, exec)
    assert.equal(release.ok, false)
    assert.equal(release.sessionId, 'ses_test1')
    const status = await findTool(tools, 'rta_status').execute({}, exec)
    assert.equal(status.balance, null)
    assert.equal(status.capacity, null)
    assert.equal(status.key.configured, true)
    const docs = await findTool(tools, 'rta_docs').execute({ page: 'quickstart' }, exec)
    assert.equal(docs.markdown, '')
    assert.equal(docs.chars, 0)
    assert.equal(docs.page, 'quickstart')
    const quickstart = await findTool(tools, 'rta_quickstart').execute({ framework: 'express' }, exec)
    assert.equal(quickstart.source, 'cancelled')
    assert.equal(quickstart.framework, 'express')
    assert.equal(stub.count, 0, 'a pre-aborted signal never reaches fetch')
  } finally {
    stub.restore()
  }
})

test('a cancellation mid-flight settles with the empty value; other failures still throw', async () => {
  const controller = new AbortController()
  const stub = routeFetch(() => {
    controller.abort()
    return { status: 500, body: { error: 'simulated failure after abort' } }
  })
  try {
    const out = await findTool(buildRtaTools(deps()), 'rta_avatars').execute({}, { signal: controller.signal })
    assert.deepEqual(out, { count: 0, avatars: [] })
  } finally {
    stub.restore()
  }
  const failing = routeFetch(() => ({ status: 500, body: { error: 'boom' } }))
  try {
    await assert.rejects(() => findTool(buildRtaTools(deps()), 'rta_avatars').execute({}, { signal: new AbortController().signal }), /boom \(HTTP 500\)/)
  } finally {
    failing.restore()
  }
})

test('every read tool forwards exec.signal: the fetch signal is an AbortSignal that follows the exec signal', async () => {
  const stub = routeFetch(({ path }) => {
    if (path.startsWith('/api/')) {
      if (path.endsWith('/balance')) return { body: BALANCE }
      if (path.endsWith('/capacity')) return { body: CAPACITY }
      if (path.endsWith('/avatars')) return { body: { data: [AVATAR] } }
      if (path.endsWith('/avatars/ava_test1')) return { body: AVATAR }
      if (path.endsWith('/clips')) return { body: { avatarId: 'ava_test1', revision: 1, data: [] } }
      if (path.endsWith('/assets')) return { body: { data: [ASSET] } }
      if (path.endsWith('/usage/sessions')) return { body: { data: [] } }
      if (path.endsWith('/release')) return { status: 204 }
      return { status: 404, body: { error: 'no route ' + path } }
    }
    return { text: DOC_PAGE }
  })
  try {
    const tools = buildRtaTools(deps())
    const cases = [
      ['rta_status', {}, 2],
      ['rta_balance', {}, 1],
      ['rta_capacity', {}, 1],
      ['rta_avatars', {}, 1],
      ['rta_avatar', { avatarId: 'ava_test1' }, 1],
      ['rta_clips', { avatarId: 'ava_test1' }, 1],
      ['rta_assets', {}, 1],
      ['rta_usage', {}, 1],
      ['rta_session_release', { sessionId: 'ses_test1' }, 1],
      ['rta_docs', { page: 'quickstart' }, 1],
      ['rta_quickstart', { framework: 'express' }, 1],
    ]
    for (const [name, args, expectedCalls] of cases) {
      const before = stub.calls.length
      const controller = new AbortController()
      await findTool(tools, name).execute(args, { signal: controller.signal })
      const mine = stub.calls.slice(before)
      assert.equal(mine.length, expectedCalls, name + ' request count')
      for (const call of mine) {
        assert.ok(call.signal instanceof AbortSignal, name + ' passes an AbortSignal to fetch')
        assert.equal(call.signal.aborted, false, name + ' signal is live during the call')
      }
      controller.abort()
      for (const call of mine) assert.equal(call.signal.aborted, true, name + ' fetch signal follows the exec signal')
    }
  } finally {
    stub.restore()
  }
})

test('rta_docs fetches the public page unauthenticated, strips the footer, extracts a heading and reports the update date', async () => {
  const stub = routeFetch(() => ({ text: DOC_PAGE }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_docs')
    const out = await tool.execute({ page: 'quickstart' }, {})
    assert.equal(stub.calls[0].url, 'https://realtimeavatar.ai/docs/quickstart.md')
    assert.equal(stub.calls[0].headers.Authorization, undefined, 'docs never carry the key')
    assert.equal(out.page, 'quickstart')
    assert.equal(out.updated, '2026-09-01')
    assert.equal(out.truncated, false)
    assert.ok(!out.markdown.includes('Realtime Avatar — Docs:'), 'footer stripped')
    assert.equal(out.chars, out.markdown.length)
    const section = await tool.execute({ page: 'quickstart', heading: 'client half' }, {})
    assert.match(section.markdown, /^## Client half/)
    assert.ok(!section.markdown.includes('Server half'))
    await assert.rejects(() => tool.execute({ page: 'quickstart', heading: 'nope' }, {}), /no heading "nope"/)
    await assert.rejects(() => tool.execute({ page: 'https://evil.example/x' }, {}), /unknown docs page/)
    await assert.rejects(() => tool.execute({}, {}), /page is required/)
    assert.match(tool.output.render({}, out)[0].text, /^# quickstart — https:\/\/realtimeavatar\.ai\/docs\/quickstart \(updated 2026-09-01\)/)
  } finally {
    stub.restore()
  }
})

test('rta_quickstart extracts the server/client skeletons from the live page and falls back to the shipped snapshot offline', async () => {
  const live = routeFetch(() => ({ text: DOC_PAGE }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_quickstart')
    const out = await tool.execute({ framework: 'express' }, {})
    assert.equal(out.source, 'live')
    assert.equal(out.serverSkeleton, 'const server = 1')
    assert.equal(out.clientSkeleton, 'const client = 1')
    assert.equal(out.envVar, 'REALTIME_AVATAR_API_KEY')
    assert.equal(out.exampleAvatarId, 'seed-rin-ashfall')
    assert.equal(out.steps.length, 6)
    assert.match(tool.output.render({}, out)[0].text, /^# Quickstart for express \(live\)/)
    await assert.rejects(() => tool.execute({ framework: 'rails' }, {}), /framework must be one of/)
    await assert.rejects(() => tool.execute({}, {}), /framework is required/)
  } finally {
    live.restore()
  }
  const offline = routeFetch(() => ({ status: 503, body: { error: 'down' } }))
  try {
    const out = await findTool(buildRtaTools(deps()), 'rta_quickstart').execute({ framework: 'express' }, {})
    assert.equal(out.source, 'snapshot')
    assert.match(out.markdown, /From the shipped snapshot/)
  } finally {
    offline.restore()
  }
})

test('rta_quickstart for react is the client half only: no server skeleton, the component and React Native skeletons, a react-specific step', async () => {
  const live = routeFetch(() => ({ text: REACT_PAGE }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_quickstart')
    const out = await tool.execute({ framework: 'react' }, {})
    assert.equal(live.calls[0].url, 'https://realtimeavatar.ai/docs/react.md')
    assert.equal(out.source, 'live')
    assert.equal(out.docsUrl, 'https://realtimeavatar.ai/docs/react')
    assert.equal(out.serverSkeleton, null)
    assert.equal(out.clientSkeleton, 'const component = 1', 'from the "The component" section, not the install block')
    assert.equal(out.reactNativeSkeleton, 'const native = 1')
    assert.equal(out.steps.length, 6)
    assert.match(out.steps[2], /^React is the client half only: pair it with one of the server adapters \(nextjs, tanstack-start, express, hono\)/)
    assert.ok(!out.steps.some((s) => /Mount the server half/.test(s)))
    const express = await tool.execute({ framework: 'express' }, {})
    assert.equal('reactNativeSkeleton' in express, false, 'only react carries the extra skeleton')
    assert.match(express.steps[2], /^Mount the server half/)
    const hono = await tool.execute({ framework: 'hono' }, {})
    assert.match(hono.steps[2], /on Workers pass apiKey as a factory/)
    assert.match(tool.output.render({}, out)[0].text, /^# Quickstart for react \(live\)/)
  } finally {
    live.restore()
  }
  const pageWithoutComponent = routeFetch(() => ({ text: '# React\n\n## Install\n\n```sh\nnpm i\n```\n' }))
  try {
    const out = await findTool(buildRtaTools(deps()), 'rta_quickstart').execute({ framework: 'react' }, {})
    assert.equal(out.clientSkeleton, null)
    assert.equal(out.reactNativeSkeleton, null)
  } finally {
    pageWithoutComponent.restore()
  }
})

test('rta_quickstart gives the live fetch a budget of max(1000, docsTimeoutMs - 1500) so the snapshot fallback stays reachable', async (t) => {
  // docsTimeoutMs clamps to 5000 at the floor → the live fetch is abandoned after 3500 ms, well inside the tool deadline.
  // Mocked setTimeout: the 3500 ms budget is ticked through instead of waited for.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const hanging = routeFetch(({ path }) => {
    if (path.startsWith('/api/')) return { status: 404, body: { error: 'no route' } }
    return new Promise((resolve, reject) => {
      hanging.calls.at(-1).signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
  })
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  try {
    const tool = findTool(buildRtaTools(deps({ docsTimeoutMs: 5000 })), 'rta_quickstart')
    assert.equal(tool.timeoutMs, 5000)
    let settled = false
    const pending = tool.execute({ framework: 'express' }, {}).finally(() => { settled = true })
    await flush()
    assert.equal(hanging.calls.length, 1, 'the live fetch was issued')
    t.mock.timers.tick(3499)
    await flush()
    assert.equal(settled, false, 'still waiting for the live page at 3499 ms')
    t.mock.timers.tick(1)
    const out = await pending
    assert.equal(out.source, 'snapshot')
    assert.match(out.markdown, /From the shipped snapshot/)
    assert.equal(hanging.calls.length, 1, 'no second fetch after the budget ran out')
  } finally {
    hanging.restore()
  }
})

test('render() is total for every tool: undefined/null/{}/[]/string/number/partials never throw', () => {
  const tools = buildRtaTools(deps())
  assert.equal(tools.length, 18)
  const values = [undefined, null, {}, [], 'str', 42, { avatars: [null, 3] }, { clips: 'x' }, { totals: null }, { steps: 'x' }, { status: 'queued' }, { status: 'ready' }, { assets: [null] }, { plugin: 'x', key: {}, errors: {}, next: [], balance: null, capacity: null }]
  for (const tool of tools) {
    for (const value of values) {
      const blocks = tool.output.render({}, value)
      assert.ok(Array.isArray(blocks) && blocks.length > 0, tool.name + ' renders a block for ' + JSON.stringify(value))
      assert.equal(blocks[0].type, 'text')
      assert.equal(typeof blocks[0].text, 'string')
    }
  }
})

test('rendered output is redacted: a key that leaks into a value never reaches the text', () => {
  const tools = buildRtaTools(deps())
  for (const tool of tools) {
    const text = tool.output.render({}, { id: KEY, displayName: KEY, error: 'Bearer ' + KEY, markdown: KEY, sessionId: KEY, warning: KEY, avatars: [{ id: KEY }], assets: [{ id: KEY }], clips: [{ clipId: KEY }], totals: { count: KEY }, next: [KEY], key: { ref: KEY, configured: true, source: KEY, environment: 'test' }, errors: { key: KEY }, plugin: 'x', balance: null, capacity: null, readOnly: false, writeApproval: true, maxSessionSeconds: 300 })[0].text
    assert.ok(!text.includes(KEY), tool.name + ' render redacts the key')
  }
})

test('renderStatus renders non-finite numbers as unknown', () => {
  const tool = findTool(buildRtaTools(deps()), 'rta_status')
  const text = tool.output.render({ key: { present: true, source: 'env', tag: 'test' }, balance: { availableCredits: NaN, reservedCredits: Infinity }, capacity: null, next: [] })
  assert.ok(!text.includes('NaN'), text)
  assert.ok(!text.includes('Infinity'), text)
})

test('rta_usage cancellation empty carries the same totals shape as a real result', async () => {
  const stub = forbidFetch()
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_usage')
    const out = await tool.execute({}, { signal: abortedSignal() })
    assert.deepEqual(Object.keys(out.totals).sort(), ['activeSeconds', 'billedCredits', 'count', 'settledCount'])
    assert.ok(!JSON.stringify(out).includes('billable'))
    assert.ok(!tool.description.includes('billable seconds'))
    assert.equal(stub.count, 0)
  } finally {
    stub.restore()
  }
})
