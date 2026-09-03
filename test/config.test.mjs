import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { API_BASE, SITE_BASE, PLUGIN_VERSION, USER_AGENT, DEFAULT_API_KEY_ENV, resolveConfig } from '../lib/config.js'

const DEFAULTS = {
  apiKeyEnv: 'REALTIME_AVATAR_API_KEY',
  readOnly: false,
  writeApproval: true,
  maxSessionSeconds: 300,
  requestTimeoutMs: 30000,
  docsTimeoutMs: 20000,
  docsMaxChars: 24000,
}

test('resolveConfig(null) yields the documented defaults', () => {
  assert.deepEqual(resolveConfig(null), DEFAULTS)
})

test('resolveConfig(undefined) and resolveConfig({}) match null', () => {
  assert.deepEqual(resolveConfig(undefined), resolveConfig(null))
  assert.deepEqual(resolveConfig({}), resolveConfig(null))
})

test('the resolved config carries only the credential reference name, never a key value', () => {
  const cfg = resolveConfig({ apiKeyEnv: 'MY_RTA_KEY' })
  assert.equal(cfg.apiKeyEnv, 'MY_RTA_KEY')
  assert.deepEqual(Object.keys(cfg).sort(), Object.keys(DEFAULTS).sort())
})

test('apiKeyEnv accepts env-var-style names and trims surrounding whitespace', () => {
  assert.equal(resolveConfig({ apiKeyEnv: 'RTA_KEY_2' }).apiKeyEnv, 'RTA_KEY_2')
  assert.equal(resolveConfig({ apiKeyEnv: '_private' }).apiKeyEnv, '_private')
  assert.equal(resolveConfig({ apiKeyEnv: 'lower_case_ok' }).apiKeyEnv, 'lower_case_ok')
  assert.equal(resolveConfig({ apiKeyEnv: '  SPACED_KEY  ' }).apiKeyEnv, 'SPACED_KEY')
})

test('apiKeyEnv rejects names outside the credential-store grammar', () => {
  for (const bad of ['bad-name', '', '   ', '1LEADING_DIGIT', 'has space', 'dotted.name', 'a/b', '$HOME', 'KEY=value', 42, true, {}, []]) {
    assert.throws(() => resolveConfig({ apiKeyEnv: bad }), /apiKeyEnv must be an environment-variable-style name/, 'should reject ' + JSON.stringify(bad))
  }
})

test('apiKeyEnv that looks like an API key is rejected without echoing the value', () => {
  const body = 'x'.repeat(40)
  for (const bad of ['tic_test_' + body, 'tic_live_' + body, 'TIC_TEST_' + body, 'Tic_Live_' + body, 'tic_' + body, 'tic_test_12345678']) {
    assert.throws(
      () => resolveConfig({ apiKeyEnv: bad }),
      (err) => {
        assert.match(err.message, /apiKeyEnv looks like an API key/)
        assert.match(err.message, /\/rta key/)
        assert.ok(!err.message.includes(bad), 'the value must not be echoed: ' + err.message)
        assert.ok(!err.message.includes(body.slice(0, 8)), 'not even a fragment of it')
        return true
      },
      'should reject ' + bad.slice(0, 12),
    )
  }
  // the grammar check still comes first: a key with characters outside the reference grammar is a grammar error
  assert.throws(() => resolveConfig({ apiKeyEnv: 'tic_test_' + body + '-x' }), /must be an environment-variable-style name/)
  // a reference that merely contains "tic_" elsewhere is fine
  assert.equal(resolveConfig({ apiKeyEnv: 'MY_tic_REF' }).apiKeyEnv, 'MY_tic_REF')
  assert.equal(resolveConfig({ apiKeyEnv: 'ATIC_KEY' }).apiKeyEnv, 'ATIC_KEY')
})

test('readOnly is off by default and only turns on with an explicit true', () => {
  assert.equal(resolveConfig({}).readOnly, false)
  assert.equal(resolveConfig({ readOnly: true }).readOnly, true)
  assert.equal(resolveConfig({ readOnly: false }).readOnly, false)
  assert.equal(resolveConfig({ readOnly: undefined }).readOnly, false)
})

test('writeApproval is on by default and only turns off with an explicit false', () => {
  assert.equal(resolveConfig({}).writeApproval, true)
  assert.equal(resolveConfig({ writeApproval: true }).writeApproval, true)
  assert.equal(resolveConfig({ writeApproval: false }).writeApproval, false)
  assert.equal(resolveConfig({ writeApproval: undefined }).writeApproval, true)
})

test('non-boolean flags are rejected rather than coerced', () => {
  for (const bad of ['true', 'false', 'yes', 1, 0, null, {}, []]) {
    assert.throws(() => resolveConfig({ readOnly: bad }), /readOnly must be a boolean/, 'readOnly should reject ' + JSON.stringify(bad))
    assert.throws(() => resolveConfig({ writeApproval: bad }), /writeApproval must be a boolean/, 'writeApproval should reject ' + JSON.stringify(bad))
  }
})

test('maxSessionSeconds clamps to 1..1800 and rounds to an integer', () => {
  assert.equal(resolveConfig({ maxSessionSeconds: 60 }).maxSessionSeconds, 60)
  assert.equal(resolveConfig({ maxSessionSeconds: 1 }).maxSessionSeconds, 1)
  assert.equal(resolveConfig({ maxSessionSeconds: 0.4 }).maxSessionSeconds, 1) // positive, rounds to 0, floored to 1
  assert.equal(resolveConfig({ maxSessionSeconds: 12.6 }).maxSessionSeconds, 13)
  assert.equal(resolveConfig({ maxSessionSeconds: 1800 }).maxSessionSeconds, 1800)
  assert.equal(resolveConfig({ maxSessionSeconds: 1801 }).maxSessionSeconds, 1800)
  assert.equal(resolveConfig({ maxSessionSeconds: 99999 }).maxSessionSeconds, 1800)
})

test('requestTimeoutMs and docsTimeoutMs clamp to 5000..120000', () => {
  for (const field of ['requestTimeoutMs', 'docsTimeoutMs']) {
    assert.equal(resolveConfig({ [field]: 1 })[field], 5000, field + ' floor')
    assert.equal(resolveConfig({ [field]: 4999 })[field], 5000, field + ' floor')
    assert.equal(resolveConfig({ [field]: 5000 })[field], 5000)
    assert.equal(resolveConfig({ [field]: 45000 })[field], 45000)
    assert.equal(resolveConfig({ [field]: 120000 })[field], 120000)
    assert.equal(resolveConfig({ [field]: 120001 })[field], 120000, field + ' ceiling')
    assert.equal(resolveConfig({ [field]: 999999999 })[field], 120000, field + ' ceiling')
  }
})

test('docsMaxChars clamps to 2000..200000', () => {
  assert.equal(resolveConfig({ docsMaxChars: 1 }).docsMaxChars, 2000)
  assert.equal(resolveConfig({ docsMaxChars: 2000 }).docsMaxChars, 2000)
  assert.equal(resolveConfig({ docsMaxChars: 50000 }).docsMaxChars, 50000)
  assert.equal(resolveConfig({ docsMaxChars: 200000 }).docsMaxChars, 200000)
  assert.equal(resolveConfig({ docsMaxChars: 1e9 }).docsMaxChars, 200000)
})

test('numeric fields reject non-positive, non-finite and non-number values', () => {
  for (const field of ['maxSessionSeconds', 'requestTimeoutMs', 'docsTimeoutMs', 'docsMaxChars']) {
    for (const bad of [0, -1, -0.5, NaN, Infinity, -Infinity, '10', '', null, true, {}, []]) {
      assert.throws(() => resolveConfig({ [field]: bad }), new RegExp(field + ' must be a positive number'), field + ' should reject ' + String(bad))
    }
  }
})

test('one bad field fails the whole config', () => {
  assert.throws(() => resolveConfig({ readOnly: true, maxSessionSeconds: -5 }), /maxSessionSeconds/)
  assert.throws(() => resolveConfig({ apiKeyEnv: 'OK_NAME', docsMaxChars: 'lots' }), /docsMaxChars/)
})

test('constants: API base, site base, default reference and user agent', () => {
  assert.equal(API_BASE, 'https://realtimeavatar.ai/api')
  assert.equal(SITE_BASE, 'https://realtimeavatar.ai')
  assert.equal(DEFAULT_API_KEY_ENV, 'REALTIME_AVATAR_API_KEY')
  assert.equal(resolveConfig(null).apiKeyEnv, DEFAULT_API_KEY_ENV)
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+/)
  assert.equal(typeof USER_AGENT, 'string')
  assert.ok(USER_AGENT.includes(PLUGIN_VERSION), 'USER_AGENT carries the plugin version')
  assert.equal(USER_AGENT, 'dsh-realtimeavatar/' + PLUGIN_VERSION)
})

test('PLUGIN_VERSION stays in sync with package.json', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'))
  assert.equal(PLUGIN_VERSION, pkg.version)
})
