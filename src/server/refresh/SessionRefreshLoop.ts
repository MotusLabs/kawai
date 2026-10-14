// Session refresh loop: drives the periodic, sync-fallback, and Enter-key
// refresh paths over the hydration in hydrateSessions.ts, and runs startup
// association verification. The generation/counter guards
// (refreshGeneration, refreshWindowCountFloor, …) are load-bearing race fixes
// and moved verbatim from index.ts.
import type { AgentSession, Session, ServerMessage, TerminalSession } from '../../shared/types'
import { isTerminalSession } from '../../shared/types'
import { toAgentSession } from '../agentSessions'
import { getLogSearchDirs } from '../logDiscovery'
import { stripPastePlaceholders } from '../logmatch'
import { applyForceWorkingOverrides, setForceWorkingUntil } from '../forceWorkingStatus'
import { initDatabase } from '../db'
import { logger } from '../logger'
import { config } from '../config'
import { SessionManager } from '../SessionManager'
import { SessionRegistry } from '../SessionRegistry'
import { SessionRefreshWorkerClient, SessionRefreshWorkerTimeoutError } from '../sessionRefreshWorkerClient'
import { TmuxTimeoutError } from '../tmuxTimeout'
import { BUILD_VERSION } from '../version'
import {
  hydrateSessionsWithAgentSessions,
  verifyAllSessions,
} from './hydrateSessions'
import type { HydrateSessionsOptions } from './hydrateSessions'

type SessionDatabase = ReturnType<typeof initDatabase>

export interface SessionRefreshLoopOptions {
  db: SessionDatabase
  registry: SessionRegistry
  sessionManager: SessionManager
  sessionRefreshWorker: SessionRefreshWorkerClient
  lastUserMessageWorker: SessionRefreshWorkerClient
  broadcast: (message: ServerMessage) => void
  mergeRemoteSessions: (sessions: Session[]) => Session[]
  /** Runtime-mutable settings state (settings routes can change it). */
  historyMaxAgeHours: () => number
}

// Lock window for Enter-key lastUserMessage capture: prevents stale log data
// from overwriting fresh terminal captures.
const LAST_USER_MESSAGE_LOCK_MS = 60_000 // 60 seconds

export class SessionRefreshLoop {
  private readonly db: SessionRefreshLoopOptions['db']
  private readonly registry: SessionRefreshLoopOptions['registry']
  private readonly sessionManager: SessionRefreshLoopOptions['sessionManager']
  private readonly sessionRefreshWorker: SessionRefreshLoopOptions['sessionRefreshWorker']
  private readonly lastUserMessageWorker: SessionRefreshLoopOptions['lastUserMessageWorker']
  private readonly broadcast: SessionRefreshLoopOptions['broadcast']
  private readonly mergeRemoteSessions: SessionRefreshLoopOptions['mergeRemoteSessions']
  private readonly historyMaxAgeHours: SessionRefreshLoopOptions['historyMaxAgeHours']

  private refreshInFlight = false
  // Bumped on optimistic registry mutations (kill, create, resume) so
  // in-flight refreshes that started before the mutation discard their stale
  // window list instead of reverting the optimistic update.
  private refreshGeneration = 0
  private hasConfirmedLocalSessionSnapshot = false
  private lastSuccessfulRefreshWindowCount = 1
  private refreshWindowCountFloor = 0
  private startupExpectedWindowCount = 1

  // Debounced refresh triggered by Enter key in terminal input
  private enterRefreshTimer: Timer | null = null
  private readonly lastUserMessageTimers = new Map<string, Timer>()
  /** tmuxWindow -> expiry timestamp; read by the log poller's lock check. */
  readonly lastUserMessageLocks = new Map<string, number>()

  constructor(options: SessionRefreshLoopOptions) {
    this.db = options.db
    this.registry = options.registry
    this.sessionManager = options.sessionManager
    this.sessionRefreshWorker = options.sessionRefreshWorker
    this.lastUserMessageWorker = options.lastUserMessageWorker
    this.broadcast = options.broadcast
    this.mergeRemoteSessions = options.mergeRemoteSessions
    this.historyMaxAgeHours = options.historyMaxAgeHours
  }

  isLastUserMessageLocked(tmuxWindow: string): boolean {
    return (this.lastUserMessageLocks.get(tmuxWindow) ?? 0) > Date.now()
  }

  /** Bump the generation so in-flight refreshes discard their stale snapshot. */
  noteOptimisticMutation(): void {
    this.refreshGeneration += 1
  }

  private ensureBaseSessionForRefresh(context: string): boolean {
    try {
      this.sessionManager.ensureSession()
      return true
    } catch (error) {
      logger.warn('base_session_ensure_failed', {
        context,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  // Active sessions update on every refresh — cheap (few rows).
  // History sessions query is expensive — only run on actual mutations.
  private filterExcludedAgentSessions(sessions: AgentSession[]): AgentSession[] {
    const excludedProjects = config.excludeProjects ?? []
    if (excludedProjects.length === 0) {
      return sessions
    }

    return sessions.filter((session) => {
      const projectPath = session.projectPath || ''
      return !excludedProjects.some((excluded) => {
        if (excluded === '<empty>') return projectPath === ''
        return projectPath.startsWith(excluded)
      })
    })
  }

  updateActiveAgentSessions() {
    const active = this.hasConfirmedLocalSessionSnapshot
      ? this.db.getActiveSessions().map(toAgentSession)
      : []
    const current = this.registry.getAgentSessions()
    this.registry.setAgentSessions(
      active,
      current.hibernating,
      current.history
    )
  }

  updateDormantAgentSessions() {
    const hibernating = this.filterExcludedAgentSessions(
      this.db.getHibernatingSessions().map(toAgentSession)
    )
    const history = this.filterExcludedAgentSessions(
      this.db.getHistorySessions({ maxAgeHours: this.historyMaxAgeHours() }).map(
        toAgentSession
      )
    )
    const active = this.hasConfirmedLocalSessionSnapshot
      ? this.db.getActiveSessions().map(toAgentSession)
      : []
    this.registry.setAgentSessions(active, hibernating, history)
  }

  hydrateSessionsWithAgentSessions(
    sessions: TerminalSession[],
    options?: HydrateSessionsOptions
  ): Session[] {
    return hydrateSessionsWithAgentSessions(
      {
        db: this.db,
        sessionManager: this.sessionManager,
        broadcast: this.broadcast,
        updateDormantAgentSessions: () => this.updateDormantAgentSessions(),
        updateActiveAgentSessions: () => this.updateActiveAgentSessions(),
      },
      sessions,
      options
    )
  }

  private normalizeWindowCount(windowCount: number): number {
    return Math.max(
      1,
      Number.isFinite(windowCount) ? Math.floor(windowCount) : 0
    )
  }

  private countLocalSessions(sessions: Session[]): number {
    return sessions.filter((session) => !session.remote).length
  }

  private seedRefreshWindowCountEstimate(localSessionCount: number): void {
    this.startupExpectedWindowCount = this.normalizeWindowCount(localSessionCount)
  }

  private recordSuccessfulRefreshWindowCount(localSessionCount: number): void {
    this.hasConfirmedLocalSessionSnapshot = true
    this.lastSuccessfulRefreshWindowCount = this.normalizeWindowCount(localSessionCount)
    this.refreshWindowCountFloor = 0
    this.startupExpectedWindowCount = 1
  }

  private shouldSkipSyncRefreshFallback(error: unknown): boolean {
    return error instanceof SessionRefreshWorkerTimeoutError
  }

  private estimateRefreshWindowCount(): number {
    const localSessionCount = this.registry.getAll().filter((session) => !session.remote).length
    return Math.max(
      1,
      localSessionCount,
      this.lastSuccessfulRefreshWindowCount,
      this.refreshWindowCountFloor,
      this.startupExpectedWindowCount
    )
  }

  private noteRefreshTimeout(): number {
    const currentEstimate = this.estimateRefreshWindowCount()
    const nextEstimate = Math.max(currentEstimate + 4, currentEstimate * 2)
    this.refreshWindowCountFloor = nextEstimate
    return nextEstimate
  }

  /**
   * Hydrate the listed windows and swap the registry. Guarded: a hydration or
   * DB error (SQLITE_BUSY from a concurrent connection was the CI trigger)
   * logs `session_refresh_hydrate_failed` and ends the cycle — the next
   * scheduled refresh retries — instead of throwing to the caller.
   */
  private hydrateAndReplaceSessions(
    sessions: TerminalSession[],
    source: 'worker' | 'fallback'
  ): void {
    const tHydrate = performance.now()
    this.recordSuccessfulRefreshWindowCount(this.countLocalSessions(sessions))
    try {
      const hydrated = this.hydrateSessionsWithAgentSessions(sessions)
      const withOverrides = applyForceWorkingOverrides(hydrated)
      this.registry.replaceSessions(this.mergeRemoteSessions(withOverrides))
    } catch (error) {
      logger.warn('session_refresh_hydrate_failed', {
        source,
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const hydrateMs = Math.round(performance.now() - tHydrate)
    if (hydrateMs > 50) {
      logger.debug('session_refresh_hydrate_slow', { hydrateMs, sessionCount: sessions.length })
    }
  }

  private async refreshSessionsAsync(): Promise<void> {
    if (this.refreshInFlight) return
    this.refreshInFlight = true
    try {
      if (!this.ensureBaseSessionForRefresh('async_refresh')) {
        return
      }
      // Loop: retry once if an optimistic mutation invalidated our snapshot.
      // At most one retry — if another mutation lands during the retry,
      // the next scheduled refresh will pick it up.
      for (let attempt = 0; attempt < 2; attempt++) {
        const gen = this.refreshGeneration
        let sessions: TerminalSession[] | null = null
        let source: 'worker' | 'fallback' = 'worker'
        try {
          sessions = await this.sessionRefreshWorker.refresh(
            config.tmuxSession,
            config.discoverPrefixes,
            {
              expectedWindowCount: this.estimateRefreshWindowCount(),
              preferWindowName: config.preferWindowName,
            }
          )
          // Mutation happened while we were listing windows — discard and retry
          if (gen !== this.refreshGeneration) continue
          // Yield before blocking SQLite work so pending WebSocket buffers flush
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
          if (gen !== this.refreshGeneration) continue
        } catch (error) {
          // Only a failure of the worker refresh may fall back to the sync
          // tmux listing; hydration runs outside this catch, so a hydration
          // or DB error never reaches it (it used to, re-running the same
          // locked read and throwing out of the fallback too).
          logger.warn('session_refresh_worker_error', {
            message: error instanceof Error ? error.message : String(error),
          })
          if (this.shouldSkipSyncRefreshFallback(error)) {
            const nextExpectedWindowCount = this.noteRefreshTimeout()
            logger.warn('session_refresh_sync_fallback_skipped', {
              reason: 'worker_timeout',
              nextExpectedWindowCount,
            })
            return
          }
          // Fallback to sync on worker failure — sync listWindows sees
          // post-mutation state so no generation check needed here.
          source = 'fallback'
          sessions = this.listWindowsSyncOrNull('worker_fallback')
          if (!sessions) {
            return
          }
        }
        if (sessions) {
          this.hydrateAndReplaceSessions(sessions, source)
        }
        return
      }
    } catch (error) {
      // refreshSessions() fires this cycle with void, so any escaping throw
      // would be an unhandled rejection that kills the server — log instead.
      logger.warn('session_refresh_unexpected_error', {
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.refreshInFlight = false
    }
  }

  refreshSessions() {
    void this.refreshSessionsAsync()
  }

  private listWindowsSyncOrNull(context: string): TerminalSession[] | null {
    try {
      if (!this.ensureBaseSessionForRefresh(context)) {
        return null
      }
      return this.sessionManager.listWindows()
    } catch (error) {
      if (error instanceof TmuxTimeoutError) {
        logger.warn('session_refresh_sync_skipped', {
          context,
          reason: 'tmux_timeout',
          timeoutMs: config.tmuxTimeoutMs,
          message: error.message,
        })
        return null
      }
      throw error
    }
  }

  // Sync version for startup - ensures sessions are ready before server starts
  refreshSessionsSync() {
    const sessions = this.listWindowsSyncOrNull('sync_refresh')
    if (!sessions) {
      return
    }
    this.recordSuccessfulRefreshWindowCount(this.countLocalSessions(sessions))
    const hydrated = this.hydrateSessionsWithAgentSessions(sessions)
    this.registry.replaceSessions(this.mergeRemoteSessions(hydrated))
  }

  setForceWorking(sessionId: string) {
    setForceWorkingUntil(sessionId, Date.now() + config.workingGracePeriodMs)
    // Immediately update registry so UI shows "working" right away
    this.registry.updateSession(sessionId, { status: 'working' })
  }

  scheduleEnterRefresh() {
    if (this.enterRefreshTimer) {
      clearTimeout(this.enterRefreshTimer)
    }
    this.enterRefreshTimer = setTimeout(() => {
      this.enterRefreshTimer = null
      this.refreshSessions()
    }, config.enterRefreshDelayMs)
  }

  scheduleLastUserMessageCapture(sessionId: string) {
    const session = this.registry.get(sessionId)
    // Chat sessions have no tmux window to capture from; their last user
    // message is tracked by the chat driver, not the Enter-key path.
    if (!session || !isTerminalSession(session)) return
    const tmuxWindow = session.tmuxWindow

    // Set lock immediately to prevent log poller from overwriting with stale data
    // during the debounce delay (before capture completes)
    this.lastUserMessageLocks.set(tmuxWindow, Date.now() + LAST_USER_MESSAGE_LOCK_MS)

    const existing = this.lastUserMessageTimers.get(tmuxWindow)
    if (existing) {
      clearTimeout(existing)
    }
    const timer = setTimeout(() => {
      this.lastUserMessageTimers.delete(tmuxWindow)
      void this.captureLastUserMessage(tmuxWindow)
    }, config.enterRefreshDelayMs)
    this.lastUserMessageTimers.set(tmuxWindow, timer)
  }

  private async captureLastUserMessage(tmuxWindow: string) {
    try {
      const captured = await this.lastUserMessageWorker.getLastUserMessage(tmuxWindow)
      const message = captured?.trim() ? stripPastePlaceholders(captured) : ''
      if (!message || message !== captured) {
        // Empty capture, or a paste the TUI collapsed to a "[Pasted text …]"
        // placeholder: the JSONL log has the real prompt, so release the
        // Enter-key lock and let the log poller supply/upgrade the summary
        // instead of blocking it for the full lock window.
        this.lastUserMessageLocks.delete(tmuxWindow)
      }
      if (!message) return
      const record = this.db.getSessionByWindow(tmuxWindow)
      if (!record) return
      if (record.lastUserMessage === message) return
      const updated = this.db.updateSession(record.sessionId, { lastUserMessage: message })
      if (!updated) return
      this.registry.updateSession(tmuxWindow, { lastUserMessage: message })
      this.updateActiveAgentSessions()
    } catch (error) {
      this.lastUserMessageLocks.delete(tmuxWindow)
      logger.warn('last_user_message_capture_error', {
        tmuxWindow,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Log startup state for debugging orphan issues. */
  logStartupState() {
    const startupActiveSessions = this.db.getActiveSessions()
    this.seedRefreshWindowCountEstimate(startupActiveSessions.length)
    const startupWindows = this.listWindowsSyncOrNull('startup_state') ?? []
    logger.info('startup_state', {
      version: BUILD_VERSION,
      activeSessionCount: startupActiveSessions.length,
      windowCount: startupWindows.length,
      activeWindows: startupActiveSessions.map((s) => ({
        sessionId: s.sessionId.slice(0, 8),
        name: s.displayName,
        window: s.currentWindow,
      })),
      tmuxWindows: startupWindows.map((w) => ({
        tmuxWindow: w.tmuxWindow,
        name: w.name,
      })),
    })
  }

  /** Start the initial sync hydration and the periodic refresh interval. */
  start() {
    this.refreshSessionsSync() // hydrate from persisted associations without verification
    setInterval(() => this.refreshSessions(), config.refreshIntervalMs) // Async for periodic
  }

  async completeStartupVerification(): Promise<void> {
    const activeSessions = this.db.getActiveSessions()
    // Use local-only sessions for verification to prevent remote sessions
    // (whose tmuxWindow values aren't host-namespaced) from causing false
    // "window exists" decisions or incorrect hydration with local DB overlays.
    const localSessions = this.registry.getAll().filter(
      (s): s is TerminalSession => !s.remote && isTerminalSession(s)
    )
    try {
      if (activeSessions.length > 0 && localSessions.length > 0) {
        const verifications = await verifyAllSessions(
          activeSessions,
          localSessions,
          getLogSearchDirs()
        )
        const hydrated = this.hydrateSessionsWithAgentSessions(localSessions, {
          precomputedVerifications: verifications,
        })
        const withOverrides = applyForceWorkingOverrides(hydrated)
        this.registry.replaceSessions(this.mergeRemoteSessions(withOverrides))
      }
    } catch (error) {
      logger.warn('startup_verification_error', {
        message: error instanceof Error ? error.message : String(error),
      })
    }

    // Load dormant sessions after startup verification so the list reflects the
    // final active/hibernating/history split without auto-waking anything.
    this.updateDormantAgentSessions()
  }
}
