// The model pays for every tool description and parameter schema on every
// turn. This pins the per-turn cost so it cannot creep back up unnoticed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRtaTools } from '../lib/tools/index.js'
import { resolveConfig } from '../lib/config.js'

const TOTAL_BUDGET = 10700 // measured 10372 on 2026-09-03 (was 12194 before the trim)
const PER_TOOL_BUDGET = 2000
const PARAM_DESCRIPTION_MAX = 90

const tools = buildRtaTools({ cfg: resolveConfig({}), keySource: () => ({ credentials: undefined, env: {} }), randomUUID: () => 'u', skillsDir: 'skills' })
const cost = (tool) => tool.description.length + JSON.stringify(tool.parameters).length

test('the 18 tool schemas fit the per-turn budget', () => {
  const total = tools.reduce((sum, tool) => sum + cost(tool), 0)
  assert.ok(total <= TOTAL_BUDGET, 'tool schemas cost ' + total + ' chars (budget ' + TOTAL_BUDGET + ')')
  for (const tool of tools) assert.ok(cost(tool) <= PER_TOOL_BUDGET, tool.name + ' costs ' + cost(tool) + ' chars (budget ' + PER_TOOL_BUDGET + ')')
})

test('descriptions are single paragraphs that still name the endpoint, the scope and the approval posture where it matters', () => {
  for (const tool of tools) {
    assert.ok(!tool.description.includes('\n'), tool.name + ' description has a line break')
    assert.ok(tool.description.length >= 80, tool.name + ' description is too thin to be useful')
    if (!['rta_status', 'rta_docs', 'rta_quickstart'].includes(tool.name)) {
      assert.match(tool.description, /\(?(GET|POST|PUT|PATCH|DELETE) \/v1\//, tool.name + ' names its endpoint')
      assert.match(tool.description, /Scope [a-z_]+:[a-z]+/, tool.name + ' names its scope')
    }
    for (const [key, prop] of Object.entries(tool.parameters.properties ?? {})) {
      if (typeof prop.description === 'string') {
        assert.ok(prop.description.length <= PARAM_DESCRIPTION_MAX, tool.name + '.' + key + ' description is ' + prop.description.length + ' chars')
        assert.ok(!/\(optional\)/i.test(prop.description), tool.name + '.' + key + ': optionality is expressed by required, not prose')
      }
    }
  }
  for (const name of ['rta_avatar_create', 'rta_loop_set', 'rta_clips_set', 'rta_session_mint']) {
    assert.match(tools.find((t) => t.name === name).description, /always asks for approval/, name)
  }
})

test('enumerated parameters do not repeat their values in prose', () => {
  const docs = tools.find((t) => t.name === 'rta_docs')
  assert.ok(Array.isArray(docs.parameters.properties.page.enum))
  assert.ok(!docs.description.includes('tanstack-start'), 'the page list lives in the enum')
  const quick = tools.find((t) => t.name === 'rta_quickstart')
  assert.ok(Array.isArray(quick.parameters.properties.framework.enum))
  assert.ok(!quick.description.includes('tanstack-start'), 'the framework list lives in the enum')
  const release = tools.find((t) => t.name === 'rta_session_release')
  assert.ok(Array.isArray(release.parameters.properties.reason.enum))
  assert.ok(!release.description.includes('idle_timeout'), 'the reason list lives in the enum')
})
