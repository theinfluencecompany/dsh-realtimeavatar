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

/**
 * Per-process page cache. The docs host answers with an ETag and
 * `cache-control: max-age=0, must-revalidate`, so a page is kept together
 * with its validator and revalidated with `If-None-Match`: a 304 costs one
 * round trip and no body (a page is 10–40 KB). Within PAGE_FRESH_MS of the
 * last validation the round trip is skipped too (rta_docs followed by
 * rta_quickstart on the same page). Only responses that carry an ETag are
 * cached; errors never touch the cache.
 */
interface CachedPage {
  etag: string
  text: string
  /** Monotonic reading (see `monotonic`) of the last successful validation. */
  validatedAt: number
  /** Issue number of the fetch that produced this entry; see `issued`. */
  issue: number
}

export const PAGE_CACHE_MAX = 24
export const PAGE_FRESH_MS = 60_000
const pageCache = new Map<string, CachedPage>()

/**
 * Fetches are numbered in issue order so a slow response can never overwrite a
 * newer one. Two calls for the same URL overlap whenever the harness dispatches
 * rta_docs and rta_quickstart in the same turn (both are concurrency-safe), and
 * a CDN can answer them from different nodes during a docs deploy: without this
 * guard a late 304 for the old validator would write the old body back over the
 * new one and pin it for a whole freshness window.
 */
let issueCounter = 0
const issued = (): number => (issueCounter += 1)

/**
 * Freshness is measured on a monotonic clock, not the wall clock: an NTP step
 * or a VM restore must not make an entry look fresh for longer than it is.
 */
const monotonic = (): number => performance.now()

/** Number of cached pages (tests and diagnostics). */
export function pageCacheSize(): number {
  return pageCache.size
}

/** Drop every cached page (tests). */
export function resetPageCache(): void {
  pageCache.clear()
}

function remember(url: string, entry: CachedPage): void {
  const current = pageCache.get(url)
  if (current !== undefined && current.issue > entry.issue) return // a newer fetch already landed
  pageCache.delete(url)
  pageCache.set(url, entry)
  while (pageCache.size > PAGE_CACHE_MAX) {
    const oldest = pageCache.keys().next().value
    if (oldest === undefined) break
    pageCache.delete(oldest)
  }
}

export interface FetchPageOptions {
  signal?: AbortSignal
  timeoutMs: number
  /** Monotonic clock override (tests). */
  now?: () => number
}

/** Fetch a public page's markdown (or llms.txt / openapi.json). Public, unauthenticated; cached by ETag. */
export async function fetchPage(url: string, options: FetchPageOptions): Promise<string> {
  if (signalAborted(options.signal)) throw new Error('docs fetch cancelled before it started')
  const now = options.now ?? monotonic
  const cached = pageCache.get(url)
  const age = cached !== undefined ? now() - cached.validatedAt : 0
  if (cached !== undefined && age >= 0 && age < PAGE_FRESH_MS) return cached.text
  const issue = issued()
  const timer = new AbortController()
  const handle = setTimeout(() => timer.abort(), options.timeoutMs)
  const signal = options.signal !== undefined ? AbortSignal.any([timer.signal, options.signal]) : timer.signal
  const headers: Record<string, string> = { Accept: 'text/markdown, text/plain, application/json;q=0.9, */*;q=0.1', 'User-Agent': USER_AGENT }
  if (cached !== undefined) headers['If-None-Match'] = cached.etag
  try {
    const response = await fetch(url, { headers, signal, redirect: 'follow' })
    if (response.status === 304 && cached !== undefined) {
      await response.text() // drain (empty) so the connection is reusable
      // "Not modified" is only news about the validator we sent. If a concurrent
      // fetch has since stored a different one, that entry is the current page.
      const current = pageCache.get(url)
      if (current !== undefined && current.etag !== cached.etag) return current.text
      remember(url, { ...cached, validatedAt: now(), issue })
      return cached.text
    }
    const text = await response.text()
    if (!response.ok) throw new Error('docs fetch failed (HTTP ' + response.status + ') for ' + url)
    const etag = response.headers.get('etag')
    if (etag !== null && etag !== '') remember(url, { etag, text, validatedAt: now(), issue })
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
