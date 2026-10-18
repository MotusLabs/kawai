// The runtime-neutral chat driver contract (openspec codex-chat-sessions
// design D1): the slice of the Claude driver's public surface that the
// session manager, mailbox, and staffing depend on, plus the output
// callbacks every driver reports through. ChatSessionDriver implements this
// interface unchanged; the Codex driver arrives with the change that wires
// it. No SDK type appears here — the Claude-only extras stay behind the
// optional capability method the manager probes for.
import type {
  ChatActivity,
  ChatApprovalDecision,
  ChatApprovalPolicy,
  ChatBackgroundTask,
  ChatCommandState,
  ChatContextUsage,
  ChatEvent,
  ChatNotification,
  ChatPendingRequest,
  ChatPeerMessage,
  ChatQuestionAnswer,
  ChatUsageReport,
  ChatWorker,
} from '../../../shared/chat'
import type { SessionStatus } from '../../../shared/types'
import type { BackgroundTaskRecord } from '../chatBackgroundTasks'
import type { ChatLimitSignal } from '../limitSignals'

/**
 * The agent runtime a chat runs on: Claude Code today, Codex with the driver
 * change that wires it. Deliberately not `provider` — the catalog's provider
 * level (providers.json, providerOf) means an account or endpoint.
 */
export type ChatRuntime = 'claude' | 'codex'

/** Reasoning effort a driver launches with: a named level or a raw number. */
export type ChatEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number

/** What one spawn launched with, for agent-start provenance. */
export interface ChatSpawnInfo {
  cwd: string
  systemPromptAppend: string
  /** The profile's effort, null when the runtime's own settings decide. */
  effort: ChatEffort | null
  /** The profile's model, null when the runtime decides. */
  model: string | null
  /** The launch environment (the server's own when the profile sets none). */
  env: Record<string, string | undefined>
  resumed: boolean
}

/**
 * Output callbacks every chat driver reports through: today's `on*` driver
 * options minus the SDK-typed ones — ChatSessionDriverOptions extends this,
 * so the signatures here are the ones every runtime type-checks against.
 * Optional callbacks stay optional — a driver must fire the required pair
 * (onEvent, onStatus) and anything else only when its runtime produces it.
 * Like events' ephemeral neighbours, the rosters and activity are never
 * sequenced, buffered, or replayed.
 */
export interface ChatDriverCallbacks {
  onEvent: (event: ChatEvent) => void
  /** Applied immediately on every derived status change. */
  onStatus: (status: SessionStatus) => void
  /**
   * Live activity of the in-flight turn; null when the turn ends. Fired
   * only when the projected phase changes, and never with a placeholder.
   */
  onActivity?: (activity: ChatActivity | null) => void
  /** An agent-emitted notification, with the frame's timeout when carried. */
  onNotification?: (notification: ChatNotification, timeoutMs?: number) => void
  /**
   * The agent process ended on its own — an unexpected exit or stream
   * failure, never kill/shutdown, whose callers already tear the session
   * state down. Fired once per process.
   */
  onProcessEnd?: () => void
  /** The spawned-worker roster: the full projection, on change — never per
   * elapsed tick; settled outcomes persist through the sidecar. */
  onWorkers?: (workers: ChatWorker[]) => void
  /** The background-task roster: the full projection, on change; never
   * consulted for status. */
  onBackgroundTasks?: (tasks: ChatBackgroundTask[]) => void
  /**
   * The latest context-meter reading; null clears it (a conversation reset
   * leaves nothing measured). Before the first measurement this callback
   * simply does not fire. `persist` marks writes that must not wait for
   * the next turn boundary.
   */
  onContextUsage?: (usage: ChatContextUsage | null, opts?: { persist?: boolean }) => void
  /**
   * The current model, when it is non-empty and differs from the last fired
   * one — so a mid-session switch lands on the next turn.
   */
  onModel?: (model: string) => void
  /** Plan usage: a pushed rate-limit report, whatever the turn state is. */
  onRateLimit?: (report: ChatUsageReport) => void
  /** Plan usage: a structured usage report from the agent. */
  onUsageReport?: (report: ChatUsageReport) => void
  /** A usage pull that yielded no windows (or failed). */
  onUsageNoData?: () => void
  /** Fired once when the runtime reveals its session/thread id. */
  onSdkSessionId?: (sdkSessionId: string) => void
  /** The agent's working directory moved (main-session moves only; a
   * driver filters its subagents' moves itself). */
  onCwdChanged?: (newCwd: string) => void
  /** Fired whenever the slash-command state meaningfully changed. */
  onCommandState?: (state: ChatCommandState) => void
  /**
   * A rate-limit, billing, or overload failure of this profile — a retried
   * attempt or the turn's final failure — with the provider's reset time
   * when a rejected rate-limit announcement carried one.
   */
  onLimitEvent?: (signal: ChatLimitSignal) => void
  /** Called once per constructed query with what the spawn launched with
   * (agent-start provenance); observational, never fails the spawn. */
  onSpawn?: (info: ChatSpawnInfo) => void
}

/**
 * The driver surface the session manager, mailbox, and staffing depend on
 * (design D1): lifecycle, approvals and questions, and the read-only probes
 * behind the transcript, roster, and pending-request views. Runtimes without
 * a feature return its neutral empty answer (no records, null output, false)
 * rather than making callers branch on the runtime.
 */
export interface ChatAgentDriver {
  /** The agent process is dead and needs a respawn before the next turn. */
  readonly isDead: boolean
  /** The session's slash-command state (this driver is its only feeder). */
  getCommandState(): ChatCommandState

  /** Start the agent (no prompt sent): first start or internal respawn. */
  start(): void
  /** The agent's project directory moved (worktree tracking). */
  setProjectPath(path: string): void
  /** Submit a user turn. */
  send(text: string): void
  /** Deliver a peer envelope as a turn (team mail), carrying its message id. */
  deliver(envelope: ChatPeerMessage): void
  /** Stop the in-flight turn and cancel its pending cards. */
  interrupt(): Promise<void>
  /** Tear down hard: no further turns, no respawn. */
  kill(): void
  /** Flush and stop cleanly (server shutdown), leaving the session resumable. */
  shutdown(): void

  /** A live approval-policy switch applies to the next pending request. */
  onApprovalPolicyChanged(policy: ChatApprovalPolicy): void
  /** Answer an approval card; the first valid answer wins. */
  resolveApproval(requestId: string, decision: ChatApprovalDecision): { ok: true } | { ok: false; error: string }
  /** Answer a question card; answers validate against the offered questions. */
  answerQuestion(requestId: string, answers: Record<string, ChatQuestionAnswer>): { ok: true } | { ok: false; error: string }
  /** Snapshot of still-pending approvals/questions (for chat-snapshot). */
  getPendingRequests(): ChatPendingRequest[]
  /** Tool use ids this live stream has produced events for (replay guard). */
  getSeenToolCallIds(): Set<string>

  /** The spawned-worker roster. */
  getWorkers(): ChatWorker[]
  /** The background-task roster. */
  getBackgroundTasks(): ChatBackgroundTask[]
  /** Sidecar records for the task store: identity and outcome. */
  getBackgroundTaskRecords(): BackgroundTaskRecord[]
  /** A task's output tail, or null when the runtime has none. */
  getTaskOutput(taskId: string): Promise<{ output: string; total_bytes: number; truncated: boolean } | null>
  /** Stop one background task; false when refused or unsupported. */
  stopTask(taskId: string): Promise<boolean>

  /**
   * Claude-only extra (design D1): updates the executable the next respawn
   * uses. Optional — the manager probes for it and skips elsewhere.
   */
  setClaudeExecutablePath?(path: string | undefined): void
}

