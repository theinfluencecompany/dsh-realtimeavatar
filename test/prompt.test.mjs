// The system-prompt section: short, names every skill and the key posture,
// and carries no key-shaped material.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/config.js'
import { SKILL_NAMES } from '../lib/facts.js'
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, buildPromptSection } from '../lib/prompt.js'

test('the section is named, ordered and short', () => {
  const section = buildPromptSection(resolveConfig(null))
  assert.equal(section.name, 'tool:rta')
  assert.equal(section.order, 118, '115/116 are taken by first-party sections; 118 keeps the placement deterministic')
  assert.equal(PROMPT_SECTION_NAME, 'tool:rta')
  assert.equal(PROMPT_SECTION_ORDER, 118)
  assert.equal(typeof section.text, 'string')
  assert.ok(section.text.length < 1500, 'prompt section is ' + section.text.length + ' chars')
  assert.ok(!section.text.includes('\n'), 'one paragraph, no line breaks')
})

test('the section names every skill, rta_docs, the credential reference, the setup command and the example avatar', () => {
  const { text } = buildPromptSection(resolveConfig(null))
  assert.equal(SKILL_NAMES.length, 5)
  for (const skill of SKILL_NAMES) assert.ok(text.includes(skill), 'prompt lacks skill ' + skill)
  for (const needle of ['rta_docs', 'REALTIME_AVATAR_API_KEY', '/rta setup', 'seed-rin-ashfall', 'rta_session_release', 'realtime-avatar', 'https://realtimeavatar.ai/api/v1', 'RTA_KEY_MISSING', 'NEXT_PUBLIC_']) {
    assert.ok(text.includes(needle), 'prompt lacks ' + JSON.stringify(needle))
  }
})

test('the section tells the model how a missing key is fixed in the web UI and headless', () => {
  const { text } = buildPromptSection(resolveConfig(null))
  assert.ok(text.includes('run /rta setup in the web UI'), text)
  assert.ok(text.includes('export REALTIME_AVATAR_API_KEY before launching dsh'), text)
  const custom = buildPromptSection(resolveConfig({ apiKeyEnv: 'MY_RTA_REF' })).text
  assert.ok(custom.includes('export MY_RTA_REF'))
})

test('the section carries no key-shaped material', () => {
  const { text } = buildPromptSection(resolveConfig(null))
  assert.doesNotMatch(text, /tic_/)
  assert.doesNotMatch(text, /Bearer/i)
})

test('a custom credential reference replaces the default name', () => {
  const { text } = buildPromptSection(resolveConfig({ apiKeyEnv: 'MY_RTA_REF' }))
  assert.ok(text.includes('MY_RTA_REF'))
  assert.ok(!text.includes('REALTIME_AVATAR_API_KEY'), 'the default reference must not be advertised when overridden')
})

test('readOnly is announced next to the credit-spending tools, and only then', () => {
  const ro = buildPromptSection(resolveConfig({ readOnly: true }))
  assert.match(ro.text, /readOnly/)
  assert.match(ro.text, /rta_session_mint ask for approval \(currently disabled: readOnly\)/)
  const rw = buildPromptSection(resolveConfig(null))
  assert.doesNotMatch(rw.text, /readOnly/)
  assert.equal(ro.name, rw.name)
  assert.equal(ro.order, rw.order)
})
