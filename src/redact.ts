/**
 * Secret redaction. Applied to every error message, rendered tool output,
 * approval-gate reason and command result so an API key can never reach the
 * model, the session log or the screen.
 *
 * @module dsh-realtimeavatar/redact
 */

/** A Realtime Avatar key: `tic_live_…` / `tic_test_…` with at least a few chars after the tag. */
const KEY_TOKEN_RE = /tic_(live|test)_[A-Za-z0-9_-]{4,}/g
/** Any bearer credential echoed by a proxy or upstream: the token68 alphabet (RFC 6750) plus `<>` so an already-redacted placeholder stays a single token and trailing punctuation survives. */
const BEARER_RE = /Bearer\s+[A-Za-z0-9\-._~+/<>]+=*/gi

/**
 * Redact secrets from free text: every exact `known` value first, then any
 * key-shaped token and any bearer header value. Idempotent.
 */
export function redactSecrets(text: string, known: readonly string[] = []): string {
  let out = text
  for (const value of known) {
    if (value !== '') out = out.split(value).join('<redacted>')
  }
  out = out.replace(KEY_TOKEN_RE, 'tic_$1_<redacted>')
  out = out.replace(BEARER_RE, 'Bearer <redacted>')
  return out
}

/** Message of any thrown value, redacted. */
export function safeMessage(error: unknown, known: readonly string[] = []): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'unexpected failure'
  return redactSecrets(raw, known)
}
