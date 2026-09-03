/**
 * Documentation tools: rta_docs (live page fetch from the closed public page
 * set) and rta_quickstart (framework page + extracted skeletons, with the
 * shipped skill snapshot as an offline fallback). No key needed.
 *
 * @module dsh-realtimeavatar/tools/docs
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clampText, fetchPage, pageRef, PAGE_SLUGS, sectionByHeading, stripFooter, summarizeOpenApi, updatedOn } from '../docs.js'
import { AGENT_PROMPT, DOC_PAGES, ENV_VAR, EXAMPLE_AVATAR_ID, SDK_PACKAGE, URLS } from '../facts.js'
import { asRecord, cancellable, compileParameters, optionalEnum, optionalInt, optionalString, signalOf, textBlock, nullable, type RtaToolDefinition, type ToolDeps } from './shared.js'

const FRAMEWORKS = ['nextjs', 'tanstack-start', 'express', 'hono', 'react'] as const
type Framework = (typeof FRAMEWORKS)[number]

/**
 * First fenced code block inside the section whose heading contains `marker`
 * (case-insensitive). Fences (``` or ~~~) are tracked from the first line so a
 * heading-looking line inside code never arms the search, and the search stops
 * at the next heading of the same or higher level.
 */
export function codeBlockAfter(markdown: string, marker: string): string | null {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const wanted = marker.toLowerCase()
  let armed = false
  let level = 0
  let fence: string | null = null
  const buf: string[] = []
  for (const line of lines) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line)
    if (fenceMatch !== null && (fence === null || fenceMatch[1] === fence)) {
      if (fence === null) fence = fenceMatch[1]
      else {
        if (armed) return buf.join('\n')
        fence = null
      }
      continue
    }
    if (fence !== null) {
      if (armed) buf.push(line)
      continue
    }
    const heading = /^(#{1,6}) (.*)$/.exec(line)
    if (heading === null) continue
    if (!armed) {
      if (heading[2].toLowerCase().includes(wanted)) {
        armed = true
        level = heading[1].length
      }
    } else if (heading[1].length <= level) {
      return null // the section ended without a code block
    }
  }
  return null
}

export function buildDocsTools(deps: ToolDeps): RtaToolDefinition[] {
  const cfg = deps.cfg
  const DT = cfg.docsTimeoutMs

  const rtaDocs: RtaToolDefinition = {
    name: 'rta_docs',
    description: 'Current text of one public realtimeavatar.ai docs page as markdown (no key needed): index is the llms.txt agent guide, openapi the operation table. heading returns one section; maxChars caps the output. The realtimeavatar-* skills hold a snapshot of the same pages; use this when freshness matters.',
    parameters: compileParameters({
      page: { type: 'string', required: true, enum: PAGE_SLUGS, description: 'Page slug.' },
      heading: { type: 'string', description: 'Only this section (case-insensitive heading text).' },
      maxChars: { type: 'integer', description: 'Cap on returned characters (default ' + cfg.docsMaxChars + ').' },
    }),
    output: {
      schema: { type: 'object', properties: { page: { type: 'string' }, url: { type: 'string' }, canonical: { type: 'string' }, updated: nullable('string'), chars: { type: 'integer' }, truncated: { type: 'boolean' }, markdown: { type: 'string' } }, required: ['page', 'url', 'canonical', 'chars', 'truncated', 'markdown'], additionalProperties: true },
      render: (_args, value) => {
        const rec = asRecord(value)
        return textBlock('# ' + String(rec.page) + ' — ' + String(rec.canonical) + (rec.updated ? ' (updated ' + String(rec.updated) + ')' : '') + (rec.truncated === true ? ' [truncated]' : '') + '\n\n' + String(rec.markdown ?? ''))
      },
    },
    async execute(rawArgs, exec) {
      const signal = signalOf(exec)
      const args = asRecord(rawArgs)
      const page = optionalString(args, 'page', 64)
      if (page === undefined) throw new Error('page is required; one of ' + PAGE_SLUGS.join(', ') + '.')
      const ref = pageRef(page.toLowerCase())
      const heading = optionalString(args, 'heading', 200)
      const maxChars = Math.min(optionalInt(args, 'maxChars', 200, 200000) ?? cfg.docsMaxChars, cfg.docsMaxChars)
      const empty = { page: ref.slug, url: ref.url, canonical: ref.canonical, updated: null, chars: 0, truncated: false, markdown: '' }
      return cancellable(signal, empty, async () => {
        const raw = await fetchPage(ref.url, { signal, timeoutMs: DT })
        let markdown: string
        if (ref.slug === 'openapi') {
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            throw new Error('openapi.json did not parse as JSON')
          }
          markdown = summarizeOpenApi(parsed)
        } else {
          markdown = stripFooter(raw)
        }
        if (heading !== undefined) {
          const section = sectionByHeading(markdown, heading)
          if (section === null) throw new Error('no heading "' + heading + '" on page ' + ref.slug + '.')
          markdown = section
        }
        const clamped = clampText(markdown, maxChars)
        return { page: ref.slug, url: ref.url, canonical: ref.canonical, updated: updatedOn(raw), chars: clamped.text.length, truncated: clamped.truncated, markdown: clamped.text }
      })
    },
    timeoutMs: DT,
    isConcurrencySafe: () => true,
  }

  const rtaQuickstart: RtaToolDefinition = {
    name: 'rta_quickstart',
    description: 'Integration page for one framework with the server-half and client-half code skeletons extracted, the env var (' + ENV_VAR + '), the public example avatar (' + EXAMPLE_AVATAR_ID + ') and the public first-app prompt. Fetched live; the shipped snapshot is the offline fallback. No key needed.',
    parameters: compileParameters({ framework: { type: 'string', required: true, enum: FRAMEWORKS, description: 'Target framework.' } }),
    output: {
      schema: { type: 'object', properties: { framework: { type: 'string' }, docsUrl: { type: 'string' }, source: { type: 'string' }, markdown: { type: 'string' }, serverSkeleton: nullable('string'), clientSkeleton: nullable('string'), envVar: { type: 'string' }, exampleAvatarId: { type: 'string' }, agentPrompt: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } }, required: ['framework', 'docsUrl', 'source', 'markdown', 'envVar', 'exampleAvatarId', 'agentPrompt', 'steps'], additionalProperties: true },
      render: (_args, value) => {
        const rec = asRecord(value)
        const steps = Array.isArray(rec.steps) ? rec.steps.map((s, i) => String(i + 1) + '. ' + String(s)).join('\n') : ''
        return textBlock('# Quickstart for ' + String(rec.framework) + ' (' + String(rec.source) + ') — ' + String(rec.docsUrl) + '\n\n' + steps + '\n\n' + String(rec.markdown ?? ''))
      },
    },
    async execute(rawArgs, exec) {
      const signal = signalOf(exec)
      const framework = optionalEnum(asRecord(rawArgs), 'framework', FRAMEWORKS)
      if (framework === undefined) throw new Error('framework is required; one of ' + FRAMEWORKS.join(', ') + '.')
      const ref = pageRef(framework)
      const isReact = framework === 'react'
      const steps = [
        'npm install ' + SDK_PACKAGE + ' — the SDK is public on npm; pin an exact version.',
        'Put the key in ' + ENV_VAR + ' on the SERVER only (never a NEXT_PUBLIC_/VITE_ name); the harness holds it for you here — run /rta status.',
        isReact
          ? 'React is the client half only: pair it with one of the server adapters (nextjs, tanstack-start, express, hono) that mounts the route holding the key.'
          : 'Mount the server half (the route adapter) with authorize + session policy; put the wallet check on the connect operation' + (framework === 'hono' ? ' (on Workers pass apiKey as a factory that reads the binding)' : '') + '.',
        'Render the client half with AvatarCall pointed at your route; start on the public example avatar ' + EXAMPLE_AVATAR_ID + '.',
        'Set maxSeconds from the balance you admitted; end calls with sayAndEnd; release early.',
        'Then create your own avatar (realtimeavatar-avatars skill, rta_avatar_create) and swap the id.',
      ]
      const base = { framework, docsUrl: ref.canonical, envVar: ENV_VAR, exampleAvatarId: EXAMPLE_AVATAR_ID, agentPrompt: AGENT_PROMPT, steps }
      const empty = { ...base, source: 'cancelled', markdown: '', serverSkeleton: null, clientSkeleton: null }
      return cancellable(signal, empty, async () => {
        let markdown: string
        let source: 'live' | 'snapshot'
        try {
          // Leave headroom under the tool deadline so the snapshot fallback is reachable when the network hangs.
          markdown = stripFooter(await fetchPage(ref.url, { signal, timeoutMs: Math.max(1000, DT - 1500) }))
          source = 'live'
        } catch (error) {
          if (signal?.aborted === true) throw error
          markdown = await snapshotSection(deps.skillsDir, framework)
          source = 'snapshot'
        }
        const clamped = clampText(markdown, cfg.docsMaxChars)
        const serverSkeleton = isReact ? null : codeBlockAfter(markdown, 'server half')
        const clientSkeleton = isReact ? codeBlockAfter(markdown, 'the component') : codeBlockAfter(markdown, 'client half')
        return { ...base, source, markdown: clamped.text, serverSkeleton, clientSkeleton, ...(isReact ? { reactNativeSkeleton: codeBlockAfter(markdown, 'react native') } : {}) }
      })
    },
    timeoutMs: DT,
    isConcurrencySafe: () => true,
  }

  return [rtaDocs, rtaQuickstart]
}

/** The framework's section from the shipped integrate skill (offline fallback). */
async function snapshotSection(skillsDir: string, framework: Framework): Promise<string> {
  const title = DOC_PAGES.find((p) => p.slug === framework)?.title ?? framework
  let text: string
  try {
    text = await readFile(join(skillsDir, 'realtimeavatar-integrate.md'), 'utf8')
  } catch {
    throw new Error('the docs page could not be fetched and no snapshot is available; see ' + URLS.docs + '/' + framework)
  }
  const section = sectionByHeading(text.replace(/\r\n/g, '\n'), title)
  if (section === null) throw new Error('the docs page could not be fetched and the snapshot has no "' + title + '" section; see ' + URLS.docs + '/' + framework)
  return section + '\n\n(From the shipped snapshot; the live page may be newer: ' + URLS.docs + '/' + framework + ')'
}
