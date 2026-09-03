/**
 * Read tools: status, balance, capacity, avatars, clips, assets, usage, and the
 * free idempotent session release. All are concurrency-safe.
 *
 * @module dsh-realtimeavatar/tools/read
 */
import { getAvatar, getBalance, getCapacity, listAssets, listAvatars, listClips, listUsage, releaseSession, RELEASE_REASONS, type Balance, type Capacity } from '../api.js'
import { PLUGIN_VERSION } from '../config.js'
import { describeKey, KeyError, type KeyPosture } from '../credentials.js'
import { ENV_VAR, EXAMPLE_AVATAR_ID, RATE_LIMIT, URLS } from '../facts.js'
import { safeMessage } from '../redact.js'
import { ANY_OBJECT, asRecord, callContext, cancellable, compileParameters, optionalEnum, optionalInt, optionalString, renderJson, requiredString, signalOf, textBlock, nullable, type RtaToolDefinition, type ToolDeps } from './shared.js'

const READ_SAFE = (): boolean => true

export interface StatusReport {
  plugin: string
  version: string
  key: KeyPosture
  readOnly: boolean
  writeApproval: boolean
  maxSessionSeconds: number
  configError?: string
  balance: Balance | null
  capacity: Capacity | null
  errors: { balance?: string; capacity?: string; key?: string }
  next: string[]
}

/** Shared by rta_status and `/rta status`. Never throws on a missing key; reports it instead. */
export async function collectStatus(deps: ToolDeps, signal: AbortSignal | undefined): Promise<StatusReport> {
  const cfg = deps.cfg
  const source = deps.keySource()
  let key: KeyPosture
  let keyError: string | undefined
  try {
    key = await describeKey(source, cfg.apiKeyEnv)
  } catch (error) {
    key = { ref: cfg.apiKeyEnv, configured: false, source: 'unknown', environment: 'none' }
    keyError = 'the credential store failed: ' + safeMessage(error)
  }
  const report: StatusReport = {
    plugin: 'dsh-realtimeavatar',
    version: PLUGIN_VERSION,
    key,
    readOnly: cfg.readOnly,
    writeApproval: cfg.writeApproval,
    maxSessionSeconds: cfg.maxSessionSeconds,
    ...(deps.configError !== undefined ? { configError: deps.configError } : {}),
    balance: null,
    capacity: null,
    errors: {},
    next: [],
  }
  if (keyError !== undefined) {
    report.errors.key = keyError
    report.next.push('Check the harness credential store, or export ' + cfg.apiKeyEnv + ' in the shell that launches dsh.')
    return report
  }
  if (!key.configured) {
    report.errors.key = 'no API key behind ' + cfg.apiKeyEnv
    report.next.push('Run /rta setup to create a key in the dashboard (' + URLS.apiKeys + '), then /rta key <tic_…> or export ' + ENV_VAR + '.')
    return report
  }
  let ctx
  try {
    ctx = await callContext(deps, signal)
  } catch (error) {
    report.errors.key = safeMessage(error)
    report.next.push('Fix the key behind ' + cfg.apiKeyEnv + ' (run /rta setup).')
    return report
  }
  const [balance, capacity] = await Promise.allSettled([getBalance(ctx), getCapacity(ctx)])
  if (balance.status === 'fulfilled') report.balance = balance.value
  else report.errors.balance = safeMessage(balance.reason, [ctx.apiKey])
  if (capacity.status === 'fulfilled') report.capacity = capacity.value
  else report.errors.capacity = safeMessage(capacity.reason, [ctx.apiKey])
  if (signal?.aborted === true) return report
  if (report.errors.balance !== undefined && /rejected|HTTP 401/.test(report.errors.balance)) {
    report.next.push('The key was rejected: create a fresh one in the dashboard and store it with /rta key.')
  } else if (report.balance !== null && typeof report.balance.availableCredits === 'number' && report.balance.availableCredits <= 0) {
    report.next.push('No credits available: top up or check the plan at ' + URLS.pricing + '.')
  } else if (report.balance !== null && report.balance.availableCredits === null) {
    report.next.push('Balance unavailable (unexpected response shape); the key works but credits could not be read.')
  } else {
    report.next.push('Ready. Build the first call on the public example avatar ' + EXAMPLE_AVATAR_ID + ' (see /rta prompt), or load the realtimeavatar-quickstart skill.')
  }
  return report
}

/** Human rendering of a status report. Total: tolerates partial or malformed values. */
export function renderStatus(value: unknown): string {
  const report = asRecord(value)
  const key = asRecord(report.key)
  const errors = asRecord(report.errors)
  const n = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : 'unknown')
  const lines = ['Realtime Avatar status (dsh-realtimeavatar ' + String(report.version ?? '?') + ')']
  if (typeof report.configError === 'string') lines.push('- config error: ' + report.configError + ' (defaults in effect)')
  lines.push('- API key (' + String(key.ref ?? '?') + '): ' + (key.configured === true ? 'configured via ' + String(key.source) + ', environment tag ' + String(key.environment) : 'NOT configured'))
  if (typeof errors.key === 'string') lines.push('- key problem: ' + errors.key)
  if (typeof report.balance === 'object' && report.balance !== null) {
    const b = asRecord(report.balance)
    lines.push('- credits: ' + n(b.availableCredits) + ' available (' + n(b.reservedCredits) + ' reserved of ' + n(b.balanceCredits) + '), ≈ ' + n(b.approxMinutesAvailable) + ' min on air')
  } else if (typeof errors.balance === 'string') lines.push('- credits: unavailable — ' + errors.balance)
  if (typeof report.capacity === 'object' && report.capacity !== null) {
    const c = asRecord(report.capacity)
    lines.push('- capacity: ' + n(c.availableSessions) + ' free of ' + n(c.maxSessions) + ' slots, queue ' + n(c.queueSize) + ', admission ' + (c.admissionOpen === true ? 'open' : c.admissionOpen === false ? 'closed' : 'unknown'))
  } else if (typeof errors.capacity === 'string') lines.push('- capacity: unavailable — ' + errors.capacity)
  lines.push('- writes: ' + (report.readOnly === true ? 'disabled (readOnly)' : report.writeApproval === false ? 'free writes ungated; credit-spending tools still ask' : 'approval-gated') + '; session cap ' + n(report.maxSessionSeconds) + ' s')
  if (Array.isArray(report.next)) for (const hint of report.next) lines.push('- next: ' + String(hint))
  return lines.join('\n')
}

const statusSchema = {
  type: 'object',
  properties: {
    plugin: { type: 'string' },
    version: { type: 'string' },
    key: ANY_OBJECT,
    readOnly: { type: 'boolean' },
    writeApproval: { type: 'boolean' },
    maxSessionSeconds: { type: 'integer' },
    configError: { type: 'string' },
    balance: nullable('object'),
    capacity: nullable('object'),
    errors: ANY_OBJECT,
    next: { type: 'array', items: { type: 'string' } },
  },
  required: ['plugin', 'version', 'key', 'readOnly', 'writeApproval', 'maxSessionSeconds', 'balance', 'capacity', 'errors', 'next'],
  additionalProperties: true,
}

export function buildReadTools(deps: ToolDeps): RtaToolDefinition[] {
  const cfg = deps.cfg
  const RT = cfg.requestTimeoutMs

  const rtaStatus: RtaToolDefinition = {
    name: 'rta_status',
    description: 'Self-check: key posture (source and live/test tag, never the value), credit balance, live capacity, write posture and what to do next. Run first when something is off or before spending credits.',
    parameters: compileParameters({}),
    output: {
      schema: statusSchema,
      render: (_args, value) => textBlock(renderStatus(value)),
    },
    async execute(_args, exec) {
      return collectStatus(deps, signalOf(exec))
    },
    timeoutMs: RT * 2,
    isConcurrencySafe: READ_SAFE,
  }

  const rtaBalance: RtaToolDefinition = {
    name: 'rta_balance',
    description: 'Workspace credit balance (GET /v1/credits/balance): available, reserved and lifetime credits, plus approximate minutes on air (1 credit = 1 s). Scope credits:read.',
    parameters: compileParameters({}),
    output: {
      schema: { type: 'object', properties: { availableCredits: nullable('number'), approxMinutesAvailable: nullable('number') }, required: ['availableCredits', 'approxMinutesAvailable'], additionalProperties: true },
      render: (_args, value) => {
        const b = asRecord(value)
        return textBlock('credits: ' + String(b.availableCredits) + ' available, ' + String(b.reservedCredits) + ' reserved, balance ' + String(b.balanceCredits) + ' (≈ ' + String(b.approxMinutesAvailable) + ' min on air); lifetime granted ' + String(b.lifetimeGrantedCredits) + ', used ' + String(b.lifetimeUsedCredits))
      },
    },
    async execute(_args, exec) {
      const signal = signalOf(exec)
      const ctx = await callContext(deps, signal)
      return cancellable(signal, { availableCredits: null, reservedCredits: null, balanceCredits: null, approxMinutesAvailable: null }, () => getBalance(ctx))
    },
    timeoutMs: RT,
    isConcurrencySafe: READ_SAFE,
  }

  const rtaCapacity: RtaToolDefinition = {
    name: 'rta_capacity',
    description: 'Live-call capacity snapshot (GET /v1/realtime/livekit/capacity): free/active slots, queue depth, admission, retry delay. Informational only — never gate a call on it; mint and treat a 429 queue answer as the signal. Scope realtime:write.',
    parameters: compileParameters({}),
    output: {
      schema: { type: 'object', properties: { availableSessions: nullable('number'), queueSize: nullable('number'), admissionOpen: nullable('boolean') }, required: ['availableSessions', 'queueSize', 'admissionOpen'], additionalProperties: true },
      render: (_args, value) => renderJson(value),
    },
    async execute(_args, exec) {
      const signal = signalOf(exec)
      const ctx = await callContext(deps, signal)
      return cancellable(signal, { availableSessions: null, queueSize: null, admissionOpen: null }, () => getCapacity(ctx))
    },
    timeoutMs: RT,
    isConcurrencySafe: READ_SAFE,
  }

  const avatarSchema = { type: 'object', properties: { id: nullable('string'), displayName: nullable('string'), status: nullable('string'), idleVideoStatus: nullable('string') }, required: ['id', 'displayName', 'status', 'idleVideoStatus'], additionalProperties: true }

  const rtaAvatars: RtaToolDefinition = {
    name: 'rta_avatars',
    description: "List the workspace's avatars (GET /v1/avatars, newest first, max 100) with status (draft · preprocessing · ready · failed · disabled) and idleVideoStatus. Public seed-* avatars are callable but not listed. Scope avatars:read.",
    parameters: compileParameters({}),
    output: {
      schema: { type: 'object', properties: { count: { type: 'integer' }, avatars: { type: 'array', items: avatarSchema } }, required: ['count', 'avatars'], additionalProperties: true },
      render: (_args, value) => {
        const rec = asRecord(value)
        const avatars = Array.isArray(rec.avatars) ? rec.avatars : []
        const lines = [String(rec.count ?? avatars.length) + ' avatar(s):']
        for (const item of avatars.slice(0, 50)) {
          const a = asRecord(item)
          lines.push('- ' + String(a.id) + ' "' + String(a.displayName) + '" status=' + String(a.status) + ' idleVideo=' + String(a.idleVideoStatus) + (a.error ? ' error=' + String(a.error) : ''))
        }
        if (avatars.length > 50) lines.push('…showing first 50')
        return textBlock(lines.join('\n'))
      },
    },
    async execute(_args, exec) {
      const signal = signalOf(exec)
      const ctx = await callContext(deps, signal)
      return cancellable(signal, { count: 0, avatars: [] }, async () => {
        const avatars = await listAvatars(ctx)
        return { count: avatars.length, avatars }
      })
    },
    timeoutMs: RT,
    isConcurrencySafe: READ_SAFE,
  }

  const rtaAvatar: RtaToolDefinition = {
    name: 'rta_avatar',
    description: 'Fetch one avatar (GET /v1/avatars/{avatarId}). After rta_avatar_create poll every few seconds (rate limit ' + RATE_LIMIT.requests + ' per ' + RATE_LIMIT.perSeconds + ' s per key) until status is ready; failed carries error. Scope avatars:read.',
    parameters: compileParameters({ avatarId: { type: 'string', required: true, description: 'Avatar id (ava_… for your own avatars).' } }),
    output: {
      schema: { ...avatarSchema, properties: { ...avatarSchema.properties, hint: { type: 'string' } } },
      render: (_args, value) => {
        const a = asRecord(value)
        return textBlock('avatar ' + String(a.id) + ' "' + String(a.displayName) + '": status=' + String(a.status) + ', idleVideo=' + String(a.idleVideoStatus) + ', voice=' + String(a.defaultVoiceId) + (a.error ? ', error=' + String(a.error) : '') + (typeof a.hint === 'string' ? '\n' + a.hint : ''))
      },
    },
    async execute(rawArgs, exec) {
      const signal = signalOf(exec)
      const avatarId = requiredString(asRecord(rawArgs), 'avatarId', 200)
      const ctx = await callContext(deps, signal)
      return cancellable(signal, { id: avatarId, displayName: null, status: null, idleVideoStatus: null }, async () => {
        const avatar = await getAvatar(ctx, avatarId)
        const hint = avatar.status === 'ready' ? 'ready: mint calls against it' : avatar.status === 'preprocessing' ? 'still generating: poll rta_avatar every few seconds until status is ready' : avatar.status === 'failed' ? 'generation failed: read error, fix the source portrait, create again' : 'status ' + String(avatar.status)
        return { ...avatar, hint }
      })
    },
    timeoutMs: RT,
    isConcurrencySafe: READ_SAFE,
  }

  const rtaClips: RtaToolDefinition = {
    name: 'rta_clips',
    description: "List an avatar's clip library (GET /v1/avatars/{avatarId}/clips): clipId, role (idle · listen · gesture), status, whenHint, source, and the revision rta_clips_set needs. Scope avatars:read.",
    parameters: compileParameters({ avatarId: { type: 'string', required: true, description: 'Avatar id.' } }),
    output: {
      schema: { type: 'object', properties: { avatarId: nullable('string'), revision: nullable('number'), clips: { type: 'array', items: ANY_OBJECT } }, required: ['avatarId', 'clips'], additionalProperties: true },
      render: (_args, value) => {
        const rec = asRecord(value)
        const clips = Array.isArray(rec.clips) ? rec.clips : []
        const lines = ['clip library of ' + String(rec.avatarId) + ' (revision ' + String(rec.revision) + '): ' + clips.length + ' clip(s)']
        for (const item of clips.slice(0, 40)) {
          const c = asRecord(item)
          lines.push('- ' + String(c.clipId) + ' role=' + String(c.role) + ' status=' + String(c.status) + (c.whenHint ? ' when="' + String(c.whenHint) + '"' : ''))
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute(rawArgs, exec) {
      const signal = signalOf(exec)
      const avatarId = requiredString(asRecord(rawArgs), 'avatarId', 200)
      const ctx = await callContext(deps, signal)
      return cancellable(signal, { avatarId, revision: null, clips: [] }, () => listClips(ctx, avatarId))
    },
    timeoutMs: RT,
    isConcurrencySafe: READ_SAFE,
  }

  const rtaAssets: RtaToolDefinition = {
    name: 'rta_assets',
    description: "List uploaded assets (GET /v1/assets): id, kind (image · video · audio), status, content type, size, public URL. An image asset id is rta_avatar_create's sourceAssetId. Scope avatars:read.",
    parameters: compileParameters({}),
    output: {
      schema: { type: 'object', properties: { count: { type: 'integer' }, assets: { type: 'array', items: ANY_OBJECT } }, required: ['count', 'assets'], additionalProperties: true },
      render: (_args, value) => {
        const rec = asRecord(value)
        const assets = Array.isArray(rec.assets) ? rec.assets : []
        const lines = [String(rec.count ?? assets.length) + ' asset(s):']
        for (const item of assets.slice(0, 50)) {
          const a = asRecord(item)
          lines.push('- ' + String(a.id) + ' ' + String(a.kind) + ' ' + String(a.status) + ' ' + String(a.contentType) + ' ' + String(a.sizeBytes) + ' B')
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute(_args, exec) {
      const signal = signalOf(exec)
      const ctx = await callContext(deps, signal)
      return cancellable(signal, { count: 0, assets: [] }, async () => {
        const assets = await listAssets(ctx)
        return { count: assets.length, assets }
      })
    },
    timeoutMs: RT,
    isConcurrencySafe: READ_SAFE,
  }

  const rtaUsage: RtaToolDefinition = {
    name: 'rta_usage',
    description: 'Per-session billing (GET /v1/usage/sessions): active seconds on air and credits per call. Window defaults to 30 days (max 90); page with cursor; endUserId filters by client_metadata.user_id. Only released and failed rows are settled. Scope usage:read.',
    parameters: compileParameters({
      from: { type: 'string', description: 'ISO date-time.' },
      to: { type: 'string', description: 'ISO date-time.' },
      limit: { type: 'integer', description: 'Page size 1-200.' },
      cursor: { type: 'string', description: 'nextCursor of the previous page.' },
      endUserId: { type: 'string', description: 'One end user.' },
    }),
    output: {
      schema: { type: 'object', properties: { sessions: { type: 'array', items: ANY_OBJECT }, nextCursor: nullable('string'), totals: ANY_OBJECT }, required: ['sessions', 'totals'], additionalProperties: true },
      render: (_args, value) => {
        const rec = asRecord(value)
        const t = asRecord(rec.totals)
        return textBlock(String(t.count) + ' session(s) from ' + String(rec.from) + ' to ' + String(rec.to) + ': ' + String(t.activeSeconds) + ' active s, ' + String(t.billedCredits) + ' credits (settled rows only)' + (rec.nextCursor ? '; more pages (cursor available)' : ''))
      },
    },
    async execute(rawArgs, exec) {
      const signal = signalOf(exec)
      const args = asRecord(rawArgs)
      const query = { from: optionalString(args, 'from', 64), to: optionalString(args, 'to', 64), limit: optionalInt(args, 'limit', 1, 200), cursor: optionalString(args, 'cursor', 512), endUserId: optionalString(args, 'endUserId', 256) }
      const ctx = await callContext(deps, signal)
      return cancellable(signal, { sessions: [], nextCursor: null, from: null, to: null, totals: { count: 0, settledCount: 0, activeSeconds: 0, billedCredits: 0 } }, async () => {
        const page = await listUsage(ctx, query)
        const settled = page.sessions.filter((s) => s.status === 'released' || s.status === 'failed')
        const totals = {
          count: page.sessions.length,
          settledCount: settled.length,
          activeSeconds: settled.reduce((sum, s) => sum + (s.activeSeconds ?? 0), 0),
          billedCredits: Math.round(settled.reduce((sum, s) => sum + (s.billedCredits ?? 0), 0) * 1000) / 1000,
        }
        return { ...page, totals, note: 'window clamped to 90 days; reconcile on released/failed rows only' }
      })
    },
    timeoutMs: RT,
    isConcurrencySafe: READ_SAFE,
  }

  const rtaSessionRelease: RtaToolDefinition = {
    name: 'rta_session_release',
    description: "Free a minted call's slot early (POST /v1/realtime/livekit/session/release); free and idempotent. Give sessionId or queueTicketId; reason defaults to manual. Scope realtime:write.",
    parameters: compileParameters({
      sessionId: { type: 'string', description: 'Session id from rta_session_mint.' },
      queueTicketId: { type: 'string', description: 'Ticket id from a queued mint.' },
      reason: { type: 'string', enum: RELEASE_REASONS, description: 'Default manual.' },
    }),
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: true },
      render: (_args, value) => {
        const rec = asRecord(value)
        return textBlock(rec.ok === true ? 'released ' + String(rec.sessionId ?? rec.queueTicketId) : 'release not confirmed')
      },
    },
    async execute(rawArgs, exec) {
      const signal = signalOf(exec)
      const args = asRecord(rawArgs)
      const sessionId = optionalString(args, 'sessionId', 200)
      const queueTicketId = optionalString(args, 'queueTicketId', 200)
      const reason = optionalEnum(args, 'reason', RELEASE_REASONS) ?? 'manual'
      const ctx = await callContext(deps, signal)
      // Only defined keys: dsh requires lossless JSON (an own `undefined` key is rejected).
      const ids = { ...(sessionId !== undefined ? { sessionId } : {}), ...(queueTicketId !== undefined ? { queueTicketId } : {}) }
      return cancellable(signal, { ok: false, ...ids, reason }, async () => {
        await releaseSession(ctx, { sessionId, queueTicketId }, reason)
        return { ok: true, ...ids, reason }
      })
    },
    timeoutMs: RT,
    // Idempotent and free: safe to overlap with sibling calls.
    isConcurrencySafe: READ_SAFE,
  }

  return [rtaStatus, rtaBalance, rtaCapacity, rtaAvatars, rtaAvatar, rtaClips, rtaAssets, rtaUsage, rtaSessionRelease]
}

export { KeyError }
