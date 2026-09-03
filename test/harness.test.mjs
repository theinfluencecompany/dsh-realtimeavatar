// Harness-contract tests: render() totality, the empty values returned on
// cancellation, timeout / concurrency declarations and — when the real
// dsh-tools package is reachable — dsh's own JSON-schema acceptance of every
// tool definition.
//
// dsh-tools is not a dependency of this package. Point DSH_TOOLS_ENTRY at an
// installed copy (e.g. <profile>/node_modules/@deepseek-ai/dsh-tools/lib/index.js)
// to run the schema tests; otherwise they are skipped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { buildRtaTools } from '../lib/tools/index.js'
import { resolveConfig } from '../lib/config.js'

const KEY = 'tic_test_' + 'x'.repeat(40)
const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))
const deps = (overrides = {}, keySource = () => ({ credentials: undefined, env: { REALTIME_AVATAR_API_KEY: KEY } })) => ({ cfg: resolveConfig(overrides), keySource, randomUUID: () => 'uuid-fixed', skillsDir: SKILLS_DIR })

const ALL_TOOLS = [
  'rta_status', 'rta_balance', 'rta_capacity', 'rta_avatars', 'rta_avatar', 'rta_clips', 'rta_assets', 'rta_usage', 'rta_session_release',
  'rta_asset_remote', 'rta_avatar_update', 'rta_avatar_delete', 'rta_avatar_create', 'rta_loop_set', 'rta_clips_set', 'rta_session_mint',
  'rta_docs', 'rta_quickstart',
]
const WRITE_TOOLS = ['rta_asset_remote', 'rta_avatar_update', 'rta_avatar_delete', 'rta_avatar_create', 'rta_loop_set', 'rta_clips_set', 'rta_session_mint']
const READ_TOOLS = ALL_TOOLS.filter((n) => !WRITE_TOOLS.includes(n))

/** Arguments that pass every tool's validation, so a pre-aborted signal is the only reason to stop. */
const VALID_ARGS = {
  rta_status: {},
  rta_balance: {},
  rta_capacity: {},
  rta_avatars: {},
  rta_avatar: { avatarId: 'ava_test1' },
  rta_clips: { avatarId: 'ava_test1' },
  rta_assets: {},
  rta_usage: {},
  rta_session_release: { sessionId: 'ses_test1' },
  rta_asset_remote: { kind: 'image', remoteUrl: 'https://example.com/a.png' },
  rta_avatar_update: { avatarId: 'ava_test1', displayName: 'x' },
  rta_avatar_delete: { avatarId: 'ava_test1' },
  rta_avatar_create: { displayName: 'x', sourceAssetId: 'ast_test1' },
  rta_loop_set: { avatarId: 'ava_test1', motionPrompt: 'x' },
  rta_clips_set: { avatarId: 'ava_test1', clips: [{ clipId: 'c', role: 'idle', source: { motionPrompt: 'x' } }] },
  rta_session_mint: { avatarId: 'seed-rin-ashfall' },
  rta_docs: { page: 'quickstart' },
  rta_quickstart: { framework: 'express' },
}

async function loadDshTools() {
  const candidates = [process.env.DSH_TOOLS_ENTRY, '@deepseek-ai/dsh-tools'].filter(Boolean)
  for (const spec of candidates) {
    try {
      return await import(spec)
    } catch {
      // not installed here — try the next candidate
    }
  }
  return null
}
const dshTools = await loadDshTools()

/** Drive every tool through a pre-aborted signal so cancellable() returns its empty value. */
async function emptyValues() {
  const original = globalThis.fetch
  const controller = new AbortController()
  controller.abort()
  globalThis.fetch = async () => {
    throw new Error('fetch must not be reached with a pre-aborted signal')
  }
  try {
    const tools = buildRtaTools(deps())
    const out = {}
    for (const tool of tools) out[tool.name] = await tool.execute(VALID_ARGS[tool.name], { signal: controller.signal })
    return out
  } finally {
    globalThis.fetch = original
  }
}

test('render() is total: never throws for undefined/null/{}/[]/string/number/partial values', () => {
  const tools = buildRtaTools(deps())
  assert.equal(tools.length, 18)
  const values = [
    undefined, null, {}, [], 'str', 42, true,
    { avatars: 'not-an-array' }, { avatars: [null, 3, {}] }, { assets: [null] }, { clips: [{ clipId: 'c' }, null] }, { clips: 'x' },
    { totals: null }, { totals: 'x' }, { steps: 'x' }, { steps: [null] }, { next: 'x' },
    { status: 'queued' }, { status: 'ready' }, { status: 'cancelled' }, { ok: 'yes' }, { deleted: 'yes' },
    { key: null, errors: null, next: null }, { plugin: 'x', key: {}, errors: {}, next: [], balance: null, capacity: null },
    { plugin: 'x', key: { ref: 'R', configured: true, source: 's', environment: 'test' }, errors: { key: 'k', balance: 'b', capacity: 'c' }, next: ['n'], balance: {}, capacity: {}, configError: 'e', readOnly: true, writeApproval: false, maxSessionSeconds: 1 },
  ]
  for (const tool of tools) {
    for (const value of values) {
      const blocks = tool.output.render({}, value)
      assert.ok(Array.isArray(blocks) && blocks.length > 0, tool.name + ' renders a block for ' + JSON.stringify(value))
      assert.equal(blocks[0].type, 'text')
      assert.equal(typeof blocks[0].text, 'string')
    }
    const blocks = tool.output.render(undefined, undefined)
    assert.equal(typeof blocks[0].text, 'string', tool.name + ' tolerates missing args')
  }
})

test('every tool declares a timeoutMs; the read tools (incl. the idempotent release) a concurrency classifier, the writes none', () => {
  const tools = buildRtaTools(deps({ requestTimeoutMs: 7000, docsTimeoutMs: 9000 }))
  const by = Object.fromEntries(tools.map((t) => [t.name, t]))
  for (const name of ALL_TOOLS) assert.equal(typeof by[name].timeoutMs, 'number', name + ' timeoutMs')
  assert.equal(by.rta_status.timeoutMs, 14000, 'rta_status budget is 2×requestTimeoutMs (two requests)')
  for (const name of ALL_TOOLS.filter((n) => !['rta_status', 'rta_docs', 'rta_quickstart'].includes(n))) assert.equal(by[name].timeoutMs, 7000, name)
  assert.equal(by.rta_docs.timeoutMs, 9000)
  assert.equal(by.rta_quickstart.timeoutMs, 9000)
  for (const name of READ_TOOLS) assert.equal(by[name].isConcurrencySafe({}), true, name)
  for (const name of WRITE_TOOLS) assert.equal(by[name].isConcurrencySafe, undefined, name)
})

test('the empty value returned on cancellation carries every key the output schema requires', async () => {
  const empties = await emptyValues()
  const tools = buildRtaTools(deps())
  for (const tool of tools) {
    const empty = empties[tool.name]
    assert.equal(typeof empty, 'object', tool.name + ' settles with an object on cancellation')
    assert.notEqual(empty, null)
    const required = tool.output.schema.required ?? []
    for (const key of required) assert.ok(key in empty, tool.name + ' empty value has ' + key)
    assert.doesNotThrow(() => JSON.stringify(empty), tool.name + ' empty value is serialisable')
    const blocks = tool.output.render(VALID_ARGS[tool.name], empty)
    assert.equal(typeof blocks[0].text, 'string', tool.name + ' renders its empty value')
    assert.ok(!blocks[0].text.includes(KEY))
  }
  assert.equal(empties.rta_docs.markdown, '')
  assert.equal(empties.rta_docs.chars, 0)
  assert.equal(empties.rta_quickstart.source, 'cancelled')
  assert.equal(empties.rta_session_mint.status, 'cancelled')
  assert.equal(empties.rta_status.balance, null)
  assert.equal(empties.rta_status.capacity, null)
})

test('dsh-tools accepts every parameters/output schema and validates the cancellation empties', { skip: dshTools === null && 'set DSH_TOOLS_ENTRY to run against an installed dsh-tools' }, async () => {
  const { assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } = dshTools
  const tools = buildRtaTools(deps())
  const empties = await emptyValues()
  for (const tool of tools) {
    assert.doesNotThrow(() => assertObjectJsonSchema(tool.parameters), tool.name + ' parameters')
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema), tool.name + ' output schema')
    const violations = validateJsonSchemaValue(tool.output.schema, empties[tool.name], tool.name)
    assert.deepEqual(violations, [], tool.name + ' empty value validates')
  }
})

test('every cancellation empty is a lossless JSON object (no own undefined-valued keys)', async () => {
  const empties = await emptyValues()
  for (const [name, empty] of Object.entries(empties)) {
    const undefinedKeys = Object.keys(empty).filter((key) => empty[key] === undefined)
    assert.deepEqual(undefinedKeys, [], name + ' empty value has no undefined-valued keys')
  }
  if (dshTools !== null) {
    const { validateJsonSchemaValue } = dshTools
    for (const tool of buildRtaTools(deps())) assert.deepEqual(validateJsonSchemaValue(tool.output.schema, empties[tool.name], tool.name), [], tool.name + ' empty value validates')
  }
})

test('dsh-tools rejects a value that breaks a declared output shape (the schema is load-bearing, not decorative)', { skip: dshTools === null && 'set DSH_TOOLS_ENTRY to run against an installed dsh-tools' }, () => {
  const { validateJsonSchemaValue } = dshTools
  const by = Object.fromEntries(buildRtaTools(deps()).map((t) => [t.name, t]))
  assert.ok(validateJsonSchemaValue(by.rta_avatars.output.schema, { count: 'one', avatars: [] }, 'v').length > 0, 'count must be an integer')
  assert.ok(validateJsonSchemaValue(by.rta_avatar_delete.output.schema, { avatarId: 'ava_test1' }, 'v').length > 0, 'deleted is required')
  assert.ok(validateJsonSchemaValue(by.rta_session_mint.output.schema, { sessionId: null }, 'v').length > 0, 'status is required')
  assert.deepEqual(validateJsonSchemaValue(by.rta_session_mint.output.schema, { status: 'ready', sessionId: 'ses_test1', queueTicketId: null, warning: 'w', extra: 1 }, 'v'), [], 'nullable and open fields validate')
})
