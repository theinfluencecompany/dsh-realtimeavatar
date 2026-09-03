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
    'Realtime Avatar (realtimeavatar.ai) tools are installed as rta_*: use them for live AI avatar voice/video calls, the `' + SDK_PACKAGE + '` npm SDK, avatars, credits and the REST API at ' + URLS.apiBase + '.',
    'Skills hold a snapshot of the public docs — ' + SKILL_NAMES.join(', ') + ' — load the relevant one before designing an integration; for the current text of any page call rta_docs.',
    "The developer's API key is held by the harness under the credential reference " + cfg.apiKeyEnv + ' and injected per call: never ask the user to paste it into chat, never print it, and never put it in client code (no NEXT_PUBLIC_/VITE_ names) — it stays on the server behind the SDK route adapters. If a tool reports RTA_KEY_MISSING, tell the user to run /rta setup in the web UI (or, headless, to export ' + cfg.apiKeyEnv + ' before launching dsh).',
    EXAMPLE_AVATAR_ID + ' is a public example avatar any key can call, so a first app never waits on creating one.',
    'Calls and generations spend credits (1 credit = 1 second on air): rta_avatar_create, rta_loop_set, rta_clips_set and rta_session_mint ask for approval' + (cfg.readOnly ? ' (currently disabled: readOnly)' : '') + '; release any session you mint with rta_session_release.',
  ].join(' ')
  return { name: PROMPT_SECTION_NAME, order: PROMPT_SECTION_ORDER, text }
}
