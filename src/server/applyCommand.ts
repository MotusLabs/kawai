// applyCommand.ts - The per-agent apply command map and launch-argument
// composition for the change apply auto-start. The selected agent plus change
// name are composed into the session's start command as a shell-quoted argv
// positional — the agent itself holds its first prompt until trust/login
// gates clear, so there is nothing to schedule and no idle-status trigger.
// The prompt is never sent as terminal input.

import type { AutoStartAgent } from '../shared/types'
import { isValidChangeName } from '../shared/workspaceValidation'
import { shellQuote } from './shellQuote'

/**
 * Per-agent-type apply command map. `claude-rp` writes Claude-family logs
 * and takes the same command. `pi` has no apply equivalent — unrecognized.
 */
const APPLY_COMMANDS: Record<string, (change: string) => string> = {
  'claude': (change) => `/opsx:apply ${change}`,
  'claude-rp': (change) => `/opsx:apply ${change}`,
  'codex': (change) => `$openspec-apply-change ${change}`,
}

/** The mapped apply command, or null when the agent type is unrecognized. */
export function applyCommandFor(agentType: string | null | undefined, change: string): string | null {
  const build = agentType ? APPLY_COMMANDS[agentType] : undefined
  return build ? build(change) : null
}

/**
 * Compose the selected agent's apply prompt onto a start command as a
 * single-quoted argv positional. Single quotes are mandatory, not cosmetic:
 * the command reaches tmux as one string and runs through `sh -c`, where the
 * Codex form `$openspec-apply-change <change>` must survive unexpanded.
 * Returns the command unchanged when no agent is selected, the agent is
 * unrecognized, or the change name is invalid — the session then starts
 * with no first prompt. A blank base command falls back to the agent itself.
 */
export function composeAutoStartCommand(
  command: string | undefined,
  agent: AutoStartAgent | undefined,
  change: string | undefined
): string | undefined {
  if (!agent || !change || !isValidChangeName(change)) {
    return command
  }
  const prompt = applyCommandFor(agent, change)
  if (prompt === null) {
    return command
  }
  const base = command?.trim() || agent
  return `${base} ${shellQuote(prompt)}`
}
