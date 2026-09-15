// pendingAutoStart.ts - Server-held pending first prompts for the change
// apply auto-start (§8.1-8.3). A create-session message carrying a change
// name maps by agent type to the apply command (Claude `/opsx:apply`,
// Codex its equivalent) and is held keyed to the new session id — server
// memory, so it survives client reloads in the gap between creation and
// agent readiness. The command is injected exactly once, through the same
// tmux send-keys path terminal input uses, the first time the session
// reports the idle (`waiting`) status. Nothing is held or sent when the
// agent type is unrecognized; entries are discarded with their session.

import { inferAgentType } from './agentDetection'
import type { Session } from '../shared/types'
import { isValidChangeName } from '../shared/workspaceValidation'

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

export interface PendingAutoStartEntry {
  /** OpenSpec change name the command was built from. */
  change: string
  /** Full command text to inject as the session's first input. */
  command: string
}

/**
 * Sends `text` (literal) followed by Enter to a tmux target; returns true
 * only when both keystrokes were accepted. Mirrors the proxy's input path:
 * `send-keys -t <target> -l -- <text>` then `send-keys -t <target> Enter`.
 */
export type AutoStartInputSender = (tmuxTarget: string, text: string) => boolean

export class PendingAutoStartStore {
  private readonly pending = new Map<string, PendingAutoStartEntry>()

  /**
   * Hold the pending prompt for one session, mapping the change name by the
   * agent type inferred from the session's start command. Returns false (and
   * holds nothing) for unrecognized agents or invalid change names.
   */
  holdFromCommand(sessionId: string, startCommand: string | undefined, change: string): boolean {
    if (!isValidChangeName(change)) return false
    const agentType = inferAgentType(startCommand ?? '')
    const command = applyCommandFor(agentType, change)
    if (command === null) return false
    this.pending.set(sessionId, { change, command })
    return true
  }

  discard(sessionId: string): void {
    this.pending.delete(sessionId)
  }

  /** Keep only entries whose session id is still present. */
  retainAll(sessionIds: Set<string>): void {
    for (const sessionId of this.pending.keys()) {
      if (!sessionIds.has(sessionId)) {
        this.pending.delete(sessionId)
      }
    }
  }

  get(sessionId: string): PendingAutoStartEntry | undefined {
    return this.pending.get(sessionId)
  }

  get size(): number {
    return this.pending.size
  }

  /**
   * Inject the pending command into every known local session whose status
   * is `waiting` — the first idle report after creation — and drop the
   * entry, so a later refresh can never trigger it twice. Remote sessions
   * have no local terminal-input path and are left untouched. Returns the
   * injected session ids in input order.
   */
  injectWaiting(sessions: Session[], send: AutoStartInputSender): string[] {
    const injected: string[] = []
    for (const session of sessions) {
      const entry = this.pending.get(session.id)
      if (!entry) continue
      if (session.remote) continue
      // `waiting` is the idle status; `permission` is mid-task approval and
      // must not receive a new command.
      if (session.status !== 'waiting') continue
      if (send(session.tmuxWindow, entry.command)) {
        this.pending.delete(session.id)
        injected.push(session.id)
      }
    }
    return injected
  }
}
