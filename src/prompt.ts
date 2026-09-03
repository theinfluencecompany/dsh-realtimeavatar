/**
 * The short system-prompt section that tells the model the Realtime Avatar
 * tools and skills exist and how the key is handled. The documentation
 * itself never goes in the prompt — it lives in the skills and behind
 * rta_docs.
 *
 * @module dsh-realtimeavatar/prompt
 */
import type { ResolvedRtaConfig } from './config.js'
import { EXAMPLE_AVATAR_ID, SDK_PACKAGE, SKILL_NAMES, URLS } from './facts.js'

export interface PromptSection {
  name: string
  order: number
  text: string
}

export const PROMPT_SECTION_NAME = 'tool:rta'
/** Tool guidance band is 100–199; 115 is taken by first-party sections (tool:workflow, tool:cordis), 116 by tool:ralph — 118 keeps the placement deterministic. */
export const PROMPT_SECTION_ORDER = 118

export function buildPromptSection(cfg: ResolvedRtaConfig): PromptSection {
  const text = [
    'rta_* tools (Realtime Avatar) cover live AI avatar voice/video calls, the `' + SDK_PACKAGE + '` SDK, avatars, credits, REST API at ' + URLS.apiBase + '.',
    'Skills ' + SKILL_NAMES.join(', ') + ' snapshot the public docs: load one before designing an integration; rta_docs has a page\'s current text.',
    'The API key is harness-held as credential ' + cfg.apiKeyEnv + ', injected per call: never ask for it in chat, print it, or put it in client code (no NEXT_PUBLIC_/VITE_ names); it stays server-side in the SDK route adapters. On RTA_KEY_MISSING tell the user to run /rta setup in the web UI (headless: export ' + cfg.apiKeyEnv + ' before launching dsh).',
    EXAMPLE_AVATAR_ID + ' is a public avatar any key can call.',
    'Credits go per second on air and per generation: rta_avatar_create, rta_loop_set, rta_clips_set and rta_session_mint ask for approval' + (cfg.readOnly ? ' (currently disabled: readOnly)' : '') + '; release minted sessions via rta_session_release.',
  ].join(' ')
  return { name: PROMPT_SECTION_NAME, order: PROMPT_SECTION_ORDER, text }
}
