// Gate tests: the tier table, decide() under every config posture, the
// redacted approval reasons, and the plugin entry (apply) wiring against a
// fake Cordis context. No network: fetch is stubbed wherever a tool runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_TIERS, TOOL_NAMES, tierOf, isWriteTool, decide, describeWrite } from '../lib/gate.js'
import { resolveConfig } from '../lib/config.js'
import { apply, name as pluginName, inject as pluginInject } from '../lib/index.js'

const KEY = 'tic_test_' + 'x'.repeat(40)

const ALL_TOOLS = [
  'rta_status', 'rta_balance', 'rta_capacity', 'rta_avatars', 'rta_avatar', 'rta_clips', 'rta_assets', 'rta_usage', 'rta_session_release',
  'rta_asset_remote', 'rta_avatar_update', 'rta_avatar_delete', 'rta_avatar_create', 'rta_loop_set', 'rta_clips_set', 'rta_session_mint',
  'rta_docs', 'rta_quickstart',
]
const READ = ['rta_status', 'rta_balance', 'rta_capacity', 'rta_avatars', 'rta_avatar', 'rta_clips', 'rta_assets', 'rta_usage', 'rta_docs', 'rta_quickstart', 'rta_session_release']
const WRITE_FREE = ['rta_asset_remote', 'rta_avatar_update', 'rta_avatar_delete']
const WRITE_COSTLY = ['rta_avatar_create', 'rta_loop_set', 'rta_clips_set', 'rta_session_mint']

const DEFAULTS = resolveConfig({})
const UNGATED = resolveConfig({ writeApproval: false })
const READ_ONLY = resolveConfig({ readOnly: true })
const READ_ONLY_UNGATED = resolveConfig({ readOnly: true, writeApproval: false })

/** Representative arguments per write tool. */
const ARGS = {
  rta_asset_remote: { kind: 'image', remoteUrl: 'https://example.com/a.png' },
  rta_avatar_update: { avatarId: 'ava_test1', displayName: 'Nova', persona: { name: 'Nova' } },
  rta_avatar_delete: { avatarId: 'ava_test1' },
  rta_avatar_create: { displayName: 'Nova', sourceAssetId: 'ast_test1', motionPrompt: 'breathing softly' },
  rta_loop_set: { avatarId: 'ava_test1', motionPrompt: 'sit still' },
  rta_clips_set: { avatarId: 'ava_test1', clips: [{ clipId: 'a', role: 'idle', source: { motionPrompt: 'x' } }, { clipId: 'b', role: 'listen', source: { motionPrompt: 'y' } }] },
  rta_session_mint: { avatarId: 'seed-rin-ashfall', mode: 'voice', maxSessionSeconds: 120 },
}

/** Run fn with console.warn silenced; returns the captured warnings. */
async function silencingWarn(fn) {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  try {
    await fn(warnings)
  } finally {
    console.warn = original
  }
  return warnings
}

/** A fake Cordis context recording registrations, listeners and inject scopes. */
function fakeContext(options = {}) {
  const registered = []
  const listeners = []
  const injected = []
  return {
    registered,
    listeners,
    injected,
    ctx: {
      tools: { register(definition) { registered.push(definition); return () => {} } },
      on(event, listener) { listeners.push({ event, listener }) },
      get(serviceName) { return options.services?.[serviceName] },
      inject(deps, callback) { injected.push(deps); callback(options.scope ?? {}) },
    },
  }
}

function forbidFetch() {
  const original = globalThis.fetch
  let count = 0
  globalThis.fetch = async () => {
    count += 1
    throw new Error('fetch must not be reached in this test')
  }
  return { get count() { return count }, restore: () => { globalThis.fetch = original } }
}

test('TOOL_TIERS covers exactly the 18 tool names with the documented tiers', () => {
  assert.deepEqual(Object.keys(TOOL_TIERS).sort(), [...ALL_TOOLS].sort())
  assert.deepEqual([...TOOL_NAMES].sort(), [...ALL_TOOLS].sort())
  for (const n of READ) assert.equal(TOOL_TIERS[n], 'read', n)
  for (const n of WRITE_FREE) assert.equal(TOOL_TIERS[n], 'write-free', n)
  for (const n of WRITE_COSTLY) assert.equal(TOOL_TIERS[n], 'write-costly', n)
  assert.equal(READ.length + WRITE_FREE.length + WRITE_COSTLY.length, 18)
  assert.equal(tierOf('rta_session_mint'), 'write-costly')
  assert.equal(tierOf('d1_query'), undefined)
  assert.equal(tierOf('toString'), undefined, 'prototype names are not tools')
  assert.equal(isWriteTool('rta_avatar_delete'), true)
  assert.equal(isWriteTool('rta_session_release'), false)
  assert.equal(isWriteTool('nope'), false)
})

test('decide(): reads are always allowed, under every posture', () => {
  for (const cfg of [DEFAULTS, UNGATED, READ_ONLY, READ_ONLY_UNGATED]) {
    for (const n of READ) assert.deepEqual(decide(cfg, n, {}), { kind: 'allow' }, n)
  }
})

test('decide(): free writes ask by default, are allowed with writeApproval:false, and are denied under readOnly', () => {
  for (const n of WRITE_FREE) {
    const ask = decide(DEFAULTS, n, ARGS[n])
    assert.equal(ask.kind, 'ask', n + ' asks by default')
    assert.equal(typeof ask.reason, 'string')
    assert.ok(ask.reason.startsWith(n), n + ' reason names the tool')
    assert.deepEqual(decide(UNGATED, n, ARGS[n]), { kind: 'allow' }, n + ' allowed when ungated')
    for (const cfg of [READ_ONLY, READ_ONLY_UNGATED]) {
      const deny = decide(cfg, n, ARGS[n])
      assert.equal(deny.kind, 'deny', n + ' denied under readOnly')
      assert.match(deny.reason, /readOnly mode/)
      assert.ok(deny.reason.includes(n))
    }
  }
})

test('decide(): costly writes ask by default AND with writeApproval:false, and are denied under readOnly', () => {
  for (const n of WRITE_COSTLY) {
    for (const cfg of [DEFAULTS, UNGATED]) {
      const ask = decide(cfg, n, ARGS[n])
      assert.equal(ask.kind, 'ask', n + ' always asks')
      assert.match(ask.reason, /credit|bill/i, n + ' reason mentions the cost')
    }
    for (const cfg of [READ_ONLY, READ_ONLY_UNGATED]) assert.equal(decide(cfg, n, ARGS[n]).kind, 'deny', n + ' denied under readOnly')
  }
})

test('decide(): foreign tool names waterfall (null) under every posture', () => {
  for (const cfg of [DEFAULTS, UNGATED, READ_ONLY]) {
    for (const n of ['d1_query', 'rta_unknown', 'bash', '', 'constructor', '__proto__']) assert.equal(decide(cfg, n, {}), null, n)
  }
})

test('describeWrite reasons stay under 320 chars for oversized arguments', () => {
  const huge = 'w'.repeat(5000)
  const big = {
    rta_asset_remote: { kind: huge, remoteUrl: 'https://example.com/' + huge },
    rta_avatar_update: { avatarId: huge, displayName: huge, defaultVoiceId: huge, llmProvider: huge, llmModel: huge, settings: {}, metadata: {}, persona: {}, artDirection: huge, stylePreset: huge, anchorTimeMs: 1 },
    rta_avatar_delete: { avatarId: huge },
    rta_avatar_create: { displayName: huge, sourceAssetId: huge, motionPrompt: huge },
    rta_loop_set: { avatarId: huge, motionPrompt: huge },
    rta_clips_set: { avatarId: huge, clips: Array.from({ length: 12 }, () => ({ clipId: huge, role: 'idle', source: { motionPrompt: huge } })) },
    rta_session_mint: { avatarId: huge, mode: huge, instructions: huge, maxSessionSeconds: 1800 },
  }
  for (const [n, args] of Object.entries(big)) {
    const reason = describeWrite(n, args)
    assert.ok(reason.length <= 320, n + ' reason is ' + reason.length + ' chars')
    assert.ok(reason.startsWith(n))
  }
  const fallback = describeWrite('rta_future_tool', { blob: huge })
  assert.ok(fallback.length <= 320, 'fallback reason is ' + fallback.length + ' chars')
  assert.match(fallback, /^rta_future_tool needs approval — /)
  assert.ok(describeWrite('rta_loop_set', undefined).startsWith('rta_loop_set'), 'total for missing arguments')
  assert.ok(describeWrite('rta_avatar_update', null).startsWith('rta_avatar_update'), 'total for null arguments')
})

test('describeWrite collapses whitespace and mentions the cost of costly tools', () => {
  const loop = describeWrite('rta_loop_set', { avatarId: 'ava_test1', motionPrompt: 'sit\n\n   very\tstill  ' })
  assert.match(loop, /motionPrompt sit very still$/)
  assert.ok(!/[\n\t]/.test(loop))
  assert.match(loop, /billed as one generation/)
  assert.match(describeWrite('rta_avatar_create', ARGS.rta_avatar_create), /spends credits.*displayName Nova, sourceAssetId ast_test1, motionPrompt \(16 chars\)/)
  assert.match(describeWrite('rta_clips_set', ARGS.rta_clips_set), /may spend credits.*avatar ava_test1, 2 clip\(s\)/)
  assert.match(describeWrite('rta_session_mint', ARGS.rta_session_mint), /bills once a client joins.*avatar seed-rin-ashfall, mode voice, max 120 s/)
  assert.match(describeWrite('rta_session_mint', { avatarId: 'seed-rin-ashfall' }), /mode avatar$/, 'mode defaults to avatar in the prompt')
  assert.match(describeWrite('rta_asset_remote', ARGS.rta_asset_remote), /image from https:\/\/example\.com\/a\.png$/)
  const update = describeWrite('rta_avatar_update', ARGS.rta_avatar_update)
  assert.match(update, /changes avatar ava_test1 — fields: displayName, persona$/)
  assert.match(describeWrite('rta_avatar_delete', ARGS.rta_avatar_delete), /soft-deletes avatar ava_test1/)
  const leadingSpace = describeWrite('rta_avatar_delete', { avatarId: '  ava_test1\n' })
  assert.match(leadingSpace, /avatar ava_test1 \(/)
})

test('describeWrite and decide() redact a key that appears inside the arguments', () => {
  const cases = [
    ['rta_loop_set', { avatarId: 'ava_test1', motionPrompt: 'use ' + KEY + ' please' }],
    ['rta_asset_remote', { kind: 'image', remoteUrl: 'https://example.com/a.png?key=' + KEY }],
    ['rta_avatar_create', { displayName: KEY, sourceAssetId: KEY }],
    ['rta_avatar_update', { avatarId: KEY, displayName: 'x' }],
    ['rta_avatar_delete', { avatarId: KEY }],
    ['rta_clips_set', { avatarId: KEY, clips: [] }],
    ['rta_session_mint', { avatarId: KEY, mode: KEY }],
    ['rta_future_tool', { token: KEY, header: 'Bearer ' + KEY }],
  ]
  for (const [n, args] of cases) {
    const reason = describeWrite(n, args)
    assert.ok(!reason.includes(KEY), n + ' reason never contains the key')
    assert.match(reason, /<redacted>/, n + ' reason shows the redaction marker')
  }
  const ask = decide(DEFAULTS, 'rta_loop_set', cases[0][1])
  assert.equal(ask.kind, 'ask')
  assert.ok(!ask.reason.includes(KEY))
  assert.match(ask.reason, /tic_test_<redacted>/)
  const fallback = describeWrite('rta_future_tool', cases[7][1])
  assert.ok(!fallback.includes('Bearer ' + KEY))
  assert.match(fallback, /Bearer <redacted>/)
})

test('apply() registers the 18 tools, one pre-execute gate and the three scoped sub-fibers', async () => {
  const fake = fakeContext()
  const warnings = await silencingWarn(() => { apply(fake.ctx, {}) })
  assert.deepEqual(warnings, [], 'a valid default config warns about nothing')
  assert.equal(pluginName, 'realtimeavatar')
  assert.deepEqual(pluginInject, ['tools'])
  assert.equal(fake.registered.length, 18)
  assert.deepEqual(fake.registered.map((d) => d.name), ALL_TOOLS)
  assert.equal(fake.listeners.length, 1)
  assert.equal(fake.listeners[0].event, 'tools/pre-execute')
  assert.deepEqual(fake.injected, [['systemPrompt'], ['skills'], ['commands']])

  const gate = fake.listeners[0].listener
  const sentinel = { kind: 'allow', reason: 'from next' }
  let nextCalls = 0
  const next = async () => { nextCalls += 1; return sentinel }
  assert.equal(await gate({ name: 'd1_query', arguments: { sql: 'SELECT 1' } }, next), sentinel, 'foreign tools waterfall to next()')
  assert.equal(nextCalls, 1)
  // Reads are allowed by waterfalling: the listener never answers {kind:'allow'} itself.
  assert.equal(await gate({ name: 'rta_balance' }, next), sentinel, 'a read returns the downstream verdict verbatim')
  assert.equal(nextCalls, 2)
  const costly = await gate({ name: 'rta_session_mint', arguments: { avatarId: 'seed-rin-ashfall' } }, next)
  assert.equal(costly.kind, 'ask')
  assert.match(costly.reason, /bills once a client joins/)
  assert.equal(nextCalls, 3, 'an ask still lets the downstream listeners see the call')
  const free = await gate({ name: 'rta_avatar_delete', arguments: { avatarId: 'ava_test1' } }, next)
  assert.equal(free.kind, 'ask')
  assert.equal(nextCalls, 4)
  // A downstream deny beats our ask; a downstream ask or allow does not.
  const deny = { kind: 'deny', reason: 'plan mode' }
  assert.equal(await gate({ name: 'rta_session_mint', arguments: { avatarId: 'seed-rin-ashfall' } }, async () => deny), deny)
  assert.equal(await gate({ name: 'rta_avatar_delete', arguments: { avatarId: 'ava_test1' } }, async () => deny), deny)
  assert.equal(await gate({ name: 'rta_balance' }, async () => deny), deny, 'a downstream deny on a read is returned as-is')
  assert.equal((await gate({ name: 'rta_loop_set', arguments: ARGS.rta_loop_set }, async () => ({ kind: 'ask', reason: 'theirs' }))).reason.startsWith('rta_loop_set'), true)
})

test('apply() under readOnly denies writes at the gate; under writeApproval:false free writes pass and costly ones still ask', async () => {
  const ro = fakeContext()
  await silencingWarn(() => { apply(ro.ctx, { readOnly: true }) })
  const roGate = ro.listeners[0].listener
  let nextCalls = 0
  const next = async () => { nextCalls += 1; return { kind: 'allow' } }
  for (const n of [...WRITE_FREE, ...WRITE_COSTLY]) {
    const verdict = await roGate({ name: n, arguments: ARGS[n] }, next)
    assert.equal(verdict.kind, 'deny', n)
    assert.match(verdict.reason, /readOnly/)
  }
  assert.equal(nextCalls, 0, 'a readOnly deny returns immediately without consulting next')
  assert.deepEqual(await roGate({ name: 'rta_status' }, next), { kind: 'allow' })
  assert.equal(nextCalls, 1, 'reads still waterfall under readOnly')

  const ungated = fakeContext()
  const warnings = await silencingWarn(() => { apply(ungated.ctx, { writeApproval: false }) })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /writeApproval:false/)
  const ungatedGate = ungated.listeners[0].listener
  nextCalls = 0
  for (const n of WRITE_FREE) assert.deepEqual(await ungatedGate({ name: n, arguments: ARGS[n] }, next), { kind: 'allow' }, n)
  assert.equal(nextCalls, WRITE_FREE.length, 'ungated free writes are allowed by waterfalling to next()')
  for (const n of WRITE_COSTLY) assert.equal((await ungatedGate({ name: n, arguments: ARGS[n] }, next)).kind, 'ask', n)
  const deny = { kind: 'deny', reason: 'a later policy said no' }
  for (const n of [...WRITE_FREE, ...WRITE_COSTLY]) assert.equal(await ungatedGate({ name: n, arguments: ARGS[n] }, async () => deny), deny, n + ': a downstream deny is returned')
})

test('describeWrite for rta_avatar_update lists at most 10 field names and counts the rest', () => {
  const many = Object.fromEntries(Array.from({ length: 14 }, (_, i) => ['field' + String(i).padStart(2, '0'), 'v']))
  const reason = describeWrite('rta_avatar_update', { avatarId: 'ava_test1', ...many })
  assert.match(reason, /^rta_avatar_update changes avatar ava_test1 — fields: field00, field01, field02, field03, field04, field05, field06, field07, field08, field09 …\(\+4 more\)$/)
  const ten = Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['f' + i, 'v']))
  assert.match(describeWrite('rta_avatar_update', { avatarId: 'ava_test1', ...ten }), /f9$/, 'exactly ten needs no ellipsis')
  const longName = 'n'.repeat(80)
  assert.match(describeWrite('rta_avatar_update', { avatarId: 'ava_test1', [longName]: 1 }), new RegExp('fields: n{40}$'), 'each name is capped at 40 chars')
  assert.ok(!describeWrite('rta_avatar_update', { avatarId: 'ava_test1', ...many }).includes('avatarId'), 'avatarId is not a changed field')
})

test('apply() with an invalid config warns, falls back to defaults, still registers 18 tools and reports configError from rta_status', async () => {
  const fake = fakeContext()
  const warnings = await silencingWarn(() => { apply(fake.ctx, { maxSessionSeconds: -1 }) })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /invalid config.*maxSessionSeconds must be a positive number/)
  assert.equal(fake.registered.length, 18)
  const status = fake.registered.find((d) => d.name === 'rta_status')
  const stub = forbidFetch()
  const saved = process.env.REALTIME_AVATAR_API_KEY
  delete process.env.REALTIME_AVATAR_API_KEY
  try {
    const report = await status.execute({}, {})
    assert.match(report.configError, /maxSessionSeconds must be a positive number/)
    assert.equal(report.maxSessionSeconds, 300, 'defaults in effect')
    assert.equal(report.key.configured, false)
    assert.equal(stub.count, 0)
    assert.match(status.output.render({}, report)[0].text, /config error: maxSessionSeconds .* \(defaults in effect\)/)
    const mint = fake.registered.find((d) => d.name === 'rta_session_mint')
    assert.match(mint.description, /capped at 300 by config/)
  } finally {
    if (saved !== undefined) process.env.REALTIME_AVATAR_API_KEY = saved
    stub.restore()
  }
})

test('apply() redacts a config error before warning and before rta_status reports it', async () => {
  const fake = fakeContext()
  const warnings = await silencingWarn(() => { apply(fake.ctx, { apiKeyEnv: KEY }) })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /invalid config.*apiKeyEnv looks like an API key/)
  assert.ok(!warnings[0].includes(KEY))
  assert.equal(fake.registered.length, 18)
  const status = fake.registered.find((d) => d.name === 'rta_status')
  const stub = forbidFetch()
  const saved = process.env.REALTIME_AVATAR_API_KEY
  delete process.env.REALTIME_AVATAR_API_KEY
  try {
    const report = await status.execute({}, {})
    assert.match(report.configError, /looks like an API key/)
    assert.ok(!JSON.stringify(report).includes(KEY))
    assert.equal(report.key.ref, 'REALTIME_AVATAR_API_KEY', 'the default reference is in effect')
    assert.equal(stub.count, 0)
  } finally {
    if (saved !== undefined) process.env.REALTIME_AVATAR_API_KEY = saved
    stub.restore()
  }
})

test('apply() resolves the key per call through a composed credentials service and degrades without ctx.get / ctx.inject', async () => {
  const seen = []
  const credentials = {
    async resolve(ref) { seen.push('resolve:' + ref); return { value: KEY, source: 'file' } },
    async describe(ref) { seen.push('describe:' + ref); return { configured: true, source: 'file' } },
    async set() {},
    async unset() {},
  }
  const fake = fakeContext({ services: { credentials } })
  await silencingWarn(() => { apply(fake.ctx, { apiKeyEnv: 'MY_RTA_KEY' }) })
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers })
    return new Response(JSON.stringify({ availableCreditMicros: 60000000 }), { status: 200 })
  }
  try {
    const balance = await fake.registered.find((d) => d.name === 'rta_balance').execute({}, {})
    assert.equal(balance.availableCredits, 60)
    assert.deepEqual(seen, ['resolve:MY_RTA_KEY'])
    assert.equal(calls[0].headers.Authorization, 'Bearer ' + KEY)
    const report = await fake.registered.find((d) => d.name === 'rta_status').execute({}, {})
    assert.equal(report.key.configured, true)
    assert.equal(report.key.source, 'file')
    assert.equal(report.key.environment, 'test')
    assert.ok(!JSON.stringify(report).includes(KEY))
  } finally {
    globalThis.fetch = original
  }

  const registered = []
  const listeners = []
  const minimal = { tools: { register(d) { registered.push(d); return () => {} } }, on(event, listener) { listeners.push(event) } }
  await silencingWarn(() => { apply(minimal, undefined) })
  assert.equal(registered.length, 18, 'a context without get/inject still gets every tool')
  assert.deepEqual(listeners, ['tools/pre-execute'])
})
