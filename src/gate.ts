/**
 * The write-approval gate: which rta_* tools are reads, free writes, or
 * credit-spending writes, and what the `tools/pre-execute` listener answers.
 *
 * | Tier          | readOnly | writeApproval:true | writeApproval:false |
 * |---------------|----------|--------------------|---------------------|
 * | read          | allow    | allow              | allow               |
 * | write-free    | deny     | ask                | allow               |
 * | write-costly  | deny     | ask                | ask (always)        |
 *
 * @module dsh-realtimeavatar/gate
 */
import type { ResolvedRtaConfig } from './config.js'
import { redactSecrets } from './redact.js'

export type ToolTier = 'read' | 'write-free' | 'write-costly'

/** Every rta_* tool and its tier. Reads include the free, idempotent session release. */
export const TOOL_TIERS = {
  rta_status: 'read',
  rta_balance: 'read',
  rta_capacity: 'read',
  rta_avatars: 'read',
  rta_avatar: 'read',
  rta_clips: 'read',
  rta_assets: 'read',
  rta_usage: 'read',
  rta_docs: 'read',
  rta_quickstart: 'read',
  rta_session_release: 'read',
  rta_asset_remote: 'write-free',
  rta_avatar_update: 'write-free',
  rta_avatar_delete: 'write-free',
  rta_avatar_create: 'write-costly',
  rta_loop_set: 'write-costly',
  rta_clips_set: 'write-costly',
  rta_session_mint: 'write-costly',
} as const satisfies Record<string, ToolTier>

export type RtaToolName = keyof typeof TOOL_TIERS
export const TOOL_NAMES = Object.keys(TOOL_TIERS) as RtaToolName[]

export function tierOf(name: string): ToolTier | undefined {
  return Object.prototype.hasOwnProperty.call(TOOL_TIERS, name) ? TOOL_TIERS[name as RtaToolName] : undefined
}

export function isWriteTool(name: string): boolean {
  const tier = tierOf(name)
  return tier === 'write-free' || tier === 'write-costly'
}

/** Verdict a pre-execute listener returns (or it calls next() to waterfall). */
export type Verdict = { kind: 'allow' | 'deny' | 'ask'; reason?: string }

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function preview(value: unknown, max = 200): string {
  let text: string
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value) ?? ''
    } catch {
      text = '(unserialisable)'
    }
  }
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return redactSecrets(collapsed.length > max ? collapsed.slice(0, max) + '…' : collapsed)
}

/** First few argument names, so a reason stays short no matter how many keys were sent. */
function fieldList(args: Record<string, unknown>, skip: string): string {
  const keys = Object.keys(args).filter((k) => k !== skip)
  const shown = keys.slice(0, 10).map((k) => k.slice(0, 40))
  return shown.join(', ') + (keys.length > 10 ? ' …(+' + (keys.length - 10) + ' more)' : '')
}

/** Human-readable reason for an approval prompt, redacted, ≤ ~300 chars. */
export function describeWrite(name: string, args: unknown): string {
  const a = asRecord(args)
  switch (name) {
    case 'rta_avatar_create':
      return 'rta_avatar_create spends credits (one generation) and needs approval — displayName ' + preview(a.displayName, 60) + ', sourceAssetId ' + preview(a.sourceAssetId, 60) + (typeof a.motionPrompt === 'string' ? ', motionPrompt (' + a.motionPrompt.length + ' chars)' : '')
    case 'rta_loop_set':
      return 'rta_loop_set re-renders the resting loop (billed as one generation) — avatar ' + preview(a.avatarId, 60) + ', motionPrompt ' + preview(a.motionPrompt, 120)
    case 'rta_clips_set':
      return 'rta_clips_set declares the clip library (new clips render; may spend credits) — avatar ' + preview(a.avatarId, 60) + ', ' + (Array.isArray(a.clips) ? a.clips.length : 0) + ' clip(s)'
    case 'rta_session_mint':
      return 'rta_session_mint reserves a call slot and bills once a client joins — avatar ' + preview(a.avatarId, 60) + ', mode ' + preview(a.mode ?? 'avatar', 10) + (typeof a.maxSessionSeconds === 'number' ? ', max ' + a.maxSessionSeconds + ' s' : '')
    case 'rta_asset_remote':
      return 'rta_asset_remote registers a remote file as an asset — ' + preview(a.kind, 10) + ' from ' + preview(a.remoteUrl, 120)
    case 'rta_avatar_update':
      return 'rta_avatar_update changes avatar ' + preview(a.avatarId, 60) + ' — fields: ' + fieldList(a, 'avatarId')
    case 'rta_avatar_delete':
      return 'rta_avatar_delete soft-deletes avatar ' + preview(a.avatarId, 60) + ' (it disappears from every read)'
    default:
      return name + ' needs approval — ' + preview(args, 160)
  }
}

/** Decide for one execution. Returns null when the tool is not ours (waterfall). */
export function decide(cfg: ResolvedRtaConfig, name: string, args: unknown): Verdict | null {
  const tier = tierOf(name)
  if (tier === undefined) return null
  if (tier === 'read') return { kind: 'allow' }
  if (cfg.readOnly) return { kind: 'deny', reason: 'dsh-realtimeavatar is in readOnly mode; ' + name + ' is disabled (set readOnly:false in the plugin config to allow writes).' }
  if (tier === 'write-free' && !cfg.writeApproval) return { kind: 'allow' }
  return { kind: 'ask', reason: describeWrite(name, args) }
}
