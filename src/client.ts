/**
 * Stateless HTTP client for the public Realtime Avatar API.
 *
 * - The key is resolved per request by the caller and lives only in the
 *   request closure; every error path is redacted before it can surface.
 * - The caller's AbortSignal (the harness's cancellation / timeout signal) is
 *   fused with a per-request timer that also covers the body read.
 * - Errors are mapped to a coded {@link RtaApiError} whose `kind` lets tools
 *   and the model react correctly (the three different 429s in particular).
 *
 * @module dsh-realtimeavatar/client
 */
import { API_BASE, USER_AGENT } from './config.js'
import { redactSecrets } from './redact.js'

export type RtaErrorKind =
  | 'auth'
  | 'scope'
  | 'billing'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'validation'
  | 'concurrency'
  | 'queue'
  | 'rate_limit'
  | 'upstream'
  | 'unavailable'
  | 'http'
  | 'network'
  | 'timeout'
  | 'cancelled'

/** A failed API call. `message` is redacted and never carries the raw body or headers. */
export class RtaApiError extends Error {
  constructor(
    readonly kind: RtaErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly retryable?: boolean,
    readonly billingUrl?: string,
    /** Queue contract on a capacity-full mint (429 without a code). */
    readonly queue?: { queueSize: number; recommendedRetryMs: number; queueTicketId?: string; queuePosition?: number },
  ) {
    super(message)
    this.name = 'RtaApiError'
  }
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Path relative to the API base, e.g. `/v1/avatars`. */
  path: string
  query?: Record<string, string | number | undefined>
  body?: unknown
  idempotencyKey?: string
  signal?: AbortSignal
  timeoutMs: number
  /** Bearer key for this request only. */
  apiKey: string
  /**
   * Retry once after a transient failure (429 rate limit, 502, 503, network
   * error), honouring Retry-After / recommended_retry_ms and the overall
   * timeout. Defaults to true for GET and false otherwise; idempotent POSTs
   * (session release) opt in.
   */
  retry?: boolean
}

export interface ApiResponse {
  status: number
  /** Parsed JSON body, or null for 204 / empty bodies. */
  json: unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** Read `aborted` through a call so TypeScript does not narrow the property across awaits. */
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

/** Cap upstream text so a huge error body cannot become a huge message; keep the string well-formed. */
function clip(text: string, max: number): string {
  const cut = text.length > max ? text.slice(0, max) + '…' : text
  return typeof cut.toWellFormed === 'function' ? cut.toWellFormed() : cut
}

/** Build the error for a non-2xx response from the parsed body (never the raw text). */
export function classifyFailure(status: number, body: unknown, known: readonly string[]): RtaApiError {
  const rec = asRecord(body)
  // Every field that reaches a message is untrusted upstream text: redact and cap it.
  const raw = typeof rec.error === 'string' ? rec.error : typeof rec.message === 'string' ? rec.message : 'request failed'
  const text = clip(redactSecrets(raw, known), 500)
  const code = typeof rec.code === 'string' ? redactSecrets(rec.code, known).slice(0, 80) : undefined
  const retryable = typeof rec.retryable === 'boolean' ? rec.retryable : undefined
  const billingUrl = typeof rec.billingUrl === 'string' ? clip(redactSecrets(rec.billingUrl, known), 500) : undefined
  const suffix = ' (HTTP ' + status + (code !== undefined ? ', ' + code : '') + ')'
  switch (status) {
    case 401:
      return new RtaApiError('auth', 'the API key was rejected: missing, malformed, revoked or expired' + suffix + '. Check the key and its environment tag; run /rta status.', status, code, retryable)
    case 402:
      return new RtaApiError('billing', text + suffix + (billingUrl !== undefined ? '. Top up at ' + billingUrl : '. Top up or raise the per-key spend limit.'), status, code, retryable, billingUrl)
    case 403: {
      if (code === 'clip_library_not_enabled') return new RtaApiError('scope', text + suffix + '. The clip library is a per-workspace rollout gate; contact support to opt in.', status, code, retryable)
      if (/not active/i.test(text)) return new RtaApiError('scope', text + suffix + '. The workspace is not active; it has to be reactivated in the dashboard (no key change will help).', status, code, retryable)
      return new RtaApiError('scope', text + suffix + '. The key lacks the scope for this operation: create a key with that scope in the dashboard (do not widen to *).', status, code, retryable)
    }
    case 404:
      return new RtaApiError('not_found', text + suffix + '. Check the id; this is a wrong or deleted id for your workspace, not a permission problem.', status, code, retryable)
    case 409: {
      const revision = typeof rec.revision === 'number' ? rec.revision : undefined
      return new RtaApiError('conflict', text + suffix + (revision !== undefined ? '. The current revision is ' + revision + '; retry with expectedRevision ' + revision + '.' : ''), status, code, retryable)
    }
    case 413:
      return new RtaApiError('too_large', text + suffix + '. Send media by URL, not inline.', status, code, retryable)
    case 422:
      return new RtaApiError('validation', text + suffix + '. The wire schemas are strict: check field names and casing.', status, code, retryable)
    case 429: {
      if (code === 'concurrency_limit_reached') {
        return new RtaApiError('concurrency', 'the plan concurrency ceiling is reached; no queue will drain it — close a session or upgrade (Sandbox allows one stream)' + suffix, status, code, retryable)
      }
      const queueSize = typeof rec.queue_size === 'number' ? rec.queue_size : undefined
      const retryMs = typeof rec.recommended_retry_ms === 'number' ? rec.recommended_retry_ms : undefined
      if (queueSize !== undefined && retryMs !== undefined) {
        return new RtaApiError('queue', 'capacity is full; you hold a place in line' + suffix, status, code, true, undefined, {
          queueSize,
          recommendedRetryMs: retryMs,
          ...(typeof rec.queue_ticket_id === 'string' ? { queueTicketId: rec.queue_ticket_id } : {}),
          ...(typeof rec.queue_position === 'number' ? { queuePosition: rec.queue_position } : {}),
        })
      }
      return new RtaApiError('rate_limit', 'per-key rate limit (120 requests per 60 seconds); back off before retrying' + suffix, status, code, true)
    }
    case 502:
      return new RtaApiError('upstream', text + suffix + '. An upstream generation or render failed; retry.', status, code, retryable ?? true)
    case 503:
      return new RtaApiError('unavailable', text + suffix + '. A dependency is unavailable and nothing was written; retry with backoff.', status, code, retryable ?? true)
    default:
      return new RtaApiError('http', text + suffix, status, code, retryable)
  }
}

/** Longest wait a retry honours; a longer Retry-After is handed back to the caller as the error. */
export const MAX_RETRY_DELAY_MS = 5000
const DEFAULT_RETRY_DELAY_MS = 1000
const NETWORK_RETRY_DELAY_MS = 250
/** A retry needs at least this much of the timeout left to be worth issuing. */
const MIN_ATTEMPT_MS = 500
const RETRY_KINDS: ReadonlySet<RtaApiError['kind']> = new Set(['rate_limit', 'upstream', 'unavailable', 'network'])

/**
 * How long a retry should wait: `Retry-After` (delay-seconds or HTTP-date),
 * else the body's `recommended_retry_ms`, else one second.
 */
export function retryDelayMs(retryAfter: string | null, body: unknown, now: number = Date.now()): number {
  if (retryAfter !== null) {
    const value = retryAfter.trim()
    if (/^\d+$/.test(value)) return Number(value) * 1000
    const at = Date.parse(value)
    if (!Number.isNaN(at)) return Math.max(0, at - now)
  }
  const rec = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  if (typeof rec.recommended_retry_ms === 'number' && rec.recommended_retry_ms >= 0) return rec.recommended_retry_ms
  return DEFAULT_RETRY_DELAY_MS
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signalAborted(signal)) {
      reject(new RtaApiError('cancelled', 'request cancelled by the caller'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(handle)
      reject(new RtaApiError('cancelled', 'request cancelled by the caller'))
    }
    const handle = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

interface Attempt {
  status: number
  text: string
  retryAfter: string | null
}

/**
 * Perform one request, retrying once after a transient failure when the
 * method is idempotent. The key is used for the Authorization header only.
 */
export async function request(options: RequestOptions): Promise<ApiResponse> {
  const { apiKey, signal: caller } = options
  const known = [apiKey]
  if (signalAborted(caller)) throw new RtaApiError('cancelled', 'request cancelled before it started')
  const deadline = Date.now() + options.timeoutMs
  const retryAllowed = options.retry ?? options.method === 'GET'
  for (let attempt = 0; ; attempt += 1) {
    let failure: RtaApiError
    let retryAfter: string | null = null
    let json: unknown = null
    try {
      const outcome = await attemptOnce(options, known, deadline - Date.now())
      retryAfter = outcome.retryAfter
      json = parseBody(outcome.status, outcome.text)
      if (outcome.status >= 200 && outcome.status < 300) return { status: outcome.status, json }
      failure = classifyFailure(outcome.status, json, known)
    } catch (error) {
      if (!(error instanceof RtaApiError)) throw error
      failure = error
    }
    if (attempt === 0 && retryAllowed && RETRY_KINDS.has(failure.kind)) {
      const delay = failure.kind === 'network' ? NETWORK_RETRY_DELAY_MS : retryDelayMs(retryAfter, json)
      if (delay <= MAX_RETRY_DELAY_MS && Date.now() + delay + MIN_ATTEMPT_MS <= deadline) {
        await sleep(delay, caller)
        continue
      }
    }
    if (attempt > 0) failure.message += ' (retried once)'
    throw failure
  }
}

function parseBody(status: number, text: string): unknown {
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    if (status >= 200 && status < 300) throw new RtaApiError('http', 'the API returned a non-JSON body (HTTP ' + status + ')', status)
    return { error: 'non-JSON error body' }
  }
}

async function attemptOnce(options: RequestOptions, known: readonly string[], timeoutMs: number): Promise<Attempt> {
  const { apiKey, signal: caller } = options
  const url = new URL(API_BASE + options.path)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
  }
  const timer = new AbortController()
  const handle = setTimeout(() => timer.abort(), Math.max(0, timeoutMs))
  const signal = caller !== undefined ? AbortSignal.any([timer.signal, caller]) : timer.signal
  const headers: Record<string, string> = {
    Authorization: 'Bearer ' + apiKey,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey
  let status = 0
  let text = ''
  let retryAfter: string | null = null
  try {
    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal,
      redirect: 'error',
    })
    status = response.status
    retryAfter = response.headers.get('retry-after')
    text = await response.text() // the timer stays armed through the body read
  } catch (error) {
    if (signalAborted(caller)) throw new RtaApiError('cancelled', 'request cancelled by the caller')
    if (timer.signal.aborted) throw new RtaApiError('timeout', 'request timed out after ' + options.timeoutMs + 'ms')
    const cause = error instanceof Error && typeof error.cause === 'object' && error.cause !== null ? (error.cause as Record<string, unknown>) : undefined
    const code = cause !== undefined && typeof cause.code === 'string' ? cause.code : undefined
    const causeText = cause !== undefined && typeof cause.message === 'string' ? ' (' + clip(redactSecrets(cause.message, known), 200) + ')' : ''
    const raw = error instanceof Error ? error.message : 'network failure'
    throw new RtaApiError('network', 'network error' + (code !== undefined ? ' (' + code + ')' : '') + ': ' + clip(redactSecrets(raw, known), 300) + causeText)
  } finally {
    clearTimeout(handle)
  }
  return { status, text, retryAfter }
}
