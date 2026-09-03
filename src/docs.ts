/**
 * Public documentation access: the closed page table, live page fetch, footer
 * stripping, heading demotion, section extraction and an OpenAPI summary.
 * Shared by the rta_docs / rta_quickstart tools and scripts/sync-docs.mjs.
 *
 * @module dsh-realtimeavatar/docs
 */
import { SITE_BASE, USER_AGENT } from './config.js'
import { DOC_PAGES, OPERATIONS, URLS, type DocSlug } from './facts.js'

export interface DocPageRef {
  slug: string
  title: string
  url: string
  canonical: string
}

/** Extra machine-readable pages the docs tool can fetch besides the 14 doc pages. */
export const EXTRA_PAGES = {
  index: { title: 'Agent guide (llms.txt)', url: SITE_BASE + '/llms.txt', canonical: SITE_BASE + '/llms.txt' },
  openapi: { title: 'OpenAPI (summarised)', url: SITE_BASE + '/openapi.json', canonical: SITE_BASE + '/openapi.json' },
} as const

export const PAGE_SLUGS: readonly string[] = [...DOC_PAGES.map((p) => p.slug), ...Object.keys(EXTRA_PAGES)]

/** Resolve a slug to its public URL; unknown slugs are rejected (no arbitrary URLs). */
export function pageRef(slug: string): DocPageRef {
  const doc = DOC_PAGES.find((p) => p.slug === slug)
  if (doc !== undefined) return { slug: doc.slug, title: doc.title, url: SITE_BASE + doc.path, canonical: SITE_BASE + doc.canonical }
  if (slug === 'index' || slug === 'openapi') {
    const extra = EXTRA_PAGES[slug]
    return { slug, title: extra.title, url: extra.url, canonical: extra.canonical }
  }
  throw new Error('unknown docs page "' + slug + '". Known pages: ' + PAGE_SLUGS.join(', ') + '.')
}

const FOOTER_MARK = 'Realtime Avatar — '

/** Read `aborted` through a call so TypeScript does not narrow the property across awaits. */
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

/**
 * Every public page ends with `---` + a one-line footer ("Realtime Avatar — …
 * Docs: … · Agent guide: …"). Strip that trailer; leave everything else intact.
 */
export function stripFooter(markdown: string): string {
  const text = markdown.replace(/\r\n/g, '\n')
  const idx = text.lastIndexOf('\n---\n')
  if (idx === -1) return text.trimEnd()
  const tail = text.slice(idx + 5).trim()
  if (tail.startsWith(FOOTER_MARK) && tail.includes('Docs: https://realtimeavatar.ai/docs')) return text.slice(0, idx).trimEnd()
  return text.trimEnd()
}

/** `- Updated: YYYY-MM-DD` from a page header, if present. */
export function updatedOn(markdown: string): string | null {
  const match = /^- Updated:\s*(\d{4}-\d{2}-\d{2})/m.exec(markdown)
  return match === null ? null : match[1]
}

/** Add one `#` to every heading outside fenced code so a page can nest under a skill's `##` section. */
export function demoteHeadings(markdown: string): string {
  const out: string[] = []
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && /^#{1,5} /.test(line)) out.push('#' + line)
    else out.push(line)
  }
  return out.join('\n')
}

/** Return one `## heading` section (until the next heading of the same or higher level), case-insensitive match. */
export function sectionByHeading(markdown: string, heading: string): string | null {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const wanted = heading.trim().toLowerCase()
  let start = -1
  let level = 0
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) continue
    const match = /^(#{1,6}) (.*)$/.exec(line)
    if (match === null) continue
    if (start === -1) {
      if (match[2].trim().toLowerCase() === wanted) {
        start = i
        level = match[1].length
      }
    } else if (match[1].length <= level) {
      return lines.slice(start, i).join('\n').trimEnd()
    }
  }
  return start === -1 ? null : lines.slice(start).join('\n').trimEnd()
}

/** Truncate to `maxChars` on a line boundary; reports whether anything was cut. */
export function clampText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const cut = text.slice(0, maxChars)
  const nl = cut.lastIndexOf('\n')
  const kept = nl > maxChars / 2 ? cut.slice(0, nl) : cut
  const safe = typeof kept.toWellFormed === 'function' ? kept.toWellFormed() : kept
  return { text: safe + '\n…(truncated; ask for one heading, or raise docsMaxChars in the plugin config)', truncated: true }
}

/** Fetch a public page's markdown (or llms.txt / openapi.json). Public, unauthenticated. */
export async function fetchPage(url: string, options: { signal?: AbortSignal; timeoutMs: number }): Promise<string> {
  if (signalAborted(options.signal)) throw new Error('docs fetch cancelled before it started')
  const timer = new AbortController()
  const handle = setTimeout(() => timer.abort(), options.timeoutMs)
  const signal = options.signal !== undefined ? AbortSignal.any([timer.signal, options.signal]) : timer.signal
  try {
    const response = await fetch(url, { headers: { Accept: 'text/markdown, text/plain, application/json;q=0.9, */*;q=0.1', 'User-Agent': USER_AGENT }, signal, redirect: 'follow' })
    const text = await response.text()
    if (!response.ok) throw new Error('docs fetch failed (HTTP ' + response.status + ') for ' + url)
    return text
  } catch (error) {
    if (signalAborted(options.signal)) throw new Error('docs fetch cancelled by the caller')
    if (timer.signal.aborted) throw new Error('docs fetch timed out after ' + options.timeoutMs + 'ms for ' + url)
    throw error
  } finally {
    clearTimeout(handle)
  }
}

/** A compact, model-friendly operation table derived from the public OpenAPI document. */
export function summarizeOpenApi(document: unknown): string {
  const doc = typeof document === 'object' && document !== null ? (document as Record<string, unknown>) : {}
  const info = typeof doc.info === 'object' && doc.info !== null ? (doc.info as Record<string, unknown>) : {}
  const paths = typeof doc.paths === 'object' && doc.paths !== null ? (doc.paths as Record<string, unknown>) : {}
  const lines = ['# ' + String(info.title ?? 'OpenAPI') + ' (version ' + String(info.version ?? '?') + ')', '', 'Base URL: ' + URLS.apiBase + ' — bearer auth (`Authorization: Bearer tic_…`).', '', '| Method | Path | operationId | Summary | Scope | Credits | rta tool |', '|---|---|---|---|---|---|---|']
  for (const [path, item] of Object.entries(paths)) {
    const ops = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
    for (const [method, op] of Object.entries(ops)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue
      const o = typeof op === 'object' && op !== null ? (op as Record<string, unknown>) : {}
      const fact = OPERATIONS.find((f) => f.method === method.toUpperCase() && '/v1' + f.path === path)
      lines.push('| ' + method.toUpperCase() + ' | `' + path + '` | ' + String(o.operationId ?? '') + ' | ' + String(o.summary ?? '') + ' | ' + (fact?.scope ?? '') + ' | ' + (fact?.costsCredits === true ? 'yes' : 'no') + ' | ' + (fact?.exposedAs ?? '—') + ' |')
    }
  }
  return lines.join('\n')
}

export function isDocSlug(value: string): value is DocSlug {
  return DOC_PAGES.some((p) => p.slug === value)
}
