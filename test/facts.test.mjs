import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  VERIFIED_ON,
  URLS,
  ENV_VAR,
  KEY_PREFIXES,
  EXAMPLE_AVATAR_ID,
  SDK_PACKAGE,
  RATE_LIMIT,
  CREDIT_RULE,
  SCOPES,
  PLANS,
  AGENT_PROMPT,
  OPERATIONS,
  ERROR_TABLE,
  DOC_PAGES,
  SKILL_PAGES,
  SKILL_NAMES,
} from '../lib/facts.js'
import { API_BASE, SITE_BASE, DEFAULT_API_KEY_ENV } from '../lib/config.js'
import { classifyFailure } from '../lib/client.js'

const OPENAPI = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/openapi.json', import.meta.url)), 'utf8'))
const METHODS = ['get', 'post', 'put', 'patch', 'delete']

/** `METHOD /v1/path` → operation object, straight from the fixture. */
function fixtureOps() {
  const out = new Map()
  for (const [path, item] of Object.entries(OPENAPI.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (METHODS.includes(method)) out.set(method.toUpperCase() + ' ' + path, op)
    }
  }
  return out
}

const byId = (id) => OPERATIONS.find((o) => o.operationId === id)

// -------------------------------------------------------------- OPERATIONS

test('OPERATIONS has 18 rows that match the fixture openapi.json exactly (no more, no fewer)', () => {
  const fixture = fixtureOps()
  assert.equal(fixture.size, 18)
  assert.equal(OPERATIONS.length, 18)
  const keys = OPERATIONS.map((o) => o.method + ' /v1' + o.path)
  assert.equal(new Set(keys).size, 18, 'no duplicate method+path')
  assert.deepEqual([...keys].sort(), [...fixture.keys()].sort())
})

test('every OPERATIONS row agrees with its fixture operation on id, summary, deprecation and Idempotency-Key', () => {
  const fixture = fixtureOps()
  for (const fact of OPERATIONS) {
    const op = fixture.get(fact.method + ' /v1' + fact.path)
    assert.equal(fact.operationId, op.operationId, fact.method + ' ' + fact.path)
    assert.ok(fact.summary.startsWith(op.summary), fact.operationId + ': summary "' + fact.summary + '" should extend "' + op.summary + '"')
    assert.equal(fact.deprecated === true, op.deprecated === true, fact.operationId + ' deprecated flag')
    const hasIdempotencyHeader = (op.parameters ?? []).some((p) => p.in === 'header' && p.name === 'Idempotency-Key')
    assert.equal(fact.idempotencyKey === true, hasIdempotencyHeader, fact.operationId + ' Idempotency-Key')
    assert.ok(fact.path.startsWith('/') && !fact.path.startsWith('/v1'), 'paths are relative to /api/v1')
    assert.equal(new Set(OPERATIONS.map((o) => o.operationId)).size, 18, 'operationIds unique')
  }
  assert.deepEqual(
    OPERATIONS.filter((o) => o.deprecated === true).map((o) => o.operationId),
    ['syncAvatarClips'],
  )
  assert.deepEqual(
    OPERATIONS.filter((o) => o.idempotencyKey === true).map((o) => o.operationId),
    ['putAvatarClips', 'putAvatarLoop'],
  )
})

test('exposedAs is a unique rta_* name or null; exactly three operations are deliberately unexposed', () => {
  const exposed = OPERATIONS.map((o) => o.exposedAs).filter((t) => t !== null)
  assert.equal(new Set(exposed).size, exposed.length, 'tool names unique')
  for (const name of exposed) assert.match(name, /^rta_[a-z][a-z_]*$/)
  assert.deepEqual(
    OPERATIONS.filter((o) => o.exposedAs === null)
      .map((o) => o.operationId)
      .sort(),
    ['createApiKey', 'syncAvatarClips', 'uploadAsset'],
  )
  assert.equal(exposed.length, 15)
  for (const o of OPERATIONS) assert.ok(o.exposedAs === null || typeof o.exposedAs === 'string')
})

test('costsCredits is true exactly for the four credit-spending operations', () => {
  assert.deepEqual(
    OPERATIONS.filter((o) => o.costsCredits)
      .map((o) => o.operationId)
      .sort(),
    ['createAvatar', 'createLiveKitSession', 'putAvatarClips', 'putAvatarLoop'],
  )
  for (const o of OPERATIONS) assert.equal(typeof o.costsCredits, 'boolean', o.operationId)
})

test('every operation scope is one of the documented scopes and reads never need a write scope', () => {
  const scopes = new Set(SCOPES.map((s) => s.scope))
  for (const o of OPERATIONS) {
    assert.ok(scopes.has(o.scope), o.operationId + ' scope ' + o.scope)
    assert.notEqual(o.scope, '*', 'no operation demands the wildcard')
    if (o.method === 'GET') assert.match(o.scope, /:(read|write)$/)
    if (o.method === 'GET' && o.path.startsWith('/avatars')) assert.equal(o.scope, 'avatars:read')
    if (o.method === 'GET' && o.path === '/assets') assert.equal(o.scope, 'avatars:read')
  }
  assert.equal(byId('getCreditBalance').scope, 'credits:read')
  assert.equal(byId('listUsageSessions').scope, 'usage:read')
  assert.equal(byId('createApiKey').scope, 'api_keys:write')
  assert.equal(byId('createLiveKitSession').scope, 'realtime:write')
})

// ------------------------------------------------------------------ SCOPES

test('SCOPES lists the 8 documented scopes exactly once each', () => {
  assert.equal(SCOPES.length, 8)
  assert.deepEqual(
    SCOPES.map((s) => s.scope).sort(),
    ['*', 'api_keys:write', 'avatars:read', 'avatars:write', 'credits:read', 'realtime:write', 'usage:read', 'usage:write'],
  )
  for (const s of SCOPES) assert.ok(typeof s.grants === 'string' && s.grants.length > 0, s.scope + ' has a description')
})

// ------------------------------------------------------------------- PLANS

test('PLANS: Sandbox is free with 1020 credits, and every plan prices credits as seconds on air', () => {
  assert.equal(PLANS.length, 4)
  const sandbox = PLANS.find((p) => p.name === 'Sandbox')
  assert.equal(sandbox.usd, 0)
  assert.equal(sandbox.credits, 1020)
  assert.equal(sandbox.streams, 1)
  assert.equal(sandbox.avatars, 1)
  assert.equal(new Set(PLANS.map((p) => p.name)).size, 4)
  for (const plan of PLANS) assert.equal(plan.credits, plan.minutes * 60, plan.name + ': 1 credit = 1 second')
  for (let i = 1; i < PLANS.length; i += 1) {
    assert.ok(PLANS[i].usd > PLANS[i - 1].usd, 'plans ordered by price')
    assert.ok(PLANS[i].credits > PLANS[i - 1].credits, 'more money, more credits')
  }
  assert.match(CREDIT_RULE, /1 credit = 1 second/)
})

// ----------------------------------------------------------------- DOC_PAGES

test('DOC_PAGES has 14 unique slugs whose markdown path and canonical path agree', () => {
  assert.equal(DOC_PAGES.length, 14)
  const slugs = DOC_PAGES.map((p) => p.slug)
  assert.equal(new Set(slugs).size, 14)
  for (const page of DOC_PAGES) {
    assert.match(page.slug, /^[a-z][a-z-]*$/)
    assert.ok(page.path.endsWith('.md'), page.slug)
    assert.equal(page.canonical, page.path.slice(0, -'.md'.length), page.slug + ' canonical = path minus .md')
    assert.ok(page.title.length > 0 && page.blurb.length > 0, page.slug)
    if (page.slug === 'overview') assert.equal(page.path, '/docs.md')
    else assert.equal(page.path, '/docs/' + page.slug + '.md')
  }
})

test('SKILL_PAGES covers all 14 pages exactly once and SKILL_NAMES mirrors its keys', () => {
  const covered = Object.values(SKILL_PAGES).flat()
  assert.equal(covered.length, 14)
  assert.deepEqual([...covered].sort(), DOC_PAGES.map((p) => p.slug).sort())
  assert.deepEqual(SKILL_NAMES, Object.keys(SKILL_PAGES))
  assert.equal(SKILL_NAMES.length, 5)
  for (const name of SKILL_NAMES) {
    assert.match(name, /^realtimeavatar-[a-z]+$/)
    assert.ok(SKILL_PAGES[name].length > 0, name + ' carries at least one page')
  }
})

// ------------------------------------------------------------ AGENT_PROMPT

test('AGENT_PROMPT names the public example avatar, the env var and the agent guide, and carries no key', () => {
  assert.equal(EXAMPLE_AVATAR_ID, 'seed-rin-ashfall')
  assert.ok(AGENT_PROMPT.includes('seed-rin-ashfall'))
  assert.ok(AGENT_PROMPT.includes(EXAMPLE_AVATAR_ID))
  assert.ok(AGENT_PROMPT.includes('REALTIME_AVATAR_API_KEY'))
  assert.ok(AGENT_PROMPT.includes(ENV_VAR))
  assert.ok(AGENT_PROMPT.includes(URLS.llms))
  assert.doesNotMatch(AGENT_PROMPT, /tic_(live|test)_[A-Za-z0-9_-]{4,}/)
})

// ------------------------------------------------------------- VERIFIED_ON

test('VERIFIED_ON is a real ISO calendar date', () => {
  assert.match(VERIFIED_ON, /^\d{4}-\d{2}-\d{2}$/)
  const parsed = new Date(VERIFIED_ON + 'T00:00:00Z')
  assert.ok(!Number.isNaN(parsed.getTime()))
  assert.ok(parsed.toISOString().startsWith(VERIFIED_ON), 'round-trips (no 2026-02-30)')
})

// -------------------------------------------------------- cross-module ties

test('URLS and constants agree with config and the fixture', () => {
  assert.equal(URLS.site, SITE_BASE)
  assert.equal(URLS.apiBase, API_BASE + '/v1')
  assert.equal(OPENAPI.servers[0].url, API_BASE)
  assert.equal(ENV_VAR, DEFAULT_API_KEY_ENV)
  assert.deepEqual([...KEY_PREFIXES], ['tic_live_', 'tic_test_'])
  assert.equal(SDK_PACKAGE, 'realtime-avatar')
  assert.deepEqual(RATE_LIMIT, { requests: 120, perSeconds: 60 })
  for (const [name, url] of Object.entries(URLS)) {
    assert.ok(url.startsWith('https://'), name)
    assert.match(new URL(url).host, /^(realtimeavatar\.ai|www\.npmjs\.com|github\.com)$/, name + ' is a public host')
  }
})

test('every ERROR_TABLE status is one the client classifies specifically (never the generic http kind)', () => {
  const statuses = ERROR_TABLE.map((e) => e.status)
  assert.equal(new Set(statuses).size, statuses.length)
  assert.deepEqual(statuses, [401, 402, 403, 404, 409, 413, 422, 429, 502, 503])
  for (const status of statuses) assert.notEqual(classifyFailure(status, { error: 'x' }, []).kind, 'http', 'HTTP ' + status)
})
