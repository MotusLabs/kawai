// The Claude chat driver's host-facing construction types (task-602c71e9),
// moved unchanged from the retired in-tree ChatSessionDriver.ts so the
// adapter (claudeRuntime.ts), the manager and the development fixture keep
// their option, method and callback shapes. Internal to Kawai: the package's
// public API is untouched. The adapter itself refuses createTurnId and
// teamMcpServer (ClaudeChatDriverOptions omits teamMcpServer and takes the
// team tool table instead).
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatApprovalPolicy, ChatWorker } from '../../../shared/chat'
import type { WorkspaceMessageContext } from '../../../shared/planWorkspace'
import type { WorkspaceContextOutcome } from '../../plans/workspace/workspaceContext'
import type { OutboundAuditSink } from '../../outbound/observer'
import type { BackgroundTaskRecord } from '../chatBackgroundTasks'
import type { ChatProviderEnv } from '../chatProviderEnv'
import type { RetainedNamesDb } from '../secretNameRegistry'
import type { ChatTimerScheduler } from '../timerScheduler'
import type { ChatWireRecorder } from '../wireTap'
import type { ChatDriverCallbacks } from './driver'

/**
 * The SDK `query()` — injected so tests run against a fake. `wire` is the
 * session's protocol-frame recorder: the real SDK is tapped through
 * `options.spawnClaudeCodeProcess`, while a fake that never spawns a process
 * (the development fixture) records synthetic frames into it directly.
 */
export type ChatQueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
  wire?: ChatWireRecorder
}) => Query

/**
 * The Claude driver's construction options. The output callbacks come from
 * `ChatDriverCallbacks` (the runtime-neutral contract, design D1), which
 * this interface extends, so the contract's callback signatures are
 * type-checked against this driver (review O2) — a contract change that
 * this driver does not follow fails the build here.
 */
export interface ChatSessionDriverOptions extends ChatDriverCallbacks {
  /** Opaque unique turn identity; injectable for deterministic protocol tests. */
  createTurnId?: () => string
  /**
   * The plan-workspace context store's record (PR D §4): the one DB write a
   * contextual submit makes, before the turn opens and before the SDK
   * message is enqueued (invariant I1). Omitted = contextual sends refuse.
   */
  recordWorkspaceContext?: (input: {
    sessionId: string
    messageUuid: string
    turnId: string
    context: WorkspaceMessageContext
  }) => WorkspaceContextOutcome
  /** Agentboard session id (chat-<uuid>); used for logging context only. */
  sessionId: string
  projectPath: string
  queryFactory: ChatQueryFactory
  /** SDK session id to resume on the first turn (undefined = fresh). */
  resumeSessionId?: string
  /** Provider overrides, read at each spawn so Settings changes apply. */
  getProviderEnv?: () => ChatProviderEnv
  /**
   * The secret-name registry's persistence seam (provider-relay-setup D2),
   * read at each spawn so a catalog edit re-registers at the next launch and
   * a name once seen survives its entry's removal. Omitted = catalog-only
   * withholding (tests, direct resolution).
   */
  retainedNamesDb?: RetainedNamesDb
  /**
   * Session approval policy, read at each canUseTool call so a live policy
   * switch applies to the next request without a respawn (design D2).
   * Omitted = manual (today's behavior).
   */
  getApprovalPolicy?: () => ChatApprovalPolicy
  /**
   * The question auto-answer wait in milliseconds, read once per question
   * when it is asked (question-auto-answer D2); 0 or omitted = off. A
   * deadline is set only when every question of the request marks a
   * recommended option. The manager supplies this for Claude chats only —
   * never for Codex (design QA-U4).
   */
  getQuestionAutoAnswerMs?: () => number
  /**
   * Timer seam behind the auto-answer deadline (question-auto-answer D2).
   * Defaults to real timers; tests advance a manual clock by hand.
   */
  timerScheduler?: ChatTimerScheduler
  /** Persisted session profile; omitted for legacy Default sessions. */
  claudeProfileId?: string
  /**
   * Home directory for the user-level profile catalog; injected in tests so a
   * real home catalog cannot leak into launch resolution.
   */
  profileCatalogHome?: string
  /**
   * Externally installed Claude Code executable passed to the SDK as
   * pathToClaudeCodeExecutable. Omitted when a fake runtime is injected
   * (tests, development fixture), leaving SDK resolution unchanged.
   */
  claudeExecutablePath?: string
  /**
   * Text appended to the preset system prompt, read at every spawn (team
   * role + mailbox note, agent-teams D7). Omitted/empty = preset only.
   */
  getSystemPromptAppend?: () => string | undefined
  /**
   * Observes audited tool use (execution-safety-recovery D3): Bash, Monitor,
   * and external MCP calls, subagents included. Purely observational — the
   * sink never blocks, delays, or decides a tool call, and the hooks swallow
   * its failures.
   */
  outbound?: OutboundAuditSink
  /**
   * Reasoning effort for the spawn, read at every spawn like the prompt
   * (group-effort D2). Undefined = no `effort` option, so Claude Code's own
   * settings decide.
   */
  getEffort?: () => Options['effort']
  teamMcpServer?: NonNullable<Options['mcpServers']>[string]
  /**
   * Recovered roster rows (workers design D6) seeding a fresh driver, so
   * outcomes from before a restart or an archive/restore stay in the roster
   * and the sidecar instead of being replaced by the first publish.
   */
  recoveredWorkers?: ChatWorker[]
  /**
   * Recovered background-task rows (background tasks D6) seeding a fresh
   * driver, so settled outcomes survive a restart or an archive/restore.
   */
  recoveredBackgroundTasks?: BackgroundTaskRecord[]
  /**
   * Claims the profile's one usage pull after a spawn (design D1); when it
   * resolves false the pull is skipped for this driver's whole lifetime. The
   * claim may be async so the manager can route the pull to the session
   * provider's own quota endpoint first (provider usage pull) and only fall
   * back to this SDK pull when that endpoint does not answer for the
   * profile.
   */
  claimUsagePull?: () => boolean | Promise<boolean>
  /** Records the raw protocol of every spawned process (chat debug view). */
  wire?: ChatWireRecorder
}
