// Owns the lifecycle of chat sessions: auth-gated creation, lazy driver
// construction (the SDK query() is spawned by the driver on the first turn),
// persistence in the chat_sessions table with restore-on-start into the
// registry, kill/shutdown settlement (including the session's protocol log),
// immediate sdkSessionId capture so a restart can resume the same agent
// conversation, and the current in-flight-turn activity (phase plus start
// time) surfaced through getSnapshot and the onActivity broadcast sink. The
// SDK import stays dynamic (injected as a queryFactory in tests) so a broken
// install disables the feature instead of crashing the server. Chat spawns
// run a separately installed Claude Code executable: creation and every
// (re)spawn first pass an executable check (KAWAI_CLAUDE_PATH/PATH, version
// baseline) whose ClaudeExecutableError messages reach the user verbatim.
import type {
  ChatActivity,
  ChatApprovalDecision,
  ChatApprovalPolicy,
  ChatCommandState,
  ChatEvent,
  ChatPendingRequest,
  ChatQuestionAnswer,
  ChatUsageReport,
} from '../../shared/chat'
import type { ServerMessage, Session, SessionNameSource, SessionStatus } from '../../shared/types'
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
import type { ChatProviderEnv } from './chatProviderEnv'
import type { ChatWireLogs } from './ChatWireLogs'
import {
  resolveClaudeProfile,
  claudeLaunchKey,
  verifyProfileExecutable,
  type ClaudeLaunchConfiguration,
  type ProfileCatalogContext,
} from './ClaudeProfiles'
import { logger } from '../logger'
import { probeSdkAvailability } from './sdkAvailability'
import { UsageLimitStore } from './usageLimits'
import {
  findTranscriptPath,
  replayTranscriptFile,
  type TranscriptReplay,
} from './transcriptReplay'

export type { ChatQueryFactory }
export { chatAuthErrorMessage, hasClaudeAuth }

export interface ChatSessionManagerOptions {
  registry: SessionRegistry
  db: SessionDatabase
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
   * Plan-usage sink (usage bar design D4): called with the latest report
   * (or null) whenever a profile's held data changes. Wired to the WS
   * broadcast in index.ts; usage is ephemeral and never persisted.
   */
  onUsage?: (profileId: string, report: ChatUsageReport | null) => void
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
   * Home directory for the user-level profile catalog (~/.kawai/profiles.json
   * lives here). Injected in tests so a real home catalog cannot leak in.
   */
  profileCatalogHome?: string
  /** Catalog file failure sink; defaults to the structured logger. */
  catalogErrorLog?: (errors: string[]) => void
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

  async createAvailableSession(input: { projectPath: string; name?: string; claudeProfileId?: string }): Promise<ChatCreateResult> {
    // Refuse a bad path before the probe spends an SDK spawn on it.
    const project = resolveProjectDirectory(input.projectPath, this.options.isDirectory)
    if (!project.ok) return project
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

  /** Synchronous capture: no driver callback can interleave with history loading. */
  getSnapshot(sessionId: string): Extract<ServerMessage, { type: 'chat-snapshot' }> | null {
    if (!this.records.has(sessionId)) return null
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
      usage: this.usageLimits.get(this.profileIdOf(sessionId) ?? 'default'),
    }
  }

  /** Current activity with a live-computed elapsed time, or null when idle. */
  private getActivity(sessionId: string): ChatActivity | null {
    const entry = this.activities.get(sessionId)
    if (!entry) return null
    return { ...entry.body, elapsedMs: Math.max(0, Date.now() - entry.phaseStartedAt) }
  }

  private captureHistory(sessionId: string): void {
    if (!this.snapshotHistory.has(sessionId)) {
      this.snapshotHistory.set(sessionId, this.getHistory(sessionId)?.events ?? [])
    }
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
    // Profile usage changes drive the chat-usage broadcast (design D4).
    this.usageLimits.subscribe((profileId, report) =>
      this.options.onUsage?.(profileId, report)
    )
    this.restorePersisted()
    // Logs of sessions deleted while the server was down are orphans now.
    void this.options.wireLogs?.pruneOrphans(new Set(this.records.keys()))
  }

  /** Create a chat session. Refused (no side effects) when auth is missing. */
  createSession(input: {
    projectPath: string
    name?: string
    claudeProfileId?: string
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
    const trimmedInputName = input.name?.trim()
    const name = trimmedInputName || generateSessionName()
    const now = new Date().toISOString()
    const record = {
      sessionId,
      name,
      projectPath,
      sdkSessionId: null as string | null,
      claudeProfileId: input.claudeProfileId ?? 'default',
      // Every session starts manual; there is no per-profile default.
      approvalPolicy: 'manual' as ChatApprovalPolicy,
      // A user-supplied name is manual forever; the generated fallback is a
      // placeholder a later generated title may replace (design D1).
      nameSource: (trimmedInputName ? 'manual' : 'placeholder') as SessionNameSource,
      status: 'waiting' as SessionStatus,
      createdAt: now,
      lastActivityAt: now,
    }
    this.records.set(sessionId, record)
    this.options.db.insertChatSession(record)
    const session = this.toSession(record)
    this.options.registry.setChatSession(session)
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
      return { status: 'ok', events: [] }
    }
    return replayTranscriptFile(findTranscriptPath(record.sdkSessionId), {
      excludeToolCallIds: this.liveToolCallIds(sessionId),
    })
  }

  /**
   * Submit a user turn. The driver (and behind it the SDK subprocess) is
   * created lazily here — the first turn pays the spawn cost, creation never
   * blocks on process startup. A stored SDK id whose transcript is missing
   * refuses the turn rather than silently starting a fresh conversation
   * (design D5): the id is kept so a restored transcript can still resume.
   */
  async send(sessionId: string, text: string): Promise<ChatActionResult> {
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
   * Rename: set the name with manual provenance (design D1 — any rename makes
   * the name user-set, forever after immune to generated titles). Free text:
   * any non-empty-after-trim value is accepted (design D5). Propagates through
   * applyPatch to the db row, the registry, and the session-update broadcast;
   * the conversation and status are untouched. Archived chats keep the action
   * (read-only covers the conversation, not the label).
   */
  rename(sessionId: string, newName: string): ChatActionResult {
    const trimmed = newName.trim()
    if (!trimmed) {
      return { ok: false, error: 'Name cannot be empty' }
    }
    if (!this.records.has(sessionId)) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    this.applyPatch(sessionId, { name: trimmed, nameSource: 'manual' })
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
    this.drivers.delete(sessionId)
    this.driverPromises.delete(sessionId)
    // The archived chat shows no activity row (design D5): any in-flight
    // phase ended with the driver above.
    this.clearActivity(sessionId)
    // Status returns to waiting: archived sessions never look busy.
    this.applyPatch(sessionId, {
      archivedAt: new Date().toISOString(),
      status: 'waiting',
    })
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
    this.drivers.delete(sessionId)
    this.driverPromises.delete(sessionId)
    this.records.delete(sessionId)
    this.snapshotHistory.delete(sessionId)
    this.liveEvents.delete(sessionId)
    this.activities.delete(sessionId)
    this.options.registry.removeChatSession(sessionId)
    this.options.db.deleteChatSession(sessionId)
    void this.options.wireLogs?.delete(sessionId).catch(() => {})
    return true
  }

  /** Server shutdown: settle every driver (callbacks cannot survive it). */
  shutdown(): void {
    for (const driver of this.drivers.values()) {
      driver.shutdown()
    }
    this.drivers.clear()
    this.driverPromises.clear()
    this.activities.clear()
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
  private restorePersisted(): void {
    for (const row of this.options.db.getChatSessions()) {
      let record = row
      // Pending requests and in-flight turns died with the old process; a
      // restored session is always idle.
      if (record.status !== 'waiting') {
        record = { ...record, status: 'waiting' }
        this.options.db.updateChatSession(record.sessionId, {
          status: 'waiting',
        })
      }
      this.records.set(record.sessionId, record)
      this.options.registry.setChatSession(this.toSession(record))
    }
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
    this.captureHistory(sessionId)
    const promise = (async () => {
      // A profile executable replaces the standard binary (already verified
      // above); otherwise every spawn runs the checked Claude Code install.
      const executable = launch.executable ? null : await this.checkExecutable()
      const queryFactory = await this.resolveQueryFactory()
      const driver = new ChatSessionDriver({
        sessionId: record.sessionId,
        projectPath: record.projectPath,
        queryFactory,
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
        onEvent: (event) => this.handleDriverEvent(record.sessionId, event),
        onCommandState: (state) =>
          this.options.onCommandState?.(record.sessionId, state),
        onActivity: (activity) =>
          this.handleDriverActivity(record.sessionId, activity),
        // Plan usage is recorded against the session's profile (design D3);
        // the store's change listener drives the onUsage broadcast.
        onRateLimit: (report) =>
          this.usageLimits.record(record.claudeProfileId ?? 'default', report),
        onUsageReport: (report) =>
          this.usageLimits.record(record.claudeProfileId ?? 'default', report),
        claimUsagePull: () =>
          this.usageLimits.claimPull(record.claudeProfileId ?? 'default'),
        onUsageNoData: () =>
          this.usageLimits.recordNoData(record.claudeProfileId ?? 'default'),
        onStatus: (status) => this.applyPatch(record.sessionId, { status }),
        onSdkSessionId: (sdkSessionId) =>
          // Persist immediately: a crash right after the first turn must not
          // lose the ability to resume the conversation.
          this.applyPatch(record.sessionId, { sdkSessionId }),
      })
      if (
        !this.records.has(record.sessionId) ||
        // Archived while the import was resolving: same discard as kill.
        this.records.get(record.sessionId)?.archivedAt != null
      ) {
        driver.kill()
        return null
      }
      this.drivers.set(record.sessionId, driver)
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
      : hasClaudeAuth(Object.fromEntries(
        Object.entries(this.launchFor(profileId, projectPath).env ?? {})
          .filter((entry): entry is [string, string] => entry[1] !== undefined)
      ))
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
    if (
      event.type === 'turn_completed' ||
      event.type === 'approval_request' ||
      event.type === 'question_request'
    ) {
      this.touch(sessionId)
    }
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

  /** Bump lastActivity across record, db, and registry in one update. */
  private touch(sessionId: string): void {
    this.applyPatch(sessionId, { lastActivityAt: new Date().toISOString() })
  }

  private applyPatch(
    sessionId: string,
    patch: Partial<ChatSessionRecord>
  ): void {
    const record = this.records.get(sessionId)
    if (!record) return
    const next = { ...record, ...patch }
    this.records.set(sessionId, next)
    this.options.db.updateChatSession(sessionId, patch)
    this.options.registry.updateSession(sessionId, {
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.nameSource !== undefined
        ? { nameSource: patch.nameSource }
        : {}),
      ...(patch.lastActivityAt !== undefined
        ? { lastActivity: patch.lastActivityAt }
        : {}),
      ...(patch.archivedAt !== undefined ? { archivedAt: patch.archivedAt } : {}),
      ...(patch.approvalPolicy !== undefined
        ? { approvalPolicy: patch.approvalPolicy }
        : {}),
    })
  }

  private toSession(record: ChatSessionRecord): Session {
    return {
      id: record.sessionId,
      name: record.name,
      kind: 'chat',
      claudeProfileId: record.claudeProfileId ?? 'default',
      approvalPolicy: record.approvalPolicy ?? 'manual',
      nameSource: record.nameSource ?? 'manual',
      projectPath: record.projectPath,
      status: record.status,
      lastActivity: record.lastActivityAt,
      createdAt: record.createdAt,
      source: 'managed',
      // Per design D1: existing icons, labels, and sorting keep working.
      agentType: 'claude',
      ...(record.archivedAt != null ? { archivedAt: record.archivedAt } : {}),
    }
  }
}
