// One long-lived Claude Agent SDK query() per chat session, in streaming-input
// mode: user turns are pushed into a TurnQueue the query consumes, events are
// mapped to ChatEvents, approvals/questions ride a cancellable promise bridge
// over canUseTool, status (working/permission/waiting) is derived from
// driver state — never from log parsing — and the live-turn activity is
// reduced from the same stream frames (thinking/tool_use block starts,
// status, api_retry) through the pure chatActivity reducer. Context-meter
// state (per-request usage, compaction drops, threshold resolution) lives in
// the pure contextUsage tracker; this module only maps frames onto its
// inputs — per-request usage from message_start, message_delta, and assistant
// frames, merged per message id. All SDK types are confined to this module; the SDK itself is
// injected as a queryFactory (the manager does the dynamic import), mirroring
// the SpawnFn convention in server/terminal/.
// Results and frames bind to turns by the client uuid each prompt carries,
// relying on the pinned CLI contract in docs/claude-cli-contract.md (floor,
// recorded-frame test, and the live check to run when the floor rises).
import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionResult,
  Query,
  SDKAssistantMessage,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  ChatApprovalDecision,
  ChatApprovalPolicy,
  ChatTurnUsage,
  ChatBackgroundTask,
  ChatCommandState,
  ChatEvent,
  ChatNotificationPriority,
  ChatNotificationSeverity,
  ChatPendingRequest,
  ChatPeerMessage,
  ChatQuestion,
  ChatQuestionAnswer,
  ChatTurnTrigger,
  ChatTurnTriggerTask,
  ChatWorker,
} from '../../shared/chat'
import { turnSucceeded } from '../../shared/chat'
import type { SessionStatus } from '../../shared/types'
import {
  ASK_USER_QUESTION_TOOL,
  parseQuestions,
  toolResultText,
} from './contentBlocks'
import {
  activityBody,
  contentBlockToInput,
  initialChatActivityState,
  projectActivity,
  reduceActivity,
  systemFrameToInput,
  type ChatActivityInput,
  type ChatActivityState,
} from './chatActivity'
import {
  anyWorkerLive,
  initialChatWorkersState,
  projectWorkers,
  recoveredWorkersState,
  reduceWorkers,
  taskFrameToInput,
  type ChatWorkersInput,
  type ChatWorkersState,
} from './chatWorkers'
import {
  backgroundInputFromWorkersInput,
  initialChatBackgroundTasksState,
  projectBackgroundTasks,
  projectBackgroundTaskRecords,
  recoveredBackgroundTasksState,
  reduceBackgroundTasks,
  type BackgroundTaskRecord,
  type ChatBackgroundTasksInput,
  type ChatBackgroundTasksState,
} from './chatBackgroundTasks'
import {
  ChatContextTracker,
  parsePositiveTokens,
  sumRequestUsage,
  mergeRequestUsage,
  EMPTY_REQUEST_USAGE,
  type RequestUsage,
  type ChatContextStep,
} from './contextUsage'
import {
  parseRateLimitEvent,
  parseUsagePull,
  parseUsageReport,
} from './usageLimits'
import type { ChatProviderEnv } from './chatProviderEnv'
import { ChatCommandTracker, type RawChatCommand } from './chatCommands'
import { decideApproval } from './approvalPolicy'
import { resolveClaudeProfile } from './ClaudeProfiles'
import { logger } from '../logger'
import { TurnQueue } from './TurnQueue'
import { CliTurnBinder } from './cliTurnBinding'
import { TEAM_ALLOWED_TOOLS } from '../team/mailboxTools'
import { outboundAuditHooks } from '../outbound/auditHooks'
import type { OutboundAuditSink } from '../outbound/observer'
import { TEAM_MCP_SERVER } from '../team/teamPrompt'
import { formatEnvelope } from '../team/envelope'
import { createWireTappedSpawn, type ChatWireRecorder } from './wireTap'
import {
  assistantLimitSignal,
  rejectedResetsAt,
  rejectedWindow,
  retryLimitSignal,
  type ChatLimitSignal,
} from './limitSignals'

/** Spawn provenance is part of the runtime-neutral contract (design D1). */
export type { ChatSpawnInfo } from './provider/driver'
import type { ChatAgentDriver, ChatDriverCallbacks, ChatSpawnInfo } from './provider/driver'

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
  /** Agentboard session id (chat-<uuid>); used for logging context only. */
  sessionId: string
  projectPath: string
  queryFactory: ChatQueryFactory
  /** SDK session id to resume on the first turn (undefined = fresh). */
  resumeSessionId?: string
  /** Provider overrides, read at each spawn so Settings changes apply. */
  getProviderEnv?: () => ChatProviderEnv
  /**
   * Session approval policy, read at each canUseTool call so a live policy
   * switch applies to the next request without a respawn (design D2).
   * Omitted = manual (today's behavior).
   */
  getApprovalPolicy?: () => ChatApprovalPolicy
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

interface PendingRequest {
  requestId: string
  kind: 'approval' | 'question'
  turnId: string
  tool: string
  /** Raw canUseTool input (AskUserQuestion validation reads questions). */
  input: Record<string, unknown>
  questions?: ChatQuestion[]
  at: string
  settled: boolean
  settle: (result: PermissionResult) => void
}

/** Omit that distributes over the ChatEvent union, keeping each member's type. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never
type ChatEventDraft = DistributiveOmit<ChatEvent, 'id' | 'sequence' | 'at'>

export class ChatSessionDriver implements ChatAgentDriver {
  private readonly options: ChatSessionDriverOptions
  private readonly queue = new TurnQueue()
  /** Slash-command list state; this driver is its only feeder (design D2). */
  private commands = new ChatCommandTracker()
  private query: Query | null = null
  private sequence = 0
  private activeTurnId: string | null = null
  private compactionStartedAt: number | null = null
  /**
   * Which CLI turn a result or content frame belongs to (see cliTurnBinding
   * and docs/claude-cli-contract.md): every prompt carries a client uuid the
   * CLI echoes on its result, so an interrupted turn's late frames and result
   * never complete or feed a turn opened since, in any order.
   */
  private readonly binder = new CliTurnBinder({
    violation: (reason) => logger.warn('chat_cli_contract_violation', { sessionId: this.options.sessionId, reason }),
    unknownUuid: (uuid) => logger.warn('chat_unknown_result_uuid', { sessionId: this.options.sessionId, uuid }),
  })
  /**
   * The CLI advertises interrupt_cancel_queued_v1 on init; undefined until
   * the first init (an older CLI ignores the field, so it is sent then).
   */
  private cancelQueuedSupported: boolean | undefined
  /**
   * Task notifications that arrived while no turn was active (background
   * tasks D5): they become the next turn's trigger — user-started or
   * agent-started alike — and are consumed when that turn opens.
   */
  private pendingTaskNotifications: ChatTurnTriggerTask[] = []
  private streamingMessageId: string | null = null
  private readonly pendingRequests = new Map<string, PendingRequest>()
  /** Tool use ids this live stream has seen (call or result). */
  private readonly seenToolCallIds = new Set<string>()
  /** Echo suppression: texts we submitted that the SDK may echo back. */
  private readonly sentEchoTexts = new Map<string, number>()
  private capturedSdkSessionId: string | undefined
  /** Last model reported to onModel; undefined before the first report. */
  private lastReportedModel: string | undefined
  private lastStatus: SessionStatus = 'waiting'
  /** Live-turn activity state (design D3); null phase when no turn runs. */
  private activityState: ChatActivityState = initialChatActivityState()
  /**
   * Spawned-worker roster state (workers design D3); reduced from the task
   * edge stream and the background level set, projected on change.
   */
  private workersState: ChatWorkersState = initialChatWorkersState()
  private backgroundTasksState: ChatBackgroundTasksState = initialChatBackgroundTasksState()
  /**
   * Agent/Task tool_use ids, parent and nested alike (design D4): the only
   * worker traffic kept in the parent transcript, and the join keys that say
   * a subagent tool_result belongs to a kept nested-spawn call.
   */
  private readonly agentToolCallIds = new Set<string>()
  /** Context-meter state (context meter designs D1–D3); see contextUsage.ts. */
  private readonly context = new ChatContextTracker()
  /**
   * Running usage of the latest top-level model request (design E1), keyed by
   * its message id. Separate from `streamingMessageId`, which only moves while
   * a turn is active (design E3).
   */
  private requestUsage: { messageId: string | null; usage: RequestUsage } = {
    messageId: null,
    usage: EMPTY_REQUEST_USAGE,
  }
  /** Reset time from the latest rejected rate_limit_event (design D6). */
  private limitResetsAt: string | null = null
  /** That event's window (`seven_day_opus`, …), kept and dropped beside the reset (providers-and-workers D7). */
  private limitWindow: string | null = null
  private dead = false
  /** The audit id of the agent process this driver currently runs (D7). */
  private currentSpawnId = 'ob-s-none'
  /** Updated by the manager before a respawn; see setClaudeExecutablePath. */
  private claudeExecutablePath: string | undefined
  /** The agent's current working directory; see setProjectPath. */
  private sessionProjectPath: string
  private killed = false

  constructor(options: ChatSessionDriverOptions) {
    this.options = options
    this.commands = new ChatCommandTracker(options.onCommandState)
    this.claudeExecutablePath = options.claudeExecutablePath
    this.sessionProjectPath = options.projectPath
    // Workers design D6: carry the recovered outcomes into the fresh roster.
    if (options.recoveredWorkers?.length) {
      this.workersState = recoveredWorkersState(options.recoveredWorkers)
    }
    // Background tasks D6: same contract for the task roster.
    if (options.recoveredBackgroundTasks?.length) {
      this.backgroundTasksState = recoveredBackgroundTasksState(options.recoveredBackgroundTasks)
    }
  }

  get isDead(): boolean {
    return this.dead
  }

  /** Current slash-command state (loading / ready / unavailable). */
  getCommandState(): ChatCommandState {
    return this.commands.state
  }

  /**
   * Spawn the query without sending a turn (attach-time start): makes the
   * agent's command list available before the first message. No-op while a
   * query runs; a dead one respawns with resume, exactly like send.
   */
  start(): void {
    if (this.killed) return
    this.ensureQuery()
  }

  /**
   * Executable for the next spawn. The manager re-verifies the executable
   * before respawning a dead driver; the CLI may have moved since the first
   * spawn, so the freshly verified path replaces the stored one.
   */
  setClaudeExecutablePath(path: string | undefined): void {
    this.claudeExecutablePath = path
  }

  /**
   * Working directory for the next spawn (worktree tracking design D2): the
   * manager advances it when the agent's cwd moves, so a respawn resumes in
   * the directory the conversation is actually in, not the creation path.
   */
  setProjectPath(path: string): void {
    this.sessionProjectPath = path
  }

  /**
   * Open the next turn id and announce it, consuming any buffered task
   * notifications as the trigger (background tasks D5). All three open
   * paths — user send, peer delivery, agent self-start — funnel through
   * here so the buffer can never outlive the turn it should name.
   */
  private startTurn(trigger?: ChatTurnTrigger): string {
    const turnId = this.options.createTurnId?.() ?? `turn-${crypto.randomUUID()}`
    this.activeTurnId = turnId
    this.pendingTaskNotifications = []
    this.binder.turnOpened(turnId, trigger !== undefined)
    this.emit({ type: 'turn_started', turnId, ...(trigger ? { trigger } : {}) })
    return turnId
  }

  /**
   * The turn content frames belong to, or null while an interrupted turn's
   * result is still owed — those frames are the aborted turn's, never the
   * turn opened since.
   */
  private frameTurnId(): string | null {
    return this.binder.framesBelongToActive() ? this.activeTurnId : null
  }

  /** Hand a prompt to the CLI under a fresh client uuid bound to `turnId`. */
  private enqueue(turnId: string, message: Omit<SDKUserMessage, 'uuid'>): void {
    const uuid = crypto.randomUUID()
    this.binder.promptSent(uuid, turnId)
    this.queue.push({ ...message, uuid })
  }

  /** Submit a user turn. Spawns the SDK lazily on the first turn. */
  send(text: string): void {
    if (this.killed) return
    this.ensureQuery()
    const turnId = this.activeTurnId ?? this.startTurn()
    this.trackEcho(text)
    this.emit({ type: 'user_message', turnId, text })
    this.enqueue(turnId, {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    })
    this.refreshStatus()
  }

  /** Peer submission is display state; only the CLI transcript proves receipt. */
  deliver(envelope: ChatPeerMessage): void {
    if (this.killed) throw new Error('Recipient was killed')
    if (this.activeTurnId || this.pendingRequests.size || anyWorkerLive(this.workersState)) {
      throw new Error('Recipient is not idle')
    }
    this.ensureQuery()
    const turnId = this.startTurn()
    const text = formatEnvelope(envelope)
    this.trackEcho(text)
    this.emit({ type: 'peer_message', turnId, ...envelope })
    this.enqueue(turnId, {
      type: 'user', message: { role: 'user', content: text },
      parent_tool_use_id: null,
      // A human sender has no session id; the envelope's senderKind says so.
      origin: { kind: 'peer', from: envelope.senderSession ?? 'human' },
    })
    this.refreshStatus()
  }

  /**
   * Stop button: abort the in-flight turn, drop queued sends, cancel asks.
   * Every caller (Stop, archive, urgent mail) also cancels what the CLI
   * already queued (cancel_queued), so a dropped send never runs later.
   * turn_interrupted is emitted at once; the promise resolves on the CLI's
   * acknowledgement. The aborted turn's late frames and result are told
   * apart by uuid (see `binder`), so nothing waits for them.
   */
  interrupt(): Promise<void> {
    this.binder.promptsWithdrawn(promptUuids(this.queue.clearPending()))
    this.cancelAllRequests('interrupted')
    if (this.activeTurnId) {
      const turnId = this.activeTurnId
      this.activeTurnId = null
      this.binder.turnInterrupted(turnId)
      this.emit({ type: 'turn_interrupted', turnId })
      // Turn boundary: re-resolve the threshold for the next turn (design D2).
      this.refreshContextThreshold()
    }
    // Workers die with the aborted turn (design D3): outcome-less rows
    // settle as stopped so none can keep reading as live.
    this.feedWorkers({ type: 'process_end' })
    const query = this.query
    this.refreshStatus()
    if (!query) return Promise.resolve()
    const cancelQueued = this.cancelQueuedSupported !== false
    if (!cancelQueued) {
      logger.warn('chat_cli_contract_violation', { sessionId: this.options.sessionId, reason: 'interrupt-cancel-queued-unsupported' })
    }
    return interruptQuery(query, cancelQueued).then((receipt) => {
      // Cancelled prompts never run: an interrupted turn whose prompts were
      // all cancelled before its init owes no result.
      if (this.query === query && receipt?.cancelled) this.binder.promptsWithdrawn(receipt.cancelled)
    }).catch(() => {
      // The process may already be gone; the stream loop handles death.
    })
  }

  /** Kill the session: abort, settle pending approvals with a denial, stop. */
  kill(): void {
    this.killed = true
    this.queue.end()
    this.cancelAllRequests('killed')
    this.activeTurnId = null
    this.binder.reset()
    // Archive and kill both end the process (design D3): every worker still
    // without an outcome settles as stopped, nothing survives as live. The
    // background tasks die with the process too (background tasks D1) — but
    // not on a turn interrupt, which they survive by design.
    this.feedWorkers({ type: 'process_end' })
    this.feedBackgroundTasks({ type: 'process_end' })
    this.notifySpawnEnd()
    this.commands.markUnavailable()
    const query = this.query
    this.query = null
    if (query) {
      try {
        void interruptQuery(query, this.cancelQueuedSupported !== false).catch(() => {})
        query.close()
      } catch {
        // Already gone.
      }
    }
  }

  /** Server shutdown: same settlement as kill (callbacks cannot survive it). */
  shutdown(): void {
    this.kill()
  }

  /**
   * A live policy switch (design D4): switching to auto grants approvals
   * already pending as cards; questions stay with the user. Switching to
   * manual affects only later requests, so it is a no-op here.
   */
  onApprovalPolicyChanged(policy: ChatApprovalPolicy): void {
    if (policy !== 'auto') return
    for (const pending of Array.from(this.pendingRequests.values())) {
      if (pending.kind !== 'approval' || pending.settled) continue
      this.pendingRequests.delete(pending.requestId)
      pending.settled = true
      pending.settle({ behavior: 'allow' })
      this.emit({
        type: 'request_resolved',
        requestId: pending.requestId,
        outcome: 'allowed',
        decidedBy: 'policy',
        tool: pending.tool,
      })
    }
    this.refreshStatus()
  }

  /** Answer an approval card. First valid answer wins; stale answers error. */
  resolveApproval(
    requestId: string,
    decision: ChatApprovalDecision
  ): { ok: true } | { ok: false; error: string } {    const pending = this.pendingRequests.get(requestId)
    if (!pending || pending.settled) {
      return {
        ok: false,
        error: `No pending approval with id ${requestId}; it may already be answered or cancelled`,
      }
    }
    if (pending.kind !== 'approval') {
      return { ok: false, error: `Request ${requestId} is not an approval` }
    }
    this.pendingRequests.delete(requestId)
    pending.settled = true
    if (decision === 'allow') {
      pending.settle({ behavior: 'allow' })
      this.emit({ type: 'request_resolved', requestId, outcome: 'allowed', decidedBy: 'user' })
    } else {
      pending.settle({
        behavior: 'deny',
        message: 'User denied this tool use in Agentboard',
      })
      this.emit({ type: 'request_resolved', requestId, outcome: 'denied', decidedBy: 'user' })
    }
    this.refreshStatus()
    return { ok: true }
  }

  /** Answer a question_request; validates against the offered questions. */
  answerQuestion(
    requestId: string,
    answers: Record<string, ChatQuestionAnswer>
  ): { ok: true } | { ok: false; error: string } {
    const pending = this.pendingRequests.get(requestId)
    if (!pending || pending.settled) {
      return {
        ok: false,
        error: `No pending question with id ${requestId}; it may already be answered or cancelled`,
      }
    }
    if (pending.kind !== 'question' || !pending.questions) {
      return { ok: false, error: `Request ${requestId} is not a question` }
    }
    const validated = validateAnswers(pending.questions, answers)
    if (!validated.ok) {
      return validated
    }
    this.pendingRequests.delete(requestId)
    pending.settled = true
    pending.settle({
      behavior: 'allow',
      updatedInput: {
        ...pending.input,
        answers: validated.answers,
        ...(validated.response !== undefined
          ? { response: validated.response }
          : {}),
      },
    })
    this.emit({ type: 'request_resolved', requestId, outcome: 'answered', decidedBy: 'user' })
    this.refreshStatus()
    return { ok: true }
  }

  /** Snapshot of still-pending approvals/questions (for chat-snapshot). */
  getPendingRequests(): ChatPendingRequest[] {
    return Array.from(this.pendingRequests.values()).map((pending) =>
      pending.kind === 'approval'
        ? {
            kind: 'approval',
            requestId: pending.requestId,
            tool: pending.tool,
            input: pending.input,
            at: pending.at,
          }
        : {
            kind: 'question',
            requestId: pending.requestId,
            questions: pending.questions ?? [],
            at: pending.at,
          }
    )
  }

  /**
   * Tool use ids this live stream has produced events for. Transcript replay
   * uses it to avoid marking in-flight tools as dead requests.
   */
  getSeenToolCallIds(): Set<string> {
    return new Set(this.seenToolCallIds)
  }

  // ---------------------------------------------------------------- internals

  /**
   * A crashed SDK process does not end the chat session: respawn with resume
   * on the next send/start. Sequence numbers keep counting so clients never
   * see a reused sequence after a respawn.
   */
  private ensureQuery(): void {
    this.dead = false
    if (!this.query) {
      this.spawnQuery()
    }
  }

  private reportSpawn(info: ChatSpawnInfo): void {
    if (!this.options.onSpawn) return
    try {
      this.options.onSpawn(info)
    } catch (error) {
      logger.warn('chat_spawn_hook_failed', { sessionId: this.options.sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private spawnQuery(): void {
    this.compactionStartedAt = null
    // D7: a fresh id per agent process; the observer holds it live until the
    // process ends, so a call with no outcome reads pending, then unknown.
    this.currentSpawnId = `ob-s-${crypto.randomUUID()}`
    const resume = this.capturedSdkSessionId ?? this.options.resumeSessionId
    const launch = resolveClaudeProfile(
      this.options.claudeProfileId,
      this.options.getProviderEnv?.() ?? {},
      {
        projectPath: this.sessionProjectPath,
        ...(this.options.profileCatalogHome
          ? { homeDir: this.options.profileCatalogHome }
          : {}),
      }
    )
    // The profile-configured window (design D2 step 2) is re-read each spawn
    // so Settings changes apply to the next process. The old process's
    // observed report readings die with it — they outrank the profile, so a
    // stale threshold would survive a window change whenever the new probe
    // fails to answer.
    this.applyContextStep(
      this.context.setProfileWindow(
        parsePositiveTokens(launch.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
      )
    )
    // An operator-named profile executable replaces the standard binary; the
    // `executable` key itself is launch bookkeeping, not an SDK option.
    const { executable: profileExecutable, ...launchOptions } = launch
    const executablePath = profileExecutable ?? this.claudeExecutablePath
    const wire = this.options.wire
    const systemPromptAppend = this.options.getSystemPromptAppend?.()
    const effort = this.options.getEffort?.()
    const options: Options = {
      cwd: this.sessionProjectPath,
      // Option parity with a terminal `claude` session in the project dir.
      // The team role + mailbox note (agent-teams D7) is read per spawn: a
      // running process keeps its prompt, the next spawn gets edits.
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(systemPromptAppend ? { append: systemPromptAppend } : {}),
      },
      ...(this.options.teamMcpServer ? {
        mcpServers: { [TEAM_MCP_SERVER]: this.options.teamMcpServer },
        allowedTools: TEAM_ALLOWED_TOOLS,
      } : {}),
      settingSources: ['user', 'project', 'local'],
      permissionMode: 'default',
      includePartialMessages: true,
      canUseTool: this.canUseTool,
      // Worktree tracking (design D1): every cwd change — EnterWorktree,
      // a shell cd, anything Claude Code records — reports the session's
      // new working directory. Observational only; never blocks the agent.
      hooks: {
        CwdChanged: [{ hooks: [this.cwdChangedHook] }],
        // The four audit hooks (D3) construct in src/server/outbound/; the
        // driver only registers them, observational exactly as built there.
        ...outboundAuditHooks({
          sink: this.options.outbound,
          spawnId: () => this.currentSpawnId,
          cwd: () => this.sessionProjectPath,
        }),
      },
      ...(executablePath
        ? { pathToClaudeCodeExecutable: executablePath }
        : {}),
      ...(resume ? { resume } : {}),
      // Before the profile's launch options, which carry no effort today, so
      // any future override there is a deliberate choice (group-effort D3).
      ...(effort ? { effort } : {}),
      ...launchOptions,
      ...(wire ? { spawnClaudeCodeProcess: createWireTappedSpawn(wire) } : {}),
    }
    let query: Query
    try {
      query = this.options.queryFactory({
        prompt: this.queue,
        options,
        ...(wire ? { wire } : {}),
      })
    } catch (error) {
      // A spawn that fails outright is reported like a crash: session error,
      // driver dead, and the next send/start retries.
      this.markDead(
        `The agent process failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return
    }
    this.query = query
    this.reportSpawn({
      cwd: this.sessionProjectPath,
      systemPromptAppend: systemPromptAppend ?? '',
      effort: effort ?? null,
      model: typeof launchOptions.model === 'string' ? launchOptions.model : null,
      env: launchOptions.env ?? process.env,
      resumed: Boolean(resume),
    })
    this.commands.beginLoading()
    void this.fetchInitializationCommands(query)
    void this.runQueryLoop(query)
    void this.maybePullUsage(query)
    // Attach-time threshold probe (design D2): the report can answer before
    // the first request does.
    this.refreshContextThreshold()
  }

  /**
   * The usage pull fallback (design D1): right after a spawn, when the
   * profile holds no data at all, ask the CLI for its plan windows so the
   * bar can appear before the first turn reports anything. The claim is
   * awaited (it may route to the provider quota endpoint first, provider
   * usage pull); everything else is wrapped: the control API is explicitly
   * unstable, and a throw, an absent method, or a shape change records the
   * no-data verdict instead of disturbing the session.
   */
  private async maybePullUsage(query: Query): Promise<void> {
    const { claimUsagePull, onUsageReport, onUsageNoData } = this.options
    if (!claimUsagePull || !onUsageReport || !(await claimUsagePull())) return
    const pull = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof pull !== 'function') {
      onUsageNoData?.()
      return
    }
    try {
      void pull
        .call(query, { skipBehaviors: true })
        .then((response) => {
          const report = parseUsagePull(response)
          if (report && report.windows.length > 0) onUsageReport(report)
          else onUsageNoData?.()
        })
        .catch(() => onUsageNoData?.())
    } catch {
      onUsageNoData?.()
    }
  }

  /**
   * The initialize response carries the command list. Fetched fire-and-forget
   * right after each spawn; a failure leaves the state to resolve through
   * init/commands_changed or the driver's death. Test fakes without the
   * method are skipped (their commands come from pushed messages).
   */
  private async fetchInitializationCommands(query: Query): Promise<void> {
    if (typeof query.initializationResult !== 'function') return
    try {
      const result = await query.initializationResult()
      if (this.query === query && Array.isArray(result.commands)) {
        this.commands.applyCommands(result.commands as RawChatCommand[])
      }
    } catch {
      // Not fatal: the process may still stream init/commands_changed, or die
      // (which marks the state unavailable).
    }
  }

  private async runQueryLoop(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        if (this.killed) break
        this.handleSdkMessage(message)
      }
      if (!this.killed) {
        this.markDead('The agent process exited unexpectedly')
      }
    } catch (error) {
      if (!this.killed) {
        this.markDead(
          `The agent process failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
  }

  /** The process ended: retire its audit spawn (D7), observationally only. */
  private notifySpawnEnd(): void {
    try {
      this.options.outbound?.onSpawnEnd(this.currentSpawnId)
    } catch {
      // Observational only: an audit failure never breaks the session.
    }
  }

  /** Only a session crash marks the driver dead; per-turn errors do not. */
  private markDead(reason: string): void {
    this.dead = true
    this.query = null
    this.activeTurnId = null
    this.binder.reset()
    // The process is gone (design D3): workers cannot have outcomes any
    // more, so any still-open row settles as stopped rather than wedging.
    // Background tasks settle the same way (D1) — the respawn starts clean.
    this.feedWorkers({ type: 'process_end' })
    this.feedBackgroundTasks({ type: 'process_end' })
    this.notifySpawnEnd()
    this.feedActivity({ type: 'turn_end' })
    this.cancelAllRequests('killed')
    // Notification strip design D4: the notices this process emitted die
    // with it — the same driver object respawns on the next send/start, so
    // the manager must hear the process ended here.
    this.options.onProcessEnd?.()
    this.emit({ type: 'error', message: reason })
    this.commands.markUnavailable()
    this.refreshStatus()
  }

  private handleSdkMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'assistant':
        this.handleAssistant(message)
        return
      case 'user':
        this.handleUser(message)
        return
      case 'result':
        this.handleResult(message)
        return
      case 'stream_event':
        this.handlePartial(message)
        return
      case 'system':
        this.handleSystem(message)
        return
      case 'rate_limit_event':
        // A rejected event's window rides beside the reset it names
        // (providers-and-workers D7); both drop together once past.
        if (rejectedResetsAt(message.rate_limit_info) !== null) {
          this.limitResetsAt = rejectedResetsAt(message.rate_limit_info)
          this.limitWindow = rejectedWindow(message.rate_limit_info)
        }
        // Plan usage rides these frames whatever the turn state; malformed
        // values degrade to a windowless report, never a session error.
        this.options.onRateLimit?.(
          parseRateLimitEvent(message.rate_limit_info)
        )
        return
      case 'conversation_reset':
        // The conversation is gone (plan-mode clear-context, fresh_session,
        // onboarding): nothing is measured any more, so the meter clears
        // rather than keeping the old window's occupancy (design D7). The
        // threshold sources stay — they describe the process/profile, not
        // the conversation.
        this.requestUsage = { messageId: null, usage: EMPTY_REQUEST_USAGE }
        this.applyContextStep(this.context.resetConversation())
        return
      default:
        // command_lifecycle frames are logged only; no rule reads them
        // (docs/claude-cli-contract.md).
        if ((message as { type: string }).type === 'command_lifecycle') {
          logger.debug('chat_command_lifecycle', { sessionId: this.options.sessionId, frame: message })
        }
        // Trailing informational frames (prompt suggestions, status, hooks,
        // ...) are tolerated and ignored — a result ends a turn, not the
        // stream, and unknown frames must never kill the session.
        return
    }
  }

  private handleAssistant(message: SDKAssistantMessage): void {
    // The /usage twin rides the wrapper level, not message.content, and is
    // replayed to nobody — capture it even outside a turn.
    if (message.usage_report) {
      const report = parseUsageReport(message.usage_report)
      if (report) this.options.onUsageReport?.(report)
    }
    // Context usage rides the same wrapper level, whatever the turn state —
    // trailing frames after an interrupt still measure the live context.
    this.readContextUsage(message)
    const turnId = this.frameTurnId()
    if (!turnId) return
    const messageId = message.message.id ?? message.uuid
    const subagent = isSubagentContentFrame(message)
    if (message.error && !subagent) {
      const text = message.message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
      const { resetsAt, window } = this.currentLimit()
      this.reportLimit(assistantLimitSignal(message.error, text, resetsAt, window))
    }
    for (const block of message.message.content) {
      if (block.type === 'text') {
        // Worker chatter stays out of the parent transcript (design D4).
        if (subagent) continue
        this.emit({
          type: 'assistant_text',
          turnId,
          messageId,
          text: block.text,
        })
      } else if (block.type === 'tool_use') {
        // D4 carve-out: a worker's own Agent/Task call is the anchor of the
        // nested worker's row, so it is emitted exactly like the parent's.
        // Everything else a worker runs stays out.
        if (subagent && !isAgentSpawnTool(block.name)) continue
        this.seenToolCallIds.add(block.id)
        this.emit({
          type: 'tool_call',
          turnId,
          toolCallId: block.id,
          tool: block.name,
          input: block.input,
        })
        if (isAgentSpawnTool(block.name)) {
          this.agentToolCallIds.add(block.id)
          // The row anchor (design D1): the spawning call's id is the workerId.
          this.feedWorkers({ type: 'spawn', toolCallId: block.id })
        }
        if (block.name === 'Bash' || block.name === 'Monitor') {
          // The kind join (background tasks D1): the tool_use block streams
          // before the task_started it will anchor.
          this.feedBackgroundTasks({ type: 'tool_call', toolCallId: block.id, tool: block.name })
        }
        if (!subagent) {
          this.feedActivity({
            type: 'tool_call',
            toolCallId: block.id,
            tool: block.name,
          })
        }
      }
      // thinking and other block kinds are not surfaced in the transcript.
    }
  }

  private handlePartial(message: SDKPartialAssistantMessage): void {
    // Worker chatter stays out of the parent transcript (design D4): its
    // stream must neither leak deltas nor hijack the parent's streaming id —
    // filtering the completed assistant message cannot undo either.
    if (isSubagentContentFrame(message)) return
    const event = message.event
    // Usage capture precedes the turn gate, like assistant-frame usage:
    // trailing frames after an interrupt still measure the live context.
    this.readStreamUsage(event)
    const turnId = this.frameTurnId()
    if (!turnId) return
    if (event.type === 'message_start') this.streamingMessageId = event.message.id
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      this.emit({
        type: 'assistant_delta',
        turnId,
        messageId: this.streamingMessageId ?? message.uuid,
        delta: event.delta.text,
      })
    }
    if (event.type === 'content_block_start') {
      const input = contentBlockToInput(event.content_block)
      if (input) this.feedActivity(input)
    }
  }

  private handleUser(message: SDKUserMessage): void {
    const turnId = this.frameTurnId()
    if (!turnId) return
    const content = message.message.content
    if (typeof content === 'string') {
      this.maybeEchoUserText(content, turnId)
      return
    }
    const subagent = isSubagentContentFrame(message)
    for (const block of content) {
      if (block.type === 'tool_result') {
        // D4 carve-out: only the tool_result of a kept Agent/Task call (a
        // nested spawn) rides the parent transcript; a worker's own tool
        // results stay out.
        if (subagent && !this.agentToolCallIds.has(block.tool_use_id)) continue
        this.seenToolCallIds.add(block.tool_use_id)
        this.emit({
          type: 'tool_result',
          turnId,
          toolCallId: block.tool_use_id,
          output: toolResultText(block.content),
          isError: block.is_error,
        })
        // A rejected spawn never starts a task, so no task frame can settle
        // its row — the error result is the only bookend the worker gets.
        // Without it the row stays live and holds the session at working.
        if (block.is_error && this.agentToolCallIds.has(block.tool_use_id)) {
          this.feedWorkers({
            type: 'spawn_rejected',
            toolCallId: block.tool_use_id,
            summary: toolResultText(block.content),
          })
        }
        if (!subagent) {
          this.feedActivity({ type: 'tool_result', toolCallId: block.tool_use_id })
        }
      } else if (block.type === 'text') {
        if (subagent) continue
        this.maybeEchoUserText(block.text, turnId)
      }
    }
  }

  /** The SDK echoes streamed user turns; suppress the copy we already sent. */
  private maybeEchoUserText(text: string, turnId: string): void {
    const outstanding = this.sentEchoTexts.get(text) ?? 0
    if (outstanding > 0) {
      this.sentEchoTexts.set(text, outstanding - 1)
      return
    }
    this.emit({ type: 'user_message', turnId, text })
  }

  private trackEcho(text: string): void {
    this.sentEchoTexts.set(text, (this.sentEchoTexts.get(text) ?? 0) + 1)
  }

  private handleResult(message: SDKResultMessage): void {
    // modelUsage arrives on every result whatever the turn state; its
    // contextWindow is the threshold fallback (design D2 step 3).
    this.readModelContextWindow(message)
    // A result ends only the turn it names (see `binder`): an interrupted
    // turn's, a late or duplicate one, or one naming a never-sent uuid is
    // dropped — already reported via turn_interrupted, or not ours.
    const verdict = this.binder.result(resultUuids(message), message.queued_turn_count)
    const turnId = this.activeTurnId
    if (verdict === 'drop' || !turnId) return
    this.activeTurnId = null
    const outcome = {
      subtype: message.subtype,
      isError: message.is_error,
      ...(message.terminal_reason ? { terminalReason: message.terminal_reason } : {}),
    }
    const succeeded = turnSucceeded(outcome)
    this.emit({
      type: 'turn_completed',
      turnId,
      ...outcome,
      totalCostUsd: message.total_cost_usd,
      numTurns: message.num_turns,
      ...turnUsageOf(message),
      // Final text only on a successful turn: under `is_error` the result is
      // the error text (chat-context-exhaustion D1).
      ...(succeeded && message.subtype === 'success' ? { finalText: message.result } : {}),
    })
    if (!succeeded) {
      // Per-turn error results keep the streaming session usable; surface the
      // failure in the transcript and return to waiting.
      this.emit({ type: 'error', message: resultErrorText(message) })
    }
    this.refreshStatus()
    // Turn boundary: re-resolve the threshold for the next turn (design D2).
    this.refreshContextThreshold()
  }

  private handleSystem(message: Extract<SDKMessage, { type: 'system' }>): void {
    if (message.subtype === 'status' && message.status === 'compacting') {
      if (this.compactionStartedAt === null) {
        this.compactionStartedAt = Date.now()
        try {
          this.options.onCompaction?.({
            trigger: 'unknown', preTokens: null, postTokens: null,
            startedAt: new Date(this.compactionStartedAt).toISOString(),
            endedAt: null, durationSeconds: null, outcome: 'started',
          }, message.uuid ? `start:${message.uuid}` : undefined)
        } catch { logger.warn('chat_compaction_observation_failed') }
      }
    }
    if (message.subtype === 'api_retry') {
      const { resetsAt, window } = this.currentLimit()
      this.reportLimit(retryLimitSignal(message, resetsAt, window))
    }
    if (message.subtype === 'init') {
      if (Array.isArray(message.capabilities)) {
        this.cancelQueuedSupported = message.capabilities.includes('interrupt_cancel_queued_v1')
      }
      // An init opening an interrupted turn whose result is still owed (the
      // interrupt landed before its init) opens nothing (see `binder`).
      const binding = this.binder.init()
      // Agent-started turn (background tasks D5): `init` opens every turn
      // and is the first frame of one that the SDK yields to consumers —
      // `session_state_changed` is `sdk_host_only` and never reaches this
      // loop. A spawn without a prompt emits no `init`, so an idle attach
      // cannot open a phantom turn; a user `send()` has already set its turn
      // id before the CLI gets the message.
      if (binding === 'open' && !this.activeTurnId) {
        this.startTurn(
          this.pendingTaskNotifications.length > 0
            ? { kind: 'task', tasks: this.pendingTaskNotifications.slice() }
            : { kind: 'resumed' }
        )
        this.refreshStatus()
      }
      if (!this.capturedSdkSessionId && message.session_id) {
        this.capturedSdkSessionId = message.session_id
        this.options.onSdkSessionId?.(message.session_id)
      }
      // The model in effect for the coming turn (design D1/D5): init opens
      // every turn, so a /model switch lands here on the next one. Only a
      // changed, non-empty value fires — a missing or empty string on an
      // older CLI never reports a placeholder.
      if (
        typeof message.model === 'string' &&
        message.model !== '' &&
        message.model !== this.lastReportedModel
      ) {
        this.lastReportedModel = message.model
        this.options.onModel?.(message.model)
      }
      // The authoritative terminal-bound set; until here the tracker used the
      // observed fallback (verified 2026-10-06: init only arrives once a turn
      // starts, so this lands with the first prompt).
      this.commands.applyTerminalCommands(message.terminal_slash_commands)
      return
    }
    if (message.subtype === 'commands_changed') {
      this.commands.applyCommands(message.commands as RawChatCommand[])
      return
    }
    if (message.subtype === 'local_command_output') {
      const turnId = this.frameTurnId()
      if (turnId) {
        this.emit({ type: 'command_output', turnId, text: message.content })
      }
      return
    }
    if (message.subtype === 'notification') {
      // A CLI-style notice (notification strip design D4): forwarded without
      // a per-key allowlist, so new CLI notices appear without Kawai changes.
      // Frames without a key or text are malformed and ignored; the wire
      // capture still records the raw frame for the debug view.
      if (typeof message.key === 'string' && message.key !== '' && typeof message.text === 'string' && message.text !== '') {
        this.options.onNotification?.(
          {
            key: message.key,
            source: 'agent',
            severity: notificationSeverity(message.color),
            priority: notificationPriority(message.priority),
            text: message.text,
            receivedAt: new Date().toISOString(),
          },
          typeof message.timeout_ms === 'number' ? message.timeout_ms : undefined
        )
      }
      return
    }
    if (message.subtype === 'compact_boundary') {
      try {
        const metadata = message.compact_metadata as { trigger?: string; pre_tokens?: number; post_tokens?: number } | undefined
        const measured = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
        this.options.onCompaction?.({
          trigger: metadata?.trigger === 'auto' ? 'auto' : metadata?.trigger === 'manual' ? 'manual' : 'unknown',
          startedAt: this.compactionStartedAt === null ? null : new Date(this.compactionStartedAt).toISOString(),
          endedAt: new Date().toISOString(), preTokens: measured(metadata?.pre_tokens),
          postTokens: measured(metadata?.post_tokens),
          durationSeconds: this.compactionStartedAt === null ? null : Math.max(0, (Date.now() - this.compactionStartedAt) / 1000),
          outcome: 'completed',
        }, message.uuid ? `boundary:${message.uuid}` : undefined)
      } catch { logger.warn('chat_compaction_observation_failed') }

      this.compactionStartedAt = null

      // Adopt before the notice so the fresher value is already live when
      // subscribers see it. The post-compaction size is the new reading
      // (design D3): the meter drops with the transcript, auto or manual
      // alike. A missing, invalid, or zero post_tokens keeps the last reading
      // — never a placeholder standing in for "unknown" — and the boundary
      // still owes a write either way.
      this.applyContextStep(
        this.context.compact(
          typeof message.compact_metadata?.post_tokens === 'number'
            ? message.compact_metadata.post_tokens
            : null,
          new Date().toISOString()
        ),
        true
      )
      this.emit({ type: 'notice', text: 'Context compacted', kind: 'compacted' })
    }
    // The task_* edges and the background level set feed the worker roster
    // (design D3); they never reach the activity reducer, whose own inputs
    // are status and api_retry only.
    if (
      message.subtype === 'task_notification' &&
      !this.activeTurnId &&
      typeof message.task_id === 'string' &&
      message.task_id
    ) {
      // No turn is running, so this notification is about to wake the agent
      // (background tasks D5): hold it as the next turn's trigger.
      this.pendingTaskNotifications.push({
        taskId: message.task_id,
        ...(typeof message.tool_use_id === 'string' && message.tool_use_id
          ? { toolCallId: message.tool_use_id }
          : {}),
        status: typeof message.status === 'string' ? message.status : 'unknown',
        ...(typeof message.summary === 'string' && message.summary
          ? { summary: message.summary }
          : {}),
      })
    }
    const rosterInput = taskFrameToInput(message)
    if (rosterInput) {
      this.feedWorkers(rosterInput)
      const backgroundInput = backgroundInputFromWorkersInput(rosterInput)
      if (backgroundInput) this.feedBackgroundTasks(backgroundInput)
      return
    }
    if (isSubagentContentFrame(message)) return
    const input = systemFrameToInput(message)
    if (input) this.feedActivity(input)
    // Other system subtypes are informational; ignored.
  }

  /** The announced reset and its window while still ahead (providers-and-workers D7). */
  private currentLimit(): { resetsAt: string | null; window: string | null } {
    if (this.limitResetsAt && Date.parse(this.limitResetsAt) <= Date.now()) {
      this.limitResetsAt = null
      this.limitWindow = null
    }
    return { resetsAt: this.limitResetsAt, window: this.limitWindow }
  }

  private reportLimit(signal: ChatLimitSignal | null): void {
    if (!signal) return
    try {
      this.options.onLimitEvent?.(signal)
    } catch {
      // Observational: recording a limit must never break the session.
    }
  }

  /**
   * Observational CwdChanged hook (worktree tracking design D1). Fires for
   * every change of the session's working directory; `agent_id` is present
   * only on subagent firings (the SDK's documented discriminator), and only
   * the main session's cwd moves the chat row. Always lets the agent
   * continue, whatever the observer does.
   */
  private readonly cwdChangedHook: HookCallback = async (input) => {
    try {
      if (input.hook_event_name === 'CwdChanged' && !input.agent_id) {
        this.options.onCwdChanged?.(input.new_cwd)
      }
    } catch {
      // Observational only: a failing observer must never block the agent.
    }
    return { continue: true }
  }

  private readonly canUseTool: CanUseTool = (toolName, input, toolOptions) => {
    if (this.options.teamMcpServer && TEAM_ALLOWED_TOOLS.includes(toolName)) {
      return Promise.resolve({ behavior: 'allow' } as PermissionResult)
    }
    const requestId = `req-${crypto.randomUUID()}`
    const turnId = this.activeTurnId ?? 'turn-0'
    const policy = this.options.getApprovalPolicy?.() ?? 'manual'
    if (decideApproval(policy, toolName) === 'allow') {
      // Auto policy (design D3): grant without a card. No pending request is
      // created, so the session never enters permission status for this use.
      this.emit({
        type: 'request_resolved',
        requestId,
        outcome: 'allowed',
        decidedBy: 'policy',
        tool: toolName,
      })
      return Promise.resolve({ behavior: 'allow' } as PermissionResult)
    }
    const answer = new Promise<PermissionResult>((resolve) => {
      const pending: PendingRequest = {
        requestId,
        kind: 'approval',
        turnId,
        tool: toolName,
        input,
        at: new Date().toISOString(),
        settled: false,
        settle: resolve,
      }
      if (toolName === ASK_USER_QUESTION_TOOL) {
        const questions = parseQuestions(input)
        if (questions) {
          pending.kind = 'question'
          pending.questions = questions
          this.pendingRequests.set(requestId, pending)
          this.emit({
            type: 'question_request',
            turnId,
            requestId,
            questions,
          })
          this.refreshStatus()
          return
        }
        // Unparseable AskUserQuestion input degrades to a plain approval card.
      }
      this.pendingRequests.set(requestId, pending)
      this.emit({
        type: 'approval_request',
        turnId,
        requestId,
        tool: toolName,
        input,
      })
      this.refreshStatus()
    })
    // Race the answer against SDK cancellation (interrupt/turn end/kill): a
    // cancelled ask settles as an interrupting denial so the tool never runs.
    const cancellation = new Promise<PermissionResult>((resolve) => {
      toolOptions.signal.addEventListener('abort', () => {
        this.cancelRequest(requestId, 'cancelled')
        resolve({
          behavior: 'deny',
          message: 'The request was cancelled',
          interrupt: true,
        })
      })
    })
    return Promise.race([answer, cancellation]).then(result => {
      if (result.behavior === 'deny') {
        try {
          this.options.outbound?.onDeniedCard({
            toolName,
            toolInput: input,
            toolUseId: toolOptions.toolUseID,
            spawnId: this.currentSpawnId,
            ...(toolOptions.agentID === undefined ? {} : { agentId: toolOptions.agentID }),
            cwd: this.sessionProjectPath,
            // An interrupt-cancelled ask stays denied; the row says why.
            ...(result.interrupt === true ? { reason: 'interrupted' } : {}),
          })
        } catch {
          // Observational only.
        }
      }
      return result
    })
  }

  private cancelRequest(requestId: string, reason: string): void {
    const pending = this.pendingRequests.get(requestId)
    if (!pending || pending.settled) return
    this.pendingRequests.delete(requestId)
    pending.settled = true
    pending.settle({
      behavior: 'deny',
      message: `The request was cancelled (${reason})`,
      interrupt: true,
    })
    this.emit({ type: 'request_resolved', requestId, outcome: 'cancelled' })
    this.refreshStatus()
  }

  private cancelAllRequests(reason: string): void {
    for (const requestId of Array.from(this.pendingRequests.keys())) {
      this.cancelRequest(requestId, reason)
    }
  }

  private refreshStatus(): void {
    // D7: a live worker holds the session at working just like an in-flight
    // turn; permission still wins. Liveness, not status: a worker in the
    // completion gap (running, left the set) must not hold the session.
    const next: SessionStatus =
      this.pendingRequests.size > 0
        ? 'permission'
        : this.activeTurnId || anyWorkerLive(this.workersState)
          ? 'working'
          : 'waiting'
    if (next !== this.lastStatus) {
      this.lastStatus = next
      this.options.onStatus(next)
    }
  }

  /**
   * One activity input (design D3). The state always advances; onActivity
   * fires when the projected phase (not its elapsed time) changes or when the
   * reducer restarts the clock (`request_resolved` after an approval wait) —
   * clients re-anchor their timer on every publish, so a suppressed reset
   * would keep counting the card's wait time.
   */
  private feedActivity(input: ChatActivityInput): void {
    const previous = this.activityState
    this.activityState = reduceActivity(this.activityState, input)
    const changed =
      JSON.stringify(activityBody(previous)) !==
        JSON.stringify(activityBody(this.activityState)) ||
      previous.phaseStartedAt !== this.activityState.phaseStartedAt
    if (this.options.onActivity && changed) {
      this.options.onActivity(projectActivity(this.activityState))
    }
  }

  /**
   * One roster input (design D3). The reducer returns the same reference on
   * a no-op input (a repeated last-tool), which is the publish gate: the
   * full projection goes out exactly when the roster changed, elapsed times
   * computed fresh so clients re-anchor their timers on every publish.
   */
  private feedWorkers(input: ChatWorkersInput): void {
    const next = reduceWorkers(this.workersState, input)
    if (next === this.workersState) return
    this.workersState = next
    this.options.onWorkers?.(projectWorkers(this.workersState))
    this.refreshStatus()
  }

  /**
   * Feed the background-task roster (background tasks D1). Unlike workers,
   * a change never touches status (D7): a running dev server must not pin
   * the session to working.
   */
  private feedBackgroundTasks(input: ChatBackgroundTasksInput): void {
    const next = reduceBackgroundTasks(this.backgroundTasksState, input)
    if (next === this.backgroundTasksState) return
    this.backgroundTasksState = next
    this.options.onBackgroundTasks?.(projectBackgroundTasks(this.backgroundTasksState))
  }

  /** Current roster projection with elapsed times computed now (design D2). */
  getWorkers(): ChatWorker[] {
    return projectWorkers(this.workersState)
  }

  /** Current background-task projection with elapsed times computed now (D2). */
  getBackgroundTasks(): ChatBackgroundTask[] {
    return projectBackgroundTasks(this.backgroundTasksState)
  }

  /** Sidecar records for the task store (D6): identity and outcome, plus the
   * server-only output-file path. */
  getBackgroundTaskRecords(): BackgroundTaskRecord[] {
    return projectBackgroundTaskRecords(this.backgroundTasksState)
  }

  /**
   * A task's output tail through the SDK's `get_task_output` control
   * (background tasks D3): at most the last 8 KiB, running or ended. The
   * method exists at runtime but is not declared in sdk.d.ts (verified
   * 2.1.296), so the call is structural; a missing method, a dead query, or
   * a throw reads as null and the caller falls back to the output file.
   */
  async getTaskOutput(
    taskId: string
  ): Promise<{ output: string; total_bytes: number; truncated: boolean } | null> {
    const query = this.query as {
      getTaskOutput?: (id: string) => Promise<{ output: string; total_bytes: number; truncated: boolean }>
    } | null
    if (!query || typeof query.getTaskOutput !== 'function') return null
    try {
      return await query.getTaskOutput(taskId)
    } catch {
      return null
    }
  }

  /**
   * Stop one background task (background tasks D4): the settle arrives as a
   * normal task_notification through the roster channel. False when there is
   * no live query or the CLI refused (typically: the task just ended); both
   * are logged and dropped by the caller, never a transcript error.
   */
  async stopTask(taskId: string): Promise<boolean> {
    const query = this.query
    if (!query) return false
    try {
      await query.stopTask(taskId)
      return true
    } catch {
      return false
    }
  }

  /**
   * Per-request context usage (design D1): an assistant frame carries the
   * latest request's usage — input plus cache reads/creations plus output —
   * which is exactly what the next request pays, never the session total.
   * Stream events (`readStreamUsage`) feed the same per-message total, for
   * providers whose frames carry zeros. The latest request wins; subagent
   * frames are skipped (design D6) so a Task tool's own requests cannot move
   * the parent's meter.
   */
  private readContextUsage(message: SDKAssistantMessage): void {
    if (isSubagentContentFrame(message)) return
    const usage = message.message.usage
    if (!usage) return
    this.noteRequestUsage(message.message.id ?? message.uuid, usage)
  }

  /**
   * Stream usage (design E1): `message_start` opens a request's usage and the
   * final `message_delta` completes it — GLM sends zeros at the start and the
   * real counts only in the delta. A delta with no known start is ignored.
   */
  private readStreamUsage(event: SDKPartialAssistantMessage['event']): void {
    if (event.type === 'message_start') {
      const { id, usage } = event.message ?? {}
      if (id && usage) this.noteRequestUsage(id, usage)
    } else if (event.type === 'message_delta' && event.usage && this.requestUsage.messageId) {
      this.noteRequestUsage(this.requestUsage.messageId, event.usage)
    }
  }

  /** Merge a usage source into its request's running usage and publish the sum. */
  private noteRequestUsage(
    messageId: string,
    incoming: Parameters<typeof mergeRequestUsage>[1]
  ): void {
    const base =
      this.requestUsage.messageId === messageId ? this.requestUsage.usage : EMPTY_REQUEST_USAGE
    const usage = mergeRequestUsage(base, incoming)
    this.requestUsage = { messageId, usage }
    this.applyContextStep(
      this.context.readRequest(sumRequestUsage(usage), new Date().toISOString())
    )
  }

  /**
   * The contextWindow on every result's modelUsage is the last-resort
   * threshold (design D2 step 3); the largest seen wins so a mid-session
   * model switch widens rather than truncates the meter's denominator.
   */
  private readModelContextWindow(message: SDKResultMessage): void {
    for (const usage of Object.values(message.modelUsage ?? {})) {
      const window = usage?.contextWindow
      if (typeof window === 'number') {
        this.applyContextStep(this.context.noteModelWindow(window))
      }
    }
  }

  /** Forward a tracker step to the manager sink. */
  private applyContextStep(step: ChatContextStep, boundary = false): void {
    if (step.kind === 'none') return
    if (step.kind === 'clear') {
      this.options.onContextUsage?.(null, { persist: true })
      return
    }
    const state = this.context.getState()
    const thresholdSource = state.reportThreshold !== null
      ? state.reportThresholdExact ? 'report-threshold' : step.usage.thresholdApproximate ? 'report-window-fallback' : 'report-window-reserve'
      : state.profileWindow !== null
        ? step.usage.thresholdApproximate ? 'profile-window-fallback' : 'profile-window-reserve'
        : 'model-window-fallback'
    this.options.onContextUsage?.(step.usage, { persist: step.persist || boundary, thresholdSource })
  }

  /**
   * Light control call (the interrupt precedent): ask the CLI for its
   * context-usage report on attach and at turn boundaries. Best-effort — a
   * missing method, a throw, or a rejection keeps the last threshold, and a
   * report that lands after a respawn (or death) is dropped.
   */
  private refreshContextThreshold(): void {
    const query = this.query
    if (!query || typeof query.getContextUsage !== 'function') return
    try {
      void query
        .getContextUsage({ detail: 'summary' })
        .then((report) => {
          if (this.query === query) {
            // The probe is asynchronous: it usually resolves just after the
            // turn boundary already persisted the previous reading, so the
            // tracker flags this re-scale for immediate persistence.
            this.applyContextStep(this.context.applyReport(report))
          }
        })
        .catch(() => {
          // Best-effort: keep the last resolved threshold.
        })
    } catch {
      // Same.
    }
  }

  private emit(draft: ChatEventDraft): void {
    this.sequence += 1
    const event: ChatEvent = {
      ...draft,
      id: `evt-${crypto.randomUUID()}`,
      sequence: this.sequence,
      at: new Date().toISOString(),
    } as ChatEvent
    this.options.onEvent(event)
    // Turn lifecycle and request resolutions are top-level driver semantics
    // (never subagent frames), so they ride the emit points directly.
    if (draft.type === 'turn_started') {
      this.feedActivity({ type: 'turn_started' })
    } else if (
      draft.type === 'turn_completed' ||
      draft.type === 'turn_interrupted'
    ) {
      this.feedActivity({ type: 'turn_end' })
    } else if (draft.type === 'request_resolved') {
      this.feedActivity({ type: 'request_resolved' })
    }
  }
}

/**
 * Subagent *content* frames (design D4): an assistant/user frame whose
 * `parent_tool_use_id` is set comes from a worker, so its text and tool
 * traffic stay out of the parent transcript — except the worker's own
 * Agent/Task calls, whose emission anchors the nested worker's row. The same
 * field on stream/system frames carries other meanings (e.g. a tool_progress
 * heartbeat names its parent tool call); there it only suppresses the
 * activity row, as it did before this change.
 */
function isSubagentContentFrame(frame: object): boolean {
  const parent = (frame as { parent_tool_use_id?: unknown }).parent_tool_use_id
  return parent != null
}

/** The tools that spawn a worker (design D1): both names, current and old. */
function isAgentSpawnTool(toolName: string): boolean {
  return toolName === 'Agent' || toolName === 'Task'
}

/** The agent's color vocabulary → strip severity; anything else reads as info. */
function notificationSeverity(color: unknown): ChatNotificationSeverity {
  if (color === 'warning') return 'warning'
  if (color === 'error') return 'error'
  return 'info'
}

/** A notification frame's priority, normalized; unknown values read as low. */
function notificationPriority(priority: unknown): ChatNotificationPriority {
  if (priority === 'immediate' || priority === 'high' || priority === 'medium' || priority === 'low') {
    return priority
  }
  return 'low'
}

function validateAnswers(
  questions: ChatQuestion[],
  answers: Record<string, ChatQuestionAnswer>
):
  | { ok: true; answers: Record<string, string>; response?: string }
  | { ok: false; error: string } {
  const result: Record<string, string> = {}
  let response: string | undefined
  for (const question of questions) {
    const answer = answers[question.question]
    if (!answer || (!answer.options?.length && !answer.text?.trim())) {
      return { ok: false, error: `Missing answer for "${question.question}"` }
    }
    const labels = new Set(question.options.map((option) => option.label))
    const text = answer.text?.trim()
    if (answer.options?.length) {
      // A single-select answer is one choice: an option or the user's own
      // text. Refuse both rather than silently dropping the text.
      if (!question.multiSelect && text) {
        return {
          ok: false,
          error: `"${question.question}" takes one answer: choose an option or type your own, not both`,
        }
      }
      if (!question.multiSelect && answer.options.length > 1) {
        return {
          ok: false,
          error: `"${question.question}" accepts only one choice`,
        }
      }
      for (const label of answer.options) {
        if (!labels.has(label)) {
          return {
            ok: false,
            error: `"${label}" is not an offered choice for "${question.question}"`,
          }
        }
      }
      // Multi-select: the user's own text is one more selection.
      result[question.question] = [...answer.options, ...(text ? [text] : [])].join(', ')
      if (text) response = text
    } else if (text) {
      result[question.question] = text
      response = text
    }
  }
  return {
    ok: true,
    answers: result,
    ...(response !== undefined ? { response } : {}),
  }
}

/** The client uuids a result echoes (`user_message_uuids`, else `user_message_uuid`). */
function resultUuids(message: SDKResultMessage): string[] {
  if (Array.isArray(message.user_message_uuids)) return message.user_message_uuids.filter((uuid) => typeof uuid === 'string')
  return typeof message.user_message_uuid === 'string' ? [message.user_message_uuid] : []
}

function promptUuids(messages: readonly SDKUserMessage[]): string[] {
  return messages.flatMap((message) => (message.uuid ? [message.uuid] : []))
}

/**
 * The SDK's runtime `interrupt` takes `{ cancelQueued }` and sends
 * `cancel_queued` (SDK 0.3.289), but its d.ts declares no parameter: this is
 * the one place that calls it with the option.
 */
type InterruptWithOptions = (options?: { cancelQueued?: boolean }) => Promise<SDKControlInterruptResponse | undefined>

function interruptQuery(query: Query, cancelQueued: boolean): Promise<SDKControlInterruptResponse | undefined> {
  const interrupt = query.interrupt as unknown as InterruptWithOptions
  return interrupt.call(query, cancelQueued ? { cancelQueued: true } : undefined)
}

/** The result's per-turn token counts (team-process-metrics D1); absent when the result carries none. */
/**
 * The transcript error for a failed result (chat-context-exhaustion D1): the
 * SDK's errors, or under `is_error` its result text, or the subtype — plus
 * the terminal reason when the CLI gave one, e.g.
 * `Prompt is too long (blocking_limit)`.
 */
export function resultErrorText(message: SDKResultMessage): string {
  const base =
    'errors' in message && message.errors.length > 0
      ? message.errors.join('; ')
      : message.subtype === 'success' && message.result.trim()
        ? message.result.trim()
        : `The turn ended with ${message.subtype}`
  return message.terminal_reason ? `${base} (${message.terminal_reason})` : base
}

export function turnUsageOf(message: { usage?: unknown }): { usage?: ChatTurnUsage } {
  const usage = message.usage
  if (!usage || typeof usage !== 'object') return {}
  const count = (key: string) => {
    const value = (usage as Record<string, unknown>)[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  return {
    usage: {
      inputTokens: count('input_tokens'),
      outputTokens: count('output_tokens'),
      cacheReadTokens: count('cache_read_input_tokens'),
      cacheCreationTokens: count('cache_creation_input_tokens'),
    },
  }
}
