// Regenerate skills/*.md from the LIVE public documentation at realtimeavatar.ai.
// A release step, not a build step: run it, review the diff, commit.
//
//   node scripts/sync-docs.mjs            # write skills/
//   node scripts/sync-docs.mjs --check    # exit 1 if skills/ differ from live
//
// Requires `npm run build` first (imports lib/). Only the public pages listed in
// src/facts.ts are fetched; the generated text is run through the leak gate
// before anything is written.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { demoteHeadings, fetchPage, stripFooter, summarizeOpenApi, updatedOn } from '../lib/docs.js'
import { AGENT_PROMPT, DOC_PAGES, ENV_VAR, ERROR_TABLE, EXAMPLE_AVATAR_ID, OPERATIONS, PLANS, SCOPES, SDK_PACKAGE, SKILL_PAGES, URLS, VERIFIED_ON } from '../lib/facts.js'
import { scan, selfCheck } from './leak-gate.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = join(ROOT, 'skills')
const MAX_BYTES = 45000
const CHECK = process.argv.includes('--check')
const TIMEOUT_MS = 20000

const DESCRIPTIONS = {
  'realtimeavatar-quickstart': 'Realtime Avatar (realtimeavatar.ai) from zero to a live call: what the product is, plans and credits, creating an API key (tic_live_/tic_test_, scopes, spend cap), keeping it server-side as REALTIME_AVATAR_API_KEY, and the quickstart on the public example avatar seed-rin-ashfall. Load before helping someone sign up, get a key, or make a first call.',
  'realtimeavatar-integrate': 'Realtime Avatar SDK integration for Next.js, TanStack Start, Express, Hono/Workers/Bun/Deno and React/React Native: the server half (route adapter holding the key, authorize + session policy) and the client half (AvatarCall / useAvatarCall). Load when writing the connect endpoint or the call UI.',
  'realtimeavatar-avatars': 'Creating and editing a Realtime Avatar character: one portrait image in, generated idle loop and motion-clip library out, resting-loop redirection, clip declarations, settling and refusals, generation prices. Load before rta_avatar_create, rta_loop_set or rta_clips_set.',
  'realtimeavatar-calls': 'Realtime Avatar calls: the server-authoritative session policy (instructions, context, maxSeconds, voice, video, clientTools, transcript), the five client states, ending a call gracefully, tool calling (client tool plane and server loop), and experimental features. Load when designing call behaviour or tools.',
  'realtimeavatar-api': 'Realtime Avatar REST API reference (https://realtimeavatar.ai/api/v1): every public endpoint with scope, request casing (realtime routes snake_case, resources camelCase), error codes (401/402/403/409/422/429 kinds), rate limit, idempotency, and the rta_* tool that wraps each. Load before calling the API directly.',
}

async function fetchWithRetry(url) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchPage(url, { timeoutMs: TIMEOUT_MS })
    } catch (error) {
      lastError = error
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
    }
  }
  throw lastError
}

/** A fetched page must look like the public markdown (title line + footer + some length); anything else is an upstream hiccup. */
function assertPageShape(page, raw) {
  const text = raw.replace(/\r\n/g, '\n')
  if (!text.startsWith('# ')) throw new Error(page.slug + ': fetched body does not start with a markdown title (got ' + JSON.stringify(text.slice(0, 40)) + ')')
  if (!text.includes('Docs: https://realtimeavatar.ai/docs')) throw new Error(page.slug + ': fetched body lacks the public footer — refusing to snapshot it')
  if (text.length < 400) throw new Error(page.slug + ': fetched body is only ' + text.length + ' chars')
}

function pageSection(page, raw) {
  assertPageShape(page, raw)
  const body = stripFooter(raw)
  const updated = updatedOn(body)
  const withoutTitle = body.replace(/^# .*\n/, '')
  return '## ' + page.title + '\n\nSource: ' + URLS.site + page.canonical + ' (markdown: ' + URLS.site + page.path + (updated !== null ? ', updated ' + updated : '') + ')\n\n' + demoteHeadings(withoutTitle).trim() + '\n'
}

function quickstartFacts() {
  const lines = ['## Key facts (verified ' + VERIFIED_ON + ')', '']
  lines.push('- Sign up: ' + URLS.signup + ' · dashboard: ' + URLS.dashboard + ' · API keys: ' + URLS.apiKeys + ' · pricing: ' + URLS.pricing)
  lines.push('- Keys look like tic_live_… or tic_test_… and are shown once. The tag is organisational, not a sandbox: both spend the same credits. Dashboard keys start with every scope except `*`; untick what a key should not do; set a per-key spend limit when handing a key to a subsystem.')
  lines.push('- Env var: ' + ENV_VAR + ' on the server only (never NEXT_PUBLIC_/VITE_). In dsh the harness holds it: `/rta key tic_…`, `/rta status`.')
  lines.push('- SDK: `npm install ' + SDK_PACKAGE + '` (public npm, MIT; pin an exact version). No Python SDK — the backend half is plain HTTP.')
  lines.push('- Public example avatar: `' + EXAMPLE_AVATAR_ID + '` — any key can mint a call against it, so a first app never waits on creating an avatar.')
  lines.push('- Credits: 1 credit = 1 second on air; live conversation lands around $5/hour.')
  lines.push('')
  lines.push('| Plan | $/mo | Credits | ≈ minutes | Concurrent streams | Avatars | Note |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const p of PLANS) lines.push('| ' + p.name + ' | ' + p.usd + ' | ' + p.credits.toLocaleString('en-US') + ' | ' + p.minutes + ' | ' + p.streams + ' | ' + p.avatars + ' | ' + p.note + ' |')
  lines.push('')
  lines.push('| Scope | Grants |')
  lines.push('|---|---|')
  for (const s of SCOPES) lines.push('| `' + s.scope + '` | ' + s.grants + ' |')
  lines.push('')
  lines.push('### The public "build my first app" prompt (hand it to a coding agent)')
  lines.push('')
  lines.push('```text')
  lines.push(AGENT_PROMPT)
  lines.push('```')
  return lines.join('\n') + '\n'
}

function apiFacts(openapi) {
  const lines = ['## Endpoints and the rta_* tools (verified against ' + URLS.openapi + ' on ' + VERIFIED_ON + ')', '']
  lines.push('Base URL `' + URLS.apiBase + '`, `Authorization: Bearer tic_…`. Realtime routes take snake_case bodies; resource routes take camelCase. Per-key throttle: 120 requests per 60 seconds.')
  lines.push('')
  lines.push('| Method | Path | Scope | Spends credits | dsh tool |')
  lines.push('|---|---|---|---|---|')
  for (const op of OPERATIONS) lines.push('| ' + op.method + ' | `' + op.path + '` | `' + op.scope + '` | ' + (op.costsCredits ? 'yes' : 'no') + ' | ' + (op.exposedAs ?? (op.deprecated ? '— (deprecated)' : '— (not exposed)')) + ' |')
  lines.push('')
  lines.push('| Status | Meaning | What to do |')
  lines.push('|---|---|---|')
  for (const e of ERROR_TABLE) lines.push('| ' + e.status + ' | ' + e.meaning + ' | ' + e.action + ' |')
  lines.push('')
  lines.push('### Operation table from the live OpenAPI document')
  lines.push('')
  lines.push(summarizeOpenApi(openapi).split('\n').slice(2).join('\n'))
  return lines.join('\n') + '\n'
}

function frontmatter(name, sources) {
  return ['---', 'name: ' + name, 'description: ' + DESCRIPTIONS[name], 'snapshot: ' + new Date().toISOString().slice(0, 10), 'sources: ' + sources.join(', '), '---', '', '> Snapshot of the public documentation at https://realtimeavatar.ai taken on ' + new Date().toISOString().slice(0, 10) + '. For the current text of any page call the `rta_docs` tool; the canonical pages are linked under every section.', '', ''].join('\n')
}

async function main() {
  selfCheck()
  const pages = new Map()
  const slugs = DOC_PAGES.map((p) => p.slug)
  // modest concurrency: three at a time
  for (let i = 0; i < slugs.length; i += 3) {
    await Promise.all(
      slugs.slice(i, i + 3).map(async (slug) => {
        const page = DOC_PAGES.find((p) => p.slug === slug)
        pages.set(slug, await fetchWithRetry(URLS.site + page.path))
      }),
    )
  }
  const openapi = JSON.parse(await fetchWithRetry(URLS.openapi))

  // Drift check: the operation table in facts.ts must match the live spec.
  const live = []
  for (const [path, item] of Object.entries(openapi.paths ?? {})) {
    for (const method of Object.keys(item)) if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) live.push(method.toUpperCase() + ' /v1' + path.replace(/^\/v1/, ''))
  }
  const known = OPERATIONS.map((op) => op.method + ' /v1' + op.path)
  const missing = live.filter((op) => !known.includes(op))
  const extra = known.filter((op) => !live.includes(op))
  if (missing.length > 0 || extra.length > 0) {
    console.error('OpenAPI drift: not in facts.ts → ' + JSON.stringify(missing) + '; not live → ' + JSON.stringify(extra))
    process.exit(2)
  }

  const outputs = new Map()
  for (const [name, pageSlugs] of Object.entries(SKILL_PAGES)) {
    const sources = pageSlugs.map((slug) => DOC_PAGES.find((p) => p.slug === slug).path.replace(/^\//, ''))
    let text = frontmatter(name, sources)
    if (name === 'realtimeavatar-quickstart') text += quickstartFacts() + '\n'
    if (name === 'realtimeavatar-api') text += apiFacts(openapi) + '\n'
    for (const slug of pageSlugs) text += pageSection(DOC_PAGES.find((p) => p.slug === slug), pages.get(slug)) + '\n'
    text = text.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
    outputs.set(name, text)
  }

  const findings = scan([...outputs].map(([name, text]) => ({ file: 'skills/' + name + '.md', text })))
  if (findings.length > 0) {
    console.error('leak gate rejected the generated skills:')
    for (const f of findings) console.error('  ' + f.file + ':' + f.line + ' [' + f.rule + '] ' + f.match)
    process.exit(1)
  }
  for (const [name, text] of outputs) {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes >= MAX_BYTES) {
      console.error(name + ' is ' + bytes + ' bytes (limit ' + MAX_BYTES + '); split it')
      process.exit(1)
    }
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
  let drift = false
  for (const [name, text] of outputs) {
    const file = join(OUT_DIR, name + '.md')
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null
    // ignore the snapshot-date lines when comparing
    const norm = (s) => s?.replace(/^snapshot: .*$/m, '').replace(/taken on \d{4}-\d{2}-\d{2}/, '')
    const changed = norm(current) !== norm(text)
    if (CHECK) {
      if (changed) {
        drift = true
        console.log('drift: ' + name)
      }
      continue
    }
    // Stage, then rename: a failure mid-loop must not leave a half-updated snapshot.
    writeFileSync(file + '.tmp', text)
    renameSync(file + '.tmp', file)
    console.log((changed ? 'wrote ' : 'unchanged ') + name + ' (' + Buffer.byteLength(text, 'utf8') + ' bytes)')
  }
  if (CHECK) {
    if (!drift) console.log('skills in sync with live docs (' + outputs.size + ' skills, operation table matches ' + URLS.openapi + ')')
    process.exit(drift ? 1 : 0)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
