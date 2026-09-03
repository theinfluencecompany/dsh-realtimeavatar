/**
 * API key resolution and storage through the harness credential store.
 *
 * The plugin config carries a credential REFERENCE (an env-var-style name),
 * never the secret. Per operation the value is resolved from dsh's optional
 * `credentials` service (which layers the launch environment, the user's
 * credential file and .env files) or, when the service is absent, from the
 * launch environment. Nothing is resolved at boot and the value is never
 * stored on any object beyond the request closure.
 *
 * @module dsh-realtimeavatar/credentials
 */

/** The subset of dsh's credential service this plugin uses (all optional at runtime). */
export interface CredentialService {
  resolve(ref: string): Promise<{ value: string; source?: string } | undefined>
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable?: boolean }>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

/** Where the key came from, for status output (never the value). */
export interface KeyPosture {
  ref: string
  configured: boolean
  source: string
  environment: 'live' | 'test' | 'unknown' | 'none'
}

export type KeyErrorCode = 'RTA_KEY_MISSING' | 'RTA_KEY_INVALID' | 'RTA_KEY_SHADOWED' | 'RTA_KEY_STORE_UNAVAILABLE'

/** A coded, actionable key error. Messages never contain the key. */
export class KeyError extends Error {
  constructor(
    readonly code: KeyErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'KeyError'
  }
}

/** `tic_live_…` / `tic_test_…`, URL-safe alphabet (the same alphabet the redactor recognises), 8+ chars after the tag. */
const KEY_FORMAT_RE = /^tic_(live|test)_[A-Za-z0-9_-]{8,}$/

/** Validate a key's shape without ever echoing it. Returns the trimmed key. */
export function validateKeyFormat(value: string, ref: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new KeyError('RTA_KEY_MISSING', 'the value behind ' + ref + ' is empty. Run /rta setup.')
  if (trimmed.length > 512 || !KEY_FORMAT_RE.test(trimmed)) {
    throw new KeyError('RTA_KEY_INVALID', 'the value behind ' + ref + ' is not a Realtime Avatar API key (expected tic_live_… or tic_test_… with no whitespace). Create one in the dashboard and run /rta setup.')
  }
  return trimmed
}

/** Environment tag from the key prefix. */
export function keyEnvironment(value: string): 'live' | 'test' | 'unknown' {
  if (value.startsWith('tic_live_')) return 'live'
  if (value.startsWith('tic_test_')) return 'test'
  return 'unknown'
}

/** Access to the optional credential service plus the launch environment. */
export interface KeySource {
  credentials?: CredentialService
  env: NodeJS.ProcessEnv
}

/** Resolve and validate the key for one operation. Throws a coded {@link KeyError}. */
export async function resolveKey(source: KeySource, ref: string): Promise<string> {
  let value: string | undefined
  if (source.credentials !== undefined) {
    value = (await source.credentials.resolve(ref))?.value
  } else {
    const ambient = source.env[ref]
    value = typeof ambient === 'string' ? ambient : undefined
  }
  if (value === undefined || value.trim() === '') {
    throw new KeyError('RTA_KEY_MISSING', 'no Realtime Avatar API key behind ' + ref + '. In the web UI run /rta setup, then /rta key <tic_…>; headless, export ' + ref + ' in the shell that launches dsh.')
  }
  return validateKeyFormat(value, ref)
}

/** Key posture for status output: configured?, source, environment tag. Never the value. */
export async function describeKey(source: KeySource, ref: string): Promise<KeyPosture> {
  if (source.credentials !== undefined) {
    const info = await source.credentials.describe(ref)
    if (!info.configured) return { ref, configured: false, source: 'none', environment: 'none' }
    const hit = await source.credentials.resolve(ref)
    const environment = hit === undefined ? 'unknown' : keyEnvironment(hit.value.trim())
    return { ref, configured: true, source: info.source ?? hit?.source ?? 'credentials', environment }
  }
  const ambient = source.env[ref]
  if (typeof ambient !== 'string' || ambient.trim() === '') return { ref, configured: false, source: 'none', environment: 'none' }
  return { ref, configured: true, source: 'process-env', environment: keyEnvironment(ambient.trim()) }
}

/** Store a key through the credential service. Throws a coded error when that is impossible. */
export async function storeKey(source: KeySource, ref: string, value: string): Promise<{ environment: 'live' | 'test' | 'unknown'; length: number }> {
  const key = validateKeyFormat(value, ref)
  if (source.credentials === undefined) {
    throw new KeyError('RTA_KEY_STORE_UNAVAILABLE', 'this profile has no credential store; export ' + ref + ' in the shell that launches dsh and restart.')
  }
  const info = await source.credentials.describe(ref)
  if (info.configured && info.source === 'env') {
    throw new KeyError('RTA_KEY_SHADOWED', ref + ' is supplied read-only by the launching environment; unset it there to store a different key, or keep using it.')
  }
  try {
    await source.credentials.set(ref, key)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new KeyError('RTA_KEY_STORE_UNAVAILABLE', 'the credential store refused to save ' + ref + ': ' + reason.split(key).join('<redacted>'))
  }
  return { environment: keyEnvironment(key), length: key.length }
}

/**
 * Remove the stored key. Only the credential file is writable: a value from the
 * launching environment or a .env file cannot be edited from here, so the
 * result reports what still resolves afterwards.
 */
export async function clearKey(source: KeySource, ref: string): Promise<{ removed: boolean; residual: KeyPosture }> {
  if (source.credentials === undefined) {
    throw new KeyError('RTA_KEY_STORE_UNAVAILABLE', 'this profile has no credential store; unset ' + ref + ' in the shell that launches dsh instead.')
  }
  const before = await source.credentials.describe(ref)
  if (before.configured && before.source === 'env') {
    throw new KeyError('RTA_KEY_SHADOWED', ref + ' comes from the launching environment and cannot be cleared from here.')
  }
  const removed = before.configured && (before.source === undefined || before.source === 'file' || before.source === 'credentials')
  try {
    await source.credentials.unset(ref)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new KeyError('RTA_KEY_STORE_UNAVAILABLE', 'the credential store refused to remove ' + ref + ': ' + reason)
  }
  return { removed, residual: await describeKey(source, ref) }
}
