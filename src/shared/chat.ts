// Chat-session wire contract: conversation events, the WebSocket message
// payloads that carry them, the ephemeral live-turn activity, and the raw
// protocol frames shown by the chat debug view. Shared between the server's
// chat driver/WS layer and the client's chat stores. All SDK-specific types
// stay in the driver; this file is SDK-agnostic so the client never imports
// the agent SDK.

/**
 * Base shape of every conversation event. `id` is stable and unique
 * (clients suppress duplicates by id). Live events carry `sequence >= 1`,
 * assigned by the server per session and increasing monotonically, so a
 * reconnecting client can skip anything it has already seen; replayed
 * history events carry `sequence: 0` — their order is the snapshot array
 * order and they are deduped by id alone. `turnId` correlates the events of
 * one user turn.
 */
export interface ChatEventBase {
  id: string
  sequence: number
  /** ISO timestamp of when the event was produced. */
  at: string
}

/** Correlates events belonging to one in-flight user turn. */
export interface ChatTurnEventBase extends ChatEventBase {
  turnId: string
}

/** Groups assistant blocks of one response (SDK message id). */
export interface ChatAssistantEventBase extends ChatTurnEventBase {
  messageId: string
}

/** Links a tool_call with its tool_result (SDK tool_use id). */
export interface ChatToolEventBase extends ChatTurnEventBase {
  toolCallId: string
}

/** One structured question from an SDK AskUserQuestion request. */
export interface ChatQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: Array<{
    label: string
    description?: string
    preview?: string
  }>
}

/**
 * A client's answer to one question of a question_request: selected option
 * labels (multi-select allowed when the question permits it) and/or a
 * free-text answer.
 */
export interface ChatQuestionAnswer {
  options?: string[]
  text?: string
}

/** Result subtype reported by turn_completed (SDK result.subtype). */
export type ChatTurnResultSubtype = string

export type ChatEvent =
  | (ChatTurnEventBase & { type: 'turn_started' })
  | (ChatTurnEventBase & { type: 'user_message'; text: string })
  | (ChatAssistantEventBase & { type: 'assistant_text'; text: string })
  | (ChatAssistantEventBase & { type: 'assistant_delta'; delta: string })
  | (ChatToolEventBase & { type: 'tool_call'; tool: string; input: unknown })
  | (ChatToolEventBase & {
      type: 'tool_result'
      output: string
      isError?: boolean
    })
  | (ChatTurnEventBase & {
      type: 'approval_request'
      requestId: string
      tool: string
      input: unknown
    })
  | (ChatTurnEventBase & {
      type: 'question_request'
      requestId: string
      questions: ChatQuestion[]
    })
  | (ChatEventBase & {
      type: 'request_resolved'
      requestId: string
      outcome: ChatRequestOutcome
      /** Who settled the request; absent on cancellations and legacy events. */
      decidedBy?: ChatRequestDecidedBy
      /** Tool name for policy grants that never showed a card. */
      tool?: string
    })
  | (ChatTurnEventBase & {
      type: 'turn_completed'
      subtype: ChatTurnResultSubtype
      totalCostUsd?: number
      numTurns?: number
      /** Final assistant text; only present on a success subtype. */
      finalText?: string
    })
  | (ChatTurnEventBase & { type: 'turn_interrupted' })
  | (ChatEventBase & { type: 'notice'; text: string })
  | (ChatEventBase & { type: 'error'; message: string })

/** How a pending approval/question request ended. */
export type ChatRequestOutcome =
  | 'allowed'
  | 'denied'
  | 'answered'
  | 'cancelled'

/** Who settled a request: the user answering, or the session's approval policy. */
export type ChatRequestDecidedBy = 'user' | 'policy'

/** Per-session approval policy: manual shows approval cards; auto grants them. */
export type ChatApprovalPolicy = 'manual' | 'auto'

/** Live phase of an in-flight chat turn (activity indicator design D1). */
export type ChatActivityPhase =
  | 'requesting'
  | 'thinking'
  | 'responding'
  | 'preparing_tool'
  | 'running_tools'
  | 'retrying'

/**
 * What the agent is doing right now. Ephemeral by design: it is not a
 * ChatEvent, never sequenced, persisted, or replayed, and excluded from the
 * session-list status broadcast. `elapsedMs` is how long the phase had lasted
 * when the message was sent, so clients tick on their own clock (design D2).
 */
export interface ChatActivity {
  phase: ChatActivityPhase
  /** Milliseconds already spent in this phase when the message was sent. */
  elapsedMs: number
  /** preparing_tool / running_tools: oldest unresolved tool name. */
  tool?: string
  /** running_tools: number of unresolved tool calls (>= 1). */
  count?: number
  /** retrying */
  attempt?: number
  maxRetries?: number
  errorStatus?: number
}

/** Overall plan-limit status of a usage report. */
export type ChatUsageStatus = 'allowed' | 'warning' | 'limited'

/** One plan-usage window, rendered as a single meter in the chat usage bar. */
export interface ChatUsageWindow {
  /**
   * Meter kind the window is keyed by (e.g. 'five_hour',
   * 'seven_day_opus'); a model-scoped window appends its scope label, so
   * distinct scoped windows never collide. Never the display label — a new
   * server meter needs no client release to render.
   */
  key: string
  /** Display text for the meter. */
  label: string
  /** Share of the window used, 0-100. */
  percentUsed: number
  /** ISO timestamp when the window resets, when known. */
  resetsAt: string | null
}

/**
 * The latest plan-usage report for a Claude profile, normalized from the
 * three shapes Claude Code emits (pushed rate_limit_event frames, /usage
 * reports on assistant messages, and the SDK usage control reply). Per
 * profile because the underlying allowance is per account and provider;
 * server memory only — a restart begins with none until the next update. A
 * report without windows carries just the status and receipt time.
 */
export interface ChatUsageReport {
  status: ChatUsageStatus
  windows: ChatUsageWindow[]
  /** ISO timestamp of when the report was received. */
  receivedAt: string
}

/** Self-contained snapshot of a still-pending approval or question. */
export type ChatPendingRequest =
  | {
      kind: 'approval'
      requestId: string
      tool: string
      input: unknown
      at: string
    }
  | {
      kind: 'question'
      requestId: string
      questions: ChatQuestion[]
      at: string
    }

/** User decision on a pending approval_request. */
export type ChatApprovalDecision = 'allow' | 'deny'

/** Public catalog metadata; environment and credentials stay on the server. */
export interface ClaudeProfileMetadata {
  id: string
  label: string
}

/**
 * Which side of the Agentboard <-> Claude Code process boundary a captured
 * protocol frame came from: `out` = written to the process stdin, `in` = read
 * from its stdout, `stderr` = its stderr, `lifecycle` = spawn/exit/error
 * records Agentboard writes about the process itself.
 */
export type ChatWireDirection = 'out' | 'in' | 'stderr' | 'lifecycle'

/** One captured line of chat protocol traffic. */
export interface ChatWireFrame {
  /** Per session, >= 1, monotonic across process respawns and restarts. */
  seq: number
  /** ISO timestamp of capture. */
  at: string
  dir: ChatWireDirection
  /** The exact line as exchanged, without its trailing newline. */
  raw: string
}
