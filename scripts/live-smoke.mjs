#!/usr/bin/env node
// dsh-realtimeavatar live smoke: a READ-ONLY pass over the real realtimeavatar.ai
// API for a maintainer. It builds the rta_* tools with a key source over
// process.env and runs only read tools — never a write tool and never
// rta_session_mint (test keys spend real credits). Output is counts only: no
// ids, names, URLs or key material from responses ever reach stdout, and any
// error message is redacted before printing.
//
// Usage: REALTIME_AVATAR_API_KEY=tic_test_… node scripts/live-smoke.mjs
// Exit:  0 when every step is ok; 1 on any failure or refusal.
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const rta = await import(new URL('../lib/index.js', import.meta.url))

const REF = rta.DEFAULT_API_KEY_ENV
const PER_CALL_TIMEOUT_MS = 20000
const REQUEST_TIMEOUT_MS = 15000

/** Redact anything that could be a secret or a response identity: exact key, key-shaped tokens, bearer values, 32-hex ids, URLs. */
function redact(text, key) {
  let out = rta.redactSecrets(String(text), key === undefined ? [] : [key])
  out = out.replace(/\b[0-9a-f]{32}\b/gi, '<hex32>')
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
  out = out.replace(/https?:\/\/\S+/g, '<url>')
  return out
}

// ---------- refuse to run without a test key ----------
const raw = process.env[REF]
if (typeof raw !== 'string' || raw.trim() === '') {
  console.error('refusing to run: ' + REF + ' is not set in the environment. Export a tic_test_… key (never a live key) and retry.')
  process.exit(1)
}
let key
try {
  key = rta.validateKeyFormat(raw, REF)
} catch (error) {
  console.error('refusing to run: ' + redact(error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
if (!key.startsWith('tic_test_')) {
  console.error('refusing to run: ' + REF + ' must be a test-tagged key (tic_test_…); a ' + rta.keyEnvironment(key) + ' key was supplied. This smoke only ever reads, but it will not touch a live workspace.')
  process.exit(1)
}

// ---------- build the tools over process.env (no harness, no credential store) ----------
const cfg = rta.resolveConfig({ apiKeyEnv: REF, readOnly: true, requestTimeoutMs: REQUEST_TIMEOUT_MS, docsTimeoutMs: REQUEST_TIMEOUT_MS })
const tools = new Map(rta.buildRtaTools({ cfg, keySource: () => ({ env: process.env }), randomUUID, skillsDir: rta.defaultSkillsDir() }).map((definition) => [definition.name, definition]))

const READ_ONLY_PLAN = [
  { name: 'rta_status', args: {}, summarize: (v) => { const errors = Object.keys(v.errors ?? {}); return { ok: errors.length === 0 && v.balance !== null && v.capacity !== null, detail: 'key=' + (v.key?.configured ? 'configured(' + v.key.environment + ')' : 'missing') + ' creditsAvailable=' + String(v.balance?.availableCredits) + ' capacity=' + String(v.capacity?.availableSessions) + '/' + String(v.capacity?.maxSessions) + ' errors=' + errors.length + (errors.length > 0 ? ' [' + errors.map((k) => k + ': ' + redact(v.errors[k], key)).join('; ') + ']' : '') } } },
  { name: 'rta_balance', args: {}, summarize: (v) => ({ ok: typeof v.availableCredits === 'number', detail: 'creditsAvailable=' + String(v.availableCredits) + ' reserved=' + String(v.reservedCredits) + ' approxMinutes=' + String(v.approxMinutesAvailable) }) },
  { name: 'rta_capacity', args: {}, summarize: (v) => ({ ok: typeof v.maxSessions === 'number', detail: 'available=' + String(v.availableSessions) + '/' + String(v.maxSessions) + ' queue=' + String(v.queueSize) + ' admissionOpen=' + String(v.admissionOpen) }) },
  { name: 'rta_avatars', args: {}, summarize: (v) => ({ ok: typeof v.count === 'number' && Array.isArray(v.avatars), detail: 'avatars=' + String(v.count) + ' ready=' + (v.avatars ?? []).filter((a) => a.status === 'ready').length }) },
  { name: 'rta_assets', args: {}, summarize: (v) => ({ ok: typeof v.count === 'number' && Array.isArray(v.assets), detail: 'assets=' + String(v.count) }) },
  { name: 'rta_usage', args: { limit: 5 }, summarize: (v) => ({ ok: Array.isArray(v.sessions) && typeof v.totals?.count === 'number', detail: 'sessions=' + String(v.totals?.count) + ' settled=' + String(v.totals?.settledCount) + ' billedCredits=' + String(v.totals?.billedCredits) + ' morePages=' + String(v.nextCursor !== null && v.nextCursor !== undefined) }) },
  { name: 'rta_docs', args: { page: 'quickstart', maxChars: 2000 }, summarize: (v) => ({ ok: typeof v.chars === 'number' && v.chars > 0 && v.chars <= 2000, detail: 'docsChars=' + String(v.chars) + ' truncated=' + String(v.truncated) + ' updated=' + String(v.updated) }) },
  { name: 'rta_quickstart', args: { framework: 'express' }, summarize: (v) => ({ ok: typeof v.markdown === 'string' && v.markdown.length > 0, detail: 'source=' + String(v.source) + ' markdownChars=' + String(v.markdown?.length ?? 0) + ' serverSkeleton=' + String(v.serverSkeleton !== null && v.serverSkeleton !== undefined) + ' clientSkeleton=' + String(v.clientSkeleton !== null && v.clientSkeleton !== undefined) }) },
]

// Belt and braces: the plan must contain read-tier tools only, and never the mint.
for (const entry of READ_ONLY_PLAN) {
  if (rta.tierOf(entry.name) !== 'read' || entry.name === 'rta_session_mint' || entry.name === 'rta_session_release') {
    console.error('refusing to run: the plan names a non-read tool (' + entry.name + ')')
    process.exit(1)
  }
}

console.log('dsh-realtimeavatar live smoke (read-only; ' + READ_ONLY_PLAN.length + ' steps; no write tool, no session mint)')
let failures = 0
for (const entry of READ_ONLY_PLAN) {
  const definition = tools.get(entry.name)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS)
  const t0 = performance.now()
  let line
  try {
    if (definition === undefined) throw new Error('tool not built')
    const value = await definition.execute(entry.args, { signal: controller.signal })
    const summary = entry.summarize(value ?? {})
    const elapsed = Math.round(performance.now() - t0)
    line = (summary.ok ? 'ok   ' : 'FAIL ') + entry.name + ' — ' + summary.detail + ' (' + elapsed + ' ms)'
    if (!summary.ok) failures += 1
  } catch (error) {
    failures += 1
    const message = error instanceof Error ? (error.name === 'KeyError' || error.name === 'RtaApiError' ? (error.code ?? error.kind ?? '') + ' ' : '') + error.message : String(error)
    line = 'FAIL ' + entry.name + ' — ' + redact(message, key) + ' (' + Math.round(performance.now() - t0) + ' ms)'
  } finally {
    clearTimeout(timer)
  }
  console.log(redact(line, key))
}
console.log((READ_ONLY_PLAN.length - failures) + '/' + READ_ONLY_PLAN.length + ' steps ok')
process.exit(failures === 0 ? 0 : 1)
