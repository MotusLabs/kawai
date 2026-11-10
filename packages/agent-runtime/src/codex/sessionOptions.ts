// The Codex session's construction options (task 4.2). The public factory
// (driver.ts) maps CodexDriverOptions onto these; `terminate` and
// `requestTimeoutMs` are internal bounds with the transport's defaults.
import type { ResumeCheckpoint } from '../contract.js'
import type { AgentCallbacks, BeforeSubmit, CodexAuditHooks, CodexPermissions, Effort, LaunchInput, Logger, ToolObservation, ToolSet, WireRecorder } from '../options.js'
import type { TerminateOptions } from '../process/ownedProcess.js'

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
  resume?: ResumeCheckpoint
  unansweredRequests?: 'deny' | 'wait'
  terminate?: TerminateOptions
  requestTimeoutMs?: number
}
