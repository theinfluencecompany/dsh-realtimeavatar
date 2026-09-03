/**
 * Typed wrappers over the public REST API: paths and casing live here and
 * nowhere else. Realtime routes are snake_case; resource routes are camelCase.
 *
 * Fleet-internal fields that the public spec still carries (pool names, worker
 * counts, agent names) are dropped from every result so they never reach the
 * model. Tenant ids are dropped too.
 *
 * @module dsh-realtimeavatar/api
 */
import { request, RtaApiError } from './client.js'

/** Per-call context: the key for this request only, the caller's signal and the timeout. */
export interface CallContext {
  apiKey: string
  signal?: AbortSignal
  timeoutMs: number
}

const ID_RE = /^[A-Za-z0-9._-]{1,160}$/

/** Ids are prefixed and stable (`ava_…`, `seed-…`, `ast_…`); reject anything that could alter the path. */
export function assertId(value: string, label: string): string {
  const trimmed = value.trim()
  if (!ID_RE.test(trimmed)) throw new Error(label + ' is invalid (letters, digits, dot, underscore, dash; 1-160 chars).')
  return trimmed
}

/** Only http(s) URLs may be registered as remote assets. */
export function assertHttpUrl(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(label + ' must be an absolute http(s) URL.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(label + ' must be an absolute http(s) URL.')
  return url.toString()
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Credits are billed in micros; 1 credit = 1 second on air. */
export function microsToCredits(micros: unknown): number | null {
  const n = num(micros)
  return n === null ? null : Math.round((n / 1_000_000) * 1000) / 1000
}

// ---------- credits / capacity / usage ----------

export interface Balance {
  balanceCredits: number | null
  reservedCredits: number | null
  availableCredits: number | null
  lifetimeGrantedCredits: number | null
  lifetimeUsedCredits: number | null
  approxMinutesAvailable: number | null
  updatedAt: string | null
}

export async function getBalance(ctx: CallContext): Promise<Balance> {
  const { json } = await request({ ...ctx, method: 'GET', path: '/v1/credits/balance' })
  const r = asRecord(json)
  const available = microsToCredits(r.availableCreditMicros)
  return {
    balanceCredits: microsToCredits(r.balanceCreditMicros),
    reservedCredits: microsToCredits(r.reservedCreditMicros),
    availableCredits: available,
    lifetimeGrantedCredits: microsToCredits(r.lifetimeGrantedCreditMicros),
    lifetimeUsedCredits: microsToCredits(r.lifetimeUsedCreditMicros),
    approxMinutesAvailable: available === null ? null : Math.floor(available / 60),
    updatedAt: str(r.updatedAt),
  }
}

export interface Capacity {
  maxSessions: number | null
  activeSessions: number | null
  reservedSessions: number | null
  availableSessions: number | null
  queueSize: number | null
  admissionOpen: boolean | null
  recommendedRetryMs: number | null
  load: number | null
}

export async function getCapacity(ctx: CallContext): Promise<Capacity> {
  const { json } = await request({ ...ctx, method: 'GET', path: '/v1/realtime/livekit/capacity' })
  const r = asRecord(json)
  return {
    maxSessions: num(r.max_sessions),
    activeSessions: num(r.active_sessions),
    reservedSessions: num(r.reserved_sessions),
    availableSessions: num(r.available_sessions),
    queueSize: num(r.queue_size),
    admissionOpen: typeof r.admission_open === 'boolean' ? r.admission_open : null,
    recommendedRetryMs: num(r.recommended_retry_ms),
    load: num(r.load),
  }
}

export interface UsageQuery {
  from?: string
  to?: string
  limit?: number
  cursor?: string
  endUserId?: string
}

export interface UsageSession {
  sessionId: string | null
  avatarId: string | null
  avatarName: string | null
  status: string | null
  startedAt: string | null
  endedAt: string | null
  /** Seconds the call was live and billable (the spec's `activeSeconds`). */
  activeSeconds: number | null
  billedCredits: number | null
  /** `client_metadata.user_id` the call was minted with, when tagged. */
  endUserId: string | null
  metadata: Record<string, unknown>
}

export interface UsagePage {
  sessions: UsageSession[]
  nextCursor: string | null
  from: string | null
  to: string | null
}

export async function listUsage(ctx: CallContext, query: UsageQuery): Promise<UsagePage> {
  const { json } = await request({ ...ctx, method: 'GET', path: '/v1/usage/sessions', query: { from: query.from, to: query.to, limit: query.limit, cursor: query.cursor, endUserId: query.endUserId } })
  const r = asRecord(json)
  const data = Array.isArray(r.data) ? r.data : []
  return {
    sessions: data.map((item) => {
      // Spec row (camelCase): sessionId, avatarId, avatarName, status, startedAt, endedAt,
      // activeSeconds, billedCreditMicros, metadata (the user tag lives in metadata.user_id), createdAt.
      const s = asRecord(item)
      const metadata = asRecord(s.metadata)
      return {
        sessionId: str(s.sessionId),
        avatarId: str(s.avatarId),
        avatarName: str(s.avatarName),
        status: str(s.status),
        startedAt: str(s.startedAt),
        endedAt: str(s.endedAt),
        activeSeconds: num(s.activeSeconds),
        billedCredits: microsToCredits(s.billedCreditMicros),
        endUserId: str(metadata.user_id ?? metadata.userId),
        metadata,
      }
    }),
    nextCursor: str(r.nextCursor),
    from: str(r.from),
    to: str(r.to),
  }
}

// ---------- avatars ----------

export interface Avatar {
  id: string | null
  displayName: string | null
  status: string | null
  idleVideoStatus: string | null
  sourceKind: string | null
  sourceAssetId: string | null
  modelId: string | null
  defaultVoiceId: string | null
  llm: { provider: string | null; model: string | null } | null
  error: string | null
  createdAt: string | null
  updatedAt: string | null
}

export function toAvatar(value: unknown): Avatar {
  const a = asRecord(value)
  const llm = typeof a.llm === 'object' && a.llm !== null ? asRecord(a.llm) : null
  return {
    id: str(a.id),
    displayName: str(a.displayName),
    status: str(a.status),
    idleVideoStatus: str(a.idleVideoStatus),
    sourceKind: str(a.sourceKind),
    sourceAssetId: str(a.sourceAssetId),
    modelId: str(a.modelId),
    defaultVoiceId: str(a.defaultVoiceId),
    llm: llm === null ? null : { provider: str(llm.provider), model: str(llm.model) },
    error: str(a.error),
    createdAt: str(a.createdAt),
    updatedAt: str(a.updatedAt),
  }
}

export async function listAvatars(ctx: CallContext): Promise<Avatar[]> {
  const { json } = await request({ ...ctx, method: 'GET', path: '/v1/avatars' })
  const data = asRecord(json).data
  return (Array.isArray(data) ? data : []).map(toAvatar)
}

export async function getAvatar(ctx: CallContext, avatarId: string): Promise<Avatar> {
  const id = assertId(avatarId, 'avatarId')
  const { json } = await request({ ...ctx, method: 'GET', path: '/v1/avatars/' + encodeURIComponent(id) })
  return toAvatar(json)
}

export interface CreateAvatarInput {
  displayName: string
  sourceAssetId: string
  motionPrompt?: string
  defaultVoiceId?: string
  voiceDescription?: string
  llm?: { provider?: string; model?: string }
  settings?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export async function createAvatar(ctx: CallContext, input: CreateAvatarInput): Promise<Avatar> {
  // Resource routes are camelCase; the nested `voice` object is snake_case on the wire.
  const body: Record<string, unknown> = { displayName: input.displayName, sourceKind: 'image', sourceAssetId: assertId(input.sourceAssetId, 'sourceAssetId') }
  if (input.motionPrompt !== undefined) body.motionPrompt = input.motionPrompt
  if (input.defaultVoiceId !== undefined) body.defaultVoiceId = input.defaultVoiceId
  if (input.voiceDescription !== undefined) body.voice = { auto_description: input.voiceDescription }
  if (input.llm !== undefined) body.llm = input.llm
  if (input.settings !== undefined) body.settings = input.settings
  if (input.metadata !== undefined) body.metadata = input.metadata
  const { json } = await request({ ...ctx, method: 'POST', path: '/v1/avatars', body })
  return toAvatar(json)
}

export interface UpdateAvatarInput {
  displayName?: string
  defaultVoiceId?: string
  llmProvider?: string
  llmModel?: string
  settings?: Record<string, unknown>
  metadata?: Record<string, unknown>
  persona?: Record<string, unknown>
  artDirection?: string
  stylePreset?: string
  anchorTimeMs?: number
  /** Portrait swap lane: exclusive of every other field except anchorTimeMs. */
  sourceAssetId?: string
}

export async function updateAvatar(ctx: CallContext, avatarId: string, input: UpdateAvatarInput): Promise<Avatar> {
  const id = assertId(avatarId, 'avatarId')
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) if (value !== undefined) body[key] = value
  if (Object.keys(body).length === 0) throw new Error('rta_avatar_update needs at least one field to change.')
  const { json } = await request({ ...ctx, method: 'PATCH', path: '/v1/avatars/' + encodeURIComponent(id), body })
  return toAvatar(json)
}

export async function deleteAvatar(ctx: CallContext, avatarId: string): Promise<void> {
  const id = assertId(avatarId, 'avatarId')
  await request({ ...ctx, method: 'DELETE', path: '/v1/avatars/' + encodeURIComponent(id) })
}

export interface Clip {
  clipId: string | null
  role: string | null
  status: string | null
  url: string | null
  whenHint: string | null
  /** `generated` or `uploaded` on the wire. */
  source: string | null
  motionPrompt: string | null
  uploadAssetId: string | null
  durationSeconds: number | null
  /** `{ code, message }` when the clip failed. */
  error: { code: string | null; message: string | null } | null
  poseCheck: unknown
}

export interface ClipLibrary {
  avatarId: string | null
  revision: number | null
  anchorVersion: number | null
  clipLibraryEligible: boolean | null
  clips: Clip[]
  plan?: Record<string, unknown>
}

function toClipLibrary(value: unknown, fallbackAvatarId: string): ClipLibrary {
  const r = asRecord(value)
  const data = Array.isArray(r.data) ? r.data : []
  return {
    avatarId: str(r.avatarId) ?? fallbackAvatarId,
    revision: num(r.revision),
    anchorVersion: num(r.anchorVersion),
    clipLibraryEligible: typeof r.clipLibraryEligible === 'boolean' ? r.clipLibraryEligible : null,
    clips: data.map((item) => {
      const c = asRecord(item)
      const err = typeof c.error === 'object' && c.error !== null ? asRecord(c.error) : null
      return {
        clipId: str(c.clipId),
        role: str(c.role),
        status: str(c.status),
        url: str(c.url),
        whenHint: str(c.whenHint),
        source: str(c.source),
        motionPrompt: str(c.motionPrompt),
        uploadAssetId: str(c.uploadAssetId),
        durationSeconds: num(c.durationSeconds),
        error: err === null ? (typeof c.error === 'string' ? { code: null, message: c.error } : null) : { code: str(err.code), message: str(err.message) },
        poseCheck: c.poseCheck ?? null,
      }
    }),
    ...(typeof r.plan === 'object' && r.plan !== null ? { plan: asRecord(r.plan) } : {}),
  }
}

export async function listClips(ctx: CallContext, avatarId: string): Promise<ClipLibrary> {
  const id = assertId(avatarId, 'avatarId')
  const { json } = await request({ ...ctx, method: 'GET', path: '/v1/avatars/' + encodeURIComponent(id) + '/clips' })
  return toClipLibrary(json, id)
}

export interface ClipDeclaration {
  clipId: string
  role: string
  whenHint?: string
  source: { motionPrompt: string } | { assetId: string }
  durationSeconds?: number
  reroll?: boolean
}

export async function setClipLibrary(ctx: CallContext, avatarId: string, clips: ClipDeclaration[], expectedRevision: number | undefined, idempotencyKey: string): Promise<ClipLibrary> {
  const id = assertId(avatarId, 'avatarId')
  const body: Record<string, unknown> = { clips }
  if (expectedRevision !== undefined) body.expectedRevision = expectedRevision
  const { json } = await request({ ...ctx, method: 'PUT', path: '/v1/avatars/' + encodeURIComponent(id) + '/clips', body, idempotencyKey })
  return toClipLibrary(json, id)
}

export interface LoopResult {
  avatarId: string | null
  loopStatus: string | null
  motionPrompt: string | null
  servingUrl: string | null
}

export async function setLoop(ctx: CallContext, avatarId: string, motionPrompt: string, idempotencyKey: string): Promise<LoopResult> {
  const id = assertId(avatarId, 'avatarId')
  const { json } = await request({ ...ctx, method: 'PUT', path: '/v1/avatars/' + encodeURIComponent(id) + '/loop', body: { motionPrompt }, idempotencyKey })
  const r = asRecord(json)
  return { avatarId: str(r.avatarId) ?? id, loopStatus: str(r.loopStatus), motionPrompt: str(r.motionPrompt), servingUrl: str(r.servingUrl) }
}

// ---------- assets ----------

export interface Asset {
  id: string | null
  kind: string | null
  status: string | null
  contentType: string | null
  sizeBytes: number | null
  publicUrl: string | null
  createdAt: string | null
}

export function toAsset(value: unknown): Asset {
  const a = asRecord(value)
  return { id: str(a.id), kind: str(a.kind), status: str(a.status), contentType: str(a.contentType), sizeBytes: num(a.sizeBytes), publicUrl: str(a.publicUrl), createdAt: str(a.createdAt) }
}

export async function listAssets(ctx: CallContext): Promise<Asset[]> {
  const { json } = await request({ ...ctx, method: 'GET', path: '/v1/assets' })
  const data = asRecord(json).data
  return (Array.isArray(data) ? data : []).map(toAsset)
}

export interface RemoteAssetInput {
  kind: 'image' | 'video' | 'audio'
  remoteUrl: string
  originalFilename?: string
  metadata?: Record<string, unknown>
}

export async function createRemoteAsset(ctx: CallContext, input: RemoteAssetInput): Promise<Asset> {
  const body: Record<string, unknown> = { kind: input.kind, remoteUrl: assertHttpUrl(input.remoteUrl, 'remoteUrl') }
  if (input.originalFilename !== undefined) body.originalFilename = input.originalFilename
  if (input.metadata !== undefined) body.metadata = input.metadata
  const { json } = await request({ ...ctx, method: 'POST', path: '/v1/assets/remote', body })
  return toAsset(json)
}

// ---------- sessions (realtime routes: snake_case on the wire) ----------

export interface MintInput {
  avatarId: string
  mode?: 'avatar' | 'voice'
  instructions?: string
  initialContext?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  maxSessionSeconds: number
  /** Plain voice override → wire field `voice_id` (string). */
  voiceId?: string
  /** Full voice object → wire field `voice` ({ provider, voice_id, … }). */
  voice?: Record<string, unknown>
  clientMetadata?: Record<string, string>
  transcriptWebhook?: { url: string; secret: string }
}

export interface SessionGrant {
  status: 'ready'
  sessionId: string | null
  roomName: string | null
  livekitUrl: string | null
  participantIdentity: string | null
  participantToken: string | null
  reservationExpiresAt: string | null
  joinTimeoutSeconds: number | null
  idleTimeoutSeconds: number | null
  maxSessionSeconds: number | null
}

export interface QueuedGrant {
  status: 'queued'
  queueTicketId: string | null
  queuePosition: number | null
  queueSize: number
  recommendedRetryMs: number
}

/** Mint a session. A capacity-full 429 is returned as a queued result, not thrown. */
export async function mintSession(ctx: CallContext, input: MintInput): Promise<SessionGrant | QueuedGrant> {
  const body: Record<string, unknown> = { avatar_id: assertId(input.avatarId, 'avatarId'), max_session_seconds: input.maxSessionSeconds }
  if (input.mode !== undefined) body.mode = input.mode
  if (input.instructions !== undefined) body.instructions = input.instructions
  if (input.initialContext !== undefined) body.initial_context = input.initialContext
  if (input.voiceId !== undefined) body.voice_id = input.voiceId
  if (input.voice !== undefined) body.voice = input.voice
  if (input.clientMetadata !== undefined) body.client_metadata = input.clientMetadata
  if (input.transcriptWebhook !== undefined) body.transcript_webhook = input.transcriptWebhook
  try {
    const { json } = await request({ ...ctx, method: 'POST', path: '/v1/realtime/livekit/session', body })
    const r = asRecord(json)
    if (typeof r.session_id !== 'string' || typeof r.livekit_url !== 'string') {
      throw new RtaApiError('http', 'the session grant is missing session_id / livekit_url; nothing to join')
    }
    return {
      status: 'ready',
      sessionId: str(r.session_id),
      roomName: str(r.room_name),
      livekitUrl: str(r.livekit_url),
      participantIdentity: str(r.participant_identity),
      participantToken: str(r.participant_token),
      reservationExpiresAt: str(r.reservation_expires_at),
      joinTimeoutSeconds: num(r.join_timeout_seconds),
      idleTimeoutSeconds: num(r.idle_timeout_seconds),
      maxSessionSeconds: num(r.max_session_seconds),
    }
  } catch (error) {
    if (error instanceof Error && 'kind' in error && error.kind === 'queue' && 'queue' in error && typeof error.queue === 'object' && error.queue !== null) {
      const q = error.queue as { queueSize: number; recommendedRetryMs: number; queueTicketId?: string; queuePosition?: number }
      return { status: 'queued', queueTicketId: q.queueTicketId ?? null, queuePosition: q.queuePosition ?? null, queueSize: q.queueSize, recommendedRetryMs: q.recommendedRetryMs }
    }
    throw error
  }
}

export const RELEASE_REASONS = ['page_hide', 'disconnected', 'superseded', 'unmount', 'manual', 'idle_timeout'] as const
export type ReleaseReason = (typeof RELEASE_REASONS)[number]

export async function releaseSession(ctx: CallContext, ids: { sessionId?: string; queueTicketId?: string }, reason: ReleaseReason): Promise<void> {
  const body: Record<string, unknown> = { reason }
  if (ids.sessionId !== undefined) body.session_id = assertId(ids.sessionId, 'sessionId')
  if (ids.queueTicketId !== undefined) body.queue_ticket_id = assertId(ids.queueTicketId, 'queueTicketId')
  if (body.session_id === undefined && body.queue_ticket_id === undefined) throw new Error('rta_session_release needs sessionId or queueTicketId.')
  await request({ ...ctx, method: 'POST', path: '/v1/realtime/livekit/session/release', body, retry: true }) // idempotent by contract
}
