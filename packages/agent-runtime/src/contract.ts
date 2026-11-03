// The public driver contract (design §2, frozen at task 1.2). Factories build
// an inert driver; start() initializes a session without a prompt; every
// submission returns a correlated handle whose result settles exactly once;
// interrupt is cooperative and never claims process exit; kill/shutdown share
// one terminal stop that succeeds only after owned processes have actually
// exited and owned asynchronous work has joined.
import type { JsonValue } from './json.js'
import type { AgentErrorInfo } from './errors.js'
import type { PendingRequest, QuestionAnswers } from './events.js'
import type { TokenUsage } from './usage/types.js'

export type AgentRuntimeKind = 'claude' | 'codex'

/**
 * Lifecycle states of the design's lifecycle table (L01-L23). `exited` is an
 * unexpected process end: start() resumes the same conversation. `stopped`
 * is terminal: resuming needs a new driver and the saved checkpoint.
 */
export type DriverState = 'unstarted' | 'starting' | 'idle' | 'active' | 'stopping' | 'stopped' | 'exited'

/**
 * How a submission relates to an active turn. `new-turn` (default) is only
 * accepted while idle. `queue` (Claude) runs as the next turn; `steer`
 * (Codex) joins the active turn and shares its result. A runtime without the
 * mode refuses it with an `unsupported` error (L23).
 */
export type ContinuationMode = 'new-turn' | 'queue' | 'steer'

export interface SubmitOptions {
  /** Caller-minted message UUID; minted by the runtime when omitted. */
  messageUuid?: string
  continuation?: ContinuationMode
  /** Opaque context handed to the beforeSubmit callback before anything is enqueued. */
  context?: JsonValue
}

export type TurnOutcome = 'success' | 'failed' | 'interrupted' | 'process-ended'

/** A turn's terminal result; the handle and onTurnResult receive the same value once. */
export interface TurnResult {
  turnId: string
  messageUuid: string
  outcome: TurnOutcome
  /** Final assistant text on success; null otherwise or when none was produced. */
  finalText: string | null
  /** The model that answered, or null when unknown. */
  model: string | null
  /** Token counts, or null when the provider reported none for this turn. */
  usage: TokenUsage | null
  /** Distinct tool-call ids observed in this turn. */
  toolCallCount: number
  /** Distinct compaction boundaries observed in this turn. */
  compactionCount: number
  /** Set for every non-success outcome. */
  error: AgentErrorInfo | null
}

export interface TurnHandle {
  turnId: string
  messageUuid: string
  /** Settles once; never rejects (failures are a non-success outcome). */
  result: Promise<TurnResult>
}

/** The runtime identity a caller persists to resume the conversation later. */
export interface ResumeCheckpoint {
  runtime: AgentRuntimeKind
  /** Claude session id or Codex thread id. */
  runtimeSessionId: string
  /** The runtime's transcript file, when known. */
  transcriptPath?: string
}

/** One owned process generation's end, as actually observed. */
export type ProcessExitFact =
  | {
      generation: number
      state: 'exited'
      pid: number
      code: number | null
      signal: string | null
      /** True when termination escalated past the first signal. */
      escalated: boolean
      /** True when the owned process group was confirmed empty after the leader exited. */
      groupCleared: boolean
    }
  | { generation: number; state: 'never-started' }

/**
 * Success of kill() or shutdown(): every owned generation has actually exited
 * and all owned JavaScript work has joined. Scope is the runtime's own agent
 * processes; independently detached services are the caller's to contain.
 */
export interface ProcessExitReceipt {
  scope: 'agent-processes'
  /** The first stop's mode; later callers observe the same receipt. */
  mode: 'kill' | 'shutdown'
  processes: readonly ProcessExitFact[]
  js: 'settled'
}

export interface InterruptReceipt {
  outcome: 'requested' | 'no-active-turn'
  /** An interrupt never proves the process ended. */
  processExit: false
}

/** Facts about an unsolicited process end, reported once per generation. */
export interface ProcessEndReport {
  generation: number
  code: number | null
  signal: string | null
  reason: string | null
}

export type AnswerOutcome =
  | { ok: true }
  | { ok: false; reason: 'not-pending' | 'invalid' | 'stopped'; message: string }

export interface AnswerOptions {
  /** Echoed as the resolved event's decidedBy (default `caller`). */
  decidedBy?: string
}

export interface AgentDriver {
  readonly runtime: AgentRuntimeKind
  readonly state: DriverState
  /** Ready the session without a model turn. Repeated calls share one initialization. */
  start(): Promise<void>
  /** Submit user work. Rejects with a typed AgentRuntimeError when not admitted. */
  send(text: string, options?: SubmitOptions): Promise<TurnHandle>
  /** Cooperative: cancel pending requests and ask the active turn to stop. */
  interrupt(): Promise<InterruptReceipt>
  /** Forced stop. Resolves only after actual owned exit and join; rejects with category `stop` otherwise. */
  kill(): Promise<ProcessExitReceipt>
  /** Same terminal stop as kill(), retaining runtime data for a later resume. */
  shutdown(): Promise<ProcessExitReceipt>
  /** The first valid answer wins; may be called from inside onRequest. */
  resolveApproval(requestId: string, decision: 'allow' | 'deny', options?: AnswerOptions): AnswerOutcome
  answerQuestion(requestId: string, answers: QuestionAnswers, options?: AnswerOptions): AnswerOutcome
  /** Requests registered and not yet settled, oldest first. */
  pendingRequests(): PendingRequest[]
}

/** A background task's output tail. */
export interface TaskOutput {
  output: string
  totalBytes: number
  truncated: boolean
}

/** Claude-only extras: the SDK's background-task probes. */
export interface ClaudeAgentDriver extends AgentDriver {
  readonly runtime: 'claude'
  /** Null when the task is unknown or the runtime has no output for it. */
  getTaskOutput(taskId: string): Promise<TaskOutput | null>
  /** False when refused or the task is unknown. */
  stopTask(taskId: string): Promise<boolean>
}

export interface CodexAgentDriver extends AgentDriver {
  readonly runtime: 'codex'
}
