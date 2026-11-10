// One Codex turn's bookkeeping (task 4.2). The runtime mints the turn id and,
// for a submitted turn, the message UUID (sent as clientUserMessageId); the
// app-server's own turn id binds to it from the turn/start reply or the
// turn/started notification, whichever comes first, and never changes after.
// Facts belong to the turn whose native id they name: tool and compaction
// items count once per item id (R03), usage is the turn's own reported
// requests, and unknown values stay null (R08).
import type { TurnOutcome, TurnResult } from '../contract.js'
import type { AgentErrorInfo } from '../errors.js'
import type { TokenUsage } from '../usage/types.js'

export interface CodexTurnState {
  turnId: string
  /** The opening message, or null for an agent-started turn. */
  messageUuid: string | null
  text: string
  opened: boolean
  settled: boolean
  /** The app-server's turn id once known. */
  codexTurnId: string | null
  /** Resolves with the native id at its binding (steer and interrupt wait on it). */
  native: Promise<string>
  bind(codexTurnId: string): void
  finalText: string | null
  model: string | null
  usage: TokenUsage | null
  readonly toolIds: Set<string>
  readonly compactionIds: Set<string>
  /** turn/interrupt was sent (or is owed once the native id is known). */
  interruptOwed: boolean
  resolve(result: TurnResult): void
  result: Promise<TurnResult>
}

export function newCodexTurn(turnId: string, messageUuid: string | null, text: string, model: string | null): CodexTurnState {
  let resolve!: (result: TurnResult) => void
  const result = new Promise<TurnResult>((r) => (resolve = r))
  let bound!: (id: string) => void
  const native = new Promise<string>((r) => (bound = r))
  const turn: CodexTurnState = {
    turnId, messageUuid, text, opened: false, settled: false, codexTurnId: null, native,
    bind: (id) => {
      if (turn.codexTurnId !== null) return
      turn.codexTurnId = id
      bound(id)
    },
    finalText: null, model, usage: null, toolIds: new Set(), compactionIds: new Set(), interruptOwed: false, resolve, result,
  }
  return turn
}

export function codexTurnResult(turn: CodexTurnState, outcome: TurnOutcome, error: AgentErrorInfo | null): TurnResult {
  return {
    turnId: turn.turnId,
    messageUuid: turn.messageUuid,
    outcome,
    finalText: outcome === 'success' ? turn.finalText : null,
    model: turn.model,
    usage: turn.usage ? { ...turn.usage } : null,
    toolCallCount: turn.toolIds.size,
    compactionCount: turn.compactionIds.size,
    error,
  }
}
