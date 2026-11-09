// One Claude turn's bookkeeping (task 4.1): its identity, what the stream
// reported for it, and the single result every handle bound to it receives.
// Submitted turns carry the UUID of the message that opened them; an
// agent-started turn (L24) has none.
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { TurnOutcome, TurnResult } from '../contract.js'
import { AgentRuntimeError, type AgentErrorInfo } from '../errors.js'
import type { BeforeSubmit, SubmitContext } from '../options.js'

export interface Turn {
  turnId: string
  /** The opening message, or null for an agent-started turn. */
  messageUuid: string | null
  text: string
  /** Opened: turn_started was emitted (queued turns open later, L21). */
  opened: boolean
  settled: boolean
  finalText: string | null
  model: string | null
  resolve(result: TurnResult): void
  result: Promise<TurnResult>
}

export function newTurn(turnId: string, messageUuid: string | null, text: string): Turn {
  let resolve!: (result: TurnResult) => void
  const result = new Promise<TurnResult>((r) => {
    resolve = r
  })
  return { turnId, messageUuid, text, opened: false, settled: false, finalText: null, model: null, resolve, result }
}

export function turnResult(turn: Turn, outcome: TurnOutcome, error: AgentErrorInfo | null): TurnResult {
  return {
    turnId: turn.turnId,
    messageUuid: turn.messageUuid,
    outcome,
    finalText: outcome === 'success' ? turn.finalText : null,
    model: turn.model,
    usage: null,
    toolCallCount: 0,
    compactionCount: 0,
    error,
  }
}

/** The client UUIDs a result echoes (`user_message_uuids`, else `user_message_uuid`). */
export function resultUuids(message: SDKResultMessage): string[] {
  const raw = message as { user_message_uuids?: unknown; user_message_uuid?: unknown }
  if (Array.isArray(raw.user_message_uuids)) return raw.user_message_uuids.filter((uuid): uuid is string => typeof uuid === 'string')
  return typeof raw.user_message_uuid === 'string' ? [raw.user_message_uuid] : []
}

/** The error text for a failed result: the SDK's errors, else its result text, else the subtype. */
export function resultErrorText(message: SDKResultMessage): string {
  const base =
    'errors' in message && message.errors.length > 0
      ? message.errors.join('; ')
      : message.subtype === 'success' && message.result.trim()
        ? message.result.trim()
        : `The turn ended with ${message.subtype}`
  return message.terminal_reason ? `${base} (${message.terminal_reason})` : base
}

/**
 * P12/P13: the host's synchronous pre-submit decision. A refusal or throw
 * withdraws the admission and rejects with category `context` before
 * anything is enqueued or emitted.
 */
export function checkSubmission(beforeSubmit: BeforeSubmit | undefined, submission: SubmitContext): void {
  if (!beforeSubmit) return
  let decision: ReturnType<BeforeSubmit>
  try {
    decision = beforeSubmit(submission)
  } catch (error) {
    throw new AgentRuntimeError({ category: 'context', message: 'the pre-submit context callback threw' }, [error])
  }
  if (decision?.accepted === true) return
  const reason = decision && decision.accepted === false ? decision.reason : 'no decision returned'
  throw new AgentRuntimeError({ category: 'context', message: `the pre-submit context callback refused: ${reason}` })
}
