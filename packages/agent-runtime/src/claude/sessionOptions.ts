// The Claude session's construction options (task 4.1; split out of
// session.ts for size, unchanged). session.ts re-exports both names.
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ResumeCheckpoint } from '../contract.js'
import type { AgentCallbacks, BeforeSubmit, ClaudeAuditHooks, ClaudePermissions, LaunchInput, Logger, ToolObservation, ToolSet, WireRecorder } from '../options.js'
import type { TerminateOptions } from '../process/ownedProcess.js'

/** Test seam: a controlled query in place of the SDK's (design §5, runtime test seams). */
export type ClaudeQueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query

export interface ClaudeSessionOptions {
  launch: LaunchInput
  callbacks: AgentCallbacks
  logger?: Logger
  wire?: WireRecorder
  /** SDK options supplied by the driver and profile layers; policy fields are overridden. */
  sdkOptions?: Partial<Options>
  /** Enforced on every generation by the PreToolUse policy (task 3.2). */
  permissions?: ClaudePermissions
  /** Termination bounds for stop (defaults: the owned spawner's). */
  terminate?: TerminateOptions
  /** Host tools bound to this session (task 3.4); absent or empty registers none. */
  tools?: ToolSet
  systemPromptAppend?: string
  /** Synchronous pre-submit decision; a refusal or throw precedes any enqueue or event (P12). */
  beforeSubmit?: BeforeSubmit
  /** Names-only tool observation (P14). */
  onToolObservation?(observation: ToolObservation): void
  /** Detailed opt-in audit adapter. */
  auditHooks?: ClaudeAuditHooks
  /** The conversation to resume on the first generation. */
  resume?: ResumeCheckpoint
  /** A request still pending after onRequest: denied at once (default) or kept. */
  unansweredRequests?: 'deny' | 'wait'
  queryFactory?: ClaudeQueryFactory
}
