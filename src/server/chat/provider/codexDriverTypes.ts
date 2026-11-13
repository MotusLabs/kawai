// The Codex driver's construction types (codex-chat-sessions D2/D5): the
// options Kawai's adapter over the package takes (codexRuntime.ts), and the
// structural client shapes of the retired root AppServerClient that the
// refused createClient knob still names. Moved verbatim from the deleted
// codex/codexThread.ts (task-ce05430a R2); its thread parameters, effort
// mapping, context reading and side-reports are the package's now.
import type { ChatApprovalPolicy } from '../../../shared/chat'
import type { OutboundAuditSink } from '../../outbound/observer'
import type { TeamToolSpec } from '../../team/mailboxTools'
import type { ChatWireRecorder } from '../wireTap'
import type { ChatDriverCallbacks, ChatEffort } from './driver'

/** How an app-server process ended: an exit code, a kill signal, or a spawn failure (both null). */
export interface CodexClientExit {
  code: number | null
  signal: string | null
}

/** A Codex app-server client's construction options (the retired AppServerClient's shape). */
export interface CodexClientOptions {
  /** The resolved Codex executable (codexExecutable.ts); never a shell command. */
  executable: string
  /** The child's full environment; the caller builds it (codexSpawnEnv). */
  env: Record<string, string>
  /** Every inbound and outbound line, plus spawn/exit lifecycle frames. */
  wire: ChatWireRecorder
  /** A server-initiated notification (a `method` with no id). */
  onNotification(method: string, params: Record<string, unknown>): void
  /** A server request (a `method` with an id): the resolved value becomes the reply's `result`. */
  onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown>
  /** The child ended. */
  onExit(exit: CodexClientExit): void
  /** SIGTERM -> SIGKILL escalation delay for end(). */
  killGraceMs?: number
  /** Per-request deadline in ms; 0 disables. */
  requestTimeoutMs?: number
  /** How long after the child's exit the stdio streams may keep the exit unsettled. */
  drainBoundMs?: number
}

/** The client surface the driver used (the retired AppServerClient's start/request/initialize/end). */
export type CodexClient = {
  start(): void
  request(method: string, params?: Record<string, unknown>): Promise<unknown>
  initialize(info: { name: string; title?: string; version: string }): Promise<unknown>
  end(): void
}

export interface CodexSessionDriverOptions extends ChatDriverCallbacks {
  sessionId: string
  projectPath: string
  /** The resolved Codex executable (codexExecutable.ts). */
  executable: string
  /** The resolved CODEX_HOME of the session's profile. */
  codexHome: string
  /** Sandbox network access (profile `network`, default on). */
  network: boolean
  /** The profile's model; omitted = the home's configuration decides. */
  model?: string
  /** The stored thread to resume on the first spawn (undefined = fresh). */
  resumeThreadId?: string
  /** Read at each request, so a live policy switch applies to the next one. */
  getApprovalPolicy?: () => ChatApprovalPolicy
  /** developerInstructions, read at every spawn (role, team, security note). */
  getSystemPromptAppend?: () => string | undefined
  /** turn/start effort, read at every turn. */
  getEffort?: () => ChatEffort | undefined
  /**
   * The kawai-team tools (D6), registered as one dynamic-tool namespace at
   * thread start and served on `item/tool/call` for this thread only.
   */
  teamTools?: readonly TeamToolSpec[]
  /** Observes commands and external MCP calls (design D13); observational. */
  outbound?: OutboundAuditSink
  wire: ChatWireRecorder
  createTurnId?: () => string
  /** The server environment the child's env derives from; default process.env. */
  serverEnv?: Record<string, string | undefined>
  /**
   * Whether this spawn may fill a home holding no report with one
   * `account/rateLimits/read` (PR E 7.1); the usage store claims it once
   * per home, so the harness default (unset) reads nothing.
   */
  claimRateLimitsRead?: () => boolean
  /**
   * The catalog-named credential variables the child never inherits
   * (openrouter-provider D3, task 1.8); required, so no launch path can
   * forget it. Evaluated at every ensureClient spawn (provider-relay-setup
   * correction A), so a name registered after the driver's creation — by a
   * catalog edit or a retention write — withholds from the respawn too.
   */
  withheldCredentials: () => ReadonlySet<string>
  /**
   * A legacy-driver knob: built the deleted in-tree driver's client. The
   * production adapter never reads it, and the test harness refuses it.
   */
  createClient?: (options: CodexClientOptions) => CodexClient
  /** How long interrupt waits for the app-server's acknowledgement. */
  interruptTimeoutMs?: number
}
