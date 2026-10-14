// Owns the lifecycle of chat sessions: auth-gated creation, lazy driver
// construction (the SDK query() is spawned by the driver on the first turn),
// persistence in the chat_sessions table with restore-on-start into the
// registry, kill/shutdown settlement (including the session's protocol log),
// immediate sdkSessionId capture so a restart can resume the same agent
// conversation, the current in-flight-turn activity (phase plus start
// time) surfaced through getSnapshot and the onActivity broadcast sink,
// the spawned-worker roster (rows plus outcomes) surfaced the same way
// through onWorkers and recovered from a sidecar on restart, and the
// notification strip's two sources (notification strip design D4/D5): agent
// notices held per session with same-key replacement and timeout expiry,
// merged ahead of the profile's account notice and surfaced through
// getSnapshot and the onNotifications broadcast sink. A
// live session's transcript is tailed for the agent's generated title rows,
// which replace any non-user-set name (chat-session-naming design D4). The
// SDK import stays dynamic (injected as a queryFactory in tests) so a broken
// install disables the feature instead of crashing the server. Chat spawns
// run a separately installed Claude Code executable: creation and every
// (re)spawn first pass an executable check (KAWAI_CLAUDE_PATH/PATH, version
// baseline) whose ClaudeExecutableError messages reach the user verbatim.
// Restore-on-start and attach history read transcripts asynchronously
// (async-transcript-parsing): whenRestored() resolves once every persisted
// row is registered, and the team mailbox starts only after that.
import type {
  ChatActivity,
  ChatApprovalDecision,
  ChatApprovalPolicy,
  ChatCommandState,
  ChatContextUsage,
  ChatEvent,
  ChatNotification,
  ChatNotificationPriority,
  ChatPendingRequest,
  ChatQuestionAnswer,
  ChatUsageReport,
  ChatWorker,
  ChatBackgroundTask,
} from '../../shared/chat'
import type {
  ChatNameSource,
  ServerMessage,
  Session,
  SessionParkedState,
  SessionStatus,
} from '../../shared/types'
import type { ChatSessionRecord, SessionDatabase } from '../db'
import { generateSessionName } from '../nameGenerator'
import { isExistingDirectory, resolveProjectDirectory } from '../paths'
import type { SessionRegistry } from '../SessionRegistry'
import { ChatSessionDriver, type ChatQueryFactory } from './ChatSessionDriver'
import { chatAuthErrorMessage, hasClaudeAuth } from './chatAuth'
import {
  ClaudeExecutableError,
  ensureClaudeExecutable,
  type ClaudeExecutableCheck,
} from './claudeExecutable'
import { effectiveChatEnv, type ChatProviderEnv } from './chatProviderEnv'
import type { ChatWireLogs } from './ChatWireLogs'
import type { ChatWorkerStore } from './chatWorkerStore'
import type { ChatTaskStore } from './chatTaskStore'
import {
  resolveClaudeProfile,
  claudeLaunchKey,
  verifyProfileExecutable,
  type ClaudeLaunchConfiguration,
  type ProfileCatalogContext,
} from './ClaudeProfiles'
import { logger } from '../logger'
import { probeSdkAvailability } from './sdkAvailability'
import { AccountNoticeStore, credentialsPathFor } from './accountNotices'
import { UsageLimitStore } from './usageLimits'
import { fetchZaiUsage } from './zaiUsage'
import { readWorkerTranscript } from './chatWorkerTranscript'
import { isTaskOutputFile, readTaskOutputTail } from './taskOutputFile'
import type { BackgroundTaskRecord } from './chatBackgroundTasks'
import { loadTeamGroups } from '../team/teamGroups'
import { SessionTeams } from '../team/sessionTeams'
import { SessionDirectory } from '../team/sessionDirectory'
import { MessageFeed } from '../team/messageFeed'
import { MessageQuery } from '../team/messageQuery'
import { TeamMailbox } from '../team/TeamMailbox'
import { createMailboxServer } from '../team/mailboxTools'
import { StrategyService } from '../strategy/StrategyService'
import { StrategyStore } from '../strategy/strategyStore'
import type { TeamMessage, TeamWorktreeOccupancy, WaitingReason } from '../../shared/team'
import { MailDispatcher } from '../team/dispatcher'
import { receiptMessageId } from '../team/receipt'
import type { LimitEventStore } from '../team/routing/limitEvents'
import type { HandoffTarget } from '../team/routing/limitOutcomes'
import type { RuleLoadReport, TeamRoutingState } from '../../shared/routing'
import { SessionMailbox } from '../team/sessionMailbox'
import type { TaskService } from '../team/TaskService'
import type { AssignmentService } from '../team/AssignmentService'
import type { SpawnRequest, SpawnResult } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import {
  findTranscriptPath,
  findTranscriptPathAsync,
  readTranscriptMetaAsync,
  replayTranscriptFile,
  replayTranscriptFileAsync,
  type TranscriptReplay,
} from './transcriptReplay'
import { watchTranscriptTitle, type TranscriptTitleWatcher } from './transcriptTitleWatcher'

export type { ChatQueryFactory }
export { chatAuthErrorMessage, hasClaudeAuth }

export interface ChatSessionManagerOptions {
  registry: SessionRegistry
  db: SessionDatabase
  onMailboxChange?: (teamId: string, message?: TeamMessage) => void
  /** A team's waiting reasons structurally changed: re-publish its mailbox (team-waiting-reasons). */
  onWaitingReasonsChange?: (teamId: string) => void
  /** Routing rules (re)loaded: every mailbox view refreshes its rule status. */
  onRoutingRulesLoaded?: () => void
  /** Every committed team-task change (wired to the task view push in index.ts). */
  onTaskChange?: (teamId: string) => void
  /** Every committed strategy change (wired to the strategy view push in bootstrap.ts). */
  onStrategyChange?: (teamId: string) => void
  /** Conversation-event sink (wired to the WS broadcast in index.ts). */
  onEvent: (sessionId: string, event: ChatEvent) => void
  /** Command-state sink (wired to the chat-commands push in index.ts). */
  onCommandState?: (sessionId: string, state: ChatCommandState) => void
  /**
   * Live-activity sink (activity indicator design D5): called on each phase
   * change of an in-flight turn, null when the turn ends. Wired to the WS
   * broadcast in index.ts; activity is ephemeral and never persisted.
   */
  onActivity?: (sessionId: string, activity: ChatActivity | null) => void
  /**
   * Context-usage sink (context meter design D5): called with the latest
   * reading whenever the driver publishes one, or null when a conversation
   * reset clears it. Wired to the coalesced WS broadcast in index.ts; the
   * reading itself persists at turn boundaries, compaction, driver death,
   * and the driver-flagged corrections.
   */
  onContextUsage?: (sessionId: string, usage: ChatContextUsage | null) => void
  /**
   * Model sink (chat-session-model design D5): called only when the driver
   * reports a model different from the last one. Wired to the coalesced WS
   * broadcast in index.ts; the value itself persists with the session row.
   */
  onModel?: (sessionId: string, model: string) => void
  /**
   * Plan-usage sink (usage bar design D4): called with the latest report
   * (or null) whenever a profile's held data changes. Wired to the WS
   * broadcast in index.ts; usage is ephemeral and never persisted.
   */
  onUsage?: (profileId: string, report: ChatUsageReport | null) => void
  /**
   * Worker-roster sink (workers design D2): the full projection whenever a
   * live session's roster changes. Wired to the WS broadcast in index.ts;
   * ephemeral in transit, persisted through the sidecar (design D6).
   */
  onWorkers?: (sessionId: string, workers: ChatWorker[]) => void
  /**
   * Background-task roster sink (background tasks design D2): the full
   * projection whenever a live session's task roster changes. Wired to the
   * WS broadcast like onWorkers; ephemeral in transit, persisted through the
   * sidecar (design D6).
   */
  onBackgroundTasks?: (sessionId: string, tasks: ChatBackgroundTask[]) => void
  /**
   * Notification sink (notification strip design D5): the session's full
   * merged list (account notice first, then agent notices, sorted by
   * priority and newest) whenever either source changes for it. Wired to the
   * WS broadcast in index.ts; notices are ephemeral and never persisted.
   */
  onNotifications?: (sessionId: string, notifications: ChatNotification[]) => void
  /** Sidecar store for restart recovery of worker outcomes (design D6). */
  workerStore?: ChatWorkerStore
  /** Sidecar store for restart recovery of background-task outcomes (D6). */
  taskStore?: ChatTaskStore
  /** Injected in tests; production resolves the SDK via dynamic import. */
  queryFactory?: ChatQueryFactory
  /** Receives the provider env so it probes the endpoint sessions will use. */
  availabilityProbe?: (
    providerEnv: ChatProviderEnv,
    launch?: ClaudeLaunchConfiguration,
    executablePath?: string
  ) => Promise<void>
  /**
   * Resolves and verifies the Claude Code executable every spawn will run.
   * Injected in tests; the default checks KAWAI_CLAUDE_PATH/PATH (version
   * probe + baseline). An injected queryFactory (fake runtime) skips it.
   */
  executableCheck?: () => Promise<ClaudeExecutableCheck>
  authCheck?: () => boolean
  /**
   * Provider overrides for SDK spawns (base URL, models, gateway token). A
   * getter, so a Settings change reaches the next spawn without a restart.
   */
  getProviderEnv?: () => ChatProviderEnv
  /** Per-session protocol capture for the chat debug view (always on). */
  wireLogs?: ChatWireLogs
  /** Project-directory check; injected in tests that use fictitious paths. */
  isDirectory?: (path: string) => boolean
  /**
   * Home directory for the user-level `.kawai` catalogs (profiles.json and
   * groups/ live here). Injected in tests so a real home catalog cannot leak
   * in.
   */
  profileCatalogHome?: string
  /**
   * Injected in tests; production uses global fetch for the provider usage
   * pull (the session provider's own quota endpoint).
   */
  providerUsageFetch?: typeof fetch
  /** Provider usage refresh cadence (provider pull design D5); tests shrink it. */
  providerUsageRefreshMs?: number
  /**
   * Base delay between transcript-locate retries (chat-session-naming D4).
   * The locator runs until the session goes away — the transcript appears
   * with the first message, which can be much later than the SDK id. Tests
   * shrink it so a delayed transcript is cheap to cover.
   */
  titleLocateIntervalMs?: number
  /** Catalog file failure sink; defaults to the structured logger. */
  catalogErrorLog?: (errors: string[]) => void
  /**
   * Scoped workspace-discovery refresh (worktree tracking design D2): called
   * once per debounce window with the session's newest path after the agent
   * moved, so a newly entered worktree is discovered without a reload.
   * Wired to the workspace coordinator in index.ts.
   */
  requestWorkspaceRefresh?: (projectPath: string) => void
  /**
   * Debounce window for those refreshes (default 500ms): a fast cd chain
   * collapses into one discovery pass for its final directory.
   */
  cwdRefreshDebounceMs?: number
}

export type ChatCreateResult =
  | { ok: true; session: Session }
  | { ok: false; error: string }

export type ChatActionResult =
  | { ok: true }
  | { ok: false; error: string }

/** Send-time refusal for archived sessions; restoring clears it (design D2). */
const ARCHIVED_SESSION_ERROR =
  'This chat session is archived. Restore it to continue the conversation.'

/** The dynamic SDK import failed; surfaced by every spawn path. */
function sdkLoadError(error: unknown): string {
  if (error instanceof ClaudeExecutableError) {
    // Actionable by construction (names the path and the fix); the
    // record and its stored conversation id are untouched.
    return error.message
  }
  return (
    'The Claude Agent SDK could not be loaded, so chat sessions are unavailable. ' +
    `Check the @anthropic-ai/claude-agent-sdk install: ${
      error instanceof Error ? error.message : String(error)
    }`
  )
}

/** Strip display order (notification strip design D5): higher first. */
const NOTICE_PRIORITY_RANK: Record<ChatNotificationPriority, number> = {
  immediate: 3,
  high: 2,
  medium: 1,
  low: 0,
}

/** Priority first (immediate highest), then newest arrival (design D5). */
function compareNotices(a: ChatNotification, b: ChatNotification): number {
  const byPriority = NOTICE_PRIORITY_RANK[b.priority] - NOTICE_PRIORITY_RANK[a.priority]
  if (byPriority !== 0) return byPriority
  return Date.parse(b.receivedAt) - Date.parse(a.receivedAt)
}

/** The chat-task-output reply payload (background tasks D3). */
export type ChatTaskOutputResult =
  | { state: 'ok'; output: string; totalBytes: number; truncated: boolean }
  | { state: 'unavailable' }

export class ChatSessionManager {
  private readonly options: ChatSessionManagerOptions
  private readonly records = new Map<string, ChatSessionRecord>()
  private readonly drivers = new Map<string, ChatSessionDriver>()
  /** In-flight ensureDriver calls, so racing sends never build two drivers. */
  private readonly driverPromises = new Map<
    string,
    Promise<ChatSessionDriver | null>
  >()
  private sdkQuery: Promise<ChatQueryFactory> | null = null
  /**
   * Current in-flight-turn activity per session: the phase body plus when it
   * began. Cleared on turn end, stop, archive, kill, and driver death; a
   * restart begins with none (design D5).
   */
  private readonly activities = new Map<
    string,
    { body: Omit<ChatActivity, 'elapsedMs'>; phaseStartedAt: number }
  >()
  /**
   * Latest context-usage reading per session (context meter design D5): the
   * fresher in-memory value between boundary writes; getSnapshot prefers it
   * over the stored column. Survives respawns; a restart begins with none.
   */
  private readonly contextReadings = new Map<string, ChatContextUsage>()
  /**
   * Latest worker roster per session (workers design D2): the last publish
   * of a live driver, or the recovered sidecar rows of a restarted one. A
   * live driver's projection is computed fresh for snapshots; this map is
   * what archived and restored sessions read.
   */
  private readonly workerRows = new Map<string, ChatWorker[]>()
  /**
   * Latest background-task roster per session (background tasks D2): the
   * last publish of a live driver, or the recovered sidecar rows of a
   * restarted one (design D6), mirroring the worker rows.
   */
  private readonly backgroundTaskRows = new Map<string, ChatBackgroundTask[]>()
  /**
   * Latest server-side task records per session (background tasks D6): the
   * rows plus the recorded output-file paths the wire shape never carries.
   * Recovery seeds the driver from these so the next roster write keeps the
   * paths; a live driver's records replace them wholesale on every publish.
   */
  private readonly backgroundTaskRecords = new Map<string, BackgroundTaskRecord[]>()
  /**
   * Availability probes for resolved provider configurations. Keyed so a provider
   * change in Settings re-probes the new endpoint; a failed probe is dropped so
   * a corrected configuration (or repaired install) recovers without a restart.
   * Concurrent creations under the same configuration share one probe.
   */
  private readonly availability = new Map<string, Promise<void>>()
  /**
   * Latest plan-usage report (or no-data verdict) per Claude profile, in
   * memory only (usage bar design D3): a restart begins with none.
   */
  private readonly usageLimits = new UsageLimitStore()
  /**
   * Profiles confirmed to serve the provider quota endpoint (provider usage
   * pull): their usage comes from there, and the host-login SDK pull is
   * skipped for the store lifetime. In memory only — a restart re-probes.
   */
  private readonly providerUsageProfiles = new Set<string>()
  /** Refresh timer per routed profile (provider usage pull design D5). */
  private readonly providerUsageTimers = new Map<string, ReturnType<typeof setInterval>>()
  /** Provider usage refresh cadence (provider usage pull design D5). */
  private readonly providerUsageRefreshMs: number
  /**
   * Latest login-expiry notice per credentials path (notification strip
   * design D2), in memory only: a restart begins with none until a check
   * runs. Keyed by path, not profile id, so profiles sharing ~/.claude share
   * one check while a profile pointing elsewhere gets its own file.
   */
  private readonly accountNotices = new AccountNoticeStore()
  /**
   * Credentials path each session's account notice is computed from
   * (notification strip design D2): resolved from the session's effective
   * launch environment on attach and agent start; null when the environment
   * suppresses the stored-login check or the profile is unknown.
   */
  private readonly sessionCredentials = new Map<string, string | null>()
  /**
   * Active agent notices per session, by key (notification strip design D4):
   * a newer frame with the same key replaces its entry. Cleared whole on
   * archive, kill, restart, and shutdown — the notices die with the process
   * that emitted them.
   */
  private readonly agentNotices = new Map<string, Map<string, ChatNotification>>()
  /**
   * Pending timeout_ms expiry timers per session and notice key (design D4):
   * each removes only the entry it was armed for, and only if that entry is
   * still the same instance it was armed against.
   */
  private readonly agentNoticeTimers = new Map<
    string,
    Map<string, ReturnType<typeof setTimeout>>
  >()
  /**
   * Transcript title tails per live session (chat-session-naming design D4):
   * a handle is either an armed watcher or a pending locate retry, so exactly
   * one entry exists whenever a session's transcript is being followed.
   * Released on kill, archive, and shutdown.
   */
  private readonly titleWatchers = new Map<string, { close: () => void }>()
  /**
   * Pending debounced workspace refreshes (worktree tracking design D2): one
   * per session whose agent moved, firing with the newest path only. Cleared
   * on kill and shutdown; the callback itself cannot outlive the session.
   */
  private readonly cwdRefreshTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; path: string }
  >()

  async createAvailableSession(input: { projectPath: string; name?: string; claudeProfileId?: string; approvalPolicy?: ChatApprovalPolicy; groupId?: string; cloneFromSessionId?: string; taskId?: string; spawned?: boolean }): Promise<ChatCreateResult> {
    // Refuse a bad path before the probe spends an SDK spawn on it.
    const project = resolveProjectDirectory(input.projectPath, this.options.isDirectory)
    if (!project.ok) return project
    const clone = input.cloneFromSessionId ? this.records.get(input.cloneFromSessionId) : undefined
    if (input.cloneFromSessionId && (!clone || clone.projectPath !== project.path)) return { ok: false, error: 'Clone source must be an existing chat in this project' }
    if (clone) input = { ...input, groupId: clone.groupId ?? undefined }
    // Fresh group choices require a definition. A clone preserves the
    // source record's immutable role, including one whose file was removed.
    if (input.groupId !== undefined && !clone) {
      const { catalog } = await loadTeamGroups(project.path, this.options.profileCatalogHome)
      if (!catalog.groups.has(input.groupId)) {
        return { ok: false, error: `Unknown group "${input.groupId}" for this project's team` }
      }
    }
    try {
      this.launchFor(input.claudeProfileId, project.path)
    } catch (error) {
      return { ok: false, error: String(error instanceof Error ? error.message : error) }
    }
    if (!this.authOk(input.claudeProfileId, project.path)) return { ok: false, error: chatAuthErrorMessage() }
    try {
      await this.probeAvailability(input.claudeProfileId, project.path)
    } catch (error) {
      if (error instanceof ClaudeExecutableError) {
        // Actionable by construction (names the path and the fix).
        return { ok: false, error: error.message }
      }
      return {
        ok: false,
        error: 'Claude Agent SDK is unavailable. Check its installation, runtime, and chat provider settings, then try again. ' +
          (error instanceof Error ? error.message : 'SDK probe failed'),
      }
    }
    return this.createSession(input)
  }
  private readonly snapshotHistory = new Map<string, ChatEvent[]>()
  private readonly liveEvents = new Map<string, ChatEvent[]>()
  /** In-flight async history loads, deduped per session (design D3). */
  private readonly historyLoads = new Map<string, Promise<void>>()
  /** Boot restore chain; chat-attach awaits it via whenRestored (design D2). */
  private readonly restorePromise: Promise<void>
  /**
   * SDK ids of persisted rows the async restore has not registered yet:
   * getSdkSessionIds reports them too, so log discovery never surfaces a
   * chat transcript as an extra session during the restore window.
   */
  private readonly restoringSdkIds = new Set<string>()
  private isShutDown = false

  /** Synchronous capture: no driver callback can interleave with history loading. */
  getSnapshot(sessionId: string): Extract<ServerMessage, { type: 'chat-snapshot' }> | null {
    if (!this.records.has(sessionId)) return null
    // Attach (live or archived) is one of the account-notice check points
    // (notification strip design D3): resolve the session's credentials path
    // and read it before the snapshot freezes the notice list.
    this.refreshAccountNotice(sessionId)
    this.captureHistory(sessionId)
    const live = this.liveEvents.get(sessionId) ?? []
    const activity = this.getActivity(sessionId)
    return {
      type: 'chat-snapshot', sessionId,
      profileId: this.records.get(sessionId)?.claudeProfileId ?? 'default',
      events: [...(this.snapshotHistory.get(sessionId) ?? []), ...live],
      pendingRequests: this.getPendingRequests(sessionId),
      status: this.options.registry.get(sessionId)?.status ?? 'waiting',
      throughSequence: live.at(-1)?.sequence ?? 0,
      commands: this.commandState(sessionId),
      activity,
      // In-memory wins: between boundary writes it is fresher than the
      // stored column (design D5).
      contextUsage:
        this.contextReadings.get(sessionId) ??
        this.records.get(sessionId)?.contextUsage ??
        null,
      // Stored with the row (design D4): applyPatch keeps the record current,
      // so this is the last reported model, null before the first one.
      model: this.records.get(sessionId)?.model ?? null,
      usage: this.usageLimits.get(this.profileIdOf(sessionId) ?? 'default'),
      // The spawned-worker roster (workers design D2); live entries hold the
      // session at working, settled ones carry their persisted outcomes.
      workers: this.getWorkers(sessionId),
      // The background-task roster (background tasks D2): running tasks
      // fresh from the driver, settled ones from the last publish.
      backgroundTasks: this.getBackgroundTasks(sessionId),
      // The notification strip's merged list (design D5): account notice
      // first, then agent notices, sorted by priority and newest.
      notifications: this.notificationsOf(sessionId),
    }
  }

  /**
   * The session's roster: a live driver's fresh projection (elapsed times
   * computed now), the last publish for archived sessions, or the recovered
   * sidecar rows after a restart.
   */
  private getWorkers(sessionId: string): ChatWorker[] {
    const driver = this.drivers.get(sessionId)
    if (driver && !driver.isDead) return driver.getWorkers()
    return this.workerRows.get(sessionId) ?? []
  }

  /**
   * The session's background-task roster: a live driver's fresh projection,
   * else the last publish (or the recovered sidecar rows, design D6).
   */
  private getBackgroundTasks(sessionId: string): ChatBackgroundTask[] {
    const driver = this.drivers.get(sessionId)
    if (driver && !driver.isDead) return driver.getBackgroundTasks()
    return this.backgroundTaskRows.get(sessionId) ?? []
  }

  /**
   * Whether the session has a live background worker (member-release D3):
   * `idle` alone is only `status === 'waiting'`, and a worker keeps running
   * — and writing to the worktree — after the turn that started it ends.
   */
  hasLiveWorkers(sessionId: string): boolean {
    return this.getWorkers(sessionId).some(worker => worker.live)
  }

  /**
   * A session's worker roster changed. A pending release's readiness
   * includes live workers (member-release D3): a change on a pending member
   * re-runs the dispatch cycle (D2), since no status change follows a worker
   * that ends while the session is already idle.
   */
  private workersChanged(sessionId: string): void {
    if (this.teamMail.releases.pendingFor(sessionId)) this.dispatcher.notify()
  }

  /** Current activity with a live-computed elapsed time, or null when idle. */
  private getActivity(sessionId: string): ChatActivity | null {
    const entry = this.activities.get(sessionId)
    if (!entry) return null
    return { ...entry.body, elapsedMs: Math.max(0, Date.now() - entry.phaseStartedAt) }
  }

  /**
   * A worker's expanded body (workers design D5), read from the on-disk
   * subagent transcript. Works live and after settle; unavailable (never an
   * error) when the worker or its file cannot be found.
   */
  getWorkerTranscript(
    sessionId: string,
    workerId: string
  ): { status: 'ok' | 'unavailable'; events: ChatEvent[] } {
    return readWorkerTranscript(
      this.records.get(sessionId)?.sdkSessionId ?? null,
      workerId
    )
  }

  // ------------------------------------------------------- background tasks

  /** In-flight output reads, so concurrent requests coalesce (design D3). */
  private readonly taskOutputReads = new Map<string, Promise<ChatTaskOutputResult>>()

  /**
   * A background task's output tail (background tasks D3): the live query's
   * `get_task_output` while it answers, else the last 8 KiB of the recorded
   * output file, else `unavailable` — never an error. Concurrent reads for
   * the same task share one request.
   */
  readTaskOutput(sessionId: string, taskId: string): Promise<ChatTaskOutputResult> {
    const key = `${sessionId}:${taskId}`
    const inFlight = this.taskOutputReads.get(key)
    if (inFlight) return inFlight
    const read = this.readTaskOutputOnce(sessionId, taskId).finally(() => {
      this.taskOutputReads.delete(key)
    })
    this.taskOutputReads.set(key, read)
    return read
  }

  private async readTaskOutputOnce(sessionId: string, taskId: string): Promise<ChatTaskOutputResult> {
    const driver = this.drivers.get(sessionId)
    if (driver && !driver.isDead) {
      const live = await driver.getTaskOutput(taskId)
      if (live && typeof live.output === 'string') {
        return {
          state: 'ok',
          output: live.output,
          totalBytes: live.total_bytes,
          truncated: live.truncated === true,
        }
      }
    }
    // The process is gone (or predates the control request): the sidecar's
    // recorded output file answers instead, while it still exists.
    const record = this.options.taskStore
      ?.read(sessionId)
      .find((entry) => entry.taskId === taskId)
    const file = record?.outputFile
    if (file !== undefined && isTaskOutputFile(file, taskId)) {
      const tail = readTaskOutputTail(file)
      if (tail) return { state: 'ok', ...tail }
    }
    return { state: 'unavailable' }
  }

  /**
   * Stop one background task (background tasks D4): accepted only for a
   * live, non-archived session and a task the roster knows as live. The
   * settle arrives as a normal notification through the roster channel, so
   * there is no reply; a refusal (already ended, unknown, archived) is
   * logged and dropped, never a transcript error.
   */
  async stopBackgroundTask(sessionId: string, taskId: string): Promise<void> {
    const record = this.records.get(sessionId)
    if (!record || record.archivedAt) {
      logger.warn('chat_task_stop_refused', { sessionId, taskId, reason: 'not_live' })
      return
    }
    const live = this.getBackgroundTasks(sessionId).some(
      (task) => task.taskId === taskId && task.live
    )
    if (!live) {
      logger.warn('chat_task_stop_refused', { sessionId, taskId, reason: 'not_live_task' })
      return
    }
    const driver = this.drivers.get(sessionId)
    if (!driver || driver.isDead) {
      logger.warn('chat_task_stop_refused', { sessionId, taskId, reason: 'no_driver' })
      return
    }
    const stopped = await driver.stopTask(taskId)
    if (!stopped) logger.warn('chat_task_stop_rejected', { sessionId, taskId })
  }

  // ---------------------------------------------------------------- notifications

  /**
   * The session's merged notice list (notification strip design D5): its
   * profile's account notice followed by its own agent notices, the whole
   * list sorted by priority and newest — a stable sort keeps the account
   * notice ahead of same-priority agent notices.
   */
  private notificationsOf(sessionId: string): ChatNotification[] {
    const credentials = this.sessionCredentials.get(sessionId)
    const account = credentials ? this.accountNotices.get(credentials) : null
    const agents = [...(this.agentNotices.get(sessionId)?.values() ?? [])]
    return [account, ...agents]
      .filter((notice): notice is ChatNotification => notice !== null)
      .sort(compareNotices)
  }

  /** Push the session's current merged list to the notification sink. */
  private emitNotifications(sessionId: string): void {
    if (!this.records.has(sessionId)) return
    this.options.onNotifications?.(sessionId, this.notificationsOf(sessionId))
  }

  /**
   * Resolve a session's credentials path from its effective launch
   * environment and re-check the stored login (notification strip design
   * D2/D3). An unresolvable profile (launchFor throws) maps to null: no
   * notice, never an error — snapshots must not fail on a bad profile.
   */
  private refreshAccountNotice(sessionId: string): void {
    const record = this.records.get(sessionId)
    if (!record) return
    let credentialsPath: string | null = null
    try {
      credentialsPath = credentialsPathFor(
        this.launchEnvOf(record.claudeProfileId, record.projectPath)
      )
    } catch {
      credentialsPath = null
    }
    this.sessionCredentials.set(sessionId, credentialsPath)
    if (credentialsPath) this.accountNotices.check(credentialsPath)
  }

  /**
   * Re-check account notices for the given sessions' credentials paths (the
   * slow-timer check point of design D3). Change-only: unchanged results
   * publish nothing, so an idle timer is a handful of file reads.
   */
  recheckAccountNotices(sessionIds: Iterable<string>): void {
    for (const sessionId of sessionIds) {
      if (this.records.has(sessionId)) this.refreshAccountNotice(sessionId)
    }
  }

  /**
   * Hold an agent-emitted notice (notification strip design D4): same-key
   * replacement by the newer instance, an optional timeout_ms expiry, and a
   * fan-out of the merged list. One session's notices never leak into
   * another — the map is keyed by the emitting session.
   */
  private handleDriverNotification(
    sessionId: string,
    notification: ChatNotification,
    timeoutMs?: number
  ): void {
    if (!this.records.has(sessionId)) return
    const notices = this.agentNotices.get(sessionId) ?? new Map<string, ChatNotification>()
    notices.set(notification.key, notification)
    this.agentNotices.set(sessionId, notices)
    this.armNoticeTimer(sessionId, notification, timeoutMs)
    this.emitNotifications(sessionId)
  }

  /**
   * (Re)arm a notice's expiry timer: a replacement clears the old timer, and
   * only arms a new one when the frame carried a usable timeout. The armed
   * timer removes its entry only if that entry is still the same instance
   * (compared by receivedAt) — a replacement must not be expired by its
   * predecessor's clock.
   */
  private armNoticeTimer(
    sessionId: string,
    notification: ChatNotification,
    timeoutMs?: number
  ): void {
    const timers =
      this.agentNoticeTimers.get(sessionId) ?? new Map<string, ReturnType<typeof setTimeout>>()
    const existing = timers.get(notification.key)
    if (existing) clearTimeout(existing)
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      timers.delete(notification.key)
    } else {
      const timer = setTimeout(() => {
        timers.delete(notification.key)
        const notices = this.agentNotices.get(sessionId)
        const current = notices?.get(notification.key)
        if (current && current.receivedAt === notification.receivedAt) {
          notices!.delete(notification.key)
          this.emitNotifications(sessionId)
        }
      }, timeoutMs)
      timer.unref?.()
      timers.set(notification.key, timer)
    }
    this.agentNoticeTimers.set(sessionId, timers)
  }

  /**
   * Drop every agent notice and timer of a session (design D4): the notices
   * die with the agent process that emitted them — archive, kill, restart,
   * shutdown, and an unexpected exit (the driver's onProcessEnd, whose
   * internal respawn would otherwise inherit them). `emit` pushes the now
   * account-only list to subscribers (archive, unexpected exit); kill and
   * shutdown have no one left to tell.
   */
  private clearAgentNotices(sessionId: string, options?: { emit?: boolean }): void {
    for (const timer of this.agentNoticeTimers.get(sessionId)?.values() ?? []) {
      clearTimeout(timer)
    }
    this.agentNoticeTimers.delete(sessionId)
    const had = this.agentNotices.delete(sessionId)
    if (had && options?.emit) this.emitNotifications(sessionId)
  }

  /**
   * Close an agent notice for its session (notification strip design D6):
   * removes the key everywhere (the push reaches every attached client) and
   * pushes the new list. Unknown keys — and account keys, which close
   * client-side only — are a no-op.
   */
  dismissNotification(sessionId: string, key: string): ChatActionResult {
    if (!this.records.has(sessionId)) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    const notices = this.agentNotices.get(sessionId)
    if (!notices?.has(key)) return { ok: true }
    const timers = this.agentNoticeTimers.get(sessionId)
    const timer = timers?.get(key)
    if (timer) clearTimeout(timer)
    timers?.delete(key)
    notices.delete(key)
    this.emitNotifications(sessionId)
    return { ok: true }
  }

  private captureHistory(sessionId: string): void {
    if (!this.records.has(sessionId)) return
    if (!this.snapshotHistory.has(sessionId)) {
      this.snapshotHistory.set(sessionId, this.getHistory(sessionId)?.events ?? [])
    }
  }

  /**
   * Load a session's transcript history off the event loop
   * (async-transcript-parsing design D3): populates the snapshot-history
   * memo once via the async replay; concurrent attaches share a single
   * load. Kill during a load is safe: the row is re-checked after the
   * awaits, so a killed session's memo is never (re-)written.
   *
   * Memo audit (design D3/D4): the memo IS `snapshotHistory`, and it is not
   * invalidated on turn completion. captureHistory runs before every driver
   * start (attach, send, start, mailbox prepare), so everything the agent
   * appends to the transcript afterwards is also in `liveEvents`; snapshots
   * are memo + live events, and re-reading the transcript at a turn boundary
   * would duplicate those turns. Only kill drops the memo (with the live
   * events). A synchronous captureHistory that wins the race (a send landing
   * while this load awaits IO) keeps its result; this load then discards its
   * own. getHistory stays synchronous as that fallback for the callers that
   * must capture before a driver starts without an await (D4).
   */
  async loadHistory(sessionId: string): Promise<void> {
    if (!this.records.has(sessionId) || this.snapshotHistory.has(sessionId)) return
    const inFlight = this.historyLoads.get(sessionId)
    if (inFlight) return inFlight
    const load = (async () => {
      const record = this.records.get(sessionId)
      if (!record || this.snapshotHistory.has(sessionId)) return
      if (record.sdkSessionId) {
        const replay = await replayTranscriptFileAsync(
          await findTranscriptPathAsync(record.sdkSessionId),
          { excludeToolCallIds: this.liveToolCallIds(sessionId) }
        )
        // The transcript's last cwd is where the conversation actually is
        // (worktree tracking design D3) — the same catch-up getHistory applies.
        if (this.records.has(sessionId) && !this.snapshotHistory.has(sessionId)) {
          if (replay.cwd) this.handleDriverCwdChanged(sessionId, replay.cwd)
          this.snapshotHistory.set(sessionId, replay.events)
        }
      } else if (this.records.has(sessionId)) {
        // Sessions that never started have no SDK id and replay as empty.
        this.snapshotHistory.set(sessionId, [])
      }
    })().finally(() => {
      this.historyLoads.delete(sessionId)
    })
    this.historyLoads.set(sessionId, load)
    return load
  }

  /**
   * The session's command state for snapshots: a live driver's tracker, or
   * unavailable when no process can be asked (never started, blocked, dead,
   * archived — design D3: the client needs no special case).
   */
  private commandState(sessionId: string): ChatCommandState {
    const driver = this.drivers.get(sessionId)
    return driver && !driver.isDead
      ? driver.getCommandState()
      : { status: 'unavailable', commands: [] }
  }

  constructor(options: ChatSessionManagerOptions) {
    this.options = options
    this.directory = new SessionDirectory(options.db.db)
    this.providerUsageRefreshMs = options.providerUsageRefreshMs ?? 10 * 60 * 1000
    // Team membership (agent-teams D6) resolves asynchronously; once a
    // session's team is known its group label/missing state is published.
    this.teams = new SessionTeams({
      ...(options.profileCatalogHome ? { homeDir: options.profileCatalogHome } : {}),
      onResolved: (sessionId) => {
        this.dispatcher?.notify()
        const record = this.records.get(sessionId)
        // The directory keys by team, so it can only record once the team is known.
        if (record) this.syncDirectory(sessionId)
        // Group-less sessions have nothing to show; skip the broadcast.
        if (record?.groupId != null) {
          this.options.registry.updateSession(sessionId, this.groupFields(record))
        }
      },
    })
    // Profile usage changes drive the chat-usage broadcast (design D4).
    this.usageLimits.subscribe((profileId, report) =>
      this.options.onUsage?.(profileId, report)
    )
    // An account-notice change fans out to every session mapped to that
    // credentials path (notification strip design D5).
    this.accountNotices.subscribe((credentialsPath) => {
      for (const [sessionId, path] of this.sessionCredentials) {
        if (path === credentialsPath) this.emitNotifications(sessionId)
      }
    })
    this.teamMail = new SessionMailbox(options.db.db, {
      teams: this.teams, records: () => this.records.values(), getRecord: id => this.records.get(id),
      getDriver: id => this.drivers.get(id), homeDir: options.profileCatalogHome,
      available: record => record.archivedAt == null && !this.startBlocker(record) && (options.isDirectory ?? isExistingDirectory)(record.projectPath),
      // The same refusal text `available` rejects on, read-only (team-waiting-reasons D2).
      startBlocker: record => this.startBlockerFor(record),
      prepare: async id => { this.captureHistory(id); const driver = await this.ensureDriver(id); if (!driver) throw new Error('Recipient disappeared'); driver.start() },
      restore: id => { const result = this.restore(id); if (!result.ok) throw new Error(result.error) },
      watchReceipt: id => this.watchSessionTitle(id),
      archive: id => this.archive(id),
      hasLiveWorkers: id => this.hasLiveWorkers(id),
      spawn: request => this.spawnMember(request),
      caps: new TeamCaps({
        ...(options.profileCatalogHome ? { homeDir: options.profileCatalogHome } : {}),
        onErrors: errors => logger.warn('team_caps_file_errors', { errors }),
      }),
      // A spawned member keeps the task it was spawned for; others follow
      // the task of the mail they received last.
      associateTask: (id, taskId) => {
        const record = this.records.get(id)
        if (record && !record.spawned && record.taskId !== taskId) this.applyPatch(id, { taskId })
      },
      // Sync discovery is fine here: a per-event lookup, not the boot path
      // (async-transcript-parsing design D4).
      transcriptFor: id => { const sdkId = this.records.get(id)?.sdkSessionId; return sdkId ? findTranscriptPath(sdkId) : null },
      onChange: options.onMailboxChange,
      onReasonsChange: options.onWaitingReasonsChange,
      usageOf: profileId => this.usageLimits.get(profileId),
      onRulesLoaded: () => options.onRoutingRulesLoaded?.(),
      onError: error => logger.warn('team_mailbox_dispatch_failed', { error: String(error) }),
    })
    this.mailbox = this.teamMail.mailbox
    this.tasks = this.teamMail.tasks
    this.assignments = this.teamMail.assignments
    this.messages = new MessageFeed(this.mailbox.store, new MessageQuery(options.db.db))
    // Product strategy (product-strategy): constructed here, beside the
    // task service, against the same database. The strategy store's changes
    // fan out to the strategy view pushes; the team comes from the record's
    // team binding (design D5).
    this.strategies = new StrategyService(new StrategyStore(options.db.db), {
      getSession: id => this.records.get(id),
      ...(options.profileCatalogHome ? { homeDir: options.profileCatalogHome } : {}),
    })
    this.strategies.store.subscribe(strategy => {
      const teamId = strategy.repoBindings.find(binding => binding.kind === 'team')?.root
      if (teamId) this.options.onStrategyChange?.(teamId)
    })
    // A retitled task re-labels the headers of the sessions working on it.
    this.tasks.store.subscribe(task => {
      this.options.onTaskChange?.(task.teamId)
      for (const record of this.records.values()) {
        if (record.taskId === task.id) this.options.registry.updateSession(record.sessionId, this.taskFields(record))
      }
    })
    // Parking pauses the session that holds the work; any change to a parked
    // message (or to one that was) re-derives its holder's paused state.
    this.mailbox.store.subscribe((_teamId, message) => {
      if (!message) return
      const holders = new Set<string>()
      if (message.claimedBy) holders.add(message.claimedBy)
      for (const [sessionId, parked] of this.parkedShown) if (parked.messageId === message.id) holders.add(sessionId)
      for (const sessionId of holders) this.refreshParked(sessionId)
    })
    this.dispatcher = this.teamMail.dispatcher
    // Restore runs off the boot path (async-transcript-parsing design D2):
    // persisted rows load without blocking server start, and the first
    // chat-attach awaits them via whenRestored(). The mailbox and wire-log
    // orphan pruning start only after the rows exist — pruning before the
    // restore would see an empty registry and delete every chat's wire log.
    this.restorePromise = this.restorePersisted()
      .then(() => {
        if (this.isShutDown) return
        this.teamMail.start()
        // Work parked before a restart keeps its sessions paused.
        for (const sessionId of this.records.keys()) this.refreshParked(sessionId)
        // Logs of sessions deleted while the server was down are orphans now.
        void this.options.wireLogs?.pruneOrphans(new Set(this.records.keys()))
      })
      .catch(error => {
        logger.error('chat_sessions_restore_failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      })
  }

  /** Resolves once persisted chat rows are restored (design D2). */
  whenRestored(): Promise<void> {
    return this.restorePromise
  }

  /** Recorded per-profile limit events (profile routing). */
  get limitEvents(): LimitEventStore {
    return this.teamMail.limits
  }

  /** Reload every user-level routing rule (Reload routing rules). */
  reloadRoutingRules(): Promise<RuleLoadReport> {
    return this.teamMail.rules.reload()
  }

  /** Rule load status and this team's routing decisions (mailbox view). */
  routingState(teamId: string): TeamRoutingState {
    return { rules: this.teamMail.rules.lastReport(), decisions: this.teamMail.router.decisions(teamId) }
  }

  /** The team's live sessions per worktree plus pending spawns (mailbox view). */
  teamRoster(teamId: string): TeamWorktreeOccupancy[] {
    return this.teamMail.roster(teamId)
  }

  /** The team's per-message waiting reasons (mailbox view, team-waiting-reasons D3). */
  waitingFor(teamId: string): Record<string, WaitingReason> {
    return this.teamMail.waitingFor(teamId)
  }

  /**
   * The start guard's refusal text, read-only (team-waiting-reasons D2): the
   * unavailable-recipient reason carries it; `available` keeps calling the
   * guard itself, unchanged.
   */
  startBlockerFor(record: ChatSessionRecord): string | null {
    return this.startBlocker(record)
  }

  /** The human hands parked work to a group or session of its team. */
  handOff(messageId: string, target: HandoffTarget): TeamMessage {
    return this.teamMail.handOff(messageId, target)
  }

  /** Live (non-archived) members of a team's group per profile, for cap warnings. */
  groupProfileCounts(teamId: string, groupId: string): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const record of this.records.values()) {
      if (record.archivedAt != null || record.groupId !== groupId || this.teams.teamOf(record.sessionId)?.teamId !== teamId) continue
      const profileId = record.claudeProfileId ?? 'default'
      counts[profileId] = (counts[profileId] ?? 0) + 1
    }
    return counts
  }

  /** Paused state last pushed per session. */
  private readonly parkedShown = new Map<string, SessionParkedState>()

  private parkedState(sessionId: string): SessionParkedState | null {
    const parked = this.mailbox.store.parkedBy(sessionId)[0]
    if (!parked) return null
    const profileId = this.records.get(sessionId)?.claudeProfileId ?? 'default'
    return { messageId: parked.id, until: parked.parkedUntil, profileId, reason: `Provider limit on ${profileId}` }
  }

  private refreshParked(sessionId: string): void {
    if (!this.records.has(sessionId)) return
    const next = this.parkedState(sessionId)
    const shown = this.parkedShown.get(sessionId)
    if (JSON.stringify(next) === JSON.stringify(shown ?? null)) return
    if (next) this.parkedShown.set(sessionId, next)
    else this.parkedShown.delete(sessionId)
    this.options.registry.updateSession(sessionId, { parked: next })
  }

  /** Each session's team (agent-teams); shared with the mailbox dispatcher. */
  readonly teams: SessionTeams
  /** Last known name/group of each team's sessions, kept past kill (team-message-threads D3). */
  readonly directory: SessionDirectory
  readonly mailbox: TeamMailbox
  /** Team tasks (team-tasks); the task tools and UI actions go through it. */
  readonly tasks: TaskService
  /** Task assignment (task-assignment); human dispatch, preview, and targets. */
  readonly assignments: AssignmentService
  /** The Messages read model and its live feed (team-message-threads D1/4.3). */
  readonly messages: MessageFeed
  /** Product strategy (product-strategy); the strategy tools and UI actions go through it. */
  readonly strategies: StrategyService
  readonly dispatcher: MailDispatcher
  private readonly teamMail: SessionMailbox

  /**
   * Worktree staffing's programmatic create (team-tasks D4): a group member
   * in the task's worktree with the group's profile and approval policy,
   * associated with the task and marked spawned. Resolves once the member's
   * team is known, so the dispatcher can deliver its first turn at once.
   */
  private async spawnMember(request: SpawnRequest): Promise<SpawnResult> {
    const result = await this.createAvailableSession({
      projectPath: request.projectPath, groupId: request.groupId, approvalPolicy: request.approvalPolicy,
      taskId: request.taskId, spawned: true,
      ...(request.profileId ? { claudeProfileId: request.profileId } : {}),
    })
    if (!result.ok) return result
    await this.teams.track(result.session.id, result.session.projectPath)
    // The task closed while this spawn was in flight (member-release D1):
    // its mail was dead-lettered, so the member starts with no turn — mark
    // it and it is released once it settles.
    this.teamMail.markSpawnedForClosedTask(result.session.id, request.taskId)
    return { ok: true, sessionId: result.session.id }
  }

  /** Create a chat session. Refused (no side effects) when auth is missing. */
  createSession(input: {
    projectPath: string
    name?: string
    claudeProfileId?: string
    /** Starting policy (reorg-settings-default-approval design D3); absent = manual. */
    approvalPolicy?: ChatApprovalPolicy
    /** Team group, already validated by createAvailableSession; absent = none. */
    groupId?: string
    /** Team task the session starts on (worktree staffing); absent = none. */
    taskId?: string
    /** Created by worktree staffing rather than the human. */
    spawned?: boolean
  }): ChatCreateResult {
    const project = resolveProjectDirectory(input.projectPath, this.options.isDirectory)
    if (!project.ok) return project
    const projectPath = project.path
    try {
      this.launchFor(input.claudeProfileId, projectPath)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!this.authOk(input.claudeProfileId, projectPath)) {
      return { ok: false, error: chatAuthErrorMessage() }
    }
    const sessionId = `chat-${crypto.randomUUID()}`
    const suppliedName = input.name?.trim()
    const name = suppliedName || generateSessionName()
    const now = new Date().toISOString()
    const record = {
      sessionId,
      name,
      projectPath,
      sdkSessionId: null as string | null,
      claudeProfileId: input.claudeProfileId ?? 'default',
      // The client's Settings default, sent on session-create; absent means
      // manual (older clients). Profiles never influence the policy.
      approvalPolicy: (input.approvalPolicy ?? 'manual') as ChatApprovalPolicy,
      // chat-session-naming design D1: a name the user typed sticks forever,
      // one the generator produced is a placeholder a later title may replace.
      nameSource: (suppliedName ? 'manual' : 'placeholder') as ChatNameSource,
      groupId: input.groupId ?? null,
      taskId: input.taskId ?? null,
      spawned: input.spawned === true,
      status: 'waiting' as SessionStatus,
      createdAt: now,
      lastActivityAt: now,
    }
    this.records.set(sessionId, record)
    this.options.db.insertChatSession(record)
    const session = this.toSession(record)
    this.options.registry.setChatSession(session)
    // The directory keys by team, so it records once resolution lands.
    void this.teams.track(sessionId, projectPath).then(() => this.syncDirectory(sessionId))
    return { ok: true, session }
  }

  /** True when the id is a known chat session. */
  has(sessionId: string): boolean {
    return this.records.has(sessionId)
  }

  /** Archived chats attach for history without starting an agent. */
  isArchived(sessionId: string): boolean {
    return this.records.get(sessionId)?.archivedAt != null
  }

  /**
   * The session's Claude profile id (usage scoping, usage bar design D4):
   * plan usage is tracked and broadcast per profile, never per session.
   */
  profileIdOf(sessionId: string): string | undefined {
    return this.records.get(sessionId)?.claudeProfileId ?? 'default'
  }

  /**
   * Read-only history for a chat session: the stored SDK transcript replayed
   * into ChatEvents (with dead requests marked cancelled), or a
   * "history unavailable" notice. Sessions that never started have no SDK id
   * and replay as empty. Unknown sessions return null.
   */
  getHistory(sessionId: string): TranscriptReplay | null {
    const record = this.records.get(sessionId)
    if (!record) return null
    if (!record.sdkSessionId) {
      return { status: 'ok', events: [], cwd: null }
    }
    const replay = replayTranscriptFile(
      findTranscriptPath(record.sdkSessionId),
      { excludeToolCallIds: this.liveToolCallIds(sessionId) }
    )
    // The transcript's last cwd is where the conversation actually is
    // (worktree tracking design D3): a session whose transcript moved while
    // the server was down follows it on attach too, not only at startup —
    // the same overwrite a live CwdChanged firing would have made.
    if (replay.cwd) this.handleDriverCwdChanged(sessionId, replay.cwd)
    return replay
  }

  /**
   * Submit a user turn. The driver (and behind it the SDK subprocess) is
   * created lazily here — the first turn pays the spawn cost, creation never
   * blocks on process startup. A stored SDK id whose transcript is missing
   * refuses the turn rather than silently starting a fresh conversation
   * (design D5): the id is kept so a restored transcript can still resume.
   */
  async send(sessionId: string, text: string): Promise<ChatActionResult> {
    // Recovery can replace the record's path: finish it before checking the
    // directory or resolving the launch configuration.
    this.captureHistory(sessionId)
    const record = this.records.get(sessionId)
    if (!record) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    const blocked = this.startBlocker(record)
    if (blocked) {
      return { ok: false, error: blocked }
    }
    let driver: ChatSessionDriver | null
    try {
      driver = await this.ensureDriver(sessionId)
    } catch (error) {
      return { ok: false, error: sdkLoadError(error) }
    }
    if (!driver) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    driver.send(text)
    this.touch(sessionId)
    return { ok: true }
  }

  /**
   * Attach-time start (design D1): spawn the agent process without sending a
   * prompt, so its command list is available before the first message. Goes
   * through the same start guard as send and the same ensureDriver, so
   * concurrent attaches and sends share one driver and a dead driver is
   * restarted. Refusals report the guard's error; a failed spawn surfaces as
   * a session error event from the driver.
   */
  async start(sessionId: string): Promise<ChatActionResult> {
    // Direct starts need the same recovery ordering as attach and send.
    this.captureHistory(sessionId)
    const record = this.records.get(sessionId)
    if (!record) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    const blocked = this.startBlocker(record)
    if (blocked) {
      return { ok: false, error: blocked }
    }
    let driver: ChatSessionDriver | null
    try {
      driver = await this.ensureDriver(sessionId)
    } catch (error) {
      return { ok: false, error: sdkLoadError(error) }
    }
    if (!driver) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    driver.start()
    return { ok: true }
  }

  /** Stop button: abort the in-flight turn without removing the session. */
  interrupt(sessionId: string): ChatActionResult {
    if (!this.records.has(sessionId)) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    // An idle session (no driver yet) has nothing to interrupt.
    this.drivers.get(sessionId)?.interrupt()
    return { ok: true }
  }

  /**
   * Archive: stop the agent process exactly the way kill stops it (interrupt
   * the in-flight turn, settle pending requests as cancelled, terminate), but
   * keep the record, SDK conversation id, live-event history, and protocol
   * log (chat-archive design D2). The driver is forgotten, and ensureDriver
   * refuses archived sessions, so nothing respawns it until restore.
   */
  archive(sessionId: string): ChatActionResult {
    const record = this.records.get(sessionId)
    if (!record) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    const driver = this.drivers.get(sessionId)
    if (driver) {
      // Interrupt first so subscribers see request_resolved(cancelled) and
      // turn_interrupted; kill then ends the process without the
      // exited-unexpectedly error a bare close would report.
      driver.interrupt()
      driver.kill()
    }
    this.teamMail.settleRecipient(sessionId)
    this.drivers.delete(sessionId)
    this.driverPromises.delete(sessionId)
    // The transcript is final once the agent is stopped: release the title
    // tail with it (design D4 risk note).
    this.releaseTitleWatch(sessionId)
    // The archived chat shows no activity row (design D5): any in-flight
    // phase ended with the driver above.
    this.clearActivity(sessionId)
    // Agent notices died with the process (notification strip design D4);
    // the archived chat keeps only its profile's account notice.
    this.clearAgentNotices(sessionId, { emit: true })
    // The archived header shows the stored reading, frozen with the agent:
    // write the freshest in-memory value, then forget the live slot so
    // snapshots fall back to the column.
    this.persistContextUsage(sessionId)
    this.contextReadings.delete(sessionId)
    // Status returns to waiting: archived sessions never look busy.
    this.applyPatch(sessionId, {
      archivedAt: new Date().toISOString(),
      status: 'waiting',
    })
    // Archived by any path: a pending release is settled by the archive
    // itself (member-release D1); a later restore starts clean.
    this.teamMail.cancelPendingRelease(sessionId)
    return { ok: true }
  }

  /**
   * Restore: clear archived_at. The next send lazily recreates the driver
   * with the stored conversation id, exactly as after a server restart.
   */
  restore(sessionId: string): ChatActionResult {
    const record = this.records.get(sessionId)
    if (!record) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    if (record.archivedAt == null) return { ok: true }
    this.applyPatch(sessionId, { archivedAt: null })
    // A restored member stays live: it is never released again for the same
    // close (member-release D1).
    this.teamMail.cancelPendingRelease(sessionId)
    return { ok: true }
  }

  /**
   * Rename a chat session (chat-session-naming design D1). A rename is a
   * claim: it sets `manual` provenance, which is terminal, so no later
   * generated title replaces it. Names are free text — trimmed non-empty —
   * because chat sessions have no tmux window to name (design D5).
   */
  rename(sessionId: string, name: string): ChatActionResult {
    const trimmed = name.trim()
    if (!trimmed) {
      return { ok: false, error: 'Name cannot be empty' }
    }
    const record = this.records.get(sessionId)
    if (!record) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    this.applyPatch(sessionId, { name: trimmed, nameSource: 'manual' })
    return { ok: true }
  }

  /**
   * Switch a session's approval policy live (chat-auto-approve-tools design
   * D4): persists and broadcasts the new policy, records a transcript
   * notice, and lets a live driver grant approvals already pending as cards.
   * Archived sessions refuse the change; setting the current value is a
   * no-op, and switching to manual affects only later requests.
   */
  setApprovalPolicy(
    sessionId: string,
    policy: ChatApprovalPolicy
  ): ChatActionResult {
    if (policy !== 'manual' && policy !== 'auto') {
      return { ok: false, error: `Unsupported approval policy ${String(policy)}` }
    }
    const record = this.records.get(sessionId)
    if (!record) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    if (record.archivedAt != null) {
      return { ok: false, error: ARCHIVED_SESSION_ERROR }
    }
    if ((record.approvalPolicy ?? 'manual') === policy) return { ok: true }
    this.applyPatch(sessionId, { approvalPolicy: policy })
    // The notice rides the same live-event path as driver events (sequence
    // assignment, snapshot inclusion) whether or not a driver is running.
    // It precedes the driver's policy grants so the transcript reads in order.
    this.handleDriverEvent(sessionId, {
      type: 'notice',
      text: policy === 'auto' ? 'Auto-approve on' : 'Auto-approve off',
      id: `evt-${crypto.randomUUID()}`,
      sequence: 0,
      at: new Date().toISOString(),
    } as ChatEvent)
    this.drivers.get(sessionId)?.onApprovalPolicyChanged(policy)
    return { ok: true }
  }

  resolveApproval(
    sessionId: string,
    requestId: string,
    decision: ChatApprovalDecision
  ): ChatActionResult {
    const driver = this.drivers.get(sessionId)
    if (!driver) {
      return {
        ok: false,
        error: this.records.has(sessionId)
          ? `No pending approval with id ${requestId}; the session has no in-flight turn`
          : `Unknown chat session ${sessionId}`,
      }
    }
    return driver.resolveApproval(requestId, decision)
  }

  answerQuestion(
    sessionId: string,
    requestId: string,
    answers: Record<string, ChatQuestionAnswer>
  ): ChatActionResult {
    const driver = this.drivers.get(sessionId)
    if (!driver) {
      return {
        ok: false,
        error: this.records.has(sessionId)
          ? `No pending question with id ${requestId}; the session has no in-flight turn`
          : `Unknown chat session ${sessionId}`,
      }
    }
    return driver.answerQuestion(requestId, answers)
  }

  getPendingRequests(sessionId: string): ChatPendingRequest[] {
    return this.drivers.get(sessionId)?.getPendingRequests() ?? []
  }

  /** Kill: abort the agent, settle pending requests, forget the session. */
  kill(sessionId: string): boolean {
    const record = this.records.get(sessionId)
    if (!record) return false
    this.drivers.get(sessionId)?.kill()
    this.teamMail.settleRecipient(sessionId)
    this.drivers.delete(sessionId)
    this.driverPromises.delete(sessionId)
    this.releaseTitleWatch(sessionId)
    this.cancelCwdRefresh(sessionId)
    // A killed session never releases; its pending row is moot (member-release D1).
    this.teamMail.cancelPendingRelease(sessionId)
    this.records.delete(sessionId)
    this.mailbox.store.deadLetterDirectTo(sessionId, 'killed-recipient')
    this.dispatcher.notify()
    this.snapshotHistory.delete(sessionId)
    this.liveEvents.delete(sessionId)
    this.activities.delete(sessionId)
    this.contextReadings.delete(sessionId)
    this.workerRows.delete(sessionId)
    this.backgroundTaskRows.delete(sessionId)
    this.backgroundTaskRecords.delete(sessionId)
    this.clearAgentNotices(sessionId)
    this.sessionCredentials.delete(sessionId)
    this.teams.forget(sessionId)
    this.options.registry.removeChatSession(sessionId)
    this.options.db.deleteChatSession(sessionId)
    void this.options.wireLogs?.delete(sessionId).catch(() => {})
    // The session is gone for good; its worker rows go with it (D6).
    void this.options.workerStore?.delete(sessionId).catch(() => {})
    void this.options.taskStore?.delete(sessionId).catch(() => {})
    return true
  }

  /** Server shutdown: settle every driver (callbacks cannot survive it). */
  shutdown(): void {
    // A restore still in flight stops at its next row (design D2).
    this.isShutDown = true
    this.teamMail.close()
    // Provider usage refreshes die with the server: timers stop now, and the
    // in-flight continuations check isShutDown before publishing.
    this.stopProviderUsageRefresh()
    for (const driver of this.drivers.values()) {
      driver.shutdown()
    }
    this.drivers.clear()
    this.driverPromises.clear()
    this.activities.clear()
    // Notices die with their processes (notification strip design D4); the
    // account store holds nothing per session either, so nothing survives.
    for (const sessionId of this.agentNotices.keys()) {
      this.clearAgentNotices(sessionId)
    }
    this.sessionCredentials.clear()
    // Shutdown settles like kill, but the rows survive it: write each live
    // reading so a restart restores the last one seen (design D5).
    for (const [sessionId] of this.contextReadings) {
      this.persistContextUsage(sessionId)
    }
    this.contextReadings.clear()
    for (const sessionId of this.titleWatchers.keys()) {
      this.releaseTitleWatch(sessionId)
    }
    for (const sessionId of this.cwdRefreshTimers.keys()) {
      this.cancelCwdRefresh(sessionId)
    }
  }

  /**
   * SDK session ids of all known chat sessions (live and restored) — used by
   * log discovery to exclude chat transcripts from agent-session matching
   * (design D6).
   */
  getSdkSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const record of this.records.values()) {
      if (record.sdkSessionId) ids.add(record.sdkSessionId)
    }
    for (const id of this.restoringSdkIds) ids.add(id)
    return ids
  }

  // ---------------------------------------------------------------- internals

  /**
   * The single start guard (add-chat-slash-commands design D1): the refusal
   * error for a spawn that must not happen — an archived session, a stored
   * conversation whose transcript is missing, or a project directory that no
   * longer exists — or null when a (re)spawn may proceed. `send` and `start`
   * (attach) both go through it, so their errors are identical.
   */
  private startBlocker(record: ChatSessionRecord): string | null {
    if (record.archivedAt != null) return ARCHIVED_SESSION_ERROR
    const spawning = !this.driverPromises.has(record.sessionId)
    if (
      record.sdkSessionId &&
      // Sync discovery acceptable: a per-request existence check, not the
      // boot path (async-transcript-parsing design D4).
      !this.drivers.has(record.sessionId) &&
      spawning &&
      !findTranscriptPath(record.sdkSessionId)
    ) {
      return (
        'Cannot resume this conversation: the agent transcript is missing. ' +
        `Restore ${record.sdkSessionId}.jsonl or create a new chat session.`
      )
    }
    const live = this.drivers.get(record.sessionId)
    if (
      (!live || live.isDead) &&
      spawning &&
      !(this.options.isDirectory ?? isExistingDirectory)(record.projectPath)
    ) {
      // A running process keeps its cwd; only a (re)spawn needs the directory.
      return (
        `Cannot start the agent: the project directory ${record.projectPath} no longer exists. ` +
        'Create a new chat session in an existing directory.'
      )
    }
    return null
  }

  /**
   * Tool call ids a live (non-dead) driver has seen. Transcript replay must
   * not mark those as cancelled — the live stream still owns their outcome.
   */
  private liveToolCallIds(sessionId: string): Set<string> {
    const driver = this.drivers.get(sessionId)
    if (!driver || driver.isDead) return new Set()
    return driver.getSeenToolCallIds()
  }

  /** Load chat_sessions rows into the registry as idle chat sessions. */
  private async restorePersisted(): Promise<void> {
    // The rows are read synchronously, before the first await, so their SDK
    // ids are excluded from log discovery from the constructor on.
    const rows = this.options.db.getChatSessions()
    for (const row of rows) {
      if (row.sdkSessionId) this.restoringSdkIds.add(row.sdkSessionId)
    }
    try {
      for (const row of rows) {
        if (this.isShutDown) return
        await this.restoreRow(row)
      }
    } finally {
      this.restoringSdkIds.clear()
    }
  }

  /** Restore one persisted row (design D2): status, title/cwd catch-up, workers. */
  private async restoreRow(row: ChatSessionRecord): Promise<void> {
    let record = row
    // Pending requests and in-flight turns died with the old process; a
    // restored session is always idle.
    if (record.status !== 'waiting') {
      record = { ...record, status: 'waiting' }
      this.options.db.updateChatSession(record.sessionId, {
        status: 'waiting',
      })
    }
    // Title catch-up (chat-session-naming design D4): a session whose name
    // was never user-set adopts its transcript's latest title now, so the
    // list is correct for sessions nobody opens. Nothing is persisted —
    // the row re-derives on the next restart the same way.
    // Cwd catch-up (worktree tracking design D3): the transcript's last
    // cwd is where the conversation actually is — the agent may have
    // entered a worktree before the restart. Unlike the title this is
    // persisted, matching what the live CwdChanged firing would have
    // written, so the row and the registry agree from here on.
    // One async discovery + one single-pass meta read per session
    // (async-transcript-parsing design D1/D2) — no sync fs on the event
    // loop at boot.
    if (record.sdkSessionId) {
      const filePath = await findTranscriptPathAsync(record.sdkSessionId)
      const meta = filePath ? await readTranscriptMetaAsync(filePath) : null
      // Shut down mid-read: the database may be closed already.
      if (this.isShutDown) return
      if (meta) {
        if ((record.nameSource ?? 'manual') !== 'manual' && meta.title) {
          record = { ...record, name: meta.title.title, nameSource: meta.title.source }
        }
        if (meta.cwd && meta.cwd !== record.projectPath) {
          record = { ...record, projectPath: meta.cwd }
          this.options.db.updateChatSession(record.sessionId, {
            projectPath: meta.cwd,
          })
        }
      }
    }
    // Worker-roster recovery (workers design D6): a sidecar row still
    // marked running can never gain an outcome — the process that owed it
    // is gone — so it recovers as stopped. The corrected roster is
    // rewritten so the file and the rows agree.
    if (this.options.workerStore) {
      const records = this.options.workerStore.read(record.sessionId)
      if (records.length > 0) {
        const recovered: ChatWorker[] = records.map((entry) => ({
          ...entry,
          ...(entry.status === 'running' ? { status: 'stopped' as const } : {}),
          live: false,
          elapsedMs: 0,
        }))
        this.workerRows.set(record.sessionId, recovered)
        void this.options.workerStore
          .write(record.sessionId, recovered)
          .catch(() => {})
      }
    }
    // Background-task recovery (background tasks D6), same contract: a row
    // still running recovers as stopped, and the corrected roster is
    // rewritten so the file and the rows agree.
    if (this.options.taskStore) {
      const taskRecords = this.options.taskStore.read(record.sessionId)
      if (taskRecords.length > 0) {
        const corrected = taskRecords.map((entry) =>
          entry.status === 'running' ? { ...entry, status: 'stopped' as const } : entry
        )
        this.backgroundTaskRecords.set(record.sessionId, corrected)
        this.backgroundTaskRows.set(record.sessionId, corrected.map((entry) => ({
          taskId: entry.taskId,
          ...(entry.toolCallId !== undefined ? { toolCallId: entry.toolCallId } : {}),
          kind: entry.kind,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
          status: entry.status,
          live: false,
          startedAtMs: entry.startedAtMs,
          ...(entry.endedAtMs !== undefined ? { endedAtMs: entry.endedAtMs } : {}),
          elapsedMs: entry.endedAtMs !== undefined ? Math.max(0, entry.endedAtMs - entry.startedAtMs) : 0,
          ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
        })))
        void this.options.taskStore.write(record.sessionId, corrected).catch(() => {})
      }
    }
    this.records.set(record.sessionId, record)
    this.options.registry.setChatSession(this.toSession(record))
    void this.teams.track(record.sessionId, record.projectPath)
  }

  /**
   * Adopt a transcript title for a session whose name is not user-set
   * (design D1/D2): placeholder and auto names follow each newer title; a
   * manual name is never touched. A `custom-title` row counts as user-set
   * (design D7), so adopting it also pins the name.
   */
  private applyTranscriptTitle(
    sessionId: string,
    title: string,
    source: 'auto' | 'manual'
  ): void {
    const record = this.records.get(sessionId)
    if (!record || (record.nameSource ?? 'manual') === 'manual') return
    if (record.name === title && record.nameSource === source) return
    this.applyPatch(sessionId, { name: title, nameSource: source })
  }

  /**
   * Start following a session's transcript for title rows. The transcript is
   * created by the first message, which can arrive much later than the SDK id
   * (the agent starts on attach, with no prompt), and a later send reuses the
   * driver without re-running this. So the locate retry lives as long as the
   * session does — giving up would pin the placeholder for the whole
   * conversation. Polls back off to `titleLocateIntervalMs * 7.5`.
   */
  private watchSessionTitle(sessionId: string, attempt = 0): void {
    if (this.titleWatchers.has(sessionId)) return
    const record = this.records.get(sessionId)
    if (!record || record.archivedAt != null || !record.sdkSessionId) return
    // Sync discovery acceptable: a per-attach watcher setup, not the boot
    // path (async-transcript-parsing design D4).
    const filePath = findTranscriptPath(record.sdkSessionId)
    if (!filePath) {
      const base = this.options.titleLocateIntervalMs ?? 2_000
      const timer = setTimeout(
        () => {
          this.titleWatchers.delete(sessionId)
          this.watchSessionTitle(sessionId, attempt + 1)
        },
        Math.min(base * 2 ** Math.min(attempt, 3), base * 7.5)
      )
      timer.unref?.()
      this.titleWatchers.set(sessionId, { close: () => clearTimeout(timer) })
      return
    }
    const watcher: TranscriptTitleWatcher = watchTranscriptTitle(
      filePath,
      (title, source) => this.applyTranscriptTitle(sessionId, title, source),
      line => {
        const id = receiptMessageId(line)
        if (!id) return
        const message = this.mailbox.store.get(id)
        if (message?.claimedBy === sessionId) this.mailbox.store.markDelivered(id)
      }
    )
    this.titleWatchers.set(sessionId, watcher)
  }

  /** Stop following a session's transcript (kill, archive, shutdown). */
  private releaseTitleWatch(sessionId: string): void {
    this.titleWatchers.get(sessionId)?.close()
    this.titleWatchers.delete(sessionId)
  }

  private async ensureDriver(
    sessionId: string
  ): Promise<ChatSessionDriver | null> {
    const existing = this.drivers.get(sessionId)
    if (existing) {
      if (existing.isDead) {
        const record = this.records.get(sessionId)
        const launch = this.launchFor(record?.claudeProfileId, record?.projectPath)
        if (launch.executable) {
          verifyProfileExecutable(record?.claudeProfileId ?? 'default', launch.executable)
        } else {
          // The executable may have been removed or moved since the last
          // spawn: surface a failure now, and respawn the path just verified.
          const executable = await this.checkExecutable()
          existing.setClaudeExecutablePath(executable?.path)
        }
        if (!this.authOk(record?.claudeProfileId, record?.projectPath)) throw new Error(chatAuthErrorMessage())
      }
      return existing
    }
    const pending = this.driverPromises.get(sessionId)
    if (pending) return pending
    const record = this.records.get(sessionId)
    if (!record) return null
    // The single guard for every would-be spawn path (design D2 risk): an
    // archived session must never start an agent process.
    if (record.archivedAt != null) throw new Error(ARCHIVED_SESSION_ERROR)
    const launch = this.launchFor(record.claudeProfileId, record.projectPath)
    if (launch.executable) verifyProfileExecutable(record.claudeProfileId ?? 'default', launch.executable)
    if (!this.authOk(record.claudeProfileId, record.projectPath)) throw new Error(chatAuthErrorMessage())
    // Agent start is one of the account-notice check points (notification
    // strip design D3).
    this.refreshAccountNotice(record.sessionId)
    const promise = (async () => {
      // A profile executable replaces the standard binary (already verified
      // above); otherwise every spawn runs the checked Claude Code install.
      const executable = launch.executable ? null : await this.checkExecutable()
      const queryFactory = await this.resolveQueryFactory()
      // The team must be known before the first spawn reads its prompt.
      await this.teams.track(record.sessionId, this.records.get(record.sessionId)?.projectPath ?? record.projectPath)
      const teamMcpServer = await createMailboxServer(this.mailbox, record.sessionId, this.tasks, this.strategies, this.teamMail.releases)
      const driver = new ChatSessionDriver({
        sessionId: record.sessionId,
        projectPath: record.projectPath,
        queryFactory,
        teamMcpServer,
        getSystemPromptAppend: () => this.teams.promptFor(
          record.sessionId,
          this.records.get(record.sessionId)?.groupId
        ),
        getEffort: () => this.teams.effortFor(
          record.sessionId,
          this.records.get(record.sessionId)?.groupId
        ),
        getProviderEnv: () => this.providerEnv(),
        // Read per request so a live policy switch reaches the next
        // canUseTool call without a respawn (design D2).
        getApprovalPolicy: () =>
          this.records.get(record.sessionId)?.approvalPolicy ?? 'manual',
        claudeProfileId: record.claudeProfileId,
        ...(this.options.profileCatalogHome
          ? { profileCatalogHome: this.options.profileCatalogHome }
          : {}),
        ...(executable ? { claudeExecutablePath: executable.path } : {}),
        ...(this.options.wireLogs
          ? { wire: this.options.wireLogs.get(record.sessionId) }
          : {}),
        ...(record.sdkSessionId
          ? { resumeSessionId: record.sdkSessionId }
          : {}),
        // Workers design D6: a fresh driver carries the recovered rows, so a
        // restart or archive/restore keeps earlier outcomes in the roster and
        // the sidecar instead of replacing them with an empty one.
        ...(this.workerRows.has(record.sessionId)
          ? { recoveredWorkers: this.workerRows.get(record.sessionId) ?? [] }
          : {}),
        ...(this.backgroundTaskRecords.has(record.sessionId)
          ? { recoveredBackgroundTasks: this.backgroundTaskRecords.get(record.sessionId) ?? [] }
          : {}),
        onEvent: (event) => this.handleDriverEvent(record.sessionId, event),
        onCommandState: (state) =>
          this.options.onCommandState?.(record.sessionId, state),
        onActivity: (activity) =>
          this.handleDriverActivity(record.sessionId, activity),
        onNotification: (notification, timeoutMs) =>
          this.handleDriverNotification(record.sessionId, notification, timeoutMs),
        // An unexpected exit ends the process but not the session: the same
        // driver respawns internally on the next send/start, so the notices
        // die here (design D4) instead of surviving into the replacement.
        onProcessEnd: () => this.clearAgentNotices(record.sessionId, { emit: true }),
        onWorkers: (workers) =>
          this.handleDriverWorkers(record.sessionId, workers),
        onBackgroundTasks: (tasks) =>
          this.handleDriverBackgroundTasks(record.sessionId, tasks),
        onContextUsage: (usage, opts) =>
          this.handleDriverContextUsage(record.sessionId, usage, opts),
        onModel: (model) => this.handleDriverModel(record.sessionId, model),
        // Plan usage is recorded against the session's profile (design D3);
        // the store's change listener drives the onUsage broadcast.
        onRateLimit: (report) =>
          this.usageLimits.record(record.claudeProfileId ?? 'default', report),
        onUsageReport: (report) =>
          this.usageLimits.record(record.claudeProfileId ?? 'default', report),
        claimUsagePull: () =>
          this.claimProfileUsagePull(record),
        onUsageNoData: () =>
          this.usageLimits.recordNoData(record.claudeProfileId ?? 'default'),
        onStatus: (status) => this.applyPatch(record.sessionId, { status }),
        onSdkSessionId: (sdkSessionId) =>
          // Persist immediately: a crash right after the first turn must not
          // lose the ability to resume the conversation.
          this.applyPatch(record.sessionId, { sdkSessionId }),
        onCwdChanged: (newCwd) =>
          this.handleDriverCwdChanged(record.sessionId, newCwd),
        // Profile routing (design D6): limit failures count against the
        // session's profile, with its current group for context.
        onLimitEvent: (signal) =>
          this.teamMail.limits.record({
            ...signal,
            profileId: record.claudeProfileId ?? 'default',
            sessionId: record.sessionId,
            groupId: this.records.get(record.sessionId)?.groupId ?? null,
          }),
      })
      if (
        !this.records.has(record.sessionId) ||
        // Archived while the import was resolving: same discard as kill.
        this.records.get(record.sessionId)?.archivedAt != null
      ) {
        driver.kill()
        return null
      }
      // A fresh process starts with a clean notice slate (design D4): any
      // notices left from the crashed predecessor it replaces are gone.
      this.clearAgentNotices(record.sessionId, { emit: true })
      this.drivers.set(record.sessionId, driver)
      // A restored conversation already has a transcript: its title tail
      // starts with the (re)spawn, before any attach or send.
      if (record.sdkSessionId) this.watchSessionTitle(record.sessionId)
      return driver
    })()
    this.driverPromises.set(sessionId, promise)
    try {
      return await promise
    } finally {
      this.driverPromises.delete(sessionId)
    }
  }

  /**
   * Verify the executable, then the SDK handshake, under the resolved launch
   * configuration. The probe cache key includes the executable identity
   * (path + realpath + mtime), so an upgraded executable re-probes the
   * handshake even when the provider configuration is unchanged.
   */
  private async probeAvailability(profileId: string = 'default', projectPath?: string): Promise<void> {
    const providerEnv = this.providerEnv()
    const launch = this.launchFor(profileId, projectPath)
    // A profile executable replaces the standard binary; verify it the same
    // way creation would so the probe failure is the actionable one.
    if (launch.executable) verifyProfileExecutable(profileId, launch.executable)
    const executable = launch.executable ? null : await this.checkExecutable()
    const key = executable
      ? `${claudeLaunchKey(launch)}\0${executable.identity}`
      : claudeLaunchKey(launch)
    const cached = this.availability.get(key)
    if (cached) return cached
    const probe = this.options.availabilityProbe ??
      (this.options.queryFactory ? async () => {} : probeSdkAvailability)
    const promise = probe(providerEnv, launch, launch.executable ?? executable?.path)
    // Bound retained configurations; evicted successful probes can be repeated.
    if (this.availability.size >= 32) this.availability.delete(this.availability.keys().next().value!)
    this.availability.set(key, promise)
    promise.catch(() => {
      if (this.availability.get(key) === promise) this.availability.delete(key)
    })
    return promise
  }

  /**
   * The verified executable every spawn will run, or null when a fake
   * runtime is injected (tests, development fixture) and no executable
   * applies. Throws ClaudeExecutableError verbatim for the caller to report.
   */
  private async checkExecutable(): Promise<ClaudeExecutableCheck | null> {
    if (this.options.executableCheck) return this.options.executableCheck()
    // An injected fake runtime (queryFactory for sends, availabilityProbe for
    // creation) must not require a Claude Code install.
    if (this.options.queryFactory || this.options.availabilityProbe) return null
    return ensureClaudeExecutable()
  }

  private providerEnv(): ChatProviderEnv {
    return this.options.getProviderEnv?.() ?? {}
  }

  /** Catalog lookup context for a session's project path. */
  private catalogCtx(projectPath?: string): ProfileCatalogContext {
    return {
      ...(projectPath ? { projectPath } : {}),
      ...(this.options.profileCatalogHome
        ? { homeDir: this.options.profileCatalogHome }
        : {}),
    }
  }

  /**
   * Launch configuration for a profile at a project path — every resolve site
   * goes through here so catalog file failures are reported (never silently
   * skipped: an invalid file would otherwise launch with inherited settings).
   */
  private launchFor(profileId: string | undefined, projectPath?: string): ClaudeLaunchConfiguration {
    const report = this.options.catalogErrorLog
      ?? (errors => logger.warn('chat_profile_catalog_errors', { errors }))
    return resolveClaudeProfile(profileId, this.providerEnv(), this.catalogCtx(projectPath), report)
  }

  private authOk(profileId: string = 'default', projectPath?: string): boolean {
    return this.options.authCheck
      ? this.options.authCheck()
      : hasClaudeAuth(this.launchEnvOf(profileId, projectPath))
  }

  /**
   * The effective environment a profile's spawn receives, inheritance
   * expanded: an unset SDK `env` means the child inherits process.env, so the
   * merged view is always process.env plus whatever the launch resolved.
   * Shared by the auth gate and the account-notice credentials check, so the
   * two can never disagree about which login applies. Undefined values
   * (process.env holes) are dropped for the ChatProviderEnv-shaped consumers.
   */
  private launchEnvOf(
    profileId: string | undefined,
    projectPath?: string
  ): Record<string, string> {
    const launch = this.launchFor(profileId, projectPath)
    const overrides = Object.fromEntries(
      Object.entries(launch.env ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    const merged = effectiveChatEnv(overrides)
    return Object.fromEntries(
      Object.entries(merged).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
  }

  // ----------------------------------------------------------- provider usage pull

  /**
   * The gap-fill pull slot (usage bar design D1, provider pull design D4):
   * the profile's one pull per store lifetime. A profile whose base URL
   * serves the provider quota endpoint is pulled here, marked routed, and
   * the host-login SDK pull is skipped — its data would only mislead. A
   * provider refusal records the no-data verdict; anything else falls
   * through to the SDK pull exactly as before. An already-routed profile
   * just restarts its refresh timer.
   */
  private async claimProfileUsagePull(record: ChatSessionRecord): Promise<boolean> {
    const profileId = record.claudeProfileId ?? 'default'
    if (this.providerUsageProfiles.has(profileId)) {
      this.ensureProviderUsageRefresh(profileId)
      return false
    }
    if (!this.usageLimits.claimPull(profileId)) return false
    const target = this.providerUsageTarget(record)
    // No provider base URL: the endpoint is never contacted, and the SDK
    // pull answers as before.
    if (!target) return true
    const pull = await this.fetchProviderUsage(target)
    // Shutdown settles every callback: nothing publishes past it.
    if (this.isShutDown) return false
    if (pull.ok) {
      this.providerUsageProfiles.add(profileId)
      this.usageLimits.record(profileId, pull.report)
      this.ensureProviderUsageRefresh(profileId)
      return false
    }
    if (pull.outcome === 'provider-refused') {
      this.usageLimits.recordNoData(profileId)
      return false
    }
    // Not provider-shaped or unreachable: the host-login SDK pull applies.
    return true
  }

  /**
   * The quota pull target for a session's profile — the effective base URL
   * and credentials its SDK spawns receive (the same resolution the auth
   * gate and account notices read), or null when the profile has no
   * provider base URL.
   */
  private providerUsageTarget(
    record: ChatSessionRecord
  ): { baseUrl: string; token?: string } | null {
    const env = this.launchEnvOf(record.claudeProfileId, record.projectPath)
    const baseUrl = env.ANTHROPIC_BASE_URL?.trim()
    if (!baseUrl) return null
    const token =
      env.ANTHROPIC_AUTH_TOKEN?.trim() || env.ANTHROPIC_API_KEY?.trim() || undefined
    return { baseUrl, token }
  }

  private fetchProviderUsage(target: { baseUrl: string; token?: string }) {
    return fetchZaiUsage(target.baseUrl, target.token, this.options.providerUsageFetch ?? fetch)
  }

  /**
   * Provider usage has no pushes (provider pull design D5): a timer per
   * routed profile re-pulls on a fixed cadence while at least one of its
   * sessions has a started agent. A tick without a qualifying session makes
   * no request and stops the timer; the next spawn of a routed profile
   * restarts it.
   */
  private ensureProviderUsageRefresh(profileId: string): void {
    if (this.providerUsageTimers.has(profileId)) return
    const timer = setInterval(
      () => this.refreshProviderUsage(profileId),
      this.providerUsageRefreshMs
    )
    timer.unref?.()
    this.providerUsageTimers.set(profileId, timer)
  }

  private refreshProviderUsage(profileId: string): void {
    if (!this.hasLiveSessionOf(profileId)) {
      const timer = this.providerUsageTimers.get(profileId)
      if (timer) clearInterval(timer)
      this.providerUsageTimers.delete(profileId)
      return
    }
    const record = [...this.records.values()].find(
      (candidate) => (candidate.claudeProfileId ?? 'default') === profileId
    )
    if (!record) return
    const target = this.providerUsageTarget(record)
    if (!target) return
    void this.fetchProviderUsage(target).then((pull) => {
      // Shutdown settles every callback (an in-flight refresh dies with it);
      // a failed refresh keeps the held report (store semantics); a lost
      // routing just skips the tick.
      if (this.isShutDown || !pull.ok) return
      this.usageLimits.record(profileId, pull.report)
    })
  }

  /** Any non-archived session of the profile with a live driver (started agent). */
  private hasLiveSessionOf(profileId: string): boolean {
    for (const record of this.records.values()) {
      if ((record.claudeProfileId ?? 'default') !== profileId) continue
      if (record.archivedAt) continue
      if (this.drivers.has(record.sessionId)) return true
    }
    return false
  }

  /** Stop every provider usage refresh timer (server shutdown). */
  private stopProviderUsageRefresh(): void {
    for (const timer of this.providerUsageTimers.values()) clearInterval(timer)
    this.providerUsageTimers.clear()
  }

  /**
   * Resolve the SDK query() once per process. The import is dynamic so a
   * missing/broken install surfaces as a send-time error, not a crash; the
   * cache is dropped on failure so a repaired install recovers without a
   * server restart.
   */
  private async resolveQueryFactory(): Promise<ChatQueryFactory> {
    const injected = this.options.queryFactory
    if (injected) return injected
    this.sdkQuery ??= import('@anthropic-ai/claude-agent-sdk').then(
      (sdk) => sdk.query,
      (error) => {
        this.sdkQuery = null
        throw error
      }
    )
    return this.sdkQuery
  }

  private handleDriverEvent(sessionId: string, event: ChatEvent): void {
    if (!this.records.has(sessionId)) return
    const events = this.liveEvents.get(sessionId) ?? []
    event = { ...event, sequence: (events.at(-1)?.sequence ?? 0) + 1 }
    events.push(event)
    this.liveEvents.set(sessionId, events)
    this.options.onEvent(sessionId, event)
    if (event.type === 'request_resolved') this.dispatcher.notify()
    if (event.type === 'error' || event.type === 'turn_completed') this.teamMail.settleRecipient(sessionId)
    // Profile routing: progress and limit outcomes for the mail a turn handles.
    if (event.type === 'tool_call') this.teamMail.toolCall(sessionId, event.tool, event.input)
    if (event.type === 'turn_completed') this.teamMail.turnEnded(sessionId, event.subtype === 'success')
    if (
      event.type === 'turn_completed' ||
      event.type === 'approval_request' ||
      event.type === 'question_request'
    ) {
      this.touch(sessionId)
    }
    // Context-usage write points (design D5): a turn boundary, the compaction
    // notice (the driver's compact_boundary), and an error — the visible
    // signal of driver death. Never per assistant frame. The compaction
    // notice is identified by its `kind`, not its display text, so rewording
    // the copy cannot silently stop the write.
    if (
      event.type === 'turn_completed' ||
      event.type === 'error' ||
      (event.type === 'notice' && event.kind === 'compacted')
    ) {
      this.persistContextUsage(sessionId)
    }
  }

  /**
   * Hold the latest reading (design D5) and forward it to the broadcast sink;
   * persistence is throttled to the boundary events above — except when the
   * driver asks for a write now (`persist`): the turn-boundary probe resolves
   * after `turn_completed` has already written the reading, and an abrupt
   * restart would otherwise restore a different threshold (and percentage)
   * than the one last displayed. Those are probe answers, spawn-time
   * re-anchors, and compaction, so they do not reintroduce per-frame churn.
   * A null usage clears the reading (a conversation reset leaves nothing
   * measured) and is persisted as such so a restart cannot restore it.
   */
  private handleDriverContextUsage(
    sessionId: string,
    usage: ChatContextUsage | null,
    opts?: { persist?: boolean }
  ): void {
    if (!this.records.has(sessionId)) return
    if (usage === null) {
      this.contextReadings.delete(sessionId)
      this.options.onContextUsage?.(sessionId, null)
      this.applyPatch(sessionId, { contextUsage: null })
      return
    }
    this.contextReadings.set(sessionId, usage)
    this.options.onContextUsage?.(sessionId, usage)
    if (opts?.persist) this.persistContextUsage(sessionId)
  }

  /** Write the freshest in-memory reading to the record, if one exists. */
  private persistContextUsage(sessionId: string): void {
    const usage = this.contextReadings.get(sessionId)
    if (!usage) return
    this.applyPatch(sessionId, { contextUsage: usage })
  }

  /**
   * The driver reported a model different from the last one (chat-session-model
   * design D5): record and persist it right away — model changes are rare (a
   * /model switch), so there is no per-request churn to batch, and a crash
   * before the next boundary must not lose the switch — then hand it to the
   * broadcast sink. The driver already deduped, so this runs per change.
   */
  private handleDriverModel(sessionId: string, model: string): void {
    if (!this.records.has(sessionId)) return
    this.applyPatch(sessionId, { model })
    this.options.onModel?.(sessionId, model)
  }

  /**
   * The agent's working directory moved (worktree tracking design D2): the
   * session row follows it in place — every consumer reads projectPath — and
   * the live driver learns it so any respawn resumes in the directory the
   * conversation is actually in, not the creation path. No-ops when the path
   * is unchanged, so hook noise for the same directory never writes.
   */
  private handleDriverCwdChanged(sessionId: string, newCwd: string): void {
    const record = this.records.get(sessionId)
    if (!record || record.projectPath === newCwd) return
    this.applyPatch(sessionId, { projectPath: newCwd })
    this.drivers.get(sessionId)?.setProjectPath(newCwd)
    this.scheduleCwdRefresh(sessionId, newCwd)
  }

  /**
   * One scoped discovery pass per debounce window (design D2): a fast cd chain
   * collapses into a single refresh for its final directory, so a newly
   * entered worktree is discovered without a reload while its creation does
   * not stampede the coordinator.
   */
  private scheduleCwdRefresh(sessionId: string, path: string): void {
    const pending = this.cwdRefreshTimers.get(sessionId)
    if (pending) clearTimeout(pending.timer)
    const timer = setTimeout(() => {
      this.cwdRefreshTimers.delete(sessionId)
      this.options.requestWorkspaceRefresh?.(path)
    }, this.options.cwdRefreshDebounceMs ?? 500)
    timer.unref?.()
    this.cwdRefreshTimers.set(sessionId, { timer, path })
  }

  /** Forget a session's pending refresh (kill, shutdown). */
  private cancelCwdRefresh(sessionId: string): void {
    const pending = this.cwdRefreshTimers.get(sessionId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.cwdRefreshTimers.delete(sessionId)
  }

  /**
   * Store the latest activity (anchored on this server's clock) and forward
   * it to the broadcast sink. Null (turn end, driver death) clears it.
   */
  private handleDriverActivity(
    sessionId: string,
    activity: ChatActivity | null
  ): void {
    if (!this.records.has(sessionId)) return
    if (activity === null) {
      this.activities.delete(sessionId)
    } else {
      const { elapsedMs, ...body } = activity
      this.activities.set(sessionId, {
        body,
        phaseStartedAt: Date.now() - elapsedMs,
      })
    }
    this.options.onActivity?.(sessionId, activity)
  }

  /** Forget a session's activity, broadcasting null if one was showing. */
  private clearActivity(sessionId: string): void {
    if (this.activities.delete(sessionId)) {
      this.options.onActivity?.(sessionId, null)
    }
  }

  /**
   * Hold the latest roster (design D2) and forward it to the broadcast sink.
   * The sidecar write (design D6) is keyed on the persisted shape, so this
   * fires on every publish but only touches the disk when a row's identity
   * or outcome changed — spawn, fill, settle. Write failures are logged by
   * the store and never fail the session.
   */
  /**
   * Hold the latest background-task roster (design D2) and forward it to the
   * broadcast sink. The sidecar write (design D6) is keyed on the persisted
   * shape, so `live` toggles never touch the disk; write failures are
   * logged by the store and never fail the session.
   */
  private handleDriverBackgroundTasks(sessionId: string, tasks: ChatBackgroundTask[]): void {
    if (!this.records.has(sessionId)) return
    this.backgroundTaskRows.set(sessionId, tasks)
    this.options.onBackgroundTasks?.(sessionId, tasks)
    const store = this.options.taskStore
    const driver = this.drivers.get(sessionId)
    if (driver && !driver.isDead) {
      this.backgroundTaskRecords.set(sessionId, driver.getBackgroundTaskRecords())
    }
    if (store && driver && !driver.isDead) {
      store.write(sessionId, driver.getBackgroundTaskRecords()).catch((error) => {
        logger.warn('chat_task_sidecar_write_failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }

  private handleDriverWorkers(sessionId: string, workers: ChatWorker[]): void {
    if (!this.records.has(sessionId)) return
    this.workerRows.set(sessionId, workers)
    this.options.onWorkers?.(sessionId, workers)
    this.workersChanged(sessionId)
    const store = this.options.workerStore
    if (store) {
      store.write(sessionId, workers).catch((error) => {
        logger.warn('chat_worker_sidecar_write_failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }

  /** Bump lastActivity across record, db, and registry in one update. */
  private touch(sessionId: string): void {
    this.applyPatch(sessionId, { lastActivityAt: new Date().toISOString() })
  }

  /**
   * Record the session's current name and group under its team. The team is
   * resolved asynchronously, so this runs again from `onResolved`; with no
   * team yet there is nothing to record. Called from detached callbacks that
   * can land after teardown has closed the database — a lost last-known-name
   * write is preferable to an unhandled rejection, so the write is best-effort.
   */
  private syncDirectory(sessionId: string): void {
    if (this.isShutDown) return
    const record = this.records.get(sessionId)
    const teamId = this.teams.teamOf(sessionId)?.teamId
    if (!record || !teamId) return
    try {
      this.directory.upsert(teamId, {
        sessionId,
        name: record.name,
        group: record.groupId ?? null,
      })
    } catch {
      // Teardown closed the database under an in-flight team resolution.
    }
  }

  private applyPatch(
    sessionId: string,
    patch: Partial<ChatSessionRecord>
  ): void {
    const record = this.records.get(sessionId)
    if (!record) return
    const next = { ...record, ...patch }
    this.records.set(sessionId, next)
    // Keep the directory's last known name and group (team-message-threads
    // D3); kill and archive deliberately never write here.
    if (patch.name !== undefined || patch.groupId !== undefined) this.syncDirectory(sessionId)
    if (
      (patch.status !== undefined && patch.status !== record.status) ||
      patch.projectPath !== undefined || patch.archivedAt !== undefined ||
      (patch.sdkSessionId !== undefined && patch.sdkSessionId !== record.sdkSessionId)
    ) this.dispatcher?.notify()
    this.options.db.updateChatSession(sessionId, patch)
    // The first SDK session id makes a transcript followable: start the
    // title tail for the now-live conversation (design D4).
    if (patch.sdkSessionId !== undefined) {
      this.watchSessionTitle(sessionId)
    }
    // A moved cwd may leave the team (another repository); re-resolve.
    if (patch.projectPath !== undefined) void this.teams.track(sessionId, patch.projectPath)
    this.options.registry.updateSession(sessionId, {
      // Status changes re-read the group file, so a removed or restored
      // group shows in the navigator without a restart.
      ...(patch.status !== undefined ? this.groupFields(next) : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      // The agent's cwd move rides the same session-update broadcast, so
      // clients re-group the row without a reload (worktree tracking D2).
      ...(patch.projectPath !== undefined
        ? { projectPath: patch.projectPath }
        : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.lastActivityAt !== undefined
        ? { lastActivity: patch.lastActivityAt }
        : {}),
      ...(patch.archivedAt !== undefined ? { archivedAt: patch.archivedAt } : {}),
      ...(patch.approvalPolicy !== undefined
        ? { approvalPolicy: patch.approvalPolicy }
        : {}),
      ...(patch.nameSource !== undefined
        ? { nameSource: patch.nameSource }
        : {}),
      ...(patch.taskId !== undefined ? this.taskFields(next) : {}),
    })
  }

  private toSession(record: ChatSessionRecord): Session {
    return {
      id: record.sessionId,
      name: record.name,
      kind: 'chat',
      claudeProfileId: record.claudeProfileId ?? 'default',
      approvalPolicy: record.approvalPolicy ?? 'manual',
      // Absent provenance is treated as manual: a name we cannot attribute is
      // never handed over to a generated title (chat-session-naming design D6).
      nameSource: record.nameSource ?? 'manual',
      projectPath: record.projectPath,
      status: record.status,
      lastActivity: record.lastActivityAt,
      createdAt: record.createdAt,
      source: 'managed',
      // Per design D1: existing icons, labels, and sorting keep working.
      agentType: 'claude',
      ...(record.archivedAt != null ? { archivedAt: record.archivedAt } : {}),
      ...this.groupFields(record),
      ...this.taskFields(record),
      ...(record.spawned ? { spawned: true } : {}),
      ...(this.parkedShown.has(record.sessionId) ? { parked: this.parkedShown.get(record.sessionId)! } : {}),
    }
  }

  /** Associated task id plus its current title (team-tasks header). */
  private taskFields(record: ChatSessionRecord): Partial<Session> {
    if (record.taskId == null) return {}
    const title = this.tasks.store.get(record.taskId)?.title
    return { taskId: record.taskId, ...(title !== undefined ? { taskTitle: title } : {}) }
  }

  /** Group id plus display state; label/missing only once the team is known. */
  private groupFields(record: ChatSessionRecord): Partial<Session> {
    if (record.groupId == null) return {}
    const info = this.teams.groupInfo(record.sessionId, record.groupId)
    return {
      groupId: record.groupId,
      ...(info ? { groupLabel: info.label, groupMissing: info.missing } : {}),
    }
  }
}
