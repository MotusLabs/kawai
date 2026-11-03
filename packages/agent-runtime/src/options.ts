// Driver construction options (design §4, §5, frozen at task 1.2). Every
// launch input is explicit: the runtime never reads process.env, the
// operator's home or Kawai settings to find authority. Optional host seams
// (tools, context, audit, wire) are inert when absent.
import type { z } from 'zod'
import type { JsonValue } from './json.js'
import type { ClaudeAgentDriver, CodexAgentDriver, ProcessEndReport, ResumeCheckpoint, TurnResult, DriverState } from './contract.js'
import type { AgentEvent, PendingRequest } from './events.js'
import type { Activity, AgentNotification, BackgroundTask, CommandState, Worker } from './activity.js'
import type { ContextUsage, LimitEvent, QuotaReport } from './usage/types.js'

/** Pino-compatible object-first logger; the runtime creates no transports. */
export interface Logger {
  debug(obj: object, msg?: string): void
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

/**
 * One process generation's complete launch input. Cloned and frozen per
 * generation; the executable check and the spawn share it.
 */
export interface LaunchConfiguration {
  /** Absolute working directory of the agent process. */
  cwd: string
  /** The complete child environment; nothing ambient is merged in. */
  childEnv: Readonly<Record<string, string>>
  /** Absolute executable path; resolved through childEnv.PATH when omitted. */
  executablePath?: string
  /** Explicit home, cache and temp locations the runtime may write. */
  homeDir: string
  cacheDir: string
  tempDir: string
}

/**
 * Launch input: a fixed configuration, or a synchronous callback read before
 * each generation (Kawai's catalog refresh on respawn). A throwing callback
 * refuses that launch.
 */
export type LaunchInput = LaunchConfiguration | (() => LaunchConfiguration)

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number

/** Claude permission configuration, independent of credentials and provider. */
export interface ClaudePermissions {
  mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'
  /**
   * Tools the session may use. A list is enforced fail-closed by a deny-capable
   * PreToolUse policy: every unlisted tool is denied without prompting. `all`
   * enforces nothing beyond disallowedTools and the mode.
   */
  enabledTools: readonly string[] | 'all'
  /** Always denied, including Bash when listed (v1 has no Bash command allow-list). */
  disallowedTools: readonly string[]
}

/** Codex approval and sandbox policy, applied on thread start, resume and turns. */
export interface CodexPermissions {
  approvalPolicy: 'never' | 'on-request' | 'untrusted'
  /** `none` maps to the protocol's danger-full-access; never silently substituted. */
  sandbox: 'workspace-write' | 'read-only' | 'none'
  networkAccess: boolean
  /** Extra writable roots (workspace-write), e.g. a Git common directory. */
  writableRoots: readonly string[]
  /** Disabled requests are answered/denied immediately, never left pending. */
  userInput: 'enabled' | 'disabled'
  elicitation: 'enabled' | 'disabled'
}

/** What a tool handler learns about its call. */
export interface ToolCallContext {
  toolCallId: string
  turnId: string | null
  /** The driver-level session/thread the call belongs to. */
  runtimeSessionId: string | null
}

export interface ToolCallResult {
  content: string
  isError?: boolean
}

/** One host-supplied tool, shared by Claude in-process MCP and Codex dynamic tools. */
export interface ToolDefinition<Schema extends z.ZodType = z.ZodType> {
  name: string
  description: string
  inputSchema: Schema
  handler(input: z.infer<Schema>, context: ToolCallContext): Promise<ToolCallResult>
}

export interface ToolSet {
  /** MCP server / dynamic-tool namespace; caller data, never hard-coded. */
  namespace: string
  tools: readonly ToolDefinition[]
}

/** Names-only tool observation: never the tool's arguments (P14). */
export interface ToolObservation {
  phase: 'call' | 'result'
  tool: string
  toolCallId: string
  turnId: string | null
  isError?: boolean
}

export interface SubmitContext {
  messageUuid: string
  turnId: string
  text: string
  context: JsonValue | undefined
}

/** Synchronous pre-submit decision; a refusal precedes any enqueue or event (P12). */
export type BeforeSubmit = (submission: SubmitContext) => { accepted: true } | { accepted: false; reason: string }

export interface WireFrame {
  generation: number
  direction: 'out' | 'in' | 'stderr' | 'lifecycle'
  at: string
  text: string
}

/** Optional raw protocol recorder; absence changes no process ownership. */
export interface WireRecorder {
  record(frame: WireFrame): void
}

/** Output callbacks. onEvent is required; everything else fires only when supplied. */
export interface AgentCallbacks {
  onEvent(event: AgentEvent): void
  onState?(state: DriverState): void
  /** Fires after the request is registered and its event emitted; may answer inline. */
  onRequest?(request: PendingRequest): void
  onProcessEnd?(report: ProcessEndReport): void
  /** Awaited before work depending on this checkpoint is acknowledged (R10). */
  onCheckpoint?(checkpoint: ResumeCheckpoint): void | Promise<void>
  onTurnResult?(result: TurnResult): void
  onModel?(model: string): void
  onCompaction?(info: { boundaryId: string; turnId: string | null; preTokens: number | null }): void
  onContextUsage?(usage: ContextUsage | null): void
  onLimitEvent?(event: LimitEvent): void
  onQuotaReport?(report: QuotaReport): void
  onActivity?(activity: Activity | null): void
  onWorkers?(workers: Worker[]): void
  onBackgroundTasks?(tasks: BackgroundTask[]): void
  onNotification?(notification: AgentNotification): void
  onCommandState?(state: CommandState): void
}

export interface BaseDriverOptions {
  logger: Logger
  launch: LaunchInput
  callbacks: AgentCallbacks
  /** Resume this conversation; a refused identity is an error, never a fresh session. */
  resume?: ResumeCheckpoint
  model?: string
  effort?: Effort
  systemPromptAppend?: string
  /** Defaults to no tools. */
  tools?: ToolSet
  beforeSubmit?: BeforeSubmit
  onToolObservation?(observation: ToolObservation): void
  wire?: WireRecorder
  /**
   * What happens to a request still pending after onRequest returns. `deny`
   * (default, headless) settles it immediately; `wait` keeps it pending for a
   * later answer (Kawai's UI and its own deadlines).
   */
  unansweredRequests?: 'deny' | 'wait'
}

/** Optional detailed Claude hook adapter (Kawai's outbound audit); opt-in only. */
export interface ClaudeAuditHooks {
  preToolUse?(input: { tool: string; toolCallId: string; input: JsonValue }): void
  postToolUse?(input: { tool: string; toolCallId: string; isError: boolean }): void
}

export interface ClaudeDriverOptions extends BaseDriverOptions {
  permissions: ClaudePermissions
  /** Settings sources the CLI reads; headless default is none. */
  settingSources?: ReadonlyArray<'user' | 'project' | 'local'>
  /** Quota pulls through the supplied home's login are off unless chosen (design §6). */
  quotaSource?: 'none' | 'host-login'
  auditHooks?: ClaudeAuditHooks
}

/** Optional detailed Codex audit adapter; opt-in only. */
export interface CodexAuditHooks {
  onItem?(item: { kind: string; itemId: string; detail: JsonValue }): void
}

export interface CodexDriverOptions extends BaseDriverOptions {
  permissions: CodexPermissions
  auditHooks?: CodexAuditHooks
}

export type CreateClaudeDriver = (options: ClaudeDriverOptions) => ClaudeAgentDriver
export type CreateCodexDriver = (options: CodexDriverOptions) => CodexAgentDriver
