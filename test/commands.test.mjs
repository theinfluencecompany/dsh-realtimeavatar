// The /rta command: grammar, onboarding text, key handling through a fake
// credential service (the pasted key must never come back out), and status.
// Everything runs offline; fetch is stubbed where a verb would reach the API.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRtaCommand, USAGE } from '../lib/commands.js'
import { resolveConfig } from '../lib/config.js'
import { AGENT_PROMPT, DOC_PAGES, SKILL_PAGES } from '../lib/facts.js'
import { defaultSkillsDir } from '../lib/skills.js'

const REF = 'REALTIME_AVATAR_API_KEY'
const KEY_BODY = 'x'.repeat(40)
const KEY = 'tic_test_' + KEY_BODY

/** A recording credential service; `stored` / `source` seed what describe/resolve report. */
function fakeCredentials({ stored, source } = {}) {
  const calls = []
  let value = stored
  let origin = source ?? (stored === undefined ? undefined : 'credentials')
  const service = {
    async resolve(ref) {
      calls.push(['resolve', ref])
      return value === undefined ? undefined : { value, source: origin }
    },
    async describe(ref) {
      calls.push(['describe', ref])
      return value === undefined ? { configured: false } : { configured: true, source: origin, writable: origin !== 'env' }
    },
    async set(ref, next) {
      calls.push(['set', ref, next])
      value = next
      origin = 'credentials'
    },
    async unset(ref) {
      calls.push(['unset', ref])
      value = undefined
      origin = undefined
    },
  }
  return { service, calls }
}

function makeDeps({ credentials, env = {}, config = null } = {}) {
  return {
    cfg: resolveConfig(config),
    keySource: () => ({ credentials, env }),
    randomUUID: () => 'u',
    skillsDir: defaultSkillsDir(),
  }
}

const run = (deps, rawInput) => buildRtaCommand(deps).handler({ rawInput })

function assertNoKeyEcho(text) {
  assert.ok(!text.includes(KEY), 'the key itself leaked into: ' + text)
  assert.ok(!text.includes(KEY_BODY), 'a fragment of the key leaked into: ' + text)
}

/** Replace globalThis.fetch for one test body. */
async function withFetch(stub, body) {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    return await body()
  } finally {
    globalThis.fetch = original
  }
}
const refuseFetch = async () => {
  throw new Error('fetch must not be reached by this verb')
}

test('the command definition never records its input', () => {
  const def = buildRtaCommand(makeDeps())
  assert.equal(def.name, 'rta')
  assert.equal(typeof def.description, 'string')
  assert.ok(def.description.length > 0)
  assert.equal(typeof def.input.hint, 'string')
  assert.ok(def.input.hint.length > 0)
  assert.equal(def.recordInput, false)
  assert.equal(typeof def.handler, 'function')
})

test('"" and "help" print the usage', async () => {
  for (const raw of ['', 'help', '  HELP  ']) {
    const result = await withFetch(refuseFetch, () => run(makeDeps(), raw))
    assert.equal(result.kind, 'success', raw)
    assert.equal(result.text, USAGE)
  }
  for (const verb of ['setup', 'key', 'key clear', 'status', 'prompt', 'docs']) assert.ok(USAGE.includes('/rta ' + verb), 'usage lists /rta ' + verb)
})

test('"setup" walks from sign-up to the first call using only public facts', async () => {
  const result = await withFetch(refuseFetch, () => run(makeDeps(), 'setup'))
  assert.equal(result.kind, 'success')
  for (const needle of ['https://realtimeavatar.ai/platform/dashboard', 'tic_test_', 'tic_live_', REF, 'seed-rin-ashfall', 'Sandbox', '1,020', '/rta key', '/rta status', 'npm install realtime-avatar']) {
    assert.ok(result.text.includes(needle), 'setup text lacks ' + JSON.stringify(needle))
  }
  assert.match(result.text, /free Sandbox: \$0\/mo, 1,020 credits/)
  assert.doesNotMatch(result.text, /tic_(live|test)_[A-Za-z0-9]/, 'setup must only show the tag, never a key-shaped value')
})

test('"setup" names a custom credential reference', async () => {
  const result = await run(makeDeps({ config: { apiKeyEnv: 'MY_RTA_REF' } }), 'setup')
  assert.ok(result.text.includes('MY_RTA_REF'))
})

test('"prompt" hands over the public agent prompt', async () => {
  const result = await withFetch(refuseFetch, () => run(makeDeps(), 'prompt'))
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes(AGENT_PROMPT))
  assert.ok(result.text.includes(REF))
})

test('"docs" lists all 14 public pages and the five skills', async () => {
  assert.equal(DOC_PAGES.length, 14)
  const result = await withFetch(refuseFetch, () => run(makeDeps(), 'docs'))
  assert.equal(result.kind, 'success')
  for (const page of DOC_PAGES) assert.ok(result.text.includes('- ' + page.slug + ': ' + page.title), 'docs list lacks ' + page.slug)
  for (const skill of Object.keys(SKILL_PAGES)) assert.ok(result.text.includes(skill), 'docs list lacks skill ' + skill)
  assert.ok(result.text.includes('https://realtimeavatar.ai/docs'))
})

test('"docs quickstart" resolves the canonical URL, markdown URL and carrying skill', async () => {
  const result = await withFetch(refuseFetch, () => run(makeDeps(), 'docs quickstart'))
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('https://realtimeavatar.ai/docs/quickstart'))
  assert.ok(result.text.includes('markdown: https://realtimeavatar.ai/docs/quickstart.md'))
  assert.ok(result.text.includes('skill: realtimeavatar-quickstart'))
  const upper = await run(makeDeps(), 'docs QUICKSTART')
  assert.equal(upper.text, result.text, 'page lookup is case-insensitive')
})

test('"docs nope" reports the unknown page and the valid slugs', async () => {
  const result = await withFetch(refuseFetch, () => run(makeDeps(), 'docs nope'))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /unknown page "nope"/)
  for (const page of DOC_PAGES) assert.ok(result.text.includes(page.slug))
})

test('"key" with no service and no env reports not configured', async () => {
  const result = await withFetch(refuseFetch, () => run(makeDeps(), 'key'))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /not configured/)
  assert.ok(result.text.includes(REF))
})

test('"key" reports the posture of an env-supplied key without the value', async () => {
  const result = await withFetch(refuseFetch, () => run(makeDeps({ env: { [REF]: KEY } }), 'key'))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /configured via process-env \(test key\)/)
  assertNoKeyEcho(result.text)
})

test('"key <value>" stores the trimmed key through the credential service and never echoes it', async () => {
  const { service, calls } = fakeCredentials()
  const result = await withFetch(refuseFetch, () => run(makeDeps({ credentials: service }), '  key   ' + KEY + '   '))
  assert.equal(result.kind, 'success', result.text)
  const sets = calls.filter((c) => c[0] === 'set')
  assert.deepEqual(sets, [['set', REF, KEY]])
  assert.ok(calls.findIndex((c) => c[0] === 'describe') < calls.findIndex((c) => c[0] === 'set'), 'describe runs before set')
  assertNoKeyEcho(result.text)
  assert.match(result.text, /test key/)
  assert.match(result.text, /49 chars/)
  assert.ok(result.text.includes(REF))
})

test('"key <value>" fails with RTA_KEY_SHADOWED when the reference comes from the launch environment', async () => {
  const { service, calls } = fakeCredentials({ stored: 'tic_live_' + 'y'.repeat(40), source: 'env' })
  const result = await withFetch(refuseFetch, () => run(makeDeps({ credentials: service }), 'key ' + KEY))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^RTA_KEY_SHADOWED: /)
  assert.equal(calls.filter((c) => c[0] === 'set').length, 0, 'set must not be attempted')
  assertNoKeyEcho(result.text)
  assert.ok(!result.text.includes('y'.repeat(40)), 'the existing env key must not be echoed either')
})

test('"key <value>" fails with RTA_KEY_STORE_UNAVAILABLE when the profile has no credential service', async () => {
  const result = await withFetch(refuseFetch, () => run(makeDeps(), 'key ' + KEY))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^RTA_KEY_STORE_UNAVAILABLE: /)
  assert.ok(result.text.includes(REF))
  assertNoKeyEcho(result.text)
})

test('"key <value>" redacts the key when the store itself throws with the value in its message', async () => {
  const { service } = fakeCredentials()
  service.set = async (_ref, value) => {
    throw new Error('disk full while writing ' + value)
  }
  const result = await withFetch(refuseFetch, () => run(makeDeps({ credentials: service }), 'key ' + KEY))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^RTA_KEY_STORE_UNAVAILABLE: /)
  assert.match(result.text, /disk full/)
  assertNoKeyEcho(result.text)
})

test('"key clear" removes the stored key', async () => {
  const { service, calls } = fakeCredentials({ stored: KEY })
  const result = await withFetch(refuseFetch, () => run(makeDeps({ credentials: service }), 'key clear'))
  assert.equal(result.kind, 'success')
  assert.deepEqual(
    calls.filter((c) => c[0] === 'unset'),
    [['unset', REF]],
  )
  assert.equal(result.text, 'Removed ' + REF + ' from the credential store.')
  assertNoKeyEcho(result.text)
})

/** A credential service layering a writable file entry over a read-only .env entry; unset() only touches the file. */
function layeredCredentials({ file, dotenv, dotenvSource = 'project-env' } = {}) {
  let fileValue = file
  const layer = () => (fileValue !== undefined ? { value: fileValue, source: 'file' } : dotenv !== undefined ? { value: dotenv, source: dotenvSource } : undefined)
  return {
    async resolve() {
      return layer()
    },
    async describe() {
      const hit = layer()
      return hit === undefined ? { configured: false } : { configured: true, source: hit.source, writable: hit.source === 'file' }
    },
    async set(_ref, next) {
      fileValue = next
    },
    async unset() {
      fileValue = undefined
    },
  }
}

test('"key clear" says what was removed and what still supplies the key afterwards', async () => {
  const nothing = await withFetch(refuseFetch, () => run(makeDeps({ credentials: layeredCredentials() }), 'key clear'))
  assert.equal(nothing.kind, 'success')
  assert.equal(nothing.text, 'Nothing was stored under ' + REF + ' in the credential store.')

  const project = await withFetch(refuseFetch, () => run(makeDeps({ credentials: layeredCredentials({ file: KEY, dotenv: 'tic_live_' + 'y'.repeat(40) }) }), 'key clear'))
  assert.equal(project.kind, 'success')
  assert.equal(project.text, 'Removed ' + REF + ' from the credential store. It is still supplied by project-env (the .env in the working directory) — remove it there to stop using it.')
  assertNoKeyEcho(project.text)
  assert.ok(!project.text.includes('y'.repeat(40)))

  const user = await withFetch(refuseFetch, () => run(makeDeps({ credentials: layeredCredentials({ dotenv: KEY, dotenvSource: 'user-env' }) }), 'key clear'))
  assert.equal(user.text, 'Nothing was stored under ' + REF + ' in the credential store. It is still supplied by user-env (the .env in the dsh home) — remove it there to stop using it.')

  const other = await withFetch(refuseFetch, () => run(makeDeps({ credentials: layeredCredentials({ dotenv: KEY, dotenvSource: 'vault' }) }), 'key clear'))
  assert.equal(other.text, 'Nothing was stored under ' + REF + ' in the credential store. It is still supplied by vault — remove it there to stop using it.')
})

test('"key clear" reports a store that refuses to remove as RTA_KEY_STORE_UNAVAILABLE', async () => {
  const { service } = fakeCredentials({ stored: KEY })
  service.unset = async () => {
    throw new Error('keychain locked')
  }
  const result = await withFetch(refuseFetch, () => run(makeDeps({ credentials: service }), 'key clear'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^RTA_KEY_STORE_UNAVAILABLE: the credential store refused to remove REALTIME_AVATAR_API_KEY: keychain locked/)
  assertNoKeyEcho(result.text)
})

test('"key clear" without a service is a coded error', async () => {
  const result = await run(makeDeps(), 'key clear')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^RTA_KEY_STORE_UNAVAILABLE: /)
})

test('"key notakey" is rejected as RTA_KEY_INVALID without echoing the input', async () => {
  const { service, calls } = fakeCredentials()
  for (const bad of ['notakey', 'tic_test_short', 'tic_prod_' + KEY_BODY, 'sk-' + KEY_BODY]) {
    const result = await withFetch(refuseFetch, () => run(makeDeps({ credentials: service }), 'key ' + bad))
    assert.equal(result.kind, 'error', bad)
    assert.match(result.text, /^RTA_KEY_INVALID: /, bad)
    assert.ok(!result.text.includes(bad), 'rejected value echoed: ' + result.text)
    assert.ok(!result.text.includes(KEY_BODY))
  }
  assert.equal(calls.filter((c) => c[0] === 'set').length, 0)
})

test('"status" without a key renders the NOT configured line and touches no network', async () => {
  const result = await withFetch(refuseFetch, () => run(makeDeps(), 'status'))
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /^Realtime Avatar status \(dsh-realtimeavatar \d+\.\d+\.\d+\)/)
  assert.match(result.text, /- API key \(REALTIME_AVATAR_API_KEY\): NOT configured/)
  assert.match(result.text, /- key problem: no API key behind REALTIME_AVATAR_API_KEY/)
  assert.match(result.text, /- writes: approval-gated; session cap 300 s/)
  assert.match(result.text, /- next: Run \/rta setup/)
})

test('"status" with a key renders credits and capacity from stubbed API responses, key never shown', async () => {
  const { service } = fakeCredentials({ stored: KEY })
  const seen = []
  const stub = async (url, init) => {
    const u = String(url)
    seen.push({ url: u, auth: init.headers.Authorization, ua: init.headers['User-Agent'] })
    if (u === 'https://realtimeavatar.ai/api/v1/credits/balance') {
      return new Response(JSON.stringify({ availableCreditMicros: 1020e6, reservedCreditMicros: 0, balanceCreditMicros: 1020e6, lifetimeGrantedCreditMicros: 1020e6, lifetimeUsedCreditMicros: 0, updatedAt: '2026-09-02T00:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u === 'https://realtimeavatar.ai/api/v1/realtime/livekit/capacity') {
      return new Response(JSON.stringify({ max_sessions: 4, active_sessions: 1, reserved_sessions: 0, available_sessions: 3, queue_size: 0, admission_open: true, recommended_retry_ms: 0, load: 0.25 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error('unexpected request ' + u)
  }
  const result = await withFetch(stub, () => run(makeDeps({ credentials: service }), 'status'))
  assert.equal(result.kind, 'success', result.text)
  assert.equal(seen.length, 2)
  for (const call of seen) {
    assert.equal(call.auth, 'Bearer ' + KEY, 'the key travels only in the Authorization header')
    assert.match(call.ua, /^dsh-realtimeavatar\/\d+\.\d+\.\d+$/)
  }
  assert.match(result.text, /- API key \(REALTIME_AVATAR_API_KEY\): configured via credentials, environment tag test/)
  assert.match(result.text, /- credits: 1020 available \(0 reserved of 1020\), ≈ 17 min on air/)
  assert.match(result.text, /- capacity: 3 free of 4 slots, queue 0, admission open/)
  assert.match(result.text, /- writes: approval-gated; session cap 300 s/)
  assert.match(result.text, /- next: Ready\. Build the first call on the public example avatar seed-rin-ashfall/)
  assertNoKeyEcho(result.text)
})

test('"status" reports a rejected key as a next step, without the key', async () => {
  const { service } = fakeCredentials({ stored: KEY })
  const stub = async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
  const result = await withFetch(stub, () => run(makeDeps({ credentials: service }), 'status'))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /- credits: unavailable — the API key was rejected/)
  assert.match(result.text, /- next: The key was rejected: create a fresh one/)
  assertNoKeyEcho(result.text)
})

test('"status" under readOnly says so', async () => {
  const result = await withFetch(refuseFetch, () => run(makeDeps({ config: { readOnly: true } }), 'status'))
  assert.match(result.text, /- writes: disabled \(readOnly\)/)
})

test('an unknown verb is an error carrying the usage', async () => {
  const result = await withFetch(refuseFetch, () => run(makeDeps(), 'frobnicate now'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^unknown sub-command "frobnicate"\./)
  assert.ok(result.text.includes(USAGE))
})

test('a key pasted without the "key" verb is never echoed: the error points at /rta key instead', async () => {
  for (const pasted of [KEY, 'tic_live_' + 'y'.repeat(40), 'TIC_TEST_' + KEY_BODY, 'tic_' + KEY_BODY + ' extra words']) {
    const result = await withFetch(refuseFetch, () => run(makeDeps(), pasted))
    assert.equal(result.kind, 'error', pasted)
    assert.match(result.text, /^unknown sub-command \(looks like a key — use \/rta key <tic_…>\)\./, pasted)
    assert.ok(!result.text.includes('y'.repeat(40)))
    assert.doesNotMatch(result.text, /tic_(live|test)_[A-Za-z0-9]/, 'no key-shaped value at all')
    assertNoKeyEcho(result.text)
    assert.ok(result.text.includes(USAGE))
  }
})

test('an unknown verb is echoed at most 40 characters long', async () => {
  const long = 'v'.repeat(60)
  const result = await withFetch(refuseFetch, () => run(makeDeps(), long + ' arg'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^unknown sub-command "v{40}…"\./)
  assert.ok(!result.text.includes('v'.repeat(41)))
  const exact = await run(makeDeps(), 'w'.repeat(40))
  assert.match(exact.text, /^unknown sub-command "w{40}"\./, 'no ellipsis at exactly 40')
  const upper = await run(makeDeps(), 'FroBnicate')
  assert.match(upper.text, /^unknown sub-command "frobnicate"\./, 'the verb is lower-cased before it is echoed')
})

test('the usage line for "key" says the value is neither recorded nor shown to the model', () => {
  const line = USAGE.split('\n').find((l) => l.startsWith('/rta key <tic_…>'))
  assert.ok(line !== undefined)
  assert.ok(line.includes('not recorded in the session log; never shown to the model'), line)
  assert.doesNotMatch(USAGE, /tic_(live|test)_[A-Za-z0-9]/)
})
