import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KeyError, validateKeyFormat, keyEnvironment, resolveKey, describeKey, storeKey, clearKey } from '../lib/credentials.js'

const REF = 'REALTIME_AVATAR_API_KEY'
const TEST_KEY = 'tic_test_' + 'x'.repeat(40)
const LIVE_KEY = 'tic_live_' + 'y'.repeat(40)

/** A fake harness credential service that records every call it receives. */
function fakeService({ resolve, describe, setError, unsetError } = {}) {
  const calls = []
  const service = {
    async resolve(ref) {
      calls.push(['resolve', ref])
      return typeof resolve === 'function' ? resolve(ref) : resolve
    },
    async describe(ref) {
      calls.push(['describe', ref])
      return describe ?? { configured: false }
    },
    async set(ref, value) {
      calls.push(['set', ref, value])
      if (setError !== undefined) throw setError
    },
    async unset(ref) {
      calls.push(['unset', ref])
      if (unsetError !== undefined) throw unsetError
    },
  }
  return { service, calls }
}

/** assert.throws / assert.rejects validator for a coded KeyError. */
function keyError(code, extra) {
  return (err) => {
    assert.ok(err instanceof KeyError, 'expected a KeyError, got ' + String(err))
    assert.equal(err.name, 'KeyError')
    assert.equal(err.code, code)
    assert.ok(!err.message.includes(TEST_KEY) && !err.message.includes(LIVE_KEY), 'message must never carry a key')
    if (extra !== undefined) extra(err)
    return true
  }
}

// ---------------------------------------------------------------- resolveKey

test('resolveKey prefers the credential service and ignores the launch environment when the service exists', async () => {
  const { service, calls } = fakeService({ resolve: { value: TEST_KEY, source: 'file' } })
  const key = await resolveKey({ credentials: service, env: { [REF]: LIVE_KEY } }, REF)
  assert.equal(key, TEST_KEY)
  assert.deepEqual(calls, [['resolve', REF]])
})

test('resolveKey does not fall back to the environment when the service has no value', async () => {
  const { service, calls } = fakeService({ resolve: undefined })
  await assert.rejects(resolveKey({ credentials: service, env: { [REF]: LIVE_KEY } }, REF), keyError('RTA_KEY_MISSING'))
  assert.deepEqual(calls, [['resolve', REF]])
})

test('resolveKey falls back to the launch environment only when the service is absent', async () => {
  assert.equal(await resolveKey({ env: { [REF]: LIVE_KEY } }, REF), LIVE_KEY)
  assert.equal(await resolveKey({ env: { OTHER_REF: TEST_KEY, [REF]: LIVE_KEY } }, 'OTHER_REF'), TEST_KEY)
})

test('a missing key is RTA_KEY_MISSING and the message names the ref, /rta setup (web UI) and the export (headless)', async () => {
  const check = keyError('RTA_KEY_MISSING', (err) => {
    assert.match(err.message, new RegExp(REF))
    assert.match(err.message, /run \/rta setup/)
    assert.match(err.message, /\/rta key <tic_…>/)
    assert.match(err.message, new RegExp('export ' + REF + ' in the shell that launches dsh'))
    assert.doesNotMatch(err.message, /tic_(live|test)_[A-Za-z0-9]/)
  })
  await assert.rejects(resolveKey({ env: {} }, REF), check)
  await assert.rejects(resolveKey({ env: { [REF]: '' } }, REF), check)
  await assert.rejects(resolveKey({ env: { [REF]: '   \n' } }, REF), check)
  await assert.rejects(resolveKey({ credentials: fakeService({ resolve: { value: '  ' } }).service, env: {} }, REF), check)
  await assert.rejects(resolveKey({ credentials: fakeService().service, env: {} }, 'CUSTOM_REF'), keyError('RTA_KEY_MISSING', (err) => {
    assert.match(err.message, /CUSTOM_REF/)
    assert.match(err.message, /export CUSTOM_REF/)
    assert.ok(!err.message.includes(REF), 'only the configured reference is named')
  }))
})

test('resolveKey trims and validates what the service returns', async () => {
  const { service } = fakeService({ resolve: { value: '  ' + TEST_KEY + '\n' } })
  assert.equal(await resolveKey({ credentials: service, env: {} }, REF), TEST_KEY)
})

test('a malformed key from either source is RTA_KEY_INVALID and is never echoed', async () => {
  const bad = 'not-a-key-' + '0'.repeat(30)
  const check = keyError('RTA_KEY_INVALID', (err) => {
    assert.ok(!err.message.includes(bad), 'message must not echo the value')
    assert.match(err.message, /tic_live_… or tic_test_…/)
  })
  await assert.rejects(resolveKey({ env: { [REF]: bad } }, REF), check)
  await assert.rejects(resolveKey({ credentials: fakeService({ resolve: { value: bad } }).service, env: {} }, REF), check)
})

// ------------------------------------------------------- validateKeyFormat

test('validateKeyFormat accepts both tags, trims, and returns the trimmed key', () => {
  assert.equal(validateKeyFormat(TEST_KEY, REF), TEST_KEY)
  assert.equal(validateKeyFormat(LIVE_KEY, REF), LIVE_KEY)
  assert.equal(validateKeyFormat('  ' + LIVE_KEY + '  ', REF), LIVE_KEY)
  assert.equal(validateKeyFormat('\t' + TEST_KEY + '\r\n', REF), TEST_KEY)
  // the URL-safe alphabet: letters, digits, underscore and dash (the same alphabet the redactor recognises)
  assert.equal(validateKeyFormat('tic_test_ab-cd_ef_gh', REF), 'tic_test_ab-cd_ef_gh')
  assert.equal(validateKeyFormat('tic_live_' + 'AZaz09_-'.repeat(2), REF), 'tic_live_' + 'AZaz09_-'.repeat(2))
})

test('validateKeyFormat rejects keys outside the URL-safe alphabet ("+", ".", "!", "/", "=")', () => {
  for (const bad of ['tic_test_ab.cd-ef_gh', 'tic_test_abcd+efgh', 'tic_test_abcdefgh!', 'tic_test_abcd/efgh', 'tic_test_abcdefgh=', 'tic_test_abcd efgh']) {
    assert.throws(() => validateKeyFormat(bad, REF), keyError('RTA_KEY_INVALID', (err) => assert.ok(!err.message.includes(bad))), 'should reject ' + bad)
  }
})

test('validateKeyFormat boundaries: 8 chars after the tag and 512 chars overall', () => {
  assert.equal(validateKeyFormat('tic_test_12345678', REF), 'tic_test_12345678')
  assert.throws(() => validateKeyFormat('tic_test_1234567', REF), keyError('RTA_KEY_INVALID'))
  const max = 'tic_live_' + 'x'.repeat(512 - 'tic_live_'.length)
  assert.equal(max.length, 512)
  assert.equal(validateKeyFormat(max, REF), max)
  assert.throws(() => validateKeyFormat(max + 'x', REF), keyError('RTA_KEY_INVALID'))
  // surrounding whitespace is not counted against the limit
  assert.equal(validateKeyFormat('  ' + max + '  ', REF), max)
})

test('an empty or blank value is RTA_KEY_MISSING', () => {
  for (const blank of ['', ' ', '\n\t ']) {
    assert.throws(
      () => validateKeyFormat(blank, REF),
      keyError('RTA_KEY_MISSING', (err) => {
        assert.match(err.message, /is empty/)
        assert.match(err.message, new RegExp(REF))
      }),
    )
  }
})

test('invalid formats are RTA_KEY_INVALID and the value never appears in the message', () => {
  const invalid = [
    'x'.repeat(40), // no prefix
    'sk-' + 'x'.repeat(40), // another vendor's shape
    'tic_prod_' + 'x'.repeat(40), // unknown tag
    'TIC_TEST_' + 'x'.repeat(40), // wrong case
    'tic_test_abcd efgh' + 'x'.repeat(20), // whitespace inside
    'tic_test_abcd\tefgh' + 'x'.repeat(20), // tab inside
    'tic_test_abcd\nefgh' + 'x'.repeat(20), // newline inside
    'tic_test_1234567', // too short
    'tic_test_' + 'é'.repeat(12), // non-ASCII
    'tic_test_' + 'x'.repeat(504), // 513 chars
    'Bearer ' + TEST_KEY, // a header value, not a key
  ]
  for (const bad of invalid) {
    assert.throws(
      () => validateKeyFormat(bad, REF),
      keyError('RTA_KEY_INVALID', (err) => {
        assert.ok(!err.message.includes(bad.trim()), 'message must not echo the value: ' + err.message)
        assert.ok(!err.message.includes('x'.repeat(8)), 'message must not echo part of the value')
        assert.match(err.message, new RegExp(REF))
        assert.match(err.message, /\/rta setup/)
      }),
      'should reject: ' + JSON.stringify(bad).slice(0, 40),
    )
  }
  // a bare tag with nothing after it is invalid too
  assert.throws(() => validateKeyFormat('tic_test_', REF), keyError('RTA_KEY_INVALID'))
})

// ---------------------------------------------------------- keyEnvironment

test('keyEnvironment reads the tag from the prefix', () => {
  assert.equal(keyEnvironment(LIVE_KEY), 'live')
  assert.equal(keyEnvironment(TEST_KEY), 'test')
  assert.equal(keyEnvironment('tic_prod_' + 'x'.repeat(40)), 'unknown')
  assert.equal(keyEnvironment('TIC_LIVE_' + 'x'.repeat(40)), 'unknown')
  assert.equal(keyEnvironment(''), 'unknown')
  assert.equal(keyEnvironment(' ' + LIVE_KEY), 'unknown') // no trimming here; callers trim
})

// ------------------------------------------------------------- describeKey

test('describeKey from the service reports configured/source/environment and never the value', async () => {
  const { service, calls } = fakeService({ describe: { configured: true, source: 'file', writable: true }, resolve: { value: TEST_KEY } })
  const posture = await describeKey({ credentials: service, env: { [REF]: LIVE_KEY } }, REF)
  assert.deepEqual(posture, { ref: REF, configured: true, source: 'file', environment: 'test' })
  assert.ok(!JSON.stringify(posture).includes(TEST_KEY))
  assert.deepEqual(calls, [['describe', REF], ['resolve', REF]])
})

test('describeKey source falls back from describe() to resolve() to "credentials"', async () => {
  const fromResolve = fakeService({ describe: { configured: true }, resolve: { value: LIVE_KEY, source: 'env' } }).service
  assert.deepEqual(await describeKey({ credentials: fromResolve, env: {} }, REF), { ref: REF, configured: true, source: 'env', environment: 'live' })
  const neither = fakeService({ describe: { configured: true }, resolve: { value: '  ' + LIVE_KEY + '  ' } }).service
  assert.deepEqual(await describeKey({ credentials: neither, env: {} }, REF), { ref: REF, configured: true, source: 'credentials', environment: 'live' })
})

test('describeKey reports an unconfigured ref without calling resolve()', async () => {
  const { service, calls } = fakeService({ describe: { configured: false }, resolve: { value: TEST_KEY } })
  assert.deepEqual(await describeKey({ credentials: service, env: { [REF]: LIVE_KEY } }, REF), { ref: REF, configured: false, source: 'none', environment: 'none' })
  assert.deepEqual(calls, [['describe', REF]])
})

test('describeKey reports environment "unknown" when describe() says configured but resolve() yields nothing', async () => {
  const { service } = fakeService({ describe: { configured: true, source: 'file' }, resolve: undefined })
  assert.deepEqual(await describeKey({ credentials: service, env: {} }, REF), { ref: REF, configured: true, source: 'file', environment: 'unknown' })
})

test('describeKey without a service reads the launch environment as process-env', async () => {
  assert.deepEqual(await describeKey({ env: { [REF]: LIVE_KEY } }, REF), { ref: REF, configured: true, source: 'process-env', environment: 'live' })
  assert.deepEqual(await describeKey({ env: { [REF]: '  ' + TEST_KEY + '  ' } }, REF), { ref: REF, configured: true, source: 'process-env', environment: 'test' })
  assert.deepEqual(await describeKey({ env: {} }, REF), { ref: REF, configured: false, source: 'none', environment: 'none' })
  assert.deepEqual(await describeKey({ env: { [REF]: '   ' } }, REF), { ref: REF, configured: false, source: 'none', environment: 'none' })
})

// ---------------------------------------------------------------- storeKey

test('storeKey validates, then hands the trimmed key to set(ref, key)', async () => {
  const { service, calls } = fakeService({ describe: { configured: false } })
  const result = await storeKey({ credentials: service, env: {} }, REF, '  ' + TEST_KEY + '\n')
  assert.deepEqual(result, { environment: 'test', length: TEST_KEY.length })
  assert.deepEqual(calls, [
    ['describe', REF],
    ['set', REF, TEST_KEY],
  ])
})

test('storeKey overwrites a key the store already holds (non-env source)', async () => {
  const { service, calls } = fakeService({ describe: { configured: true, source: 'file' } })
  assert.deepEqual(await storeKey({ credentials: service, env: {} }, REF, LIVE_KEY), { environment: 'live', length: LIVE_KEY.length })
  assert.deepEqual(calls, [
    ['describe', REF],
    ['set', REF, LIVE_KEY],
  ])
})

test('storeKey rejects a malformed or empty key before touching the store', async () => {
  const { service, calls } = fakeService()
  await assert.rejects(storeKey({ credentials: service, env: {} }, REF, 'garbage-' + '0'.repeat(30)), keyError('RTA_KEY_INVALID'))
  await assert.rejects(storeKey({ credentials: service, env: {} }, REF, ''), keyError('RTA_KEY_MISSING'))
  assert.deepEqual(calls, [])
  // validation runs even when there is no store at all
  await assert.rejects(storeKey({ env: {} }, REF, 'garbage-' + '0'.repeat(30)), keyError('RTA_KEY_INVALID'))
})

test('storeKey refuses when the profile has no credential store', async () => {
  await assert.rejects(
    storeKey({ env: {} }, REF, TEST_KEY),
    keyError('RTA_KEY_STORE_UNAVAILABLE', (err) => {
      assert.match(err.message, /no credential store/)
      assert.match(err.message, new RegExp('export ' + REF))
    }),
  )
})

test('storeKey refuses to shadow a key supplied by the launching environment and does not call set()', async () => {
  const { service, calls } = fakeService({ describe: { configured: true, source: 'env' } })
  await assert.rejects(
    storeKey({ credentials: service, env: {} }, REF, TEST_KEY),
    keyError('RTA_KEY_SHADOWED', (err) => assert.match(err.message, new RegExp(REF))),
  )
  assert.deepEqual(calls, [['describe', REF]])
})

test('storeKey wraps a throwing set() as RTA_KEY_STORE_UNAVAILABLE with the key scrubbed from the reason', async () => {
  const { service } = fakeService({ describe: { configured: false }, setError: new Error('keychain write failed for ' + TEST_KEY) })
  await assert.rejects(
    storeKey({ credentials: service, env: {} }, REF, TEST_KEY),
    keyError('RTA_KEY_STORE_UNAVAILABLE', (err) => {
      assert.match(err.message, /refused to save REALTIME_AVATAR_API_KEY: keychain write failed for <redacted>/)
    }),
  )
  const nonError = fakeService({ describe: { configured: false }, setError: 'EACCES' }).service
  await assert.rejects(
    storeKey({ credentials: nonError, env: {} }, REF, TEST_KEY),
    keyError('RTA_KEY_STORE_UNAVAILABLE', (err) => assert.match(err.message, /EACCES/)),
  )
})

// ---------------------------------------------------------------- clearKey

test('clearKey refuses when the profile has no credential store', async () => {
  await assert.rejects(
    clearKey({ env: { [REF]: TEST_KEY } }, REF),
    keyError('RTA_KEY_STORE_UNAVAILABLE', (err) => {
      assert.match(err.message, /no credential store/)
      assert.match(err.message, new RegExp('unset ' + REF))
    }),
  )
})

test('clearKey refuses to clear a key supplied by the launching environment and does not call unset()', async () => {
  const { service, calls } = fakeService({ describe: { configured: true, source: 'env' } })
  await assert.rejects(clearKey({ credentials: service, env: {} }, REF), keyError('RTA_KEY_SHADOWED', (err) => assert.match(err.message, new RegExp(REF))))
  assert.deepEqual(calls, [['describe', REF]])
})

/** A service whose file entry disappears on unset() while a read-only layer (a .env file) may keep resolving. */
function layeredService({ file, dotenv, dotenvSource = 'project-env', fileSource = 'file' } = {}) {
  const calls = []
  let fileValue = file
  const layer = () => (fileValue !== undefined ? { value: fileValue, source: fileSource } : dotenv !== undefined ? { value: dotenv, source: dotenvSource } : undefined)
  const service = {
    async resolve(ref) {
      calls.push(['resolve', ref])
      return layer()
    },
    async describe(ref) {
      calls.push(['describe', ref])
      const hit = layer()
      if (hit === undefined) return { configured: false }
      const info = { configured: true, writable: hit.source === 'file' }
      if (hit.source !== undefined) info.source = hit.source
      return info
    },
    async set(ref, value) {
      calls.push(['set', ref, value])
      fileValue = value
    },
    async unset(ref) {
      calls.push(['unset', ref])
      fileValue = undefined
    },
  }
  return { service, calls }
}

test('clearKey calls unset(ref) for a stored key and reports removed:true with an unconfigured residual', async () => {
  const { service, calls } = layeredService({ file: TEST_KEY })
  const result = await clearKey({ credentials: service, env: {} }, REF)
  assert.deepEqual(result, { removed: true, residual: { ref: REF, configured: false, source: 'none', environment: 'none' } })
  assert.deepEqual(calls, [
    ['describe', REF],
    ['unset', REF],
    ['describe', REF],
  ])
  assert.ok(!JSON.stringify(result).includes(TEST_KEY))
})

test('clearKey counts a removal only for a file / credentials / unlabelled source', async () => {
  for (const fileSource of ['file', 'credentials', undefined]) {
    const { service } = layeredService({ file: TEST_KEY, fileSource })
    assert.equal((await clearKey({ credentials: service, env: {} }, REF)).removed, true, String(fileSource))
  }
  for (const source of ['project-env', 'user-env', 'vault']) {
    const { service, calls } = layeredService({ dotenv: TEST_KEY, dotenvSource: source })
    const result = await clearKey({ credentials: service, env: {} }, REF)
    assert.equal(result.removed, false, source + ' cannot be edited from here')
    assert.deepEqual(calls.filter((c) => c[0] === 'unset'), [['unset', REF]], 'unset is still attempted for ' + source)
    assert.deepEqual(result.residual, { ref: REF, configured: true, source, environment: 'test' }, source + ' keeps resolving afterwards')
  }
})

test('clearKey reports the layer that still supplies the key after the file entry is gone', async () => {
  const { service } = layeredService({ file: TEST_KEY, dotenv: LIVE_KEY })
  const result = await clearKey({ credentials: service, env: {} }, REF)
  assert.deepEqual(result, { removed: true, residual: { ref: REF, configured: true, source: 'project-env', environment: 'live' } })
})

test('clearKey on an unconfigured ref is a harmless unset reported as removed:false', async () => {
  const { service, calls } = fakeService({ describe: { configured: false } })
  const result = await clearKey({ credentials: service, env: {} }, REF)
  assert.deepEqual(result, { removed: false, residual: { ref: REF, configured: false, source: 'none', environment: 'none' } })
  assert.deepEqual(calls, [
    ['describe', REF],
    ['unset', REF],
    ['describe', REF],
  ])
})

test('clearKey wraps a throwing unset() as RTA_KEY_STORE_UNAVAILABLE', async () => {
  const { service, calls } = fakeService({ describe: { configured: true, source: 'file' }, unsetError: new Error('keychain locked') })
  await assert.rejects(
    clearKey({ credentials: service, env: {} }, REF),
    keyError('RTA_KEY_STORE_UNAVAILABLE', (err) => assert.match(err.message, /refused to remove REALTIME_AVATAR_API_KEY: keychain locked/)),
  )
  assert.deepEqual(calls, [
    ['describe', REF],
    ['unset', REF],
  ])
  const nonError = fakeService({ describe: { configured: true, source: 'file' }, unsetError: 'EACCES' }).service
  await assert.rejects(clearKey({ credentials: nonError, env: {} }, REF), keyError('RTA_KEY_STORE_UNAVAILABLE', (err) => assert.match(err.message, /EACCES/)))
})
