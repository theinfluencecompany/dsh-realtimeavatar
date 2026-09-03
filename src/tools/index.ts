/**
 * All rta_* tool definitions.
 *
 * @module dsh-realtimeavatar/tools
 */
import { buildDocsTools } from './docs.js'
import { buildReadTools } from './read.js'
import type { RtaToolDefinition, ToolDeps } from './shared.js'
import { buildWriteTools } from './write.js'

export function buildRtaTools(deps: ToolDeps): RtaToolDefinition[] {
  return [...buildReadTools(deps), ...buildWriteTools(deps), ...buildDocsTools(deps)]
}

export type { RtaToolDefinition, ToolDeps, ContentBlock } from './shared.js'
export { collectStatus, renderStatus, type StatusReport } from './read.js'
