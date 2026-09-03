/**
 * dsh-realtimeavatar config: the credential reference for the API key, the
 * write posture, the session cap and timeouts.
 *
 * The API key itself is NEVER part of the config — only the NAME of the
 * credential reference (an environment-variable-style name). The value is
 * resolved per call from the harness credential store or the launch
 * environment (see {@link ../credentials}).
 *
 * @module dsh-realtimeavatar/config
 */

/** Public API base (production). Every REST path below is relative to this. */
export const API_BASE = 'https://realtimeavatar.ai/api'
/** Public site base for docs / llms.txt / openapi.json. */
export const SITE_BASE = 'https://realtimeavatar.ai'
/** Plugin version as sent in the User-Agent header (kept in sync with package.json by a test). */
export const PLUGIN_VERSION = '0.1.1'
export const USER_AGENT = 'dsh-realtimeavatar/' + PLUGIN_VERSION
/** Default credential reference (the public env var name documented by realtimeavatar.ai). */
export const DEFAULT_API_KEY_ENV = 'REALTIME_AVATAR_API_KEY'

/** Raw plugin config (as authored in cordis.patch.yml). */
export interface RtaConfig {
  apiKeyEnv?: string
  readOnly?: boolean
  writeApproval?: boolean
  maxSessionSeconds?: number
  requestTimeoutMs?: number
  docsTimeoutMs?: number
  docsMaxChars?: number
}

/** Fully resolved, validated config. */
export interface ResolvedRtaConfig {
  apiKeyEnv: string
  readOnly: boolean
  writeApproval: boolean
  maxSessionSeconds: number
  requestTimeoutMs: number
  docsTimeoutMs: number
  docsMaxChars: number
}

/** Credential references are env-var-style names (matches the harness credential store's grammar). */
const REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function clampInt(value: unknown, label: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(label + ' must be a positive number.')
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Parse and validate config. Writes are enabled by default but approval-gated
 * (credit-spending tools always ask); `readOnly:true` disables every write tool.
 */
export function resolveConfig(config: RtaConfig | undefined | null): ResolvedRtaConfig {
  const cfg = config ?? {}
  let apiKeyEnv = DEFAULT_API_KEY_ENV
  if (cfg.apiKeyEnv !== undefined) {
    if (typeof cfg.apiKeyEnv !== 'string' || !REF_RE.test(cfg.apiKeyEnv.trim())) {
      throw new Error('apiKeyEnv must be an environment-variable-style name (letters, digits, underscore).')
    }
    if (/^tic_/i.test(cfg.apiKeyEnv.trim())) {
      // The value must NAME the credential, never hold it; never echo it either.
      throw new Error('apiKeyEnv looks like an API key. It must name the credential reference (e.g. REALTIME_AVATAR_API_KEY); store the key itself with /rta key or in the environment.')
    }
    apiKeyEnv = cfg.apiKeyEnv.trim()
  }
  if (cfg.readOnly !== undefined && typeof cfg.readOnly !== 'boolean') throw new Error('readOnly must be a boolean.')
  if (cfg.writeApproval !== undefined && typeof cfg.writeApproval !== 'boolean') throw new Error('writeApproval must be a boolean.')
  return {
    apiKeyEnv,
    readOnly: cfg.readOnly === true,
    writeApproval: cfg.writeApproval !== false,
    maxSessionSeconds: clampInt(cfg.maxSessionSeconds, 'maxSessionSeconds', 1, 1800, 300),
    requestTimeoutMs: clampInt(cfg.requestTimeoutMs, 'requestTimeoutMs', 5000, 120000, 30000),
    docsTimeoutMs: clampInt(cfg.docsTimeoutMs, 'docsTimeoutMs', 5000, 120000, 20000),
    docsMaxChars: clampInt(cfg.docsMaxChars, 'docsMaxChars', 2000, 200000, 24000),
  }
}
