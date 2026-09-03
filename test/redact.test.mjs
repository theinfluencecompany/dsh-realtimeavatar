import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets, safeMessage } from '../lib/redact.js'

const LIVE_KEY = 'tic_live_' + 'x'.repeat(40)
const TEST_KEY = 'tic_test_' + 'y'.repeat(40)

test('key-shaped tokens are redacted for both environment tags, keeping the tag', () => {
  assert.equal(redactSecrets('key=' + LIVE_KEY), 'key=tic_live_<redacted>')
  assert.equal(redactSecrets('key=' + TEST_KEY), 'key=tic_test_<redacted>')
  assert.equal(redactSecrets('two: ' + LIVE_KEY + ' and ' + TEST_KEY), 'two: tic_live_<redacted> and tic_test_<redacted>')
})

test('tokens are redacted wherever they sit: inside JSON, URLs and header values', () => {
  const input = '{"authorization":"Bearer ' + LIVE_KEY + '","url":"https://x.example/?key=' + TEST_KEY + '"}'
  assert.equal(redactSecrets(input), '{"authorization":"Bearer <redacted>","url":"https://x.example/?key=tic_test_<redacted>"}')
})

test('a bearer header value is redacted whatever it contains (case-insensitive on Bearer)', () => {
  assert.equal(redactSecrets('Authorization: Bearer xyz'), 'Authorization: Bearer <redacted>')
  assert.equal(redactSecrets('header "Bearer abc.def-ghi" rejected'), 'header "Bearer <redacted>" rejected')
  assert.equal(redactSecrets("token 'bearer opaque' rejected"), "token 'Bearer <redacted>' rejected")
  assert.equal(redactSecrets('BEARER\t\tmulti-space'), 'Bearer <redacted>')
})

test('exact known values are removed even when they are not key-shaped', () => {
  const out = redactSecrets('proxy said: value=opaque-secret-value; again opaque-secret-value', ['opaque-secret-value'])
  assert.equal(out, 'proxy said: value=<redacted>; again <redacted>')
})

test('known values go first, so a key the pattern would miss is still removed', () => {
  const odd = 'tic_live_ab!' // too short / punctuation for the token pattern
  assert.equal(redactSecrets('k=' + odd, [odd]), 'k=<redacted>')
})

test('an empty known value is ignored instead of exploding the text', () => {
  assert.equal(redactSecrets('plain text', ['']), 'plain text')
  assert.equal(redactSecrets('plain text', ['', 'plain']), '<redacted> text')
})

test('redaction is idempotent', () => {
  const once = redactSecrets('Bearer ' + LIVE_KEY + ' / ' + TEST_KEY + ' / secret', ['secret'])
  assert.equal(once, 'Bearer <redacted> / tic_test_<redacted> / <redacted>')
  assert.equal(redactSecrets(once, ['secret']), once)
  assert.equal(redactSecrets(redactSecrets(once)), once)
})

test('the documented placeholders and plain prose are left untouched', () => {
  for (const text of [
    'expected tic_live_… or tic_test_… with no whitespace',
    'Run /rta key <tic_…>',
    'Authorization: Bearer',
    'tic_live_ and tic_test_ are the two tags',
    'nothing secret here',
    '',
  ]) {
    assert.equal(redactSecrets(text), text)
  }
})

test('safeMessage redacts an Error message', () => {
  const err = new Error('rejected ' + LIVE_KEY + ' by Bearer ' + TEST_KEY)
  assert.equal(safeMessage(err), 'rejected tic_live_<redacted> by Bearer <redacted>')
  assert.equal(safeMessage(new TypeError('fetch failed: ' + TEST_KEY)), 'fetch failed: tic_test_<redacted>')
})

test('safeMessage redacts a thrown string and applies known values', () => {
  assert.equal(safeMessage('string failure with ' + TEST_KEY), 'string failure with tic_test_<redacted>')
  assert.equal(safeMessage('opaque leaked', ['opaque']), '<redacted> leaked')
  assert.equal(safeMessage(new Error('opaque leaked'), ['opaque']), '<redacted> leaked')
})

test('safeMessage falls back to a fixed message for non-Error, non-string throwables', () => {
  for (const thrown of [undefined, null, 42, true, { message: LIVE_KEY }, [LIVE_KEY], Symbol('s')]) {
    assert.equal(safeMessage(thrown), 'unexpected failure')
  }
})

test('bearer redaction keeps trailing punctuation and stays a single placeholder when re-applied', () => {
  assert.equal(redactSecrets('rejected (Bearer ' + LIVE_KEY + ') by upstream'), 'rejected (Bearer <redacted>) by upstream')
  assert.equal(redactSecrets('Bearer abc.def=, then'), 'Bearer <redacted>, then')
  assert.equal(redactSecrets('Bearer tic_live_<redacted>'), 'Bearer <redacted>', 'a key already masked by the token rule collapses to one placeholder')
  assert.equal(redactSecrets('Bearer <redacted>'), 'Bearer <redacted>')
})
