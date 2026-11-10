// One Codex turn's bookkeeping (task 4.2). The runtime mints the turn id and,
// for a submitted turn, the message UUID (sent as clientUserMessageId); the
// app-server's own turn id binds to it from the turn/start reply or the
// turn/started notification, whichever comes first, and never changes after.
// Facts belong to the turn whose native id they name: tool and compaction
// items count once per item id (R03), usage is the turn's own reported
// requests, and unknown values stay null (R08).
import type { TurnOutcome, TurnResult } from '../contract.js'
import type { AgentErrorInfo } from '../errors.js'
import type { EventBody } from '../eventStream.js'
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
  /** Each native item's accepted phase in this turn (facts.ts): a duplicate or regressive phase is rejected. */
  readonly itemPhases: Map<string, 'started' | 'completed'>
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
    finalText: null, model, usage: null, toolIds: new Set(), compactionIds: new Set(), itemPhases: new Map(), interruptOwed: false, resolve, result,
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

export interface SettleHost {
  emit(body: EventBody): void
  notify(name: string, callback: () => void): void
  onTurnResult: ((result: TurnResult) => void) | undefined
}

/**
 * Decide a turn's terminal result now, marking it settled with no callback,
 * and return the step that publishes it: turn_interrupted or turn_completed
 * only for a turn that opened, then its handle, then onTurnResult, once. Null
 * when the turn was already decided.
 */
export function decideTurn(turn: CodexTurnState, outcome: TurnOutcome, error: AgentErrorInfo | null, subtype: string, terminalReason: string | null, host: SettleHost): (() => void) | null {
  if (turn.settled) return null
  turn.settled = true
  const result = codexTurnResult(turn, outcome, error)
  return () => {
    if (turn.opened && outcome === 'interrupted') host.emit({ type: 'turn_interrupted', turnId: turn.turnId })
    else if (turn.opened) {
      host.emit({
        type: 'turn_completed', turnId: turn.turnId, subtype, isError: outcome !== 'success', usage: result.usage, finalText: result.finalText,
        totalCostUsd: null, providerCostUsd: null, numTurns: null, terminalReason,
      })
    }
    turn.resolve(result)
    const onTurnResult = host.onTurnResult
    if (onTurnResult) host.notify('onTurnResult', () => onTurnResult(result))
  }
}

export const INTERRUPTED: AgentErrorInfo = { category: 'stopped', message: 'the turn was interrupted' }

/** A turn/completed frame's outcome: failed (with the error `turnError` classifies), interrupted, or success. */
export function completionOutcome(raw: { status?: unknown; error?: unknown }, turnError: () => AgentErrorInfo): { outcome: TurnOutcome; error: AgentErrorInfo | null } {
  const failed = raw.status === 'failed' || (raw.error != null && raw.status !== 'completed' && raw.status !== 'interrupted')
  if (failed) return { outcome: 'failed', error: turnError() }
  return raw.status === 'interrupted' ? { outcome: 'interrupted', error: INTERRUPTED } : { outcome: 'success', error: null }
}
