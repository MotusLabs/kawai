// The Codex session's construction options (task 4.2). The public factory
// (driver.ts) maps CodexDriverOptions onto these; `terminate` and
// `requestTimeoutMs` are internal bounds with the transport's defaults, and
// `spawn` is the transport's private process seam (default spawnOwned).
import type { ResumeCheckpoint } from '../contract.js'
import type { AgentCallbacks, BeforeSubmit, CodexAuditHooks, CodexPermissions, Effort, LaunchInput, Logger, ToolObservation, ToolSet, WireRecorder, CodexThreadOpened } from '../options.js'
import type { OwnedProcess, OwnedSpawnRequest, TerminateOptions } from '../process/ownedProcess.js'

export interface CodexSessionOptions {
  launch: LaunchInput
  callbacks: AgentCallbacks
  logger?: Logger
  wire?: WireRecorder
  /** Applied on every thread/start, thread/resume and turn/start (task 3.3). */
  permissions: CodexPermissions
  tools?: ToolSet
  /** Sent as the thread's developerInstructions. */
  systemPromptAppend?: string
  model?: string
  effort?: Effort
  beforeSubmit?: BeforeSubmit
  onToolObservation?(observation: ToolObservation): void
  auditHooks?: CodexAuditHooks
  /** Asked once per ready generation; omitted, the one read per driver (quotaRead.ts). */
  claimRateLimitsRead?: () => boolean
  /** Read per new turn/start; precedes `effort` (R2). */
  getEffort?: () => Effort | undefined
  /** Each actual generation's opened thread, after its checkpoint settled (R3). */
  onThreadOpened?: (info: CodexThreadOpened) => void
  resume?: ResumeCheckpoint
  unansweredRequests?: 'deny' | 'wait'
  terminate?: TerminateOptions
  requestTimeoutMs?: number
  spawn?(request: OwnedSpawnRequest): OwnedProcess
}
