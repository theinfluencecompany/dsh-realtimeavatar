/**
 * The `/rta` slash command: onboarding without the model in the loop.
 * `/rta key <tic_…>` stores the key through the harness credential service
 * and is registered with recordInput:false so the pasted key is not recorded
 * in the session log and is never shown to the model. (The web composer may
 * still keep its draft in browser storage while you type; headless users
 * export the env var instead.)
 *
 * @module dsh-realtimeavatar/commands
 */
import { clearKey, describeKey, KeyError, storeKey } from './credentials.js'
import { AGENT_PROMPT, DOC_PAGES, ENV_VAR, EXAMPLE_AVATAR_ID, PLANS, SCOPES, SDK_PACKAGE, SKILL_PAGES, URLS } from './facts.js'
import { redactSecrets, safeMessage } from './redact.js'
import { collectStatus, renderStatus } from './tools/read.js'
import type { ToolDeps } from './tools/shared.js'

export interface CommandResult {
  kind: 'success' | 'error'
  text: string
}

export interface CommandInvocation {
  rawInput: string
  signal?: AbortSignal
}

export interface CommandDefinition {
  name: string
  description: string
  input: { hint: string }
  recordInput: boolean
  handler(invocation: CommandInvocation): Promise<CommandResult>
}

export const USAGE = [
  '/rta setup           — how to get a key and make the first call',
  '/rta key <tic_…>     — store your API key in the harness credential store (not recorded in the session log; never shown to the model)',
  '/rta key             — key posture (source, live/test tag; never the value)',
  '/rta key clear       — remove the stored key',
  '/rta status          — key, credits, capacity, write posture',
  '/rta prompt          — the public "build my first app" prompt for a coding agent',
  '/rta docs [page]     — the public documentation pages',
].join('\n')

export function setupText(ref: string): string {
  const sandbox = PLANS[0]
  return [
    'Realtime Avatar — from no key to a live call',
    '',
    '1. Sign up (free Sandbox: $' + sandbox.usd + '/mo, ' + sandbox.credits.toLocaleString('en-US') + ' credits ≈ ' + sandbox.minutes + ' min, ' + sandbox.streams + ' stream, ' + sandbox.avatars + ' avatar, ' + sandbox.note + '): ' + URLS.signup,
    '   1 credit = 1 second on air; live conversation lands around $5/hour. Plans: ' + URLS.pricing,
    '2. Open the dashboard: ' + URLS.dashboard + ' — API keys live under ' + URLS.apiKeys,
    '3. Create a key. It is shown once and looks like tic_test_… or tic_live_… (the tag is organisational — both spend the same credits).',
    '   Dashboard keys start with every scope except *: untick what this key should not do (especially api_keys:write).',
    '   Scopes: ' + SCOPES.filter((s) => s.scope !== '*').map((s) => s.scope).join(', ') + '. Set a per-key spend limit for anything you hand to a subsystem.',
    '4. Store it here: /rta key tic_…   (goes to the harness credential store under ' + ref + '; never into chat history)',
    '   — or export ' + ref + '=… in the shell that launches dsh. Never a NEXT_PUBLIC_/VITE_ name: the key stays on your server.',
    '5. Verify: /rta status  (credits, capacity, key tag).',
    '6. Build: npm install ' + SDK_PACKAGE + ', then hand the agent /rta prompt — it starts on the public example avatar ' + EXAMPLE_AVATAR_ID + ' so nothing waits on creating one.',
    '   The agent can load the realtimeavatar-quickstart / realtimeavatar-integrate skills or call rta_quickstart {framework}.',
    '7. Your own character: register a portrait (rta_asset_remote), create it (rta_avatar_create — spends credits, asks first), poll rta_avatar until ready, swap the id.',
    '',
    'Docs: ' + URLS.docs + ' · agent guide: ' + URLS.llms,
  ].join('\n')
}

export function docsText(page: string | undefined): string {
  if (page !== undefined) {
    const doc = DOC_PAGES.find((p) => p.slug === page.toLowerCase())
    if (doc === undefined) return 'unknown page "' + page + '". Pages: ' + DOC_PAGES.map((p) => p.slug).join(', ')
    const skill = Object.entries(SKILL_PAGES).find(([, pages]) => (pages as readonly string[]).includes(doc.slug))?.[0]
    return doc.title + ' — ' + URLS.site + doc.canonical + '\nmarkdown: ' + URLS.site + doc.path + (skill !== undefined ? '\nskill: ' + skill : '') + '\n' + doc.blurb
  }
  const lines = ['Public documentation (' + URLS.docs + '); append .md to any page for markdown; agent guide ' + URLS.llms]
  for (const doc of DOC_PAGES) lines.push('- ' + doc.slug + ': ' + doc.title + ' — ' + doc.blurb)
  lines.push('Skills shipped with this plugin: ' + Object.keys(SKILL_PAGES).join(', ') + ' (type /<skill-name> or let the agent load them).')
  return lines.join('\n')
}

/** Build the command definition (registered by the plugin entry when the commands service exists). */
export function buildRtaCommand(deps: ToolDeps): CommandDefinition {
  const ref = deps.cfg.apiKeyEnv
  return {
    name: 'rta',
    description: 'Realtime Avatar: setup, API key, status, docs',
    input: { hint: '[setup|key <tic_…>|key clear|status|prompt|docs [page]|help]' },
    recordInput: false,
    async handler(invocation) {
      const raw = invocation.rawInput.trim()
      const space = raw.search(/\s/)
      const verb = (space === -1 ? raw : raw.slice(0, space)).toLowerCase()
      const rest = space === -1 ? '' : raw.slice(space).trim()
      try {
        switch (verb) {
          case '':
          case 'help':
            return { kind: 'success', text: USAGE }
          case 'setup':
            return { kind: 'success', text: setupText(ref) }
          case 'prompt':
            return { kind: 'success', text: 'Paste this into your coding agent (it starts on the public example avatar; the key belongs in ' + ENV_VAR + ' on the server):\n\n' + AGENT_PROMPT }
          case 'docs':
            return { kind: 'success', text: docsText(rest === '' ? undefined : rest.split(/\s+/)[0]) }
          case 'status': {
            const report = await collectStatus(deps, invocation.signal)
            return { kind: 'success', text: renderStatus(report) }
          }
          case 'key': {
            const source = deps.keySource()
            if (rest === '') {
              const posture = await describeKey(source, ref)
              return { kind: 'success', text: posture.configured ? ref + ': configured via ' + posture.source + ' (' + posture.environment + ' key). Run /rta status to test it.' : ref + ': not configured. Run /rta setup, then /rta key <tic_…>.' }
            }
            const value = rest.split(/\s+/)[0]
            if (value.toLowerCase() === 'clear') {
              const { removed, residual } = await clearKey(source, ref)
              const head = removed ? 'Removed ' + ref + ' from the credential store.' : 'Nothing was stored under ' + ref + ' in the credential store.'
              const tail = residual.configured ? ' It is still supplied by ' + residual.source + (residual.source === 'project-env' ? ' (the .env in the working directory)' : residual.source === 'user-env' ? ' (the .env in the dsh home)' : '') + ' — remove it there to stop using it.' : ''
              return { kind: 'success', text: head + tail }
            }
            const stored = await storeKey(source, ref, value)
            return { kind: 'success', text: 'Stored ' + ref + ' (' + stored.environment + ' key, ' + stored.length + ' chars) in the harness credential store. Run /rta status to verify.' }
          }
          default: {
            // Never echo something key-shaped (a pasted key without the verb), and keep the echo short.
            const shown = /^tic_/i.test(verb) ? '(looks like a key — use /rta key <tic_…>)' : '"' + redactSecrets(verb.slice(0, 40)) + (verb.length > 40 ? '…' : '') + '"'
            return { kind: 'error', text: 'unknown sub-command ' + shown + '.\n' + USAGE }
          }
        }
      } catch (error) {
        const message = error instanceof KeyError ? error.code + ': ' + error.message : safeMessage(error)
        return { kind: 'error', text: redactSecrets(message) }
      }
    },
  }
}
