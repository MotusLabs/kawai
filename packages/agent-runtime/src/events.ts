// Core conversation events (design §6). Every event is a JSON value with a
// stable id and an increasing sequence within one stream identity; a resumed
// driver starts a fresh stream, so its events never collide with archived
// ones (R07). Host-specific events (Kawai's peer mail, workspace context,
// auto-answer deadlines) are host extensions, not members of this union.
import type { JsonValue } from './json.js'
import type { AgentErrorInfo } from './errors.js'
import type { TokenUsage } from './usage/types.js'

export interface AgentEventBase {
  /** Stable and unique across streams. */
  id: string
  /** The emitter's stream identity: one per driver generation of a conversation. */
  streamId: string
  /** 1-based, strictly increasing within streamId. */
  sequence: number
  /** ISO time the event was produced, or null when unknown. */
  at: string | null
}

export interface AgentTurnEventBase extends AgentEventBase {
  turnId: string
}

export interface AgentQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: Array<{ label: string; description?: string; preview?: string }>
  /** Codex: the answer is secret. */
  isSecret?: boolean
  /** Codex: whether a free-text answer is allowed (absent = allowed). */
  isOther?: boolean
}

export interface QuestionAnswer {
  options?: string[]
  text?: string
}

/** Answers keyed by question text. */
export type QuestionAnswers = Record<string, QuestionAnswer>

export type RequestOutcome = 'allowed' | 'denied' | 'answered' | 'cancelled'

/** A pending approval or question, as passed to onRequest. */
export type PendingRequest =
  | { kind: 'approval'; requestId: string; turnId: string; tool: string; input: JsonValue; at: string }
  | { kind: 'question'; requestId: string; turnId: string; questions: AgentQuestion[]; at: string }

export type AgentEvent =
  | (AgentTurnEventBase & { type: 'turn_started'; trigger?: { kind: 'task' | 'resumed' } })
  | (AgentTurnEventBase & { type: 'user_message'; text: string; messageUuid: string })
  | (AgentTurnEventBase & { type: 'command_output'; text: string })
  | (AgentTurnEventBase & { type: 'assistant_text'; messageId: string; text: string })
  | (AgentTurnEventBase & { type: 'assistant_delta'; messageId: string; delta: string })
  | (AgentTurnEventBase & { type: 'tool_call'; toolCallId: string; tool: string; input: JsonValue })
  | (AgentTurnEventBase & { type: 'tool_result'; toolCallId: string; output: string; isError: boolean })
  | (AgentTurnEventBase & { type: 'approval_request'; requestId: string; tool: string; input: JsonValue })
  | (AgentTurnEventBase & { type: 'question_request'; requestId: string; questions: AgentQuestion[] })
  | (AgentEventBase & {
      type: 'request_resolved'
      requestId: string
      outcome: RequestOutcome
      /** Who settled it: `caller`, `policy`, or the attribution the caller passed. */
      decidedBy?: string
      tool?: string
    })
  | (AgentTurnEventBase & {
      type: 'turn_completed'
      subtype: string
      isError: boolean
      usage: TokenUsage | null
      finalText: string | null
      totalCostUsd: number | null
      providerCostUsd: number | null
      numTurns: number | null
      terminalReason: string | null
    })
  | (AgentTurnEventBase & { type: 'turn_interrupted' })
  | (AgentEventBase & { type: 'notice'; text: string; kind?: 'compacted' })
  | (AgentEventBase & { type: 'error'; error: AgentErrorInfo })

export type AgentEventType = AgentEvent['type']
