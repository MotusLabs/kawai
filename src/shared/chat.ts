// Chat-session wire contract: conversation events, the WebSocket message
// payloads that carry them, the ephemeral live-turn activity, and the raw
// protocol frames shown by the chat debug view. Shared between the server's
// chat driver/WS layer and the client's chat stores. All SDK-specific types
// stay in the driver; this file is SDK-agnostic so the client never imports
// the agent SDK.

import type { ChatPeerTaskContext, RevisionNotice } from './teamTasks'
import type { ChatHandoffPackage } from './team'

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
  /**
   * ISO timestamp of when the event was produced, or empty when the source
   * recorded none (undated history rows). Read it through `validTime`
   * (`chatTime.ts`), never `new Date(at)` directly.
   */
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

/** One turn's token counts (SDK result.usage); a missing field reads 0. */
export interface ChatTurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/** Result subtype reported by turn_completed (SDK result.subtype). */
export type ChatTurnResultSubtype = string

/** Where a slash command the agent reports is defined. */
export type ChatCommandSource = 'builtin' | 'project' | 'user'

/**
 * One slash command the session's agent offers, normalized server-side from
 * the agent's raw list: terminal-bound and internal commands are already
 * filtered out, and the ` (project)` display suffix is folded into `source`.
 */
export interface ChatCommand {
  /** Without the leading slash. */
  name: string
  description: string
  /** Typed-arguments hint (e.g. `"[name]"`); omitted when the agent gave none. */
  argumentHint?: string
  /** Alternate names that resolve to this command. */
  aliases: string[]
  source: ChatCommandSource
}

/**
 * The session's slash-command list as a replaceable state: `loading` while
 * the agent starts, `ready` with the list, `unavailable` when no agent is
 * (or can be) asked — never started, blocked, dead, or archived.
 */
export interface ChatCommandState {
  status: 'loading' | 'ready' | 'unavailable'
  commands: ChatCommand[]
}

/** One background-task notification that woke the agent (background tasks D5). */
export interface ChatTurnTriggerTask {
  taskId: string
  toolCallId?: string
  status: string
  summary?: string
}

/** Why a turn the agent started on its own began. */
export type ChatTurnTrigger =
  | { kind: 'task'; tasks: ChatTurnTriggerTask[] }
  | { kind: 'resumed' }

/** Mail received from another chat agent; shared without SDK dependencies. */
export interface ChatPeerMessage {
  messageId: string
  /** Sender session; null for a human sender (team-message-threads D4). */
  senderSession: string | null
  /**
   * Actor kind of the sender (team-message-threads D4): the human composing
   * mail, or an agent session. Absent on recorded envelopes = agent.
   */
  senderKind?: 'agent' | 'human' | 'system'
  senderGroup: string | null
  priority: 'normal' | 'urgent'
  originPath: string
  tags: string[]
  threadId: string
  body: string
  possibleDuplicate: boolean
  thread?: Array<{ messageId: string; senderSession: string | null; body: string; senderKind?: 'agent' | 'human' | 'system' }>
  /** The referenced team task as it was at delivery (team-tasks D3); absent = none. */
  task?: ChatPeerTaskContext
  /** Work handed off after a provider limit (profile routing); absent = none. */
  handoff?: ChatHandoffPackage
  /**
   * A revision notice (task-revision-publication D3): the revision it
   * announces, which may be older than `task.revision` built at delivery.
   */
  revisionNotice?: RevisionNotice
}

export type ChatEvent =
  | (ChatTurnEventBase & {
      type: 'turn_started'
      /**
       * Why the turn began (background tasks D5). Absent on user-started
       * turns; `task` lists the notifications that woke the agent, `resumed`
       * marks a self-start with no known cause.
       */
      trigger?: ChatTurnTrigger
    })
  | (ChatTurnEventBase & { type: 'user_message'; text: string })
  | (ChatTurnEventBase & ChatPeerMessage & { type: 'peer_message' })
  | (ChatTurnEventBase & {
      type: 'command_output'
      /** Output text of a local slash command run in this turn. */
      text: string
    })
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
      /** The turn's token counts from the SDK result (team-process-metrics D1); absent in older history. */
      usage?: ChatTurnUsage
      /** Final assistant text; only present on a success subtype. */
      finalText?: string
    })
  | (ChatTurnEventBase & { type: 'turn_interrupted' })
  | (ChatEventBase & {
      type: 'notice'
      text: string
      /**
       * Discriminator for notices other code acts on. `compacted` marks the
       * compact_boundary notice; matching on this beats matching on its
       * display text, which is free to change.
       */
      kind?: 'compacted'
    })
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

/**
 * Read a stored policy value; anything absent or unknown reads as manual.
 * Shared so the browser-persisted settings default and the wire/DB value
 * sanitize identically.
 */
export function parseApprovalPolicy(value: unknown): ChatApprovalPolicy {
  return value === 'auto' ? 'auto' : 'manual'
}

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

/**
 * The session's distance to auto-compaction: how much of its
 * auto-compaction threshold — the used-token count at which the conversation
 * would be compacted, not the model's full context window — the current
 * conversation occupies. `usedTokens` is the latest model request's
 * `input + cache_read + cache_creation + output`: the window as of that
 * request, never lifetime traffic. `percentage` is used/threshold × 100 and
 * may exceed 100, since compaction can lag the threshold. Unlike
 * `ChatActivity` this is a slow session fact: it persists with the chat
 * session across restart and archive and rides the snapshot; it is never a
 * ChatEvent and is absent (`null`) rather than zero before the first
 * request.
 */
export interface ChatContextUsage {
  usedTokens: number
  thresholdTokens: number
  /** Share of the threshold in use; not clamped to 100. */
  percentage: number
  /** ISO timestamp of when the reading was measured. */
  at: string
  /**
   * True when `thresholdTokens` is a window standing in for the compaction
   * threshold (design D2 steps 2–3): the profile window with no observed
   * reserve, or the model's context window. An approximation of the window,
   * not a measured threshold — the meter must say so rather than claim a
   * distance to compaction it does not know. Absent/false means the number
   * is a real threshold.
   */
  thresholdApproximate?: boolean
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
  /**
   * Window length in milliseconds when the server knows it for the kind
   * (5-hour, 7-day, per-model weekly); absent otherwise — never guessed.
   * With resetsAt it places the usage bar's elapsed-time marker.
   */
  periodMs?: number
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
  /**
   * Which shape it came from: a pushed rate_limit_event, a /usage report, the
   * SDK usage pull (which follows the host claude.ai login, not the session's
   * provider), or a pull from the session provider's own quota endpoint.
   * Absent on reports from older servers.
   */
  source?: ChatUsageSource
}

export type ChatUsageSource =
  | 'push'
  | 'report'
  | 'pull'
  /** Pulled from the session provider's own quota endpoint (provider usage pull). */
  | 'provider'

/** Where a chat notification came from. */
export type ChatNotificationSource = 'account' | 'agent'

/** How strongly a notification styles itself in the strip. */
export type ChatNotificationSeverity = 'info' | 'warning' | 'error'

/** The agent's own urgency ranking; higher sorts first in the strip. */
export type ChatNotificationPriority = 'low' | 'medium' | 'high' | 'immediate'

/**
 * One CLI-style notice shown in the chat notification strip: either an
 * account-level warning the server computes from the profile's stored login
 * (login expiry), or a notice the agent emitted on the SDK notification
 * channel. Ephemeral by design, like `ChatActivity` and `ChatUsageReport`:
 * held in server memory only, carried by the snapshot and the additive
 * `chat-notifications` push, never a `ChatEvent` — never sequenced,
 * persisted, or replayed — and never part of the session-list status.
 */
export interface ChatNotification {
  /**
   * Stable within a session: a newer notice with the same key replaces the
   * one it supersedes, and closing an agent notice names its key.
   */
  key: string
  source: ChatNotificationSource
  severity: ChatNotificationSeverity
  priority: ChatNotificationPriority
  text: string
  /** Dimmed follow-up line (e.g. how to renew); omitted when there is none. */
  hint?: string
  /** ISO timestamp of when the notice was produced. */
  receivedAt: string
}

/** Lifecycle outcome of an agent the chat session spawned (workers design D2). */
export type ChatWorkerStatus = 'running' | 'completed' | 'failed' | 'stopped'

/**
 * One agent spawned by the chat session's `Agent`/`Task` tool call, joined to
 * its transcript row by that call's id. Live fields (`lastTool`, `elapsedMs`,
 * `live`) churn with the worker's progress and ride the roster channel — the
 * full-set `chat-workers` message and `chat-snapshot.workers` — never the
 * sequenced event stream; only the settled outcome is durable. Like
 * `ChatActivity`, `elapsedMs` is the value when the message was sent, so
 * clients tick their own clock.
 */
export interface ChatWorker {
  /** The spawning Agent tool call's id. */
  workerId: string
  /** SDK task handle; needed later for per-task stop. */
  taskId?: string
  agentType?: string
  description?: string
  /** 1 for a top-level spawn; omit when unknown. */
  depth?: number
  status: ChatWorkerStatus
  /**
   * Whether the worker is known to be running right now. Distinct from
   * `status`: `running` + `live: false` is the gap after the worker has left
   * the background set and before its notification has landed.
   */
  live: boolean
  /** Most recent tool the worker ran. */
  lastTool?: string
  /** Milliseconds since the spawn when the message was sent. */
  elapsedMs: number
  /** Settled workers only. */
  summary?: string
}

/** What started the task: a backgrounded shell command or a Monitor. */
export type ChatBackgroundTaskKind = 'shell' | 'monitor'

/** Lifecycle outcome of a background task (background tasks D1). */
export type ChatBackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

/**
 * One background shell or Monitor the chat session's agent started, joined to
 * its tool row by the starting call's id. Sibling of `ChatWorker`: a roster
 * entry that rides the full-set `chat-background-tasks` message and
 * `chat-snapshot.backgroundTasks`, never the sequenced event stream. The
 * recorded output-file path stays server-side (design D3: a client can never
 * supply or receive a path); reading the tail is the `chat-task-output`
 * request. `elapsedMs` is the value when the message was sent, frozen once
 * the task settles, so clients tick their own clock while it runs.
 */
export interface ChatBackgroundTask {
  /** SDK task id; the handle for output reads and stop. */
  taskId: string
  /** The `Bash`/`Monitor` tool call that started the task. */
  toolCallId?: string
  kind: ChatBackgroundTaskKind
  description?: string
  status: ChatBackgroundTaskStatus
  /**
   * Whether the task is in the CLI's background set right now. Distinct from
   * `status`: the level set and the settle notification arrive separately.
   */
  live: boolean
  /** Epoch ms of task_started; the sidecar persists it (design D6). */
  startedAtMs: number
  /** Epoch ms of the settle; absent while running. */
  endedAtMs?: number
  elapsedMs: number
  /** Settled tasks only: the one-line outcome the agent received. */
  summary?: string
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
  /** The provider owning this model: its cooldown and usage key (design D10). */
  providerId: string
  providerLabel: string
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
