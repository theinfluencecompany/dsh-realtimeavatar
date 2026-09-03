/**
 * Shared tool plumbing: the definition shape dsh's ToolRuntime accepts,
 * parameter compilation, argument narrowing, cancellation handling and the
 * per-call key resolution.
 *
 * @module dsh-realtimeavatar/tools/shared
 */
import type { CallContext } from '../api.js'
import type { ResolvedRtaConfig } from '../config.js'
import { resolveKey, type KeySource } from '../credentials.js'
import { redactSecrets } from '../redact.js'

/** A model-visible content block. */
export interface ContentBlock {
  type: 'text'
  text: string
}

/** The raw tool definition passed to ctx.tools.register. */
export interface RtaToolDefinition {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: unknown, exec: unknown): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
}

/** Everything the tools need from the plugin, injectable for tests. */
export interface ToolDeps {
  cfg: ResolvedRtaConfig
  /** Evaluated per call so a credential service that appears later is picked up. */
  keySource: () => KeySource
  randomUUID: () => string
  /** Absolute path of the shipped skills directory (snapshot fallback for rta_quickstart). */
  skillsDir: string
  configError?: string
}

export interface ParamSpec {
  type?: string
  description?: string
  required?: boolean
  items?: unknown
  enum?: readonly string[]
  properties?: Record<string, unknown>
}

export function compileParameters(spec: Record<string, ParamSpec>): RtaToolDefinition['parameters'] {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, prop] of Object.entries(spec)) {
    if (prop.required === true) required.push(key)
    const node: Record<string, unknown> = {}
    if (typeof prop.type === 'string') node.type = prop.type
    if (typeof prop.description === 'string') node.description = prop.description
    if (prop.items !== undefined) node.items = prop.items
    if (prop.enum !== undefined) node.enum = [...prop.enum]
    if (prop.properties !== undefined) node.properties = prop.properties
    properties[key] = node
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** The harness's cancellation signal from the second execute() argument, when present. */
export function signalOf(exec: unknown): AbortSignal | undefined {
  const signal = asRecord(exec).signal
  return signal instanceof AbortSignal ? signal : undefined
}

/**
 * Run a tool body under the harness's cancellation signal. When the harness
 * aborted the call, settle with `empty` instead of throwing: dsh reports a body
 * that resolves after its signal aborted as its canonical ABORTED outcome.
 */
export async function cancellable(signal: AbortSignal | undefined, empty: unknown, body: () => Promise<unknown>): Promise<unknown> {
  try {
    return await body()
  } catch (error) {
    if (isAborted(signal)) return empty
    throw error
  }
}

/** Read `aborted` through a call so TypeScript does not narrow the property across awaits. */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

export function optionalString(args: Record<string, unknown>, key: string, max = 8000): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(key + ' must be a string.')
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > max) throw new Error(key + ' is longer than ' + max + ' characters.')
  return trimmed
}

export function requiredString(args: Record<string, unknown>, key: string, max = 8000): string {
  const value = optionalString(args, key, max)
  if (value === undefined) throw new Error(key + ' is required and must be a non-empty string.')
  return value
}

export function optionalInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(key + ' must be an integer.')
  if (value < min || value > max) throw new Error(key + ' must be between ' + min + ' and ' + max + '.')
  return value
}

export function optionalEnum<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const value = optionalString(args, key, 64)
  if (value === undefined) return undefined
  const found = allowed.find((item) => item === value.toLowerCase())
  if (found === undefined) throw new Error(key + ' must be one of: ' + allowed.join(', ') + '.')
  return found
}

export function optionalRecord(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(key + ' must be an object.')
  return value as Record<string, unknown>
}

/** Resolve the key and build the per-call context. Throws a coded KeyError when no key is usable. */
export async function callContext(deps: ToolDeps, signal: AbortSignal | undefined): Promise<CallContext> {
  const apiKey = await resolveKey(deps.keySource(), deps.cfg.apiKeyEnv)
  return { apiKey, signal, timeoutMs: deps.cfg.requestTimeoutMs }
}

/** Keep a sliced string well-formed (no lone surrogate at the cut). */
function wellFormed(text: string): string {
  return typeof text.toWellFormed === 'function' ? text.toWellFormed() : text
}

/** Render any value as redacted, pretty JSON (total: never throws). */
export function renderJson(value: unknown, maxChars = 6000): ContentBlock[] {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = String(value)
  }
  const redacted = redactSecrets(text)
  return [{ type: 'text', text: redacted.length > maxChars ? wellFormed(redacted.slice(0, maxChars)) + '\n…(truncated)' : redacted }]
}

/** Redacted text block. */
export function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text: redactSecrets(text) }]
}

/**
 * Redacting boundary around a tool body: errors the plugin constructs are
 * already redacted; anything else (a credential service rejecting with the
 * secret in its message, a serialisation failure) is re-thrown redacted so no
 * exception can carry the key to the model.
 */
export function guarded(definition: RtaToolDefinition): RtaToolDefinition {
  const execute = definition.execute
  return {
    ...definition,
    async execute(args, exec) {
      try {
        return await execute(args, exec)
      } catch (error) {
        const name = error instanceof Error ? error.name : ''
        if (name === 'RtaApiError' || name === 'KeyError') throw error
        throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)))
      }
    },
  }
}

/** Common schema fragment. */
export const ANY_OBJECT = { type: 'object', additionalProperties: true } as const

/**
 * A nullable scalar/object in dsh's JSON-schema subset: type arrays are not
 * supported, exact-one `oneOf` with a `null` branch is.
 */
export function nullable(type: 'string' | 'number' | 'integer' | 'boolean' | 'object'): { oneOf: Array<Record<string, unknown>> } {
  return { oneOf: [type === 'object' ? { type: 'object', additionalProperties: true } : { type }, { type: 'null' }] }
}
