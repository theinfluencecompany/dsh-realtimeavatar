import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pageRef, PAGE_SLUGS, EXTRA_PAGES, stripFooter, updatedOn, demoteHeadings, sectionByHeading, clampText, summarizeOpenApi, fetchPage, isDocSlug, resetPageCache, pageCacheSize, PAGE_CACHE_MAX, PAGE_FRESH_MS } from '../lib/docs.js'
import { codeBlockAfter } from '../lib/tools/docs.js'
import { DOC_PAGES, OPERATIONS, URLS } from '../lib/facts.js'
import { SITE_BASE, USER_AGENT } from '../lib/config.js'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const PAGE = readFileSync(fixtures + 'page-with-footer.md', 'utf8')
const OPENAPI = JSON.parse(readFileSync(fixtures + 'openapi.json', 'utf8'))
const FOOTER = 'Realtime Avatar — realtime AI avatar API & SDK. Docs: https://realtimeavatar.ai/docs · Agent guide: https://realtimeavatar.ai/llms.txt'

/** Install a fake fetch that returns `response` (or calls it) and records the request. */
function stubFetch(response) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (typeof response === 'function') return response(url, init)
    return response
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

function abortError() {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

// ---------------------------------------------------------------- pageRef

test('pageRef resolves all 14 documentation slugs to their public markdown and canonical URLs', () => {
  assert.equal(DOC_PAGES.length, 14)
  for (const doc of DOC_PAGES) {
    const ref = pageRef(doc.slug)
    assert.deepEqual(ref, { slug: doc.slug, title: doc.title, url: SITE_BASE + doc.path, canonical: SITE_BASE + doc.canonical })
    assert.ok(ref.url.startsWith('https://realtimeavatar.ai/'), 'url stays on the public site')
    assert.ok(ref.url.endsWith('.md'), 'url is the markdown rendition')
    assert.ok(isDocSlug(doc.slug))
  }
  assert.deepEqual(pageRef('overview'), { slug: 'overview', title: 'Realtime Avatar API', url: 'https://realtimeavatar.ai/docs.md', canonical: 'https://realtimeavatar.ai/docs' })
  assert.deepEqual(pageRef('express'), { slug: 'express', title: 'Express', url: 'https://realtimeavatar.ai/docs/express.md', canonical: 'https://realtimeavatar.ai/docs/express' })
})

test('pageRef resolves index (llms.txt) and openapi (openapi.json)', () => {
  assert.deepEqual(pageRef('index'), { slug: 'index', title: 'Agent guide (llms.txt)', url: 'https://realtimeavatar.ai/llms.txt', canonical: 'https://realtimeavatar.ai/llms.txt' })
  assert.deepEqual(pageRef('openapi'), { slug: 'openapi', title: 'OpenAPI (summarised)', url: 'https://realtimeavatar.ai/openapi.json', canonical: 'https://realtimeavatar.ai/openapi.json' })
  assert.equal(pageRef('index').url, URLS.llms)
  assert.equal(pageRef('openapi').url, URLS.openapi)
  assert.deepEqual(Object.keys(EXTRA_PAGES).sort(), ['index', 'openapi'])
  assert.equal(PAGE_SLUGS.length, 16)
  assert.deepEqual([...PAGE_SLUGS].sort(), [...DOC_PAGES.map((p) => p.slug), 'index', 'openapi'].sort())
  assert.equal(isDocSlug('index'), false)
  assert.equal(isDocSlug('openapi'), false)
})

test('pageRef rejects unknown slugs and arbitrary URLs (the page table is closed)', () => {
  for (const bad of [
    'nope',
    '',
    ' express',
    'EXPRESS',
    'docs/express',
    '/docs/express.md',
    'express.md',
    'https://realtimeavatar.ai/docs/express.md',
    'https://evil.example/llms.txt',
    '../llms.txt',
    'index.html',
    'llms.txt',
    'constructor',
    '__proto__',
    'toString',
  ]) {
    assert.throws(() => pageRef(bad), /unknown docs page/, 'should reject ' + JSON.stringify(bad))
  }
  assert.throws(() => pageRef('nope'), (err) => {
    assert.match(err.message, /"nope"/)
    for (const slug of PAGE_SLUGS) assert.ok(err.message.includes(slug), 'lists ' + slug)
    return true
  })
  assert.equal(isDocSlug('nope'), false)
})

// ------------------------------------------------------------ stripFooter

test('stripFooter removes exactly the public footer from the fixture page', () => {
  const stripped = stripFooter(PAGE)
  assert.equal(PAGE, stripped + '\n\n---\n\n' + FOOTER + '\n', 'only the trailing --- + footer line was removed')
  assert.ok(stripped.startsWith('# Express\n'))
  assert.ok(stripped.endsWith('everything the `session` policy can decide.'))
  assert.ok(!stripped.includes('Agent guide: https://realtimeavatar.ai/llms.txt'))
  assert.ok(!stripped.includes('Realtime Avatar — realtime AI avatar'))
  assert.ok(stripped.includes('## Next'), 'the section before the footer survives')
  assert.ok(stripped.includes('```tsx'), 'code fences survive')
})

test('stripFooter normalises CRLF before looking for the footer', () => {
  assert.equal(stripFooter(PAGE.replace(/\n/g, '\r\n')), stripFooter(PAGE))
})

test('stripFooter leaves text without a footer untouched (apart from trailing whitespace)', () => {
  assert.equal(stripFooter('# Title\n\nbody\n'), '# Title\n\nbody')
  assert.equal(stripFooter('no trailing newline'), 'no trailing newline')
  assert.equal(stripFooter(''), '')
  // a horizontal rule that is not followed by the footer is content
  assert.equal(stripFooter('# T\n\ntext\n\n---\n\nmore text\n'), '# T\n\ntext\n\n---\n\nmore text')
  // a trailer that starts like the footer but lacks the docs link is content too
  assert.equal(stripFooter('# T\n\ntext\n\n---\n\nRealtime Avatar — something else\n'), '# T\n\ntext\n\n---\n\nRealtime Avatar — something else')
  // the footer text without the --- separator is content
  assert.equal(stripFooter('# T\n\n' + FOOTER + '\n'), '# T\n\n' + FOOTER)
})

test('stripFooter only considers the last --- separator', () => {
  assert.equal(stripFooter('# T\n\n---\n\nmid\n\n---\n\n' + FOOTER + '\n'), '# T\n\n---\n\nmid')
})

// -------------------------------------------------------------- updatedOn

test('updatedOn reads the header date and returns null when absent', () => {
  assert.equal(updatedOn(PAGE), '2026-09-02')
  assert.equal(updatedOn('# T\n\nno header'), null)
  assert.equal(updatedOn(''), null)
  assert.equal(updatedOn('- Updated: 2021-02-03\n- Updated: 2022-03-04'), '2021-02-03')
  assert.equal(updatedOn('- Updated:2021-02-03'), '2021-02-03')
  assert.equal(updatedOn('- Updated: 2021-02-03T10:00:00Z'), '2021-02-03')
  // must be a list item at the start of a line
  assert.equal(updatedOn('  - Updated: 2021-02-03'), null)
  assert.equal(updatedOn('Updated: 2021-02-03'), null)
  assert.equal(updatedOn('- Updated: yesterday'), null)
})

// --------------------------------------------------------- demoteHeadings

test('demoteHeadings adds one # to every heading outside fenced code', () => {
  assert.equal(demoteHeadings('# A\n\ntext\n## B\n### C\n#### D\n##### E'), '## A\n\ntext\n### B\n#### C\n##### D\n###### E')
  assert.equal(demoteHeadings(''), '')
  assert.equal(demoteHeadings('no headings\n'), 'no headings\n')
})

test('demoteHeadings skips ``` and ~~~ fences, including indented ones', () => {
  const input = ['# A', '```sh', '# a shell comment', '## not a heading', '```', '## B', '~~~', '# still code', '~~~', '### C', '  ```', '# indented fence', '  ```', '# D'].join('\n')
  const expected = ['## A', '```sh', '# a shell comment', '## not a heading', '```', '### B', '~~~', '# still code', '~~~', '#### C', '  ```', '# indented fence', '  ```', '## D'].join('\n')
  assert.equal(demoteHeadings(input), expected)
})

test('demoteHeadings ignores hash characters that are not headings and leaves h6 alone', () => {
  assert.equal(demoteHeadings('#hashtag\ntext # inline\n ## indented'), '#hashtag\ntext # inline\n ## indented')
  assert.equal(demoteHeadings('###### deepest'), '###### deepest', 'markdown has no h7')
})

test('demoteHeadings on the fixture nests every heading one level deeper and keeps code intact', () => {
  const out = demoteHeadings(stripFooter(PAGE))
  assert.ok(out.startsWith('## Express\n'))
  assert.ok(out.includes('\n### The server half\n'))
  assert.ok(out.includes('\n### The client half\n'))
  assert.ok(out.includes('\n### Next\n'))
  assert.equal(out.split('\n').length, stripFooter(PAGE).split('\n').length, 'line count preserved')
  assert.ok(out.includes('import express from "express";'), 'code block content untouched')
})

// -------------------------------------------------------- sectionByHeading

test('sectionByHeading returns one section from the fixture, case-insensitively, and stops at the next same-level heading', () => {
  const section = sectionByHeading(PAGE, 'The client half')
  assert.ok(section !== null)
  assert.ok(section.startsWith('## The client half\n'))
  assert.ok(section.includes('createProxyClient'))
  assert.ok(section.endsWith('so its auth is your session, not ours.'))
  assert.ok(!section.includes('## Next'))
  assert.ok(!section.includes('express.json()'), 'the previous section is not included')
  assert.equal(sectionByHeading(PAGE, 'the CLIENT half'), section)
  assert.equal(sectionByHeading(PAGE, '  The client half  '), section)
  const server = sectionByHeading(PAGE, 'the server half')
  assert.ok(server.startsWith('## The server half\n'))
  assert.ok(server.includes('```ts'))
  assert.ok(!server.includes('The client half'))
})

test('sectionByHeading includes nested lower-level headings and stops at a higher-level one', () => {
  assert.equal(sectionByHeading('## A\n### A.1\nx\n#### deep\n## B\ny', 'A'), '## A\n### A.1\nx\n#### deep')
  assert.equal(sectionByHeading('intro\n## A\ntext\n# Top\nmore', 'a'), '## A\ntext')
  assert.equal(sectionByHeading('## A\ntext\n\n\n', 'A'), '## A\ntext', 'the last section runs to the end, trailing whitespace trimmed')
  assert.equal(sectionByHeading('# Title\n## A\n## B\nlast\n', 'B'), '## B\nlast')
  assert.equal(sectionByHeading('# Title\n## A\ntext', 'Title'), '# Title\n## A\ntext')
})

test('sectionByHeading ignores headings inside fenced code for both matching and termination', () => {
  const md = '## A\n```\n## B\n# C\n```\ntail\n## D'
  assert.equal(sectionByHeading(md, 'A'), '## A\n```\n## B\n# C\n```\ntail')
  assert.equal(sectionByHeading(md, 'B'), null)
  assert.equal(sectionByHeading(md, 'C'), null)
  assert.equal(sectionByHeading(md, 'D'), '## D')
})

test('sectionByHeading normalises CRLF before matching and slicing', () => {
  const crlf = PAGE.replace(/\n/g, '\r\n')
  assert.equal(sectionByHeading(crlf, 'The client half'), sectionByHeading(PAGE, 'The client half'))
  assert.equal(sectionByHeading('## A\r\ntext\r\n## B\r\nlast\r\n', 'A'), '## A\ntext')
  assert.equal(sectionByHeading('## A\r\ntext\r\n## B\r\nlast\r\n', 'b'), '## B\nlast')
  assert.ok(!sectionByHeading(crlf, 'The server half').includes('\r'), 'no stray carriage returns in the slice')
})

// --------------------------------------------------------- codeBlockAfter

test('codeBlockAfter returns the first fenced block inside the section whose heading contains the marker', () => {
  const md = ['# Express', '', '## The server half', 'prose', '```ts', 'const server = 1', '```', '', '```ts', 'const second = 2', '```', '## The client half', '```tsx', 'const client = 1', '```'].join('\n')
  assert.equal(codeBlockAfter(md, 'server half'), 'const server = 1', 'first block only')
  assert.equal(codeBlockAfter(md, 'THE CLIENT HALF'), 'const client = 1', 'marker is case-insensitive')
  assert.equal(codeBlockAfter(md, 'client'), 'const client = 1', 'marker is a substring of the heading')
  assert.equal(codeBlockAfter(md, 'nope'), null)
  assert.equal(codeBlockAfter('', 'x'), null)
  assert.equal(codeBlockAfter(PAGE, 'server half').split('\n')[0], 'import express from "express";')
  assert.ok(codeBlockAfter(PAGE, 'client half').includes('createProxyClient'))
})

test('codeBlockAfter stops at the next heading of the same or higher level and returns null when the section has no code', () => {
  assert.equal(codeBlockAfter('## Server half\nprose\n## Client half\n```\nclient\n```', 'server half'), null, 'the section ended without a block')
  assert.equal(codeBlockAfter('## Server half\nprose\n# Top\n```\ntop\n```', 'server half'), null, 'a higher-level heading ends it too')
  assert.equal(codeBlockAfter('## Server half\n### A sub-section\n```\nnested\n```', 'server half'), 'nested', 'a lower-level heading does not end it')
  assert.equal(codeBlockAfter('## Server half\n```\nopen fence never closed', 'server half'), null, 'an unterminated fence yields nothing')
})

test('codeBlockAfter tracks fences from the start: a heading inside code never arms the search', () => {
  const md = ['```sh', '## Server half', 'echo not-a-heading', '```', '## Other', '```', 'other code', '```'].join('\n')
  assert.equal(codeBlockAfter(md, 'server half'), null)
  assert.equal(codeBlockAfter(md, 'other'), 'other code')
  const armedLater = ['```', '# comment', '```', '## Server half', '```', 'real', '```'].join('\n')
  assert.equal(codeBlockAfter(armedLater, 'server half'), 'real')
})

test('codeBlockAfter supports ~~~ fences, indented fences, info strings and CRLF', () => {
  assert.equal(codeBlockAfter('## X\n~~~js\nconst y = 2\n~~~', 'x'), 'const y = 2')
  assert.equal(codeBlockAfter('## X\n  ```ts\n  indented\n  ```', 'x'), '  indented')
  assert.equal(codeBlockAfter('## X\r\n```\r\ncode\r\nmore\r\n```\r\n', 'x'), 'code\nmore')
  assert.equal(codeBlockAfter('## X\n~~~\nline\n~~~\n```\nsecond\n```', 'x'), 'line', 'a ~~~ block is closed only by ~~~')
})

test('sectionByHeading returns null when the heading is missing and does not match partially', () => {
  assert.equal(sectionByHeading(PAGE, 'nope'), null)
  assert.equal(sectionByHeading(PAGE, 'client'), null)
  assert.equal(sectionByHeading(PAGE, 'The client'), null)
  assert.equal(sectionByHeading('', 'A'), null)
  assert.equal(sectionByHeading('#A\ntext', 'A'), null, 'a hash without a space is not a heading')
})

// -------------------------------------------------------------- clampText

test('clampText leaves text within the limit untouched (inclusive)', () => {
  assert.deepEqual(clampText('short', 100), { text: 'short', truncated: false })
  assert.deepEqual(clampText('exact', 5), { text: 'exact', truncated: false })
  assert.deepEqual(clampText('', 0), { text: '', truncated: false })
})

test('clampText cuts on a line boundary and flags the truncation', () => {
  const text = Array.from({ length: 20 }, (_, i) => 'line ' + String(i).padStart(2, '0')).join('\n') // 8 chars per line
  const { text: out, truncated } = clampText(text, 50)
  assert.equal(truncated, true)
  const marker = '\n…(truncated; ask for one heading, or raise docsMaxChars in the plugin config)'
  assert.ok(out.endsWith(marker))
  const kept = out.slice(0, -marker.length)
  assert.ok(text.startsWith(kept), 'kept text is a prefix of the original')
  assert.equal(text[kept.length], '\n', 'the cut lands on a line boundary')
  assert.ok(!kept.endsWith('\n'))
  assert.ok(kept.length <= 50)
  assert.equal(kept, 'line 00\nline 01\nline 02\nline 03\nline 04\nline 05') // 6 x 8 chars = 48 ≤ 50
})

test('clampText falls back to a hard cut when no line break lies in the second half', () => {
  const marker = '\n…(truncated; ask for one heading, or raise docsMaxChars in the plugin config)'
  const solid = clampText('x'.repeat(100), 50)
  assert.deepEqual(solid, { text: 'x'.repeat(50) + marker, truncated: true })
  const earlyBreak = clampText('ab\n' + 'x'.repeat(100), 50)
  assert.deepEqual(earlyBreak, { text: 'ab\n' + 'x'.repeat(47) + marker, truncated: true })
})

// -------------------------------------------------------- summarizeOpenApi

test('summarizeOpenApi lists all 18 fixture operations with scope, credits and the rta_* tool name', () => {
  const summary = summarizeOpenApi(OPENAPI)
  const lines = summary.split('\n')
  assert.equal(lines[0], '# Realtime Avatar LiveKit API (version 1.0.0)')
  assert.equal(lines[2], 'Base URL: https://realtimeavatar.ai/api/v1 — bearer auth (`Authorization: Bearer tic_…`).')
  assert.equal(lines[4], '| Method | Path | operationId | Summary | Scope | Credits | rta tool |')
  assert.equal(lines[5], '|---|---|---|---|---|---|---|')
  const rows = lines.slice(6)
  assert.equal(rows.length, 18)
  assert.equal(OPERATIONS.length, 18)
  for (const fact of OPERATIONS) {
    const path = '/v1' + fact.path
    const op = OPENAPI.paths[path][fact.method.toLowerCase()]
    assert.ok(op !== undefined, 'fixture has ' + fact.method + ' ' + path)
    const expected = '| ' + fact.method + ' | `' + path + '` | ' + op.operationId + ' | ' + op.summary + ' | ' + fact.scope + ' | ' + (fact.costsCredits ? 'yes' : 'no') + ' | ' + (fact.exposedAs ?? '—') + ' |'
    assert.ok(rows.includes(expected), 'missing row: ' + expected)
  }
  const tools = rows.map((r) => r.split(' | ').at(-1).replace(/ \|$/, '')).filter((t) => t !== '—')
  assert.deepEqual(tools.sort(), OPERATIONS.map((o) => o.exposedAs).filter((t) => t !== null).sort())
  assert.equal(rows.filter((r) => r.endsWith('| — |')).length, 3, 'three operations are deliberately not exposed')
  assert.equal(rows.filter((r) => r.includes('| yes |')).length, 4, 'four operations cost credits')
})

test('summarizeOpenApi tolerates malformed input and skips non-operation keys', () => {
  for (const bad of [null, undefined, 'text', 42, {}, { paths: null }, { info: 'x', paths: 'y' }]) {
    const out = summarizeOpenApi(bad)
    assert.ok(out.startsWith('# OpenAPI (version ?)'), JSON.stringify(bad))
    assert.equal(out.split('\n').length, 6, 'header only, no rows')
  }
  const synthetic = summarizeOpenApi({ info: { title: 'T', version: '9' }, paths: { '/x': { parameters: [], get: { operationId: 'a', summary: 'A' }, options: { operationId: 'b' }, head: {}, post: 'not an object' } } })
  const rows = synthetic.split('\n').slice(6)
  assert.deepEqual(rows, ['| GET | `/x` | a | A |  | no | — |', '| POST | `/x` |  |  |  | no | — |'])
})

// -------------------------------------------------------------- fetchPage

test('fetchPage returns the body text and sends a public, unauthenticated request', async () => {
  const stub = stubFetch(new Response('# Hi\n\nbody', { status: 200, headers: { 'content-type': 'text/markdown' } }))
  try {
    const text = await fetchPage('https://realtimeavatar.ai/docs/express.md', { timeoutMs: 5000 })
    assert.equal(text, '# Hi\n\nbody')
    assert.equal(stub.calls.length, 1)
    const { url, init } = stub.calls[0]
    assert.equal(url, 'https://realtimeavatar.ai/docs/express.md')
    assert.match(init.headers.Accept, /text\/markdown/)
    assert.equal(init.headers['User-Agent'], USER_AGENT)
    assert.ok(!('Authorization' in init.headers), 'docs are public; no bearer')
    assert.equal(init.redirect, 'follow')
    assert.ok(init.signal instanceof AbortSignal)
    assert.equal(init.method, undefined, 'plain GET')
  } finally {
    stub.restore()
  }
})

test('fetchPage throws with the status and url on a non-2xx response', async () => {
  const stub = stubFetch(new Response('not found', { status: 404 }))
  try {
    await assert.rejects(fetchPage('https://realtimeavatar.ai/docs/nope.md', { timeoutMs: 5000 }), /docs fetch failed \(HTTP 404\) for https:\/\/realtimeavatar\.ai\/docs\/nope\.md/)
  } finally {
    stub.restore()
  }
})

test('fetchPage with an already-aborted signal issues no request', async () => {
  const stub = stubFetch(new Response('x', { status: 200 }))
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(fetchPage('https://realtimeavatar.ai/llms.txt', { timeoutMs: 5000, signal: controller.signal }), /cancelled before it started/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('fetchPage reports a mid-flight caller abort as cancelled', async () => {
  const stub = stubFetch(
    (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(abortError()))
      }),
  )
  try {
    const controller = new AbortController()
    const pending = fetchPage('https://realtimeavatar.ai/llms.txt', { timeoutMs: 5000, signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await assert.rejects(pending, /docs fetch cancelled by the caller/)
  } finally {
    stub.restore()
  }
})

test('fetchPage times out while waiting for headers and while reading the body', async () => {
  const headers = stubFetch(
    (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(abortError()))
      }),
  )
  try {
    const started = Date.now()
    await assert.rejects(fetchPage('https://realtimeavatar.ai/llms.txt', { timeoutMs: 100 }), /docs fetch timed out after 100ms for https:\/\/realtimeavatar\.ai\/llms\.txt/)
    assert.ok(Date.now() - started < 1500)
  } finally {
    headers.restore()
  }
  const body = stubFetch((url, init) => {
    const stream = new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(abortError()))
      },
    })
    return new Response(stream, { status: 200 })
  })
  try {
    const started = Date.now()
    await assert.rejects(fetchPage('https://realtimeavatar.ai/llms.txt', { timeoutMs: 100 }), /timed out after 100ms/)
    assert.ok(Date.now() - started < 1500)
  } finally {
    body.restore()
  }
})

test('fetchPage lets a genuine network error through unchanged', async () => {
  const stub = stubFetch(() => {
    throw new TypeError('fetch failed')
  })
  try {
    await assert.rejects(fetchPage('https://realtimeavatar.ai/llms.txt', { timeoutMs: 5000 }), (err) => {
      assert.ok(err instanceof TypeError)
      assert.equal(err.message, 'fetch failed')
      return true
    })
  } finally {
    stub.restore()
  }
})

test('codeBlockAfter keeps a fence marker of the other kind inside an open fence as code', () => {
  const md = '## Server half\n\n~~~md\nsome text\n```ts\nconst x = 1\n```\nmore\n~~~\n'
  assert.equal(codeBlockAfter(md, 'server half'), 'some text\n```ts\nconst x = 1\n```\nmore')
  const md2 = '## Client half\n\n```md\nintro\n~~~sh\nnpm i\n~~~\n```\n'
  assert.equal(codeBlockAfter(md2, 'client half'), 'intro\n~~~sh\nnpm i\n~~~')
})

// ---------------------------------------------------------- page cache

/** A fetch stub that serves a page with an ETag and answers 304 to a matching If-None-Match. */
function etagServer(pages) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const headers = init?.headers ?? {}
    calls.push({ url, ifNoneMatch: headers['If-None-Match'] ?? null })
    const page = pages[url]
    if (page === undefined) return new Response('nope', { status: 404 })
    if (page.status !== undefined && page.status !== 200) return new Response(page.body ?? 'error', { status: page.status })
    if (page.etag !== undefined && headers['If-None-Match'] === page.etag) return new Response(null, { status: 304, headers: { etag: page.etag } })
    return new Response(page.body, { status: 200, headers: page.etag !== undefined ? { etag: page.etag } : {} })
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

const PAGE_URL = 'https://realtimeavatar.ai/docs/sessions.md'

test('a page with an ETag is served from the cache within the freshness window without any request', async () => {
  resetPageCache()
  let clock = 1_000_000
  const now = () => clock
  const server = etagServer({ [PAGE_URL]: { etag: '"v1"', body: '# Sessions v1' } })
  try {
    assert.equal(await fetchPage(PAGE_URL, { timeoutMs: 5000, now }), '# Sessions v1')
    assert.equal(server.calls.length, 1)
    assert.equal(server.calls[0].ifNoneMatch, null, 'first fetch is unconditional')
    clock += PAGE_FRESH_MS - 1
    assert.equal(await fetchPage(PAGE_URL, { timeoutMs: 5000, now }), '# Sessions v1')
    assert.equal(server.calls.length, 1, 'no request inside the freshness window')
    assert.equal(pageCacheSize(), 1)
  } finally {
    server.restore()
    resetPageCache()
  }
})

test('after the freshness window the page is revalidated with If-None-Match and a 304 reuses the cached body', async () => {
  resetPageCache()
  let clock = 1_000_000
  const now = () => clock
  const pages = { [PAGE_URL]: { etag: '"v1"', body: '# Sessions v1' } }
  const server = etagServer(pages)
  try {
    await fetchPage(PAGE_URL, { timeoutMs: 5000, now })
    clock += PAGE_FRESH_MS
    assert.equal(await fetchPage(PAGE_URL, { timeoutMs: 5000, now }), '# Sessions v1')
    assert.equal(server.calls.length, 2)
    assert.equal(server.calls[1].ifNoneMatch, '"v1"', 'conditional request carries the validator')
    clock += 1
    assert.equal(await fetchPage(PAGE_URL, { timeoutMs: 5000, now }), '# Sessions v1')
    assert.equal(server.calls.length, 2, 'a 304 refreshes the freshness window')
    // the page changes upstream: the conditional request gets a 200 with a new ETag and the new body wins
    pages[PAGE_URL] = { etag: '"v2"', body: '# Sessions v2' }
    clock += PAGE_FRESH_MS
    assert.equal(await fetchPage(PAGE_URL, { timeoutMs: 5000, now }), '# Sessions v2')
    assert.equal(server.calls.length, 3)
    assert.equal(server.calls[2].ifNoneMatch, '"v1"')
    clock += PAGE_FRESH_MS
    await fetchPage(PAGE_URL, { timeoutMs: 5000, now })
    assert.equal(server.calls[3].ifNoneMatch, '"v2"', 'the new validator is stored')
  } finally {
    server.restore()
    resetPageCache()
  }
})

test('responses without an ETag are never cached and errors never poison an existing entry', async () => {
  resetPageCache()
  let clock = 1_000_000
  const now = () => clock
  const plain = 'https://realtimeavatar.ai/docs/react.md'
  const pages = { [plain]: { body: '# React' }, [PAGE_URL]: { etag: '"v1"', body: '# Sessions v1' } }
  const server = etagServer(pages)
  try {
    await fetchPage(plain, { timeoutMs: 5000, now })
    await fetchPage(plain, { timeoutMs: 5000, now })
    assert.equal(server.calls.length, 2, 'no ETag → every call is a real fetch')
    assert.equal(server.calls[1].ifNoneMatch, null)
    assert.equal(pageCacheSize(), 0)
    await fetchPage(PAGE_URL, { timeoutMs: 5000, now })
    assert.equal(pageCacheSize(), 1)
    pages[PAGE_URL] = { status: 503, body: 'down' }
    clock += PAGE_FRESH_MS
    await assert.rejects(() => fetchPage(PAGE_URL, { timeoutMs: 5000, now }), /HTTP 503/)
    pages[PAGE_URL] = { etag: '"v1"', body: 'never sent' }
    clock += 1
    assert.equal(await fetchPage(PAGE_URL, { timeoutMs: 5000, now }), '# Sessions v1', 'the entry survives the failure and still validates')
  } finally {
    server.restore()
    resetPageCache()
  }
})

test('the page cache is bounded: the least recently validated page is evicted first', async () => {
  resetPageCache()
  const now = () => 1_000_000
  const pages = {}
  for (let i = 0; i <= PAGE_CACHE_MAX; i += 1) pages['https://realtimeavatar.ai/docs/p' + i + '.md'] = { etag: '"e' + i + '"', body: 'page ' + i }
  const server = etagServer(pages)
  try {
    for (let i = 0; i <= PAGE_CACHE_MAX; i += 1) await fetchPage('https://realtimeavatar.ai/docs/p' + i + '.md', { timeoutMs: 5000, now })
    assert.equal(pageCacheSize(), PAGE_CACHE_MAX)
    const before = server.calls.length
    await fetchPage('https://realtimeavatar.ai/docs/p0.md', { timeoutMs: 5000, now: () => 1_000_000 + PAGE_FRESH_MS })
    assert.equal(server.calls[before].ifNoneMatch, null, 'p0 was evicted, so it is fetched unconditionally')
    await fetchPage('https://realtimeavatar.ai/docs/p1.md', { timeoutMs: 5000, now: () => 1_000_000 + PAGE_FRESH_MS })
    assert.equal(server.calls[before + 1].ifNoneMatch, null, 'p1 went next once p0 was re-added')
    await fetchPage('https://realtimeavatar.ai/docs/p3.md', { timeoutMs: 5000, now: () => 1_000_000 + PAGE_FRESH_MS })
    assert.equal(server.calls[before + 2].ifNoneMatch, '"e3"', 'a page that is still cached revalidates')
  } finally {
    server.restore()
    resetPageCache()
  }
})

test('an already-aborted caller signal wins over a fresh cache entry', async () => {
  resetPageCache()
  const server = etagServer({ [PAGE_URL]: { etag: '"v1"', body: '# Sessions v1' } })
  try {
    await fetchPage(PAGE_URL, { timeoutMs: 5000 })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(() => fetchPage(PAGE_URL, { timeoutMs: 5000, signal: controller.signal }), /cancelled before it started/)
    assert.equal(server.calls.length, 1)
  } finally {
    server.restore()
    resetPageCache()
  }
})

test('rta_docs then rta_quickstart on the same page cost one request', async () => {
  resetPageCache()
  const { buildRtaTools } = await import('../lib/tools/index.js')
  const { resolveConfig } = await import('../lib/config.js')
  const url = 'https://realtimeavatar.ai/docs/express.md'
  const server = etagServer({ [url]: { etag: '"x"', body: '# Express\n\n- Updated: 2026-09-01\n\n## Server half\n\n```ts\nconst s = 1\n```\n\n## Client half\n\n```tsx\nconst c = 1\n```\n' } })
  try {
    const tools = buildRtaTools({ cfg: resolveConfig({}), keySource: () => ({ credentials: undefined, env: {} }), randomUUID: () => 'u', skillsDir: fixtures + '../../skills/' })
    const docs = tools.find((t) => t.name === 'rta_docs')
    const quick = tools.find((t) => t.name === 'rta_quickstart')
    const page = await docs.execute({ page: 'express' }, {})
    assert.match(page.markdown, /Server half/)
    const q = await quick.execute({ framework: 'express' }, {})
    assert.equal(q.source, 'live')
    assert.equal(server.calls.length, 1, 'the second tool reads the cached page')
  } finally {
    server.restore()
    resetPageCache()
  }
})
