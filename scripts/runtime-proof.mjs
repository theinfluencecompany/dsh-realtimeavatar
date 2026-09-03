#!/usr/bin/env node
// dsh-realtimeavatar runtime proof: drive the plugin through the REAL dsh
// runtime — ToolRuntime (`tools`), SystemPrompt, the tool-call timeout policy,
// the SkillRegistry (`skills`), the CommandRuntime (`commands`), the
// file-backed LocalCredentialProvider (`credentials`) and, for one step, the
// ApprovalService — all composed in a Cordis Context. No network: globalThis.fetch
// is stubbed with canned realtimeavatar.ai responses that honour init.signal.
// Placeholder keys only; nothing here is a real credential.
//
// Usage: node scripts/runtime-proof.mjs   (exit 0 only when every step passes)
// Env:   DSH_PROFILE_MODULES — the @deepseek-ai package directory of a dsh profile.
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const PROFILE = process.env.DSH_PROFILE_MODULES ?? join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai')
const mod = (name) => import(PROFILE + '/' + name + '/lib/index.js')
const { Context, Service } = await mod('cordis')
const { SystemPrompt, renderPrompt } = await mod('dsh-system-prompt')
const { ToolRuntime } = await mod('dsh-tools')
const timeoutPolicy = await mod('dsh-tool-call-timeout-policy')
const { ApprovalService } = await mod('dsh-user-approval')
const { SkillRegistry } = await mod('dsh-skill')
const rta = await import(new URL('../lib/index.js', import.meta.url))

const REF = 'REALTIME_AVATAR_API_KEY'
const KEY = 'tic_test_' + 'x'.repeat(40) // placeholder; never a real key
const KEY_FRAGMENT = 'tic_test_x'
const RTA_CONFIG = { apiKeyEnv: REF, readOnly: false, writeApproval: true, maxSessionSeconds: 120, requestTimeoutMs: 5000 }
// The launch environment is the credential store's read-only top layer; make sure it does not shadow the file store.
delete process.env[REF]

// ---------- fetch stub (canned realtimeavatar.ai responses; honours init.signal; logs paths, never headers) ----------
const fetchLog = []
let fetchDelayMs = 0
let fetchHangMs = 0
let mintCalls = 0
const originalFetch = globalThis.fetch
const BALANCE = { tenantId: 't', balanceCreditMicros: 1020000000, reservedCreditMicros: 0, availableCreditMicros: 1020000000, lifetimeGrantedCreditMicros: 1020000000, lifetimeUsedCreditMicros: 0, updatedAt: '2026-09-02T00:00:00Z' }
const CAPACITY = { max_sessions: 4, active_sessions: 1, reserved_sessions: 0, available_sessions: 3, queue_size: 0, admission_open: true, recommended_retry_ms: 1000, load: 0.25, capacity_pool: 'primary', agent_name: 'x', worker_count: 1, max_sessions_per_gpu: 4, observed_worker_active_sessions: 1 }
const AVATAR = { id: 'ava_test1', tenantId: 't', displayName: 'Test', status: 'ready', idleVideoStatus: 'ready', sourceKind: 'image', modelId: 'm', sourceAssetId: 'ast_test1', error: null, defaultVoiceId: 'v', llm: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }
const ASSET = { id: 'ast_test1', tenantId: 't', kind: 'image', status: 'ready', contentType: 'image/png', sizeBytes: 1234, publicUrl: 'https://example.invalid/nova.png', createdAt: '2026-09-01T00:00:00Z' }
const QUEUED = { message: 'busy', capacity: {}, queue_size: 2, recommended_retry_ms: 1500, queue_ticket_id: 'qt_1', queue_position: 2 }
const GRANT = { status: 'ready', session_id: 'ses_1', room_name: 'r', livekit_url: 'wss://example.invalid', participant_token: 'tok_secret', participant_identity: 'p', agent_name: 'a', capacity_pool: 'primary', reservation_expires_at: '2026-09-02T00:05:00Z', max_sessions_per_gpu: 4, stt_mode: 'x', room_created: true, dispatch_created: true, join_timeout_seconds: 30, idle_timeout_seconds: 60, max_session_seconds: 120 }
const FOOTER = '\n---\n\nRealtime Avatar — realtime AI avatar API & SDK. Docs: https://realtimeavatar.ai/docs · Agent guide: https://realtimeavatar.ai/llms.txt'
const QUICKSTART_MD = ['# Quickstart', '', '- Updated: 2026-09-02', '- Canonical: https://realtimeavatar.ai/docs/quickstart', '', 'From an API key to a live call in three steps.', '', '## 1. Get a key', '', 'Create a key in the dashboard and keep it on the server as REALTIME_AVATAR_API_KEY.', '', '## 2. Mint a session', '', '```ts', 'const grant = await mint()', '```', ''].join('\n') + FOOTER

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function abortError() {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}
function canned(method, path) {
  if (method === 'GET' && path === '/api/v1/credits/balance') return jsonResponse(200, BALANCE)
  if (method === 'GET' && path === '/api/v1/realtime/livekit/capacity') return jsonResponse(200, CAPACITY)
  if (method === 'GET' && path === '/api/v1/avatars') return jsonResponse(200, { data: [AVATAR] })
  if (method === 'POST' && path === '/api/v1/avatars') return jsonResponse(201, { ...AVATAR, status: 'preprocessing', idleVideoStatus: 'pending' })
  if (method === 'POST' && path === '/api/v1/assets/remote') return jsonResponse(201, ASSET)
  if (method === 'POST' && path === '/api/v1/realtime/livekit/session') {
    mintCalls += 1
    return mintCalls === 1 ? jsonResponse(429, QUEUED) : jsonResponse(200, GRANT)
  }
  if (method === 'GET' && path === '/docs/quickstart.md') return new Response(QUICKSTART_MD, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } })
  return jsonResponse(404, { error: 'no canned response for ' + method + ' ' + path })
}
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = String(init.method ?? 'GET').toUpperCase()
  const headers = init.headers ?? {}
  const entry = { method, path: url.pathname, host: url.host, bearerMatchesKey: headers.Authorization === 'Bearer ' + KEY, signalAborted: false, abortedAfterMs: null, settled: 'pending', startedAt: performance.now() }
  fetchLog.push(entry)
  const signal = init.signal
  const markAborted = () => {
    entry.signalAborted = true
    entry.abortedAfterMs = Math.round(performance.now() - entry.startedAt)
    entry.settled = 'aborted'
  }
  if (signal?.aborted) {
    markAborted()
    throw abortError()
  }
  const wait = fetchHangMs > 0 ? fetchHangMs : fetchDelayMs
  if (wait > 0) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, wait)
      signal?.addEventListener('abort', () => { clearTimeout(t); markAborted(); reject(abortError()) }, { once: true })
    })
  }
  entry.settled = 'completed'
  return canned(method, url.pathname)
}

// ---------- fallbacks (used only when the real service cannot be composed in a bare Context) ----------
class FakeCredentials extends Service {
  constructor(ctx) {
    super(ctx, 'credentials')
    this.values = new Map()
  }
  async resolve(ref) {
    const ambient = process.env[ref]
    if (typeof ambient === 'string' && ambient.length > 0) return { value: ambient, source: 'env' }
    const stored = this.values.get(ref)
    return stored === undefined ? undefined : { value: stored, source: 'file' }
  }
  async describe(ref) {
    const ambient = process.env[ref]
    if (typeof ambient === 'string' && ambient.length > 0) return { configured: true, source: 'env', writable: false }
    return this.values.has(ref) ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true }
  }
  async set(ref, value) {
    this.values.set(ref, value)
  }
  async unset(ref) {
    this.values.delete(ref)
  }
}
class FakeCommands extends Service {
  constructor(ctx) {
    super(ctx, 'commands')
    this.definitions = new Map()
  }
  register(definition) {
    if (this.definitions.has(definition.name)) throw new Error('command "' + definition.name + '" is already registered')
    this.definitions.set(definition.name, definition)
    return this.ctx.effect(() => () => { this.definitions.delete(definition.name) }, 'fake commands.register()')
  }
}

// ---------- composition ----------
const home = await mkdtemp(join(tmpdir(), 'dsh-rta-proof-'))
const credentialsPath = join(home, '.credentials.yaml')
let LocalCredentialProvider
let credentialsMode = 'real'
try {
  ;({ LocalCredentialProvider } = await mod('dsh-credentials-local'))
} catch (error) {
  credentialsMode = 'fake (dsh-credentials-local failed to import: ' + (error instanceof Error ? error.message : String(error)) + ')'
}
let CommandRuntime
let commandsMode = 'real'
try {
  ;({ CommandRuntime } = await mod('dsh-commands'))
} catch (error) {
  commandsMode = 'fake (dsh-commands failed to import: ' + (error instanceof Error ? error.message : String(error)) + ')'
}

async function mountOrFallback(ctx, label, real, fallback) {
  if (real !== undefined) {
    try {
      const fiber = ctx.plugin(...real)
      await fiber
      if (fiber.state === 2) return { fiber, mode: 'real' }
      await fiber.dispose()
      throw new Error('fiber settled in state ' + fiber.state)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const fiber = ctx.plugin(fallback)
      await fiber
      return { fiber, mode: 'fake (' + label + ' could not mount bare: ' + reason.split('\n')[0] + ')' }
    }
  }
  const fiber = ctx.plugin(fallback)
  await fiber
  return { fiber, mode: 'fake' }
}

/** Mount a credentials service in `ctx`: the real file-backed provider over the shared temp document, else the in-memory fake. */
async function mountCredentials(ctx, seedKey) {
  const mounted = await mountOrFallback(ctx, 'LocalCredentialProvider', LocalCredentialProvider === undefined ? undefined : [LocalCredentialProvider, { path: credentialsPath, watch: false }], FakeCredentials)
  if (mounted.mode !== 'real' && seedKey !== undefined) await ctx.get('credentials').set(REF, seedKey)
  return mounted
}

const ctx = new Context()
const fSystemPrompt = ctx.plugin(SystemPrompt, {}); await fSystemPrompt
const fTools = ctx.plugin(ToolRuntime, {}); await fTools
const fTimeout = ctx.plugin(timeoutPolicy, {}); await fTimeout
const fSkills = ctx.plugin(SkillRegistry, {}); await fSkills
const commandsMount = await mountOrFallback(ctx, 'CommandRuntime', CommandRuntime === undefined ? undefined : [CommandRuntime], FakeCommands)
const fCommands = commandsMount.fiber
if (commandsMount.mode !== 'real') commandsMode = commandsMode === 'real' ? commandsMount.mode : commandsMode
const credentialsMount = await mountCredentials(ctx)
const fCredentials = credentialsMount.fiber
if (credentialsMount.mode !== 'real') credentialsMode = credentialsMode === 'real' ? credentialsMount.mode : credentialsMode
const fRta = ctx.plugin(rta, RTA_CONFIG); await fRta

const credentials = ctx.get('credentials')
const skills = ctx.get('skills')
const commands = ctx.get('commands')
console.log('composition: credentials=' + credentialsMode + (credentialsMode === 'real' ? ' (LocalCredentialProvider over ' + credentialsPath + ', watch:false)' : '') + '; commands=' + commandsMode + (commandsMode === 'real' ? ' (CommandRuntime)' : ''))

// ---------- harness ----------
const steps = []
function step(name, ok, detail) {
  steps.push({ name, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ' — ' + detail)
}
const textOf = (result) => (result.content ?? []).map((block) => block.text ?? '').join('\n')
const codeOf = (result) => result.error?.info?.code ?? '-'
const short = (text, max = 220) => JSON.stringify(String(text).length > max ? String(text).slice(0, max) + '…' : String(text))
let callSeq = 0
const runIn = (context) => (name, args, signal = new AbortController().signal) => context.tools.execute({ callId: 'call-' + (++callSeq), name, arguments: args, signal })
const run = runIn(ctx)
const countFetches = (predicate = () => true) => fetchLog.filter(predicate).length

// ---------- 1. registration surface ----------
{
  const fibers = { systemPrompt: fSystemPrompt, tools: fTools, timeoutPolicy: fTimeout, skills: fSkills, commands: fCommands, credentials: fCredentials, realtimeavatar: fRta }
  const states = Object.entries(fibers).map(([name, fiber]) => name + '=' + fiber.state)
  step('fibers active (systemPrompt/tools/timeout-policy/skills/commands/credentials/realtimeavatar)', Object.values(fibers).every((fiber) => fiber.state === 2), states.join(' '))
  step('ctx.tools is the real ToolRuntime', ctx.get('tools') instanceof ToolRuntime, 'constructor=' + ctx.get('tools')?.constructor?.name)
}
{
  const names = ctx.tools.schemas().map((schema) => schema.name).filter((name) => name.startsWith('rta_')).sort()
  const expected = [...rta.TOOL_NAMES].sort()
  step('18 rta_* tools visible in ctx.tools.schemas() (exactly the gate table)', names.length === 18 && JSON.stringify(names) === JSON.stringify(expected), names.length + ' tools: ' + names.join(', '))
}
{
  const reads = rta.TOOL_NAMES.filter((name) => rta.tierOf(name) === 'read' && name !== 'rta_session_release')
  const writes = rta.TOOL_NAMES.filter((name) => rta.isWriteTool(name))
  const unsafeReads = reads.filter((name) => ctx.tools.get(name)?.isConcurrencySafe?.({}) !== true)
  const safeWrites = writes.filter((name) => ctx.tools.get(name)?.isConcurrencySafe !== undefined)
  step('GET-backed read tools + docs tools report isConcurrencySafe; the 7 write tools are exclusive', unsafeReads.length === 0 && safeWrites.length === 0, reads.length + ' reads safe' + (unsafeReads.length > 0 ? ' except ' + unsafeReads.join(',') : '') + '; ' + writes.length + ' writes exclusive' + (safeWrites.length > 0 ? ' except ' + safeWrites.join(',') : ''))
  const release = ctx.tools.get('rta_session_release')
  step('rta_session_release (read tier, idempotent) declares isConcurrencySafe so dsh may overlap it with sibling reads', release?.isConcurrencySafe?.({}) === true, 'isConcurrencySafe({})=' + String(release?.isConcurrencySafe?.({})))
}
{
  const assembly = await ctx.systemPrompt.assemble({})
  const section = assembly.sections.find((entry) => entry.name === 'tool:rta')
  const text = renderPrompt(assembly)
  const promptTools = assembly.tools.filter((tool) => tool.name.startsWith('rta_'))
  step('systemPrompt.assemble(): section tool:rta present, text names rta_docs + REALTIME_AVATAR_API_KEY, 18 rta schemas offered', section !== undefined && text.includes('rta_docs') && text.includes(REF) && promptTools.length === 18 && !text.includes(KEY_FRAGMENT), 'section=' + (section !== undefined ? 'yes(order ' + rta.PROMPT_SECTION_ORDER + ')' : 'MISSING') + ' schemas=' + promptTools.length + ' text=' + short(section?.text ?? '', 120))
}
{
  const summaries = await skills.list()
  const names = summaries.filter((summary) => summary.name.startsWith('realtimeavatar-')).map((summary) => summary.name).sort()
  const expected = [...rta.SKILL_NAMES].sort()
  const definition = await skills.get('realtimeavatar-quickstart')
  const body = definition?.content ?? ''
  step('skills.list() has the five realtimeavatar-* skills; skills.get() loads the snapshot body', JSON.stringify(names) === JSON.stringify(expected) && definition?.provider === rta.PROVIDER_NAME && body.includes('> Snapshot of the public documentation'), names.join(', ') + '; get(quickstart).provider=' + String(definition?.provider) + ' bodyChars=' + body.length)
}

// ---------- 2. key posture ----------
{
  const before = fetchLog.length
  const r = await run('rta_status', {})
  const text = textOf(r)
  step('rta_status without a key: not configured, zero fetches, next hint points at /rta setup', r.isError === false && r.value?.key?.configured === false && fetchLog.length === before && text.includes('NOT configured') && (r.value?.next ?? []).some((hint) => hint.includes('/rta setup')), 'fetches=' + (fetchLog.length - before) + ' key=' + JSON.stringify(r.value?.key) + ' next=' + short(r.value?.next?.[0] ?? '', 100))
}
{
  await credentials.set(REF, KEY)
  const info = await credentials.describe(REF)
  const hit = await credentials.resolve(REF)
  step('the key stored through the credentials service resolves back (source recorded, value never printed)', info.configured === true && hit?.value === KEY, 'describe=' + JSON.stringify(info) + ' resolved.source=' + String(hit?.source) + ' length=' + String(hit?.value?.length))
}
{
  const before = fetchLog.length
  const r = await run('rta_status', {})
  const text = textOf(r)
  const json = JSON.stringify(r.value ?? null)
  const leaked = ['capacity_pool', 'agent_name', 'worker_count', 'max_sessions_per_gpu', 'observed_worker_active_sessions', 'tenantId'].filter((key) => json.includes(key))
  const wire = fetchLog.slice(before)
  step('rta_status with the stored key: credits 1020 (≈17 min), capacity 3 free, fleet fields dropped, no key in text/value', r.isError === false && r.value?.balance?.availableCredits === 1020 && r.value?.balance?.approxMinutesAvailable === 17 && r.value?.capacity?.availableSessions === 3 && leaked.length === 0 && !text.includes(KEY_FRAGMENT) && !json.includes(KEY_FRAGMENT) && text.includes('credits: 1020 available') && text.includes('≈ 17 min'), 'fetches=' + wire.map((entry) => entry.method + ' ' + entry.path).join(', ') + ' leaked=' + JSON.stringify(leaked) + ' text=' + short(text, 200))
  step('the resolved key reached the wire as the bearer on every API request (stub compared it; never logged)', wire.length === 2 && wire.every((entry) => entry.bearerMatchesKey === true), wire.length + ' requests, bearerMatchesKey=' + wire.map((entry) => entry.bearerMatchesKey).join(','))
}
{
  const r = await run('rta_avatars', {})
  const json = JSON.stringify(r.value ?? null)
  step('rta_avatars: 1 avatar, tenantId dropped from the value', r.isError === false && r.value?.count === 1 && r.value?.avatars?.[0]?.id === 'ava_test1' && !json.includes('tenantId') && textOf(r).includes('1 avatar(s)'), 'text=' + short(textOf(r), 160))
}
{
  const before = fetchLog.length
  const r = await run('rta_docs', { page: 'quickstart', heading: '1. Get a key' })
  const served = fetchLog.slice(before)
  const markdown = String(r.value?.markdown ?? '')
  step('rta_docs {quickstart, heading "1. Get a key"}: served from the stub, one section, footer stripped, updated 2026-09-02', r.isError === false && served.length === 1 && served[0].path === '/docs/quickstart.md' && r.value?.updated === '2026-09-02' && markdown.startsWith('## 1. Get a key') && !markdown.includes('## 2.') && !markdown.includes('Agent guide:') && r.value?.canonical === 'https://realtimeavatar.ai/docs/quickstart', 'served=' + served.map((entry) => entry.method + ' ' + entry.host + entry.path).join(',') + ' updated=' + String(r.value?.updated) + ' chars=' + String(r.value?.chars) + ' markdown=' + short(markdown, 120))
  const full = await run('rta_docs', { page: 'quickstart' })
  const fullMd = String(full.value?.markdown ?? '')
  step('rta_docs {quickstart} full page: title kept, public footer stripped', full.isError === false && fullMd.startsWith('# Quickstart') && fullMd.includes('## 2. Mint a session') && !fullMd.includes('Realtime Avatar — realtime AI avatar') && !fullMd.trimEnd().endsWith('---'), 'chars=' + String(full.value?.chars) + ' tail=' + short(fullMd.slice(-60), 80))
}

// ---------- 3. the write gate (writeApproval:true) ----------
{
  const before = fetchLog.length
  const r = await run('rta_avatar_create', { displayName: 'Nova', sourceAssetId: 'ast_test1', motionPrompt: 'calm breathing' })
  const text = textOf(r)
  const posts = fetchLog.slice(before).filter((entry) => entry.method === 'POST')
  step('rta_avatar_create: gate asks → no approval service → runtime denies (reason names credits + approval), zero POSTs', r.isError === true && /spends credits/.test(text) && /approval/.test(text) && posts.length === 0 && fetchLog.length === before, 'posts=' + posts.length + ' text=' + short(text, 200))
}
{
  const fApproval = ctx.plugin(ApprovalService, {}); await fApproval
  const before = fetchLog.length
  const r = await run('rta_avatar_create', { displayName: 'Nova', sourceAssetId: 'ast_test1' })
  const text = textOf(r)
  step('with ApprovalService mounted and no agent on the call: fails closed, zero fetches', fApproval.state === 2 && r.isError === true && /requires approval, but the call has no agent/.test(text) && fetchLog.length === before, 'text=' + short(text, 160))
  await fApproval.dispose()
}
{
  const before = fetchLog.length
  const r = await run('rta_session_mint', { avatarId: 'seed-rin-ashfall', maxSessionSeconds: 60 })
  const text = textOf(r)
  // dsh reuses the gate's ask-reason verbatim as the denial text when no approval service is composed.
  step('rta_session_mint: costly write asks → denied without an approval service (gate reason surfaced), zero fetches', r.isError === true && /reserves a call slot/.test(text) && /^Error: rta_session_mint/.test(text) && fetchLog.length === before && !text.includes(KEY_FRAGMENT), 'text=' + short(text, 200))
}

// ---------- 4. cancellation and timeouts ----------
{
  const before = fetchLog.length
  const ac = new AbortController()
  ac.abort()
  const r = await run('rta_balance', {}, ac.signal)
  step('pre-aborted signal → ABORTED_BEFORE_DISPATCH, body never ran', r.isError === true && codeOf(r) === 'ABORTED_BEFORE_DISPATCH' && fetchLog.length === before, 'code=' + codeOf(r) + ' fetches=' + (fetchLog.length - before))
}
{
  fetchDelayMs = 1500
  const before = fetchLog.length
  const ac = new AbortController()
  const t0 = performance.now()
  const pending = run('rta_balance', {}, ac.signal)
  setTimeout(() => ac.abort(), 100)
  const r = await pending
  const elapsed = Math.round(performance.now() - t0)
  fetchDelayMs = 0
  const entry = fetchLog[before]
  step('mid-flight abort on rta_balance: runtime reports ABORTED and the stub saw init.signal abort within ~200 ms', r.isError === true && codeOf(r) === 'ABORTED' && entry?.signalAborted === true && entry.abortedAfterMs !== null && entry.abortedAfterMs <= 250 && elapsed < 1000, 'code=' + codeOf(r) + ' elapsed=' + elapsed + 'ms fetch=' + String(entry?.settled) + ' abortedAfter=' + String(entry?.abortedAfterMs) + 'ms')
}
{
  fetchHangMs = 20000
  const before = fetchLog.length
  const t0 = performance.now()
  const r = await run('rta_balance', {})
  const elapsed = Math.round(performance.now() - t0)
  fetchHangMs = 0
  const entry = fetchLog[before]
  step('hung request: rta_balance settles at ~requestTimeoutMs (5000) with TOOL_TIMEOUT and the request is aborted', r.isError === true && codeOf(r) === 'TOOL_TIMEOUT' && elapsed >= 4900 && elapsed < 7000 && entry?.settled === 'aborted', 'code=' + codeOf(r) + ' elapsed=' + elapsed + 'ms fetch=' + String(entry?.settled) + ' abortedAfter=' + String(entry?.abortedAfterMs) + 'ms')
}

// ---------- 5. fresh contexts for the other write postures (duplicate tool names cannot coexist) ----------
async function composeFresh(config) {
  const fresh = new Context()
  await fresh.plugin(SystemPrompt, {})
  await fresh.plugin(ToolRuntime, {})
  await fresh.plugin(timeoutPolicy, {})
  const mounted = await mountCredentials(fresh, KEY)
  const fiber = fresh.plugin(rta, config)
  await fiber
  return { ctx: fresh, fiber, run: runIn(fresh), credentialsMode: mounted.mode }
}
{
  const fresh = await composeFresh({ ...RTA_CONFIG, writeApproval: false })
  const posture = await fresh.ctx.get('credentials').describe(REF)
  step('fresh Context (writeApproval:false): a second credentials provider reads the stored key back', fresh.fiber.state === 2 && posture.configured === true, 'credentials=' + fresh.credentialsMode + ' describe=' + JSON.stringify(posture))
  const before = fetchLog.length
  const r = await fresh.run('rta_asset_remote', { kind: 'image', remoteUrl: 'https://example.invalid/nova.png' })
  const posts = fetchLog.slice(before).filter((entry) => entry.method === 'POST' && entry.path === '/api/v1/assets/remote')
  step('writeApproval:false — rta_asset_remote (free write) runs without asking', r.isError === false && r.value?.id === 'ast_test1' && posts.length === 1 && posts[0].bearerMatchesKey === true && !textOf(r).includes('approval'), 'posts=' + posts.length + ' value.id=' + String(r.value?.id) + ' status=' + String(r.value?.status))
  const before2 = fetchLog.length
  const mint = await fresh.run('rta_session_mint', { avatarId: 'seed-rin-ashfall' })
  const text = textOf(mint)
  step('writeApproval:false — rta_session_mint STILL asks (costly always asks) → denied, zero fetches', mint.isError === true && /reserves a call slot/.test(text) && /^Error: rta_session_mint/.test(text) && fetchLog.length === before2, 'text=' + short(text, 160))
  await fresh.fiber.dispose()
  await fresh.ctx.fiber.dispose()
}
{
  const fresh = await composeFresh({ ...RTA_CONFIG, readOnly: true })
  const before = fetchLog.length
  const r = await fresh.run('rta_avatar_delete', { avatarId: 'ava_test1' })
  const text = textOf(r)
  step('readOnly:true — rta_avatar_delete denied with a readOnly reason, zero fetches', fresh.fiber.state === 2 && r.isError === true && /readOnly mode/.test(text) && /rta_avatar_delete is disabled/.test(text) && fetchLog.length === before, 'text=' + short(text, 160))
  const s = await fresh.run('rta_status', {})
  step('readOnly:true — rta_status still reads and reports writes disabled', s.isError === false && textOf(s).includes('writes: disabled (readOnly)') && s.value?.readOnly === true, short(textOf(s).split('\n').find((line) => line.startsWith('- writes')) ?? '', 100))
  await fresh.fiber.dispose()
  await fresh.ctx.fiber.dispose()
}

// ---------- 6. the /rta command ----------
const session = { events: [], append(type, data) { this.events.push({ type, data }) } }
const agent = { session }
{
  await credentials.unset(REF)
  const cleared = await credentials.describe(REF)
  const signal = new AbortController().signal
  if (commandsMode === 'real') {
    const definition = commands.find(agent, 'rta')
    const exec = await commands.execute(agent, '/rta key ' + KEY, [], signal)
    const runEvent = session.events.find((event) => event.type === 'command/run')
    const doneEvent = session.events.find((event) => event.type === 'command/done')
    const stored = await credentials.resolve(REF)
    const eventsJson = JSON.stringify(session.events)
    step('/rta key <key> through the real CommandRuntime: key lands in the credential store; command/run carries no args; no event or result text contains the key', cleared.configured === false && definition?.recordInput === false && exec?.result?.kind === 'success' && stored?.value === KEY && runEvent !== undefined && !('args' in runEvent.data) && doneEvent?.data?.kind === 'success' && !eventsJson.includes('tic_test_') && !exec.result.text.includes('tic_test_'), 'recordInput=' + String(definition?.recordInput) + ' run.data.keys=' + JSON.stringify(Object.keys(runEvent?.data ?? {})) + ' stored.source=' + String(stored?.source) + ' result=' + short(exec?.result?.text ?? '', 120))
    const status = await commands.execute(agent, '/rta status', [], signal)
    step('/rta status through the CommandRuntime renders credits', status?.result?.kind === 'success' && status.result.text.includes('credits: 1020 available') && !status.result.text.includes(KEY_FRAGMENT), short(status?.result?.text ?? '', 200))
    const listed = commands.list(agent).map((descriptor) => descriptor.name)
    step('commands.list(agent) advertises /rta with its input hint', listed.includes('rta') && typeof commands.find(agent, 'rta')?.input?.hint === 'string', 'commands=' + listed.join(','))
  } else {
    const definition = commands.definitions.get('rta')
    const r = await definition.handler({ rawInput: 'key ' + KEY, signal })
    const stored = await credentials.resolve(REF)
    step('/rta key <key> through the registered definition (fake commands service): key lands in the credential store; result text has no key fragment', cleared.configured === false && definition?.recordInput === false && r.kind === 'success' && stored?.value === KEY && !r.text.includes('tic_test_'), 'recordInput=' + String(definition?.recordInput) + ' result=' + short(r.text, 120))
    const status = await definition.handler({ rawInput: 'status', signal })
    step('/rta status through the definition renders credits', status.kind === 'success' && status.text.includes('credits: 1020 available') && !status.text.includes(KEY_FRAGMENT), short(status.text, 200))
  }
}

// ---------- 7. teardown ----------
{
  await fRta.dispose()
  const toolsLeft = ctx.tools.schemas().map((schema) => schema.name).filter((name) => name.startsWith('rta_'))
  const skillsLeft = (await skills.list()).map((summary) => summary.name).filter((name) => name.startsWith('realtimeavatar-'))
  const promptLeft = (await ctx.systemPrompt.assemble({})).sections.some((section) => section.name === 'tool:rta')
  const commandLeft = commandsMode === 'real' ? commands.list(agent).some((descriptor) => descriptor.name === 'rta') : commands.definitions.has('rta')
  step('disposing the plugin fiber removes every rta_* tool, the skill provider, the prompt section and /rta', toolsLeft.length === 0 && skillsLeft.length === 0 && !promptLeft && !commandLeft, 'tools=' + toolsLeft.length + ' skills=' + skillsLeft.length + ' promptSection=' + promptLeft + ' command=' + commandLeft)
}
{
  const unexpected = fetchLog.filter((entry) => entry.host !== 'realtimeavatar.ai')
  const secretsInLog = JSON.stringify(fetchLog).includes('tic_test_')
  step('every stubbed request targeted realtimeavatar.ai and the request log holds no key material', unexpected.length === 0 && !secretsInLog, fetchLog.length + ' requests: ' + fetchLog.map((entry) => entry.method + ' ' + entry.path + '(' + entry.settled + ')').join(', '))
}

globalThis.fetch = originalFetch
await ctx.fiber.dispose()
await rm(home, { recursive: true, force: true })
const failed = steps.filter((entry) => !entry.ok).length
console.log('\n' + (steps.length - failed) + '/' + steps.length + ' steps passed')
process.exit(failed === 0 ? 0 : 1)
