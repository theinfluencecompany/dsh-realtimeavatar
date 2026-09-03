/**
 * dsh-realtimeavatar — Realtime Avatar (realtimeavatar.ai) for the DeepSeek
 * Harness, built on the Cordis plugin framework.
 *
 * `apply` resolves the config, installs the write-approval gate, registers the
 * rta_* tools, and — when the respective services are composed — a short
 * system-prompt section, the five docs skills and the `/rta` command. Every
 * registration is a fiber-owned effect: cordis removes it when the plugin
 * unloads or reloads, so there is no manual teardown.
 *
 * @module dsh-realtimeavatar
 */
import { randomUUID } from 'node:crypto'
import { buildRtaCommand } from './commands.js'
import { resolveConfig, type RtaConfig, type ResolvedRtaConfig } from './config.js'
import type { CredentialService, KeySource } from './credentials.js'
import { decide } from './gate.js'
import { buildPromptSection } from './prompt.js'
import { createSkillProvider, defaultSkillsDir } from './skills.js'
import { redactSecrets } from './redact.js'
import { buildRtaTools } from './tools/index.js'
import { guarded, type ToolDeps } from './tools/shared.js'

export const name = 'realtimeavatar'
export const inject = ['tools']

type Disposer = () => void

/** A pending tool execution as seen by the pre-execute gate (dsh-tools ToolExecution). */
interface PreExecuteEvent {
  name: string
  arguments?: unknown
}
type PreExecuteVerdict = { kind: 'allow' | 'deny' | 'ask'; reason?: string }
type PreExecuteListener = (event: PreExecuteEvent, next: () => Promise<PreExecuteVerdict>) => Promise<PreExecuteVerdict>

/** The subset of the Cordis context this plugin uses. Optional members degrade gracefully. */
export interface PluginContext {
  tools: { register(definition: unknown): Disposer }
  on(event: 'tools/pre-execute', listener: PreExecuteListener): void
  /** Optional service lookup (cordis `ctx.get`). */
  get?(name: string): unknown
  /** Optional dependency-scoped sub-fiber (cordis `ctx.inject`). */
  inject?(deps: string[], callback: (scope: ScopedContext) => void): unknown
}

/** What the sub-fibers see once their services exist. */
export interface ScopedContext {
  systemPrompt?: { section(section: { name: string; order: number; text: string }): Disposer }
  skills?: { registerProvider(create: () => unknown): Disposer }
  commands?: { register(definition: unknown): Disposer }
}

function isCredentialService(value: unknown): value is CredentialService {
  return typeof value === 'object' && value !== null && typeof (value as { resolve?: unknown }).resolve === 'function' && typeof (value as { describe?: unknown }).describe === 'function'
}

/** Key source evaluated per call: the credential service if composed, else the launch environment. */
function keySourceFor(ctx: PluginContext): () => KeySource {
  return () => {
    const service = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    return { credentials: isCredentialService(service) ? service : undefined, env: process.env }
  }
}

/** Plugin entry. */
export function apply(ctx: PluginContext, config: RtaConfig | undefined | null): void {
  let cfg: ResolvedRtaConfig
  let configError: string | undefined
  try {
    cfg = resolveConfig(config)
  } catch (error) {
    // Redacted: a misconfiguration might have put a key where a name belongs.
    configError = redactSecrets(error instanceof Error ? error.message : String(error))
    // eslint-disable-next-line no-console -- surface misconfig at boot; redacted above.
    console.warn('[dsh-realtimeavatar] invalid config, falling back to defaults: ' + configError)
    cfg = resolveConfig(null)
  }
  if (!cfg.readOnly && !cfg.writeApproval) {
    // eslint-disable-next-line no-console -- an ungated write path deserves one boot-time line.
    console.warn('[dsh-realtimeavatar] writeApproval:false — free writes (asset/avatar update/delete) run without approval; credit-spending tools still ask.')
  }

  const deps: ToolDeps = {
    cfg,
    keySource: keySourceFor(ctx),
    randomUUID: () => randomUUID(),
    skillsDir: defaultSkillsDir(),
    ...(configError !== undefined ? { configError } : {}),
  }

  ctx.on('tools/pre-execute', async (event, next) => {
    const verdict = decide(cfg, event.name, event.arguments)
    // Never force-allow: a later policy listener (plan mode, a deployment policy) must still see the call.
    if (verdict === null || verdict.kind === 'allow') return next()
    if (verdict.kind === 'deny') return verdict
    // ask: a downstream deny wins over our approval prompt.
    const downstream = await next()
    return downstream.kind === 'deny' ? downstream : verdict
  })

  for (const definition of buildRtaTools(deps)) ctx.tools.register(guarded(definition))

  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt?.section(buildPromptSection(cfg))
    })
    ctx.inject(['skills'], (scope) => {
      const provider = createSkillProvider(deps.skillsDir)
      scope.skills?.registerProvider(() => provider)
    })
    ctx.inject(['commands'], (scope) => {
      scope.commands?.register(buildRtaCommand(deps))
    })
  }
}

export * from './config.js'
export * from './credentials.js'
export * from './redact.js'
export * from './client.js'
export * from './api.js'
export * from './docs.js'
export * from './facts.js'
export * from './gate.js'
export * from './prompt.js'
export * from './skills.js'
export * from './commands.js'
export { buildRtaTools, collectStatus, renderStatus } from './tools/index.js'
export type { RtaToolDefinition, ToolDeps, ContentBlock, StatusReport } from './tools/index.js'
