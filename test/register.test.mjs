// Plugin entry: what apply() registers on a fake Cordis context, how the
// pre-execute gate answers, the optional-service sub-fibers, config fallback,
// and the boot-time invariant that nothing touches the network or the key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'
import { TOOL_NAMES } from '../lib/gate.js'

const KEY_BODY = 'x'.repeat(40)
const KEY = 'tic_test_' + KEY_BODY

function makeFakeCtx({ withInject = true, withGet = true, services = {} } = {}) {
  const registered = []
  const listeners = []
  const injects = []
  const gets = []
  const ctx = {
    tools: {
      register(def) {
        registered.push(def)
        return () => {}
      },
    },
    on(event, listener) {
      listeners.push([event, listener])
    },
  }
  if (withGet) {
    ctx.get = (service) => {
      gets.push(service)
      return services[service]
    }
  }
  if (withInject) {
    ctx.inject = (deps, callback) => {
      injects.push({ deps, callback })
    }
  }
  const gate = () => {
    const found = listeners.filter(([event]) => event === 'tools/pre-execute')
    assert.equal(found.length, 1, 'exactly one pre-execute listener')
    return found[0][1]
  }
  return { ctx, registered, listeners, injects, gets, gate }
}

const next = async () => ({ kind: 'allow', reason: 'from next' })

/** Run body with console.warn captured. */
function captureWarn(body) {
  const warnings = []
  const original = console.warn
  console.warn = (msg) => warnings.push(String(msg))
  try {
    body()
  } finally {
    console.warn = original
  }
  return warnings
}

test('plugin metadata', () => {
  assert.equal(name, 'realtimeavatar')
  assert.deepEqual(inject, ['tools'])
})

test('apply registers exactly the 18 rta_* tools and exactly one pre-execute listener', () => {
  const { ctx, registered, listeners } = makeFakeCtx()
  apply(ctx, null)
  assert.equal(registered.length, 18)
  const names = registered.map((d) => d.name)
  assert.equal(new Set(names).size, 18, 'tool names are unique')
  for (const n of names) assert.match(n, /^rta_[a-z_]+$/)
  assert.deepEqual([...names].sort(), [...TOOL_NAMES].sort(), 'registered tools match the gate table')
  assert.deepEqual(
    listeners.map(([event]) => event),
    ['tools/pre-execute'],
  )
})

test('every registered tool has the shape dsh expects', () => {
  const { ctx, registered } = makeFakeCtx()
  apply(ctx, null)
  for (const def of registered) {
    assert.equal(typeof def.name, 'string')
    assert.ok(def.description.length > 0, def.name + ' has a description')
    assert.equal(def.parameters.type, 'object')
    assert.equal(typeof def.parameters.properties, 'object')
    assert.equal(typeof def.output.schema, 'object')
    assert.equal(typeof def.output.render, 'function')
    assert.equal(typeof def.execute, 'function')
    assert.equal(typeof def.timeoutMs, 'number', def.name + ' declares a timeout')
  }
})

test('the gate waterfalls a foreign tool by calling next', async () => {
  const { ctx, gate } = makeFakeCtx()
  apply(ctx, null)
  let nextCalled = false
  const verdict = await gate()({ name: 'd1_query', arguments: { sql: 'SELECT 1' } }, async () => {
    nextCalled = true
    return { kind: 'ask', reason: 'someone else decides' }
  })
  assert.equal(nextCalled, true)
  assert.deepEqual(verdict, { kind: 'ask', reason: 'someone else decides' })
})

test('the gate never force-allows: reads waterfall to next and return its verdict verbatim', async () => {
  const { ctx, gate } = makeFakeCtx()
  apply(ctx, null)
  for (const read of ['rta_status', 'rta_balance', 'rta_docs', 'rta_session_release']) {
    let nextCalled = 0
    const sentinel = { kind: 'allow', reason: 'from next' }
    const verdict = await gate()({ name: read, arguments: {} }, async () => {
      nextCalled += 1
      return sentinel
    })
    assert.equal(nextCalled, 1, read + ' consults next exactly once')
    assert.equal(verdict, sentinel, read + ' returns the downstream verdict itself, never its own {kind:allow}')
    // A later policy (plan mode, a deployment policy) can still deny a read.
    const denied = await gate()({ name: read, arguments: {} }, async () => ({ kind: 'deny', reason: 'plan mode' }))
    assert.deepEqual(denied, { kind: 'deny', reason: 'plan mode' }, read)
  }
})

test('for an ask the gate awaits next: a downstream deny wins, anything else yields our ask', async () => {
  const { ctx, gate } = makeFakeCtx()
  apply(ctx, null)
  const event = { name: 'rta_session_mint', arguments: { avatarId: 'seed-rin-ashfall' } }
  let nextCalled = 0
  const ask = await gate()(event, async () => {
    nextCalled += 1
    return { kind: 'allow', reason: 'from next' }
  })
  assert.equal(nextCalled, 1)
  assert.equal(ask.kind, 'ask')
  assert.match(ask.reason, /^rta_session_mint reserves a call slot/)
  const theirs = await gate()(event, async () => ({ kind: 'ask', reason: 'someone else asks' }))
  assert.equal(theirs.kind, 'ask')
  assert.match(theirs.reason, /^rta_session_mint/, 'our reason, not the downstream one')
  const denied = await gate()(event, async () => ({ kind: 'deny', reason: 'plan mode forbids writes' }))
  assert.deepEqual(denied, { kind: 'deny', reason: 'plan mode forbids writes' })
  // the same for a free write under the defaults
  const free = await gate()({ name: 'rta_avatar_delete', arguments: { avatarId: 'ava_1' } }, async () => ({ kind: 'deny', reason: 'nope' }))
  assert.deepEqual(free, { kind: 'deny', reason: 'nope' })
})

test('every tool is wrapped by guarded(): a foreign error is re-thrown redacted, coded errors pass through untouched', async () => {
  const credentials = {
    async resolve() {
      throw new Error('vault exploded while reading ' + KEY + '; header Bearer ' + KEY)
    },
    async describe() {
      return { configured: true, source: 'file' }
    },
    async set() {},
    async unset() {},
  }
  const { ctx, registered } = makeFakeCtx({ services: { credentials } })
  apply(ctx, null)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('fetch must not be reached')
  }
  try {
    for (const name of ['rta_balance', 'rta_avatar_create', 'rta_docs']) {
      const tool = registered.find((d) => d.name === name)
      const args = { rta_balance: {}, rta_avatar_create: { displayName: 'x', sourceAssetId: 'ast_test1' }, rta_docs: { page: 'nope' } }[name]
      await assert.rejects(
        () => tool.execute(args, {}),
        (err) => {
          assert.ok(err instanceof Error)
          assert.ok(!err.message.includes(KEY), name + ' leaked the key: ' + err.message)
          assert.ok(!err.message.includes(KEY_BODY), name + ' leaked a fragment of the key')
          if (name !== 'rta_docs') {
            assert.equal(err.name, 'Error', 'a foreign error becomes a plain Error')
            assert.equal(err.message, 'vault exploded while reading tic_test_<redacted>; header Bearer <redacted>')
          } else {
            assert.match(err.message, /unknown docs page "nope"/, 'plugin-constructed errors keep their message')
          }
          return true
        },
        name,
      )
    }
    // A coded KeyError passes through with its name and code intact.
    credentials.resolve = async () => undefined
    await assert.rejects(() => registered.find((d) => d.name === 'rta_balance').execute({}, {}), (err) => err.name === 'KeyError' && err.code === 'RTA_KEY_MISSING')
    // So does an RtaApiError from the client.
    credentials.resolve = async () => ({ value: KEY, source: 'file' })
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'nope' }), { status: 404 })
    await assert.rejects(() => registered.find((d) => d.name === 'rta_avatar').execute({ avatarId: 'ava_test1' }, {}), (err) => err.name === 'RtaApiError' && err.kind === 'not_found')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('under readOnly the gate denies rta_avatar_create', async () => {
  const { ctx, gate } = makeFakeCtx()
  apply(ctx, { readOnly: true })
  const verdict = await gate()({ name: 'rta_avatar_create', arguments: { displayName: 'Nova' } }, next)
  assert.equal(verdict.kind, 'deny')
  assert.match(verdict.reason, /readOnly/)
  assert.match(verdict.reason, /rta_avatar_create/)
  const free = await gate()({ name: 'rta_avatar_update', arguments: { avatarId: 'ava_1' } }, next)
  assert.equal(free.kind, 'deny')
})

test('under the defaults the gate asks for rta_avatar_create with a redacted reason', async () => {
  const { ctx, gate } = makeFakeCtx()
  apply(ctx, null)
  const verdict = await gate()({ name: 'rta_avatar_create', arguments: { displayName: 'Nova ' + KEY, sourceAssetId: 'ast_portrait', motionPrompt: 'warm smile' } }, next)
  assert.equal(verdict.kind, 'ask')
  assert.equal(typeof verdict.reason, 'string')
  assert.match(verdict.reason, /^rta_avatar_create spends credits/)
  assert.match(verdict.reason, /ast_portrait/)
  assert.match(verdict.reason, /tic_test_<redacted>/)
  assert.ok(!verdict.reason.includes(KEY_BODY), 'the reason leaked the key: ' + verdict.reason)
  assert.ok(verdict.reason.length < 400)
})

test('ctx.inject is called for systemPrompt, skills and commands, and each callback registers only when the service exists', () => {
  const { ctx, injects } = makeFakeCtx()
  apply(ctx, null)
  assert.deepEqual(
    injects.map((i) => i.deps),
    [['systemPrompt'], ['skills'], ['commands']],
  )
  const [prompt, skills, commands] = injects

  const sections = []
  prompt.callback({ systemPrompt: { section: (s) => (sections.push(s), () => {}) } })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:rta')
  assert.equal(sections[0].order, 118)
  assert.equal(typeof sections[0].text, 'string')

  const factories = []
  skills.callback({ skills: { registerProvider: (f) => (factories.push(f), () => {}) } })
  assert.equal(factories.length, 1)
  assert.equal(typeof factories[0], 'function')
  const provider = factories[0]()
  assert.equal(provider.name, 'dsh-realtimeavatar')
  assert.equal(typeof provider.list, 'function')
  assert.equal(typeof provider.get, 'function')

  const definitions = []
  commands.callback({ commands: { register: (d) => (definitions.push(d), () => {}) } })
  assert.equal(definitions.length, 1)
  assert.equal(definitions[0].name, 'rta')
  assert.equal(definitions[0].recordInput, false)

  // A scope without the service is a no-op, not a crash.
  for (const { callback } of injects) assert.doesNotThrow(() => callback({}))
  assert.equal(sections.length, 1)
  assert.equal(factories.length, 1)
  assert.equal(definitions.length, 1)
})

test('apply works on a context with neither inject nor get', () => {
  const { ctx, registered, listeners } = makeFakeCtx({ withInject: false, withGet: false })
  assert.equal('inject' in ctx, false)
  assert.equal('get' in ctx, false)
  assert.doesNotThrow(() => apply(ctx, null))
  assert.equal(registered.length, 18)
  assert.equal(listeners.length, 1)
})

test('invalid config warns once and falls back to the defaults; rta_status reports the reason', async () => {
  const { ctx, registered, gate } = makeFakeCtx({ withGet: false })
  const saved = process.env.REALTIME_AVATAR_API_KEY
  delete process.env.REALTIME_AVATAR_API_KEY
  try {
    const warnings = captureWarn(() => apply(ctx, { maxSessionSeconds: -5, readOnly: false, writeApproval: true }))
    assert.equal(warnings.length, 1, JSON.stringify(warnings))
    assert.match(warnings[0], /^\[dsh-realtimeavatar\] invalid config, falling back to defaults: maxSessionSeconds/)
    assert.equal(registered.length, 18)
    // Defaults in effect: writes ask.
    const verdict = await gate()({ name: 'rta_avatar_delete', arguments: { avatarId: 'ava_1' } }, next)
    assert.equal(verdict.kind, 'ask')
    // rta_status carries the config error and never throws on a missing key.
    const status = await registered.find((d) => d.name === 'rta_status').execute({}, {})
    assert.match(status.configError, /maxSessionSeconds/)
    assert.equal(status.key.configured, false)
    assert.equal(status.maxSessionSeconds, 300)
    assert.equal(status.balance, null)
  } finally {
    if (saved !== undefined) process.env.REALTIME_AVATAR_API_KEY = saved
  }
})

test('a key pasted into apiKeyEnv is refused at boot and neither the warning nor rta_status echoes it', async () => {
  const { ctx, registered } = makeFakeCtx({ withGet: false })
  const saved = process.env.REALTIME_AVATAR_API_KEY
  delete process.env.REALTIME_AVATAR_API_KEY
  try {
    const warnings = captureWarn(() => apply(ctx, { apiKeyEnv: KEY }))
    assert.equal(warnings.length, 1, JSON.stringify(warnings))
    assert.match(warnings[0], /^\[dsh-realtimeavatar\] invalid config, falling back to defaults: apiKeyEnv looks like an API key/)
    assert.ok(!warnings[0].includes(KEY) && !warnings[0].includes(KEY_BODY), 'the warning leaked the key')
    const status = await registered.find((d) => d.name === 'rta_status').execute({}, {})
    assert.match(status.configError, /looks like an API key/)
    assert.ok(!JSON.stringify(status).includes(KEY_BODY), 'rta_status leaked the key')
    assert.equal(status.key.ref, 'REALTIME_AVATAR_API_KEY', 'defaults in effect')
    const text = registered.find((d) => d.name === 'rta_status').output.render({}, status)[0].text
    assert.match(text, /config error: apiKeyEnv looks like an API key/)
    assert.ok(!text.includes(KEY_BODY))
  } finally {
    if (saved !== undefined) process.env.REALTIME_AVATAR_API_KEY = saved
  }
})

test('writeApproval:false with readOnly:false warns at boot, frees the free writes and still asks for credit spend', async () => {
  const { ctx, gate } = makeFakeCtx()
  const warnings = captureWarn(() => apply(ctx, { readOnly: false, writeApproval: false }))
  assert.equal(warnings.length, 1, JSON.stringify(warnings))
  assert.match(warnings[0], /writeApproval:false/)
  assert.match(warnings[0], /credit-spending tools still ask/)
  const free = await gate()({ name: 'rta_avatar_update', arguments: { avatarId: 'ava_1', displayName: 'x' } }, next)
  assert.equal(free.kind, 'allow')
  const costly = await gate()({ name: 'rta_session_mint', arguments: { avatarId: 'seed-rin-ashfall' } }, next)
  assert.equal(costly.kind, 'ask')
})

test('readOnly:true with writeApproval:false warns nothing and still denies', async () => {
  const { ctx, gate } = makeFakeCtx()
  const warnings = captureWarn(() => apply(ctx, { readOnly: true, writeApproval: false }))
  assert.deepEqual(warnings, [])
  const verdict = await gate()({ name: 'rta_avatar_update', arguments: {} }, next)
  assert.equal(verdict.kind, 'deny')
})

test('apply touches neither the network, the credential service nor the environment', () => {
  const originalFetch = globalThis.fetch
  const originalEnv = process.env
  const saved = originalEnv.REALTIME_AVATAR_API_KEY
  delete originalEnv.REALTIME_AVATAR_API_KEY
  globalThis.fetch = () => {
    throw new Error('fetch must not be called at apply')
  }
  process.env = new Proxy(originalEnv, {
    get(target, key) {
      if (key === 'REALTIME_AVATAR_API_KEY') throw new Error('the key must not be read at apply')
      return target[key]
    },
  })
  try {
    const { ctx, registered, gets, injects } = makeFakeCtx({
      services: {
        credentials: {
          resolve() {
            throw new Error('credentials.resolve must not run at apply')
          },
          describe() {
            throw new Error('credentials.describe must not run at apply')
          },
        },
      },
    })
    assert.doesNotThrow(() => apply(ctx, null))
    assert.equal(registered.length, 18)
    assert.deepEqual(gets, [], 'ctx.get is consulted per call, never at boot')
    // Even wiring the optional services must stay lazy.
    for (const { callback } of injects) callback({ systemPrompt: { section: () => () => {} }, skills: { registerProvider: () => () => {} }, commands: { register: () => () => {} } })
    assert.deepEqual(gets, [])
  } finally {
    process.env = originalEnv
    globalThis.fetch = originalFetch
    if (saved !== undefined) process.env.REALTIME_AVATAR_API_KEY = saved
  }
})
