// agentDetection.ts - Shared agent type detection logic
// Used by both SessionManager and sessionRefreshWorker

import type { AgentType } from '../shared/types'
import { resolveAgentToken } from '../shared/agentToken'

// Token resolution and pane-command normalization live in shared/agentToken so
// the session form's prefix rule consumes the same walk as exact matching.
export { normalizePaneStartCommand, resolveAgentToken } from '../shared/agentToken'

export type AgentFamily = 'claude' | 'codex' | 'pi'

/** Collapse agent variants onto the log family they write to (claude-rp -> claude). */
export function agentFamily(agentType: AgentType | null | undefined): AgentFamily | null {
  if (!agentType) return null
  return agentType === 'claude-rp' ? 'claude' : agentType
}

/**
 * Infer agent type from the pane start command, by exact match on the
 * resolved agent token. Wrappers (claude-glm, codex-foo) stay undefined here —
 * the log family backfills them once their JSONL is discovered — while the
 * session form's prefix rule (autoStartAgentFromToken) guesses them visibly.
 * Handles various invocation patterns:
 * - Full paths: /usr/local/bin/claude -> claude
 * - Package runners: npx codex, bunx claude -> codex, claude
 * - Flags: claude --help, codex --search -> claude, codex
 * - Quoted commands: "codex --search" -> codex
 */
export function inferAgentType(command: string): AgentType | undefined {
  const token = resolveAgentToken(command)
  if (token === 'claude') {
    return 'claude'
  }
  if (token === 'codex') {
    return 'codex'
  }
  if (token === 'pi') {
    return 'pi'
  }
  return undefined
}
