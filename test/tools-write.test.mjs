// Write-tool tests: wire casing per route (camelCase resources, snake_case
// realtime), validation before any request, idempotency keys, the session
// grant / queue / 429 contract, the readOnly refusal and cancellation.
// No network: globalThis.fetch is stubbed per test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { buildRtaTools } from '../lib/tools/index.js'
import { resolveConfig } from '../lib/config.js'

const KEY = 'tic_test_' + 'x'.repeat(40)
const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))
const withKey = () => ({ credentials: undefined, env: { REALTIME_AVATAR_API_KEY: KEY } })
const deps = (overrides = {}, keySource = withKey) => ({ cfg: resolveConfig(overrides), keySource, randomUUID: () => 'uuid-fixed', skillsDir: SKILLS_DIR })

const WRITE_TOOLS = ['rta_asset_remote', 'rta_avatar_update', 'rta_avatar_delete', 'rta_avatar_create', 'rta_loop_set', 'rta_clips_set', 'rta_session_mint']

/** Arguments that pass validation for every write tool. */
const VALID_ARGS = {
  rta_asset_remote: { kind: 'image', remoteUrl: 'https://example.com/a.png' },
  rta_avatar_update: { avatarId: 'ava_test1', displayName: 'Nova' },
  rta_avatar_delete: { avatarId: 'ava_test1' },
  rta_avatar_create: { displayName: 'Nova', sourceAssetId: 'ast_test1' },
  rta_loop_set: { avatarId: 'ava_test1', motionPrompt: 'sit still' },
  rta_clips_set: { avatarId: 'ava_test1', clips: [{ clipId: 'idle-1', role: 'idle', source: { motionPrompt: 'rest' } }] },
  rta_session_mint: { avatarId: 'seed-rin-ashfall' },
}

const AVATAR = { id: 'ava_test1', displayName: 'Nova', status: 'preprocessing', idleVideoStatus: 'pending', sourceKind: 'image', sourceAssetId: 'ast_test1', modelId: 'model-1', defaultVoiceId: 'voice-1', error: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', tenantId: 'ten_test1' }
const ASSET = { id: 'ast_test1', kind: 'image', status: 'pending', contentType: 'image/png', sizeBytes: null, publicUrl: 'https://example.com/a.png', createdAt: '2026-09-01T00:00:00Z', tenantId: 'ten_test1' }
const GRANT = { session_id: 'ses_test1', room_name: 'room-1', livekit_url: 'wss://example.com/rtc', participant_identity: 'user-1', participant_token: 'join-token-placeholder', reservation_expires_at: '2026-09-01T00:01:00Z', join_timeout_seconds: 30, idle_timeout_seconds: 60, max_session_seconds: 300 }

/**
 * Route fetch by URL path + method. The handler receives { path, method, body, headers }
 * and returns { status?, body? } (JSON). No body → empty response.
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
    const headers = init.headers ?? {}
    calls.push({ url: href, path: parsed.pathname, method, headers, body, signal: init.signal })
    const out = handler({ path: parsed.pathname, method, body, headers }) ?? {}
    const status = out.status ?? 200
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

test('rta_asset_remote posts camelCase {kind, remoteUrl} to /v1/assets/remote and maps the asset', async () => {
  const stub = routeFetch(() => ({ status: 201, body: ASSET }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_asset_remote')
    const out = await tool.execute({ kind: 'image', remoteUrl: 'https://example.com/a.png' }, {})
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].path, '/api/v1/assets/remote')
    assert.equal(stub.calls[0].method, 'POST')
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer ' + KEY)
    assert.equal(stub.calls[0].headers['Content-Type'], 'application/json')
    assert.deepEqual(stub.calls[0].body, { kind: 'image', remoteUrl: 'https://example.com/a.png' })
    assert.equal(out.id, 'ast_test1')
    assert.equal(out.status, 'pending')
    assert.ok(!('tenantId' in out), 'tenantId dropped')

    await tool.execute({ kind: 'Audio', remoteUrl: 'http://example.com/v.mp3', originalFilename: 'v.mp3', metadata: { tag: 'x' } }, {})
    assert.deepEqual(stub.calls[1].body, { kind: 'audio', remoteUrl: 'http://example.com/v.mp3', originalFilename: 'v.mp3', metadata: { tag: 'x' } })
    assert.match(tool.output.render({}, out)[0].text, /"id": "ast_test1"/)
  } finally {
    stub.restore()
  }
})

test('rta_asset_remote rejects non-http URLs and unknown kinds before any request', async () => {
  const stub = forbidFetch()
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_asset_remote')
    for (const remoteUrl of ['ftp://example.com/a.png', 'javascript:alert(1)', 'example.com/a.png', '/relative/a.png', 'data:image/png;base64,AAAA', 'file:///etc/passwd']) {
      await assert.rejects(() => tool.execute({ kind: 'image', remoteUrl }, {}), /remoteUrl must be an absolute http\(s\) URL/, 'rejects ' + remoteUrl)
    }
    await assert.rejects(() => tool.execute({ kind: 'gif', remoteUrl: 'https://example.com/a.gif' }, {}), /kind must be one of: image, video, audio/)
    await assert.rejects(() => tool.execute({ remoteUrl: 'https://example.com/a.png' }, {}), /kind is required/)
    await assert.rejects(() => tool.execute({ kind: 'image' }, {}), /remoteUrl is required/)
    await assert.rejects(() => tool.execute({ kind: 'image', remoteUrl: 'https://example.com/a.png', metadata: 'x' }, {}), /metadata must be an object/)
    assert.equal(stub.count, 0)
  } finally {
    stub.restore()
  }
})

test('rta_avatar_update PATCHes only the provided fields and refuses an empty update', async () => {
  const stub = routeFetch(() => ({ body: { ...AVATAR, displayName: 'Nova 2', status: 'ready' } }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_avatar_update')
    const out = await tool.execute({ avatarId: 'ava_test1', displayName: 'Nova 2', anchorTimeMs: 1200, persona: { name: 'Nova' } }, {})
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].path, '/api/v1/avatars/ava_test1')
    assert.equal(stub.calls[0].method, 'PATCH')
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer ' + KEY)
    assert.deepEqual(stub.calls[0].body, { displayName: 'Nova 2', anchorTimeMs: 1200, persona: { name: 'Nova' } })
    assert.equal(out.id, 'ava_test1')
    assert.equal(out.displayName, 'Nova 2')
    assert.ok(!('tenantId' in out))

    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1' }, {}), /needs at least one field/)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', displayName: '   ' }, {}), /needs at least one field/, 'blank strings do not count as a field')
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', anchorTimeMs: -1 }, {}), /anchorTimeMs must be between 0 and 3600000/)
    await assert.rejects(() => tool.execute({ avatarId: '../x', displayName: 'x' }, {}), /avatarId is invalid/)
    await assert.rejects(() => tool.execute({ displayName: 'x' }, {}), /avatarId is required/)
    assert.equal(stub.calls.length, 1, 'refusals never reach the API')
  } finally {
    stub.restore()
  }
})

test('rta_avatar_update validates llmProvider and stylePreset against their closed sets', async () => {
  const stub = routeFetch(() => ({ body: AVATAR }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_avatar_update')
    await tool.execute({ avatarId: 'ava_test1', llmProvider: 'Gemini', llmModel: 'model-x', stylePreset: 'warm-anime', artDirection: 'soft light' }, {})
    assert.deepEqual(stub.calls[0].body, { llmProvider: 'gemini', llmModel: 'model-x', artDirection: 'soft light', stylePreset: 'warm-anime' })
    for (const provider of ['local', 'gemini', 'openai']) {
      await tool.execute({ avatarId: 'ava_test1', llmProvider: provider }, {})
      assert.equal(stub.calls.at(-1).body.llmProvider, provider)
    }
    for (const preset of ['cinematic-founder', 'editorial-companion', 'warm-anime', 'luxury-realism', 'soft-3d', 'noir-avatar']) {
      await tool.execute({ avatarId: 'ava_test1', stylePreset: preset }, {})
      assert.equal(stub.calls.at(-1).body.stylePreset, preset)
    }
    const before = stub.calls.length
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', llmProvider: 'anthropic' }, {}), /llmProvider must be one of: local, gemini, openai/)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', stylePreset: 'vaporwave' }, {}), /stylePreset must be one of: cinematic-founder, editorial-companion, warm-anime, luxury-realism, soft-3d, noir-avatar/)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', llmProvider: 42 }, {}), /llmProvider must be a string/)
    assert.equal(stub.calls.length, before)
    assert.deepEqual(tool.parameters.properties.llmProvider.enum, ['local', 'gemini', 'openai'])
    assert.deepEqual(tool.parameters.properties.stylePreset.enum, ['cinematic-founder', 'editorial-companion', 'warm-anime', 'luxury-realism', 'soft-3d', 'noir-avatar'])
  } finally {
    stub.restore()
  }
})

test('rta_avatar_update sourceAssetId is the portrait-swap lane: alone or with anchorTimeMs, exclusive of every other field', async () => {
  const stub = routeFetch(() => ({ body: { ...AVATAR, sourceAssetId: 'ast_test2' } }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_avatar_update')
    const alone = await tool.execute({ avatarId: 'ava_test1', sourceAssetId: 'ast_test2' }, {})
    assert.deepEqual(stub.calls[0].body, { sourceAssetId: 'ast_test2' })
    assert.equal(alone.sourceAssetId, 'ast_test2')
    await tool.execute({ avatarId: 'ava_test1', sourceAssetId: 'ast_test2', anchorTimeMs: 1500 }, {})
    assert.deepEqual(stub.calls[1].body, { anchorTimeMs: 1500, sourceAssetId: 'ast_test2' })
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', sourceAssetId: 'ast_test2', displayName: 'Nova' }, {}), /sourceAssetId \(portrait swap\) is exclusive of every other field except anchorTimeMs; remove: displayName\./)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', sourceAssetId: 'ast_test2', anchorTimeMs: 1, persona: { name: 'N' }, stylePreset: 'soft-3d' }, {}), /exclusive.*remove: persona, stylePreset\./)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', sourceAssetId: 's'.repeat(201) }, {}), /sourceAssetId is longer than 200/)
    assert.equal(stub.calls.length, 2)
    assert.match(tool.description, /Portrait swap is its own lane: pass sourceAssetId .* exclusive of every other field/)
  } finally {
    stub.restore()
  }
})

test('write tools refuse a body over 1 MiB before any request', async () => {
  const stub = forbidFetch()
  try {
    const tools = buildRtaTools(deps())
    const huge = { blob: 'x'.repeat(1_100_000) }
    await assert.rejects(() => findTool(tools, 'rta_avatar_update').execute({ avatarId: 'ava_test1', settings: huge }, {}), /rta_avatar_update body is \d+ bytes; the API caps request bodies at a few KB/)
    await assert.rejects(() => findTool(tools, 'rta_avatar_create').execute({ displayName: 'x', sourceAssetId: 'ast_test1', metadata: huge }, {}), /rta_avatar_create body is \d+ bytes; the API caps request bodies/)
    const circular = {}
    circular.self = circular
    await assert.rejects(() => findTool(tools, 'rta_avatar_update').execute({ avatarId: 'ava_test1', settings: circular }, {}), /cannot be serialised as JSON/)
    assert.equal(stub.count, 0)
  } finally {
    stub.restore()
  }
})

test('the free-write descriptions state the approval posture in effect', () => {
  const FREE = ['rta_asset_remote', 'rta_avatar_update', 'rta_avatar_delete']
  const byPosture = (overrides) => Object.fromEntries(FREE.map((n) => [n, findTool(buildRtaTools(deps(overrides)), n).description]))
  for (const [name, d] of Object.entries(byPosture({}))) assert.ok(d.endsWith('asks for approval.'), name + ' under the defaults: ' + d.slice(-60))
  for (const [name, d] of Object.entries(byPosture({ writeApproval: false }))) assert.ok(d.endsWith('runs without approval (writeApproval:false).'), name + ' ungated: ' + d.slice(-60))
  for (const [name, d] of Object.entries(byPosture({ readOnly: true }))) assert.ok(d.endsWith('disabled while readOnly is on.'), name + ' readOnly: ' + d.slice(-60))
  for (const [name, d] of Object.entries(byPosture({ readOnly: true, writeApproval: false }))) assert.ok(d.endsWith('disabled while readOnly is on.'), name + ' readOnly wins')
  for (const n of ['rta_avatar_create', 'rta_loop_set', 'rta_clips_set', 'rta_session_mint']) {
    assert.match(findTool(buildRtaTools(deps({ writeApproval: false })), n).description, /always asks for approval/, n + ' is costly and always asks')
  }
  const loop = findTool(buildRtaTools(deps()), 'rta_loop_set').description
  assert.match(loop, /Needs a portrait on the avatar \(422 loop_not_generatable otherwise\)/)
  assert.doesNotMatch(loop, /image-sourced avatars only/i)
  assert.match(loop, /do not gate on sourceKind/)
})

test('rta_avatar_delete DELETEs the avatar (204, no body) and returns {avatarId, deleted: true}', async () => {
  const stub = routeFetch(() => ({ status: 204 }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_avatar_delete')
    const out = await tool.execute({ avatarId: 'ava_test1' }, {})
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].path, '/api/v1/avatars/ava_test1')
    assert.equal(stub.calls[0].method, 'DELETE')
    assert.equal(stub.calls[0].body, undefined)
    assert.equal(stub.calls[0].headers['Content-Type'], undefined)
    assert.deepEqual(out, { avatarId: 'ava_test1', deleted: true })
    assert.equal(tool.output.render({}, out)[0].text, 'deleted ava_test1')
    assert.equal(tool.output.render({}, { avatarId: 'ava_test1', deleted: false })[0].text, 'not deleted')
    await assert.rejects(() => tool.execute({ avatarId: 'ava test1' }, {}), /avatarId is invalid/)
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})

test('rta_avatar_create POSTs camelCase with sourceKind image and a snake_case voice.auto_description, never a portraitUrl', async () => {
  const stub = routeFetch(() => ({ status: 201, body: AVATAR }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_avatar_create')
    const out = await tool.execute({ displayName: 'Nova', sourceAssetId: 'ast_test1', voiceDescription: 'warm mid-pitch', portraitUrl: 'https://example.com/nova.png' }, {})
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].path, '/api/v1/avatars')
    assert.equal(stub.calls[0].method, 'POST')
    assert.deepEqual(stub.calls[0].body, { displayName: 'Nova', sourceKind: 'image', sourceAssetId: 'ast_test1', voice: { auto_description: 'warm mid-pitch' } })
    assert.ok(!('portraitUrl' in stub.calls[0].body))
    assert.ok(!('voiceDescription' in stub.calls[0].body), 'voiceDescription travels as voice.auto_description')
    assert.equal(out.id, 'ava_test1')
    assert.equal(out.status, 'preprocessing')
    assert.match(out.next, /poll rta_avatar with this id every few seconds until status is ready/)
    assert.ok(!('tenantId' in out))
    assert.match(tool.output.render({}, out)[0].text, /created avatar ava_test1 "Nova" status=preprocessing\. poll rta_avatar/)

    await tool.execute({ displayName: 'Nova', sourceAssetId: 'ast_test1', motionPrompt: 'breathing softly', defaultVoiceId: 'voice-1', llm: { provider: 'OpenAI', model: 'm', extra: 'dropped' }, settings: { a: 1 }, metadata: { b: 2 } }, {})
    assert.deepEqual(stub.calls[1].body, { displayName: 'Nova', sourceKind: 'image', sourceAssetId: 'ast_test1', motionPrompt: 'breathing softly', defaultVoiceId: 'voice-1', llm: { provider: 'openai', model: 'm' }, settings: { a: 1 }, metadata: { b: 2 } })
    assert.ok(!('voice' in stub.calls[1].body), 'no voice object without a voiceDescription')
    await tool.execute({ displayName: 'Nova', sourceAssetId: 'ast_test1', llm: { provider: 'local' } }, {})
    assert.deepEqual(stub.calls[2].body.llm, { provider: 'local' }, 'model is optional; no undefined-valued key on the wire')
    await tool.execute({ displayName: 'Nova', sourceAssetId: 'ast_test1', voiceDescription: 'v'.repeat(2000) }, {})
    assert.equal(stub.calls[3].body.voice.auto_description.length, 2000, 'voiceDescription accepts up to 2000 chars')

    await assert.rejects(() => tool.execute({ displayName: 'Nova' }, {}), /sourceAssetId is required/)
    await assert.rejects(() => tool.execute({ sourceAssetId: 'ast_test1' }, {}), /displayName is required/)
    await assert.rejects(() => tool.execute({ displayName: 'Nova', sourceAssetId: 'ast test1' }, {}), /sourceAssetId is invalid/)
    await assert.rejects(() => tool.execute({ displayName: 'Nova', sourceAssetId: 'ast_test1', llm: { model: 'm' } }, {}), /llm\.provider is required when llm is given; one of local, gemini, openai\./)
    await assert.rejects(() => tool.execute({ displayName: 'Nova', sourceAssetId: 'ast_test1', llm: {} }, {}), /llm\.provider is required/)
    await assert.rejects(() => tool.execute({ displayName: 'Nova', sourceAssetId: 'ast_test1', llm: { provider: 'p', model: 'm' } }, {}), /provider must be one of: local, gemini, openai/)
    await assert.rejects(() => tool.execute({ displayName: 'Nova', sourceAssetId: 'ast_test1', llm: 'gemini' }, {}), /llm must be an object/)
    await assert.rejects(() => tool.execute({ displayName: 'Nova', sourceAssetId: 'ast_test1', voiceDescription: 'v'.repeat(2001) }, {}), /voiceDescription is longer than 2000/)
    assert.equal(stub.calls.length, 4)
  } finally {
    stub.restore()
  }
})

test('rta_loop_set PUTs /loop with an Idempotency-Key (given or generated) and echoes it', async () => {
  const stub = routeFetch(() => ({ status: 202, body: { avatarId: 'ava_test1', loopStatus: 'rendering', motionPrompt: 'sit still', servingUrl: 'https://example.com/loop.mp4' } }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_loop_set')
    const generated = await tool.execute({ avatarId: 'ava_test1', motionPrompt: 'sit still' }, {})
    assert.equal(stub.calls[0].path, '/api/v1/avatars/ava_test1/loop')
    assert.equal(stub.calls[0].method, 'PUT')
    assert.equal(stub.calls[0].headers['Idempotency-Key'], 'uuid-fixed')
    assert.deepEqual(stub.calls[0].body, { motionPrompt: 'sit still' })
    assert.deepEqual(generated, { avatarId: 'ava_test1', loopStatus: 'rendering', motionPrompt: 'sit still', servingUrl: 'https://example.com/loop.mp4', idempotencyKey: 'uuid-fixed' })

    const given = await tool.execute({ avatarId: 'ava_test1', motionPrompt: 'sit still', idempotencyKey: 'retry-key-1' }, {})
    assert.equal(stub.calls[1].headers['Idempotency-Key'], 'retry-key-1')
    assert.equal(given.idempotencyKey, 'retry-key-1')

    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1' }, {}), /motionPrompt is required/)
    await assert.rejects(() => tool.execute({ motionPrompt: 'x' }, {}), /avatarId is required/)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', motionPrompt: 'x'.repeat(1201) }, {}), /motionPrompt is longer than 1200/)
    assert.equal(stub.calls.length, 2)
  } finally {
    stub.restore()
  }
})

test('rta_loop_set and rta_clips_set accept only header-safe idempotency keys of 1-180 chars', async () => {
  const stub = routeFetch(({ path }) => (path.endsWith('/loop') ? { status: 202, body: { avatarId: 'ava_test1', loopStatus: 'rendering' } } : { body: { avatarId: 'ava_test1', revision: 1, data: [] } }))
  try {
    const tools = buildRtaTools(deps())
    const loop = findTool(tools, 'rta_loop_set')
    const clips = findTool(tools, 'rta_clips_set')
    const max = 'k'.repeat(180)
    await loop.execute({ avatarId: 'ava_test1', motionPrompt: 'x', idempotencyKey: max }, {})
    assert.equal(stub.calls[0].headers['Idempotency-Key'], max)
    await clips.execute({ avatarId: 'ava_test1', clips: [], idempotencyKey: 'a.b_c:d-E9' }, {})
    assert.equal(stub.calls[1].headers['Idempotency-Key'], 'a.b_c:d-E9')
    await loop.execute({ avatarId: 'ava_test1', motionPrompt: 'x', idempotencyKey: '  padded  ' }, {})
    assert.equal(stub.calls[2].headers['Idempotency-Key'], 'padded', 'surrounding whitespace is trimmed')
    await loop.execute({ avatarId: 'ava_test1', motionPrompt: 'x', idempotencyKey: '' }, {})
    assert.equal(stub.calls[3].headers['Idempotency-Key'], 'uuid-fixed', 'an empty key means "generate one"')
    const before = stub.calls.length
    for (const bad of [max + 'k', 'a\nb', 'a\rb', 'a b', 'a/b', 'a;b', 'ключ']) {
      await assert.rejects(() => loop.execute({ avatarId: 'ava_test1', motionPrompt: 'x', idempotencyKey: bad }, {}), /idempotencyKey must be 1-180 characters of letters, digits, "\.", "_", ":" or "-"/, 'loop rejects ' + JSON.stringify(bad))
      await assert.rejects(() => clips.execute({ avatarId: 'ava_test1', clips: [], idempotencyKey: bad }, {}), /1-180/, 'clips rejects ' + JSON.stringify(bad))
    }
    await assert.rejects(() => loop.execute({ avatarId: 'ava_test1', motionPrompt: 'x', idempotencyKey: 42 }, {}), /idempotencyKey must be a string/)
    assert.equal(stub.calls.length, before)
  } finally {
    stub.restore()
  }
})

test('rta_clips_set validates the clip declarations and PUTs /clips with expectedRevision and an Idempotency-Key', async () => {
  const stub = routeFetch(({ body }) => ({ body: { avatarId: 'ava_test1', revision: 4, anchorVersion: 1, clipLibraryEligible: true, data: body.clips.map((c) => ({ ...c, status: 'queued', url: null, error: null })) } }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_clips_set')
    const clips = [
      { clipId: 'idle-1', role: 'idle', source: { motionPrompt: 'rest' }, whenHint: 'between turns', durationSeconds: 6, reroll: true, unknownField: 'dropped' },
      { clipId: 'listen-1', role: 'LISTEN', source: { assetId: 'ast_test1' } },
    ]
    const out = await tool.execute({ avatarId: 'ava_test1', clips, expectedRevision: 3 }, {})
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].path, '/api/v1/avatars/ava_test1/clips')
    assert.equal(stub.calls[0].method, 'PUT')
    assert.equal(stub.calls[0].headers['Idempotency-Key'], 'uuid-fixed')
    assert.deepEqual(stub.calls[0].body, {
      clips: [
        { clipId: 'idle-1', role: 'idle', source: { motionPrompt: 'rest' }, whenHint: 'between turns', durationSeconds: 6, reroll: true },
        { clipId: 'listen-1', role: 'listen', source: { assetId: 'ast_test1' } },
      ],
      expectedRevision: 3,
    })
    assert.equal(out.avatarId, 'ava_test1')
    assert.equal(out.revision, 4)
    assert.equal(out.clips.length, 2)
    assert.equal(out.idempotencyKey, 'uuid-fixed')

    const retried = await tool.execute({ avatarId: 'ava_test1', clips: clips.slice(0, 1), idempotencyKey: 'retry-key-2' }, {})
    assert.equal(stub.calls[1].headers['Idempotency-Key'], 'retry-key-2')
    assert.ok(!('expectedRevision' in stub.calls[1].body), 'no compare-and-swap unless asked')
    assert.equal(retried.idempotencyKey, 'retry-key-2')

    // An empty library is a valid declaration: it retires every clip.
    const retired = await tool.execute({ avatarId: 'ava_test1', clips: [], expectedRevision: 4 }, {})
    assert.deepEqual(stub.calls[2].body, { clips: [], expectedRevision: 4 })
    assert.equal(stub.calls[2].method, 'PUT')
    assert.deepEqual(retired.clips, [])
    assert.equal(retired.idempotencyKey, 'uuid-fixed')
    const twelve = Array.from({ length: 12 }, (_, i) => ({ clipId: 'c' + i, role: 'idle', source: { motionPrompt: 'x' } }))
    await tool.execute({ avatarId: 'ava_test1', clips: twelve }, {})
    assert.equal(stub.calls[3].body.clips.length, 12, 'twelve is the maximum')

    const one = { clipId: 'c', role: 'idle', source: { motionPrompt: 'x' } }
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', clips: [{ ...one, role: 'dance' }] }, {}), /role must be one of: idle, listen, gesture/)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', clips: [{ clipId: 'c', source: { motionPrompt: 'x' } }] }, {}), /clips\[0\]\.role must be idle, listen or gesture/)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', clips: [one, { ...one, source: {} }] }, {}), /clips\[1\]\.source must be \{ motionPrompt \} or \{ assetId \}/)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', clips: [{ ...one, source: 'rest' }] }, {}), /clips\[0\]\.source must be/)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', clips: [{ role: 'idle', source: { motionPrompt: 'x' } }] }, {}), /clipId is required/)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', clips: Array.from({ length: 13 }, (_, i) => ({ ...one, clipId: 'c' + i })) }, {}), /clips must be an array of at most 12 clip declarations \(\[\] retires the whole library\)/)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', clips: 'idle' }, {}), /clips must be an array of at most 12/)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1' }, {}), /clips must be an array/)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', clips: [one], expectedRevision: -1 }, {}), /expectedRevision must be between/)
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', clips: [one], expectedRevision: 1.5 }, {}), /expectedRevision must be an integer/)
    await assert.rejects(() => tool.execute({ clips: [one] }, {}), /avatarId is required/)
    assert.equal(stub.calls.length, 4, 'invalid libraries never reach the API')
  } finally {
    stub.restore()
  }
})

test('rta_clips_set validates each clip: clipId grammar and length, whenHint, durationSeconds, source prompt and asset id', async () => {
  const stub = forbidFetch()
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_clips_set')
    const declare = (clip) => tool.execute({ avatarId: 'ava_test1', clips: [clip] }, {})
    const base = { role: 'idle', source: { motionPrompt: 'rest' } }
    for (const clipId of ['Idle-1', '-idle', '_idle', 'idle 1', 'idle.1', 'idle/1', 'ідле']) {
      await assert.rejects(() => declare({ ...base, clipId }), /clips\[0\]\.clipId must be lowercase letters, digits, "_" or "-" \(1-64 chars, starting with a letter or digit\)/, 'rejects clipId ' + JSON.stringify(clipId))
    }
    await assert.rejects(() => declare({ ...base, clipId: 'c'.repeat(65) }), /clipId is longer than 64/)
    await assert.rejects(() => declare({ ...base, clipId: 'ok', whenHint: 'w'.repeat(281) }), /whenHint is longer than 280/)
    for (const durationSeconds of [3, 9, 0, -4]) await assert.rejects(() => declare({ ...base, clipId: 'ok', durationSeconds }), /durationSeconds must be between 4 and 8/, 'rejects duration ' + durationSeconds)
    for (const durationSeconds of [6.5, '6']) await assert.rejects(() => declare({ ...base, clipId: 'ok', durationSeconds }), /durationSeconds must be an integer/, 'rejects duration ' + JSON.stringify(durationSeconds))
    await assert.rejects(() => declare({ clipId: 'ok', role: 'idle', source: { motionPrompt: '   ' } }), /clips\[0\]\.source\.motionPrompt must be a non-empty string \(max 1200 chars\)/)
    await assert.rejects(() => declare({ clipId: 'ok', role: 'idle', source: { motionPrompt: 'm'.repeat(1201) } }), /motionPrompt is longer than 1200/)
    for (const assetId of ['../x', 'ast test1', 'ast/test1', '']) await assert.rejects(() => declare({ clipId: 'ok', role: 'idle', source: { assetId } }), /clips\[0\]\.source\.assetId is invalid/, 'rejects assetId ' + JSON.stringify(assetId))
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', clips: [{ ...base, clipId: 'a' }, { ...base, clipId: 'b', whenHint: 42 }] }, {}), /whenHint must be a string/)
    assert.equal(stub.count, 0)
  } finally {
    stub.restore()
  }
  const ok = routeFetch(({ body }) => ({ body: { avatarId: 'ava_test1', revision: 2, data: body.clips.map((c) => ({ clipId: c.clipId, role: c.role, status: 'queued', source: 'assetId' in c.source ? 'uploaded' : 'generated', motionPrompt: c.source.motionPrompt ?? null, uploadAssetId: c.source.assetId ?? null, durationSeconds: c.durationSeconds ?? null, error: null })) } }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_clips_set')
    const out = await tool.execute({ avatarId: 'ava_test1', clips: [{ clipId: 'a1_b-c', role: 'gesture', source: { motionPrompt: 'wave' }, durationSeconds: 4 }, { clipId: '9', role: 'listen', source: { assetId: 'ast_test1' }, durationSeconds: 8, whenHint: 'w'.repeat(280) }] }, {})
    assert.deepEqual(ok.calls[0].body.clips, [{ clipId: 'a1_b-c', role: 'gesture', source: { motionPrompt: 'wave' }, durationSeconds: 4 }, { clipId: '9', role: 'listen', source: { assetId: 'ast_test1' }, whenHint: 'w'.repeat(280), durationSeconds: 8 }])
    assert.equal(out.clips[1].source, 'uploaded')
    assert.equal(out.clips[1].uploadAssetId, 'ast_test1')
    assert.equal(out.clips[0].motionPrompt, 'wave')
  } finally {
    ok.restore()
  }
})

test('rta_session_mint sends the snake_case session body and nothing fleet-internal', async () => {
  const stub = routeFetch(() => ({ body: GRANT }))
  try {
    const tool = findTool(buildRtaTools(deps({ maxSessionSeconds: 600 })), 'rta_session_mint')
    await tool.execute({
      avatarId: 'seed-rin-ashfall',
      mode: 'voice',
      instructions: 'be kind',
      initialContext: [{ role: 'system', content: 'you are Rin' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      maxSessionSeconds: 120,
      voiceId: 'voice-1',
      voice: { provider: 'fish', voice_id: 'v-1', speed: 1.1, language: 'en' },
      clientMetadata: { user_id: 'u1', plan: 'free' },
      transcriptWebhook: { url: 'https://example.com/hook', secret: 's'.repeat(16) },
      capacityPool: 'primary',
      capacity_pool: 'primary',
      clip_library: 'y',
      clipLibrary: 'y',
      render_backend: 'z',
      renderBackend: 'z',
    }, {})
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].path, '/api/v1/realtime/livekit/session')
    assert.equal(stub.calls[0].method, 'POST')
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer ' + KEY)
    assert.deepEqual(stub.calls[0].body, {
      avatar_id: 'seed-rin-ashfall',
      max_session_seconds: 120,
      mode: 'voice',
      instructions: 'be kind',
      initial_context: [{ role: 'system', content: 'you are Rin' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      voice_id: 'voice-1',
      voice: { provider: 'fish', voice_id: 'v-1', speed: 1.1, language: 'en' },
      client_metadata: { user_id: 'u1', plan: 'free' },
      transcript_webhook: { url: 'https://example.com/hook', secret: 's'.repeat(16) },
    })
    const wire = JSON.stringify(stub.calls[0].body)
    for (const forbidden of ['capacity_pool', 'capacityPool', 'clip_library', 'clipLibrary', 'render_backend', 'renderBackend', 'avatarId', 'maxSessionSeconds', 'initialContext', 'clientMetadata', 'transcriptWebhook', 'voiceId']) {
      assert.ok(!wire.includes(forbidden), 'wire body never carries ' + forbidden)
    }
  } finally {
    stub.restore()
  }
})

test('rta_session_mint: voiceId is the plain id (voice_id), voice is the full object (voice) and needs provider + voice_id', async () => {
  const stub = routeFetch(() => ({ body: GRANT }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_session_mint')
    await tool.execute({ avatarId: 'seed-rin-ashfall', voiceId: '  voice-2  ' }, {})
    assert.equal(stub.calls[0].body.voice_id, 'voice-2')
    assert.ok(!('voice' in stub.calls[0].body))
    await tool.execute({ avatarId: 'seed-rin-ashfall', voice: { provider: 'elevenlabs', voice_id: 'v-9' } }, {})
    assert.deepEqual(stub.calls[1].body.voice, { provider: 'elevenlabs', voice_id: 'v-9' })
    assert.ok(!('voice_id' in stub.calls[1].body))
    await tool.execute({ avatarId: 'seed-rin-ashfall', voiceId: 'v'.repeat(240) }, {})
    assert.equal(stub.calls[2].body.voice_id.length, 240)
    const before = stub.calls.length
    await assert.rejects(() => tool.execute({ avatarId: 'seed-rin-ashfall', voice: 'voice-1' }, {}), /voice must be an object/, 'a plain id belongs in voiceId')
    await assert.rejects(() => tool.execute({ avatarId: 'seed-rin-ashfall', voice: ['v'] }, {}), /voice must be an object/)
    await assert.rejects(() => tool.execute({ avatarId: 'seed-rin-ashfall', voice: { voice_id: 'v-9' } }, {}), /voice must be an object with at least provider and voice_id \(use voiceId for a plain voice id\)/)
    await assert.rejects(() => tool.execute({ avatarId: 'seed-rin-ashfall', voice: { provider: 'fish' } }, {}), /at least provider and voice_id/)
    await assert.rejects(() => tool.execute({ avatarId: 'seed-rin-ashfall', voice: { provider: 'fish', voice_id: 7 } }, {}), /at least provider and voice_id/)
    await assert.rejects(() => tool.execute({ avatarId: 'seed-rin-ashfall', voiceId: 'v'.repeat(241) }, {}), /voiceId is longer than 240/)
    await assert.rejects(() => tool.execute({ avatarId: 'seed-rin-ashfall', voiceId: { provider: 'fish' } }, {}), /voiceId must be a string/)
    assert.equal(stub.calls.length, before)
    assert.equal(tool.parameters.properties.voice.type, 'object')
    assert.equal(tool.parameters.properties.voiceId.type, 'string')
  } finally {
    stub.restore()
  }
})

test('rta_session_mint throws an http RtaApiError when the grant lacks session_id or livekit_url', async () => {
  let body = { room_name: 'room-1', livekit_url: 'wss://example.com/rtc' }
  const stub = routeFetch(() => ({ body }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_session_mint')
    const check = (error) => {
      assert.equal(error.name, 'RtaApiError')
      assert.equal(error.kind, 'http')
      assert.match(error.message, /the session grant is missing session_id \/ livekit_url; nothing to join/)
      return true
    }
    await assert.rejects(() => tool.execute({ avatarId: 'seed-rin-ashfall' }, {}), check)
    body = { session_id: 'ses_test1', room_name: 'room-1' }
    await assert.rejects(() => tool.execute({ avatarId: 'seed-rin-ashfall' }, {}), check)
    body = { session_id: 42, livekit_url: 'wss://example.com/rtc' }
    await assert.rejects(() => tool.execute({ avatarId: 'seed-rin-ashfall' }, {}), check)
    body = {}
    await assert.rejects(() => tool.execute({ avatarId: 'seed-rin-ashfall' }, {}), check)
    body = { session_id: 'ses_test1', livekit_url: 'wss://example.com/rtc' }
    const minimal = await tool.execute({ avatarId: 'seed-rin-ashfall' }, {})
    assert.equal(minimal.status, 'ready')
    assert.equal(minimal.roomName, null, 'other fields are merely nullable')
    assert.equal(stub.calls.length, 5)
  } finally {
    stub.restore()
  }
})

test('rta_session_mint clamps maxSessionSeconds to the config cap and to 1800', async () => {
  const stub = routeFetch(() => ({ body: GRANT }))
  try {
    const defaults = findTool(buildRtaTools(deps()), 'rta_session_mint')
    await defaults.execute({ avatarId: 'seed-rin-ashfall' }, {})
    assert.equal(stub.calls[0].body.max_session_seconds, 300, 'omitted → config default 300')
    await defaults.execute({ avatarId: 'seed-rin-ashfall', maxSessionSeconds: 900 }, {})
    assert.equal(stub.calls[1].body.max_session_seconds, 300, 'above the cap → clamped to cfg.maxSessionSeconds')
    await defaults.execute({ avatarId: 'seed-rin-ashfall', maxSessionSeconds: 45 }, {})
    assert.equal(stub.calls[2].body.max_session_seconds, 45, 'below the cap → kept')

    const wide = findTool(buildRtaTools(deps({ maxSessionSeconds: 1800 })), 'rta_session_mint')
    await wide.execute({ avatarId: 'seed-rin-ashfall', maxSessionSeconds: 1800 }, {})
    assert.equal(stub.calls[3].body.max_session_seconds, 1800)
    await assert.rejects(() => wide.execute({ avatarId: 'seed-rin-ashfall', maxSessionSeconds: 1801 }, {}), /maxSessionSeconds must be between 1 and 1800/)
    await assert.rejects(() => wide.execute({ avatarId: 'seed-rin-ashfall', maxSessionSeconds: 0 }, {}), /maxSessionSeconds must be between 1 and 1800/)
    await assert.rejects(() => wide.execute({ avatarId: 'seed-rin-ashfall', maxSessionSeconds: 12.5 }, {}), /maxSessionSeconds must be an integer/)
    assert.equal(stub.calls.length, 4)
    assert.match(wide.description, /capped at 1800 by config/)
    assert.match(defaults.description, /capped at 300 by config/)
  } finally {
    stub.restore()
  }
})

test('rta_session_mint validates initialContext, clientMetadata and transcriptWebhook before any request', async () => {
  const stub = forbidFetch()
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_session_mint')
    const id = 'seed-rin-ashfall'
    await assert.rejects(() => tool.execute({ avatarId: id, initialContext: [{ role: 'tool', content: 'x' }] }, {}), /role must be one of: system, user, assistant/)
    await assert.rejects(() => tool.execute({ avatarId: id, initialContext: [{ role: 'user' }] }, {}), /initialContext\[0\] needs role \(system\|user\|assistant\) and content/)
    await assert.rejects(() => tool.execute({ avatarId: id, initialContext: [{ role: 'user', content: 'ok' }, { role: 'user', content: '' }] }, {}), /initialContext\[1\] needs role/)
    await assert.rejects(() => tool.execute({ avatarId: id, initialContext: Array.from({ length: 33 }, () => ({ role: 'user', content: 'x' })) }, {}), /at most 32 messages/)
    await assert.rejects(() => tool.execute({ avatarId: id, initialContext: 'hi' }, {}), /initialContext must be an array/)
    await assert.rejects(() => tool.execute({ avatarId: id, clientMetadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['k' + i, 'v'])) }, {}), /clientMetadata must be at most 16 string pairs/)
    const pairRule = /clientMetadata: keys must be 1-64 chars and values strings of at most 200 chars \(offending key: /
    await assert.rejects(() => tool.execute({ avatarId: id, clientMetadata: { n: 1 } }, {}), new RegExp(pairRule.source + 'n\\)\\.'))
    await assert.rejects(() => tool.execute({ avatarId: id, clientMetadata: { ok: 'v', ['k'.repeat(65)]: 'v' } }, {}), new RegExp(pairRule.source + 'k{40}\\)\\.'), 'the offending key is echoed at most 40 chars')
    await assert.rejects(() => tool.execute({ avatarId: id, clientMetadata: { long: 'v'.repeat(201) } }, {}), new RegExp(pairRule.source + 'long\\)'))
    await assert.rejects(() => tool.execute({ avatarId: id, clientMetadata: { '': 'v' } }, {}), pairRule)
    await assert.rejects(() => tool.execute({ avatarId: id, clientMetadata: { nested: { a: 1 } } }, {}), pairRule)
    await assert.rejects(() => tool.execute({ avatarId: id, clientMetadata: ['a'] }, {}), /clientMetadata must be an object/)
    const hookRule = /transcriptWebhook needs an https url \(≤500 chars\) and a secret of 16-200 characters/
    await assert.rejects(() => tool.execute({ avatarId: id, transcriptWebhook: { url: 'https://example.com/hook', secret: 's'.repeat(15) } }, {}), hookRule)
    await assert.rejects(() => tool.execute({ avatarId: id, transcriptWebhook: { secret: 's'.repeat(16) } }, {}), hookRule)
    await assert.rejects(() => tool.execute({ avatarId: id, transcriptWebhook: { url: 'https://example.com/hook' } }, {}), hookRule)
    await assert.rejects(() => tool.execute({ avatarId: id, transcriptWebhook: { url: 'https://example.com/hook', secret: 's'.repeat(201) } }, {}), /secret is longer than 200/)
    await assert.rejects(() => tool.execute({ avatarId: id, transcriptWebhook: { url: 'https://example.com/' + 'p'.repeat(500), secret: 's'.repeat(16) } }, {}), /url is longer than 500/)
    await assert.rejects(() => tool.execute({ avatarId: id, transcriptWebhook: { url: 'http://example.com/hook', secret: 's'.repeat(16) } }, {}), /transcriptWebhook\.url must use https\./)
    await assert.rejects(() => tool.execute({ avatarId: id, transcriptWebhook: { url: 'wss://example.com/hook', secret: 's'.repeat(16) } }, {}), /must use https/)
    await assert.rejects(() => tool.execute({ avatarId: id, transcriptWebhook: { url: 'example.com/hook', secret: 's'.repeat(16) } }, {}), /transcriptWebhook\.url must be an absolute https URL\./)
    await assert.rejects(() => tool.execute({ avatarId: id, transcriptWebhook: 'https://example.com/hook' }, {}), /transcriptWebhook must be an object/)
    await assert.rejects(() => tool.execute({ avatarId: id, mode: 'video' }, {}), /mode must be one of: avatar, voice/)
    await assert.rejects(() => tool.execute({ avatarId: id, instructions: 'x'.repeat(4001) }, {}), /instructions is longer than 4000/)
    await assert.rejects(() => tool.execute({ avatarId: 'seed rin' }, {}), /avatarId is invalid/)
    await assert.rejects(() => tool.execute({}, {}), /avatarId is required/)
    assert.equal(stub.count, 0)
  } finally {
    stub.restore()
  }
})

test('rta_session_mint accepts the metadata / webhook limits exactly and normalises the webhook URL', async () => {
  const stub = routeFetch(() => ({ body: GRANT }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_session_mint')
    const fifteen = Object.fromEntries(Array.from({ length: 15 }, (_, i) => ['k' + i, 'v']))
    await tool.execute({ avatarId: 'seed-rin-ashfall', clientMetadata: { ...fifteen, k0: 'v'.repeat(200), ['k'.repeat(64)]: 'x' } }, {})
    assert.equal(Object.keys(stub.calls[0].body.client_metadata).length, 16, 'sixteen pairs, a 64-char key and a 200-char value are all within the limits')
    assert.equal(stub.calls[0].body.client_metadata.k0.length, 200)
    assert.equal(stub.calls[0].body.client_metadata['k'.repeat(64)], 'x')
    await tool.execute({ avatarId: 'seed-rin-ashfall', transcriptWebhook: { url: 'HTTPS://Example.COM/Hook?a=1#frag', secret: 's'.repeat(200) } }, {})
    assert.deepEqual(stub.calls[1].body.transcript_webhook, { url: 'https://example.com/Hook?a=1#frag', secret: 's'.repeat(200) }, 'new URL().toString() normalises scheme and host')
    await tool.execute({ avatarId: 'seed-rin-ashfall', transcriptWebhook: { url: 'https://example.com', secret: 's'.repeat(16) } }, {})
    assert.equal(stub.calls[2].body.transcript_webhook.url, 'https://example.com/', 'a bare origin gains its trailing slash')
    assert.equal(stub.calls.length, 3)
  } finally {
    stub.restore()
  }
})

test('a ready grant withholds the participant token unless includeToken is true and warns about rta_session_release', async () => {
  const stub = routeFetch(() => ({ body: GRANT }))
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_session_mint')
    const withheld = await tool.execute({ avatarId: 'seed-rin-ashfall' }, {})
    assert.equal(withheld.status, 'ready')
    assert.equal(withheld.sessionId, 'ses_test1')
    assert.equal(withheld.roomName, 'room-1')
    assert.equal(withheld.livekitUrl, 'wss://example.com/rtc')
    assert.equal(withheld.participantIdentity, 'user-1')
    assert.equal(withheld.participantToken, null)
    assert.equal(withheld.tokenWithheld, true)
    assert.equal(withheld.maxSessionSeconds, 300)
    assert.match(withheld.warning, /rta_session_release/)
    assert.ok(!JSON.stringify(withheld).includes('join-token-placeholder'), 'the token never leaves the tool unless asked')
    assert.match(tool.output.render({}, withheld)[0].text, /^session ses_test1 ready: room room-1 at wss:\/\/example\.com\/rtc, expires 2026-09-01T00:01:00Z, max 300 s\. This holds a capacity slot/)

    assert.ok(!tool.output.render({}, withheld)[0].text.includes('participant token'), 'the withheld render never mentions a token')

    const included = await tool.execute({ avatarId: 'seed-rin-ashfall', includeToken: true }, {})
    assert.equal(included.participantToken, 'join-token-placeholder')
    assert.equal(included.tokenWithheld, undefined)
    assert.match(included.warning, /rta_session_release/)
    const rendered = tool.output.render({ includeToken: true }, included)[0].text
    assert.match(rendered, /^session ses_test1 ready: room room-1 at wss:\/\/example\.com\/rtc, expires 2026-09-01T00:01:00Z, max 300 s\. This holds a capacity slot[^\n]*\nparticipant token \(requested with includeToken\): join-token-placeholder$/, 'the token is rendered, on its own line, when it was asked for')

    const stringy = await tool.execute({ avatarId: 'seed-rin-ashfall', includeToken: 'true' }, {})
    assert.equal(stringy.participantToken, null, 'only a boolean true releases the token')
    assert.equal(stringy.tokenWithheld, true)
    assert.ok(!tool.output.render({}, stringy)[0].text.includes('join-token-placeholder'))
    assert.ok(!tool.output.render({}, { status: 'ready', sessionId: 'ses_test1', participantToken: 42 })[0].text.includes('participant token'), 'a non-string token is not rendered')
  } finally {
    stub.restore()
  }
})

test('a capacity-full 429 becomes status queued; a concurrency 429 throws; a bare 429 is a rate limit', async () => {
  let reply = { status: 429, body: { error: 'capacity is full', queue_size: 4, recommended_retry_ms: 3000, queue_ticket_id: 'qt_test1', queue_position: 2 } }
  const stub = routeFetch(() => reply)
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_session_mint')
    const queued = await tool.execute({ avatarId: 'seed-rin-ashfall' }, {})
    assert.deepEqual(queued, { status: 'queued', queueTicketId: 'qt_test1', queuePosition: 2, queueSize: 4, recommendedRetryMs: 3000 })
    assert.equal(tool.output.render({}, queued)[0].text, 'queued: position 2 of 4, retry in 3000 ms (ticket qt_test1)')

    reply = { status: 429, body: { error: 'full', queue_size: 9, recommended_retry_ms: 500 } }
    const anonymous = await tool.execute({ avatarId: 'seed-rin-ashfall' }, {})
    assert.deepEqual(anonymous, { status: 'queued', queueTicketId: null, queuePosition: null, queueSize: 9, recommendedRetryMs: 500 })

    reply = { status: 429, body: { error: 'too many streams', code: 'concurrency_limit_reached', queue_size: 4, recommended_retry_ms: 3000 } }
    await assert.rejects(() => tool.execute({ avatarId: 'seed-rin-ashfall' }, {}), (error) => error.kind === 'concurrency' && error.code === 'concurrency_limit_reached' && /concurrency ceiling/.test(error.message))

    reply = { status: 429, body: { error: 'slow down' } }
    await assert.rejects(() => tool.execute({ avatarId: 'seed-rin-ashfall' }, {}), (error) => error.kind === 'rate_limit' && error.retryable === true && /120 requests per 60 seconds/.test(error.message))

    reply = { status: 402, body: { error: 'no credits', billingUrl: 'https://example.com/billing' } }
    await assert.rejects(() => tool.execute({ avatarId: 'seed-rin-ashfall' }, {}), (error) => error.kind === 'billing' && error.billingUrl === 'https://example.com/billing')
    assert.equal(stub.calls.length, 5)
  } finally {
    stub.restore()
  }
})

test('under readOnly:true every write tool refuses at execute time with zero requests', async () => {
  const stub = forbidFetch()
  try {
    const tools = buildRtaTools(deps({ readOnly: true }))
    for (const name of WRITE_TOOLS) {
      await assert.rejects(() => findTool(tools, name).execute(VALID_ARGS[name], {}), /readOnly/, name + ' refuses under readOnly')
      await assert.rejects(() => findTool(tools, name).execute({}, {}), /readOnly/, name + ' refuses before validating arguments')
    }
    assert.equal(stub.count, 0)
    const release = await findTool(tools, 'rta_session_release').execute({ sessionId: 'ses_test1' }, { signal: abortedSignal() })
    assert.equal(release.ok, false, 'the free release is not a write and stays available')
  } finally {
    stub.restore()
  }
})

test('a pre-aborted exec signal makes every write tool settle with its empty value and issue no request', async () => {
  const stub = forbidFetch()
  try {
    const tools = buildRtaTools(deps())
    const exec = { signal: abortedSignal() }
    const empties = {
      rta_asset_remote: { id: null, status: null },
      rta_avatar_update: { id: 'ava_test1', status: null },
      rta_avatar_delete: { avatarId: 'ava_test1', deleted: false },
      rta_avatar_create: { id: null, status: null, next: 'cancelled' },
      rta_loop_set: { avatarId: 'ava_test1', loopStatus: null, idempotencyKey: 'uuid-fixed' },
      rta_clips_set: { avatarId: 'ava_test1', revision: null, clips: [], idempotencyKey: 'uuid-fixed' },
      rta_session_mint: { status: 'cancelled', sessionId: null, queueTicketId: null },
    }
    for (const name of WRITE_TOOLS) {
      assert.deepEqual(await findTool(tools, name).execute(VALID_ARGS[name], exec), empties[name], name + ' settles with its empty value')
    }
    assert.equal(stub.count, 0)
  } finally {
    stub.restore()
  }
})

test('every write tool forwards exec.signal: the fetch signal is an AbortSignal that follows the exec signal', async () => {
  const stub = routeFetch(({ path, method }) => {
    if (method === 'DELETE') return { status: 204 }
    if (path.endsWith('/assets/remote')) return { status: 201, body: ASSET }
    if (path.endsWith('/loop')) return { status: 202, body: { avatarId: 'ava_test1', loopStatus: 'rendering' } }
    if (path.endsWith('/clips')) return { body: { avatarId: 'ava_test1', revision: 1, data: [] } }
    if (path.endsWith('/session')) return { body: GRANT }
    return { body: AVATAR }
  })
  try {
    const tools = buildRtaTools(deps())
    for (const name of WRITE_TOOLS) {
      const before = stub.calls.length
      const controller = new AbortController()
      await findTool(tools, name).execute(VALID_ARGS[name], { signal: controller.signal })
      assert.equal(stub.calls.length, before + 1, name + ' issues one request')
      const call = stub.calls[before]
      assert.equal(call.headers.Authorization, 'Bearer ' + KEY, name + ' bearer')
      assert.ok(call.signal instanceof AbortSignal, name + ' passes an AbortSignal to fetch')
      assert.equal(call.signal.aborted, false)
      controller.abort()
      assert.equal(call.signal.aborted, true, name + ' fetch signal follows the exec signal')
    }
  } finally {
    stub.restore()
  }
})

test('write tools need a usable key and never echo it in errors', async () => {
  const stub = forbidFetch()
  try {
    const tools = buildRtaTools(deps({}, () => ({ credentials: undefined, env: {} })))
    for (const name of WRITE_TOOLS) {
      await assert.rejects(() => findTool(tools, name).execute(VALID_ARGS[name], {}), (error) => error.code === 'RTA_KEY_MISSING', name + ' needs a key')
    }
    assert.equal(stub.count, 0)
  } finally {
    stub.restore()
  }
  const leaky = routeFetch(() => ({ status: 422, body: { error: 'bad field for ' + KEY, code: 'invalid_body' } }))
  try {
    await assert.rejects(() => findTool(buildRtaTools(deps()), 'rta_avatar_create').execute(VALID_ARGS.rta_avatar_create, {}), (error) => error.kind === 'validation' && error.status === 422 && !error.message.includes(KEY) && /check field names and casing/.test(error.message))
  } finally {
    leaky.restore()
  }
})

test('rta_avatar_update validates sourceAssetId as an id before it reaches the PATCH body', async () => {
  const stub = forbidFetch()
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_avatar_update')
    for (const bad of ['ast test2', '../x', 'a/b', 'x'.repeat(161)]) {
      await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', sourceAssetId: bad }, {}), /sourceAssetId is invalid/, JSON.stringify(bad))
    }
    assert.equal(stub.count, 0)
  } finally {
    stub.restore()
  }
})

test('idempotencyKey gets the one 1-180 rule whatever its length', async () => {
  const stub = forbidFetch()
  try {
    const tool = findTool(buildRtaTools(deps()), 'rta_loop_set')
    for (const bad of ['k'.repeat(181), 'k'.repeat(401), 'k'.repeat(5000), 'has space']) {
      await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', motionPrompt: 'breathe', idempotencyKey: bad }, {}), /idempotencyKey must be 1-180 characters/, 'length ' + bad.length)
    }
    await assert.rejects(() => tool.execute({ avatarId: 'ava_test1', motionPrompt: 'breathe', idempotencyKey: 7 }, {}), /idempotencyKey must be a string/)
    assert.equal(stub.count, 0)
  } finally {
    stub.restore()
  }
})
