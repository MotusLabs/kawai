// Session wake: resume a hibernated agent session by rematching it to a live
// window or recreating one from the stored resume command. The claim-race
// branches (atomic claimCurrentWindow with reread verification, created-window
// cleanup, and the wakeInFlight set) are load-bearing race fixes and moved
// verbatim from index.ts.
import type { ServerWebSocket } from 'bun'
import { logger } from '../logger'
import { config } from '../config'
import { toAgentSession } from '../agentSessions'
import { getLogSearchDirs } from '../logDiscovery'
import { DEFAULT_SCROLLBACK_LINES, matchWindowsToLogsByExactRgAsync } from '../logmatch'
import { isValidSessionId } from '../validators'
import { isTerminalSession } from '../../shared/types'
import type { ClientMessage, TerminalSession, WakeError } from '../../shared/types'
import type { AgentSessionRecord, ClaimCurrentWindowPatch } from '../db'
import { revalidateRematchTarget } from '../sessionWake/rematchTarget'
import { readTmuxCapture } from '../tmuxCapture'
import { stampLocalSession } from '../sessionStamp'
import type { WSData } from '../ws/wsTypes'
import { buildResumeCommand, validateWakeTemplate } from './resumeCommand'
import type { SessionOpsContext } from './context'

const wakeInFlight = new Set<string>()

function recordWakeFailure(ctx: SessionOpsContext, sessionId: string, message: string) {
  try {
    ctx.db.updateSession(sessionId, {
      lastResumeError: message,
      wakeStartedAt: null,
    })
    ctx.refresh.updateDormantAgentSessions()
  } catch (error) {
    logger.error('session_wake_error_persist_failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function hydrateWakeSession(
  session: TerminalSession,
  record: AgentSessionRecord
): TerminalSession {
  return stampLocalSession({
    ...session,
    agentType: session.agentType ?? record.agentType,
    agentSessionId: record.sessionId,
    agentSessionName: record.displayName,
    logFilePath: record.logFilePath,
    lastUserMessage: record.lastUserMessage ?? session.lastUserMessage,
    lastActivity: record.lastActivityAt,
    createdAt: record.createdAt,
    isPinned: record.isPinned,
  })
}

async function tryRematchDormantSession(
  ctx: SessionOpsContext,
  record: AgentSessionRecord
): Promise<{ session: TerminalSession; record: AgentSessionRecord } | null> {
  ctx.refresh.refreshSessionsSync()

  const alreadyHydrated = ctx.registry.getAll().find(
    (session): session is TerminalSession =>
      isTerminalSession(session) &&
      !session.remote &&
      (session.agentSessionId?.trim() === record.sessionId ||
        session.logFilePath === record.logFilePath)
  )
  if (alreadyHydrated) {
    const claimExtra: ClaimCurrentWindowPatch = {
      displayName: alreadyHydrated.name,
      lastResumeError: null,
      wakeStartedAt: null,
    }
    if (alreadyHydrated.command && !record.launchCommand) {
      claimExtra.launchCommand = alreadyHydrated.command
    }
    const updated = ctx.db.claimCurrentWindow(
      record.sessionId,
      alreadyHydrated.tmuxWindow,
      claimExtra
    )
    if (!updated) {
      return null
    }
    const hydrated = hydrateWakeSession(alreadyHydrated, updated)
    ctx.registry.replaceSessions(
      ctx.registry.getAll().map((session) =>
        session.id === hydrated.id ? hydrated : session
      )
    )
    ctx.refresh.updateDormantAgentSessions()
    return { session: hydrated, record: updated }
  }

  if (!record.logFilePath) {
    return null
  }

  const claimedWindows = new Set(
    ctx.db.getActiveSessions()
      .map((session) => session.currentWindow)
      .filter(Boolean) as string[]
  )
  const candidates = ctx.registry
    .getAll()
    .filter(
      (session): session is TerminalSession =>
        isTerminalSession(session) &&
        !session.remote &&
        !claimedWindows.has(session.tmuxWindow)
    )
  if (candidates.length === 0) {
    return null
  }

  try {
    // Paced async variant (design D4): the wake path runs on the main thread,
    // so its scrollback captures must interleave with interactive traffic
    // instead of monopolizing the tmux server for the whole burst.
    const result = await matchWindowsToLogsByExactRgAsync(
      candidates,
      getLogSearchDirs(),
      DEFAULT_SCROLLBACK_LINES,
      {
        logPaths: [record.logFilePath],
        rgThreads: config.rgThreads,
        interWindowYieldMs: config.logMatchYieldMs,
      }
    )
    const match = result.matches.get(record.logFilePath)
    if (!match) {
      return null
    }
    // Matching yields between windows. Recheck tmux and fetch current registry
    // data before claiming: the captured candidate may have exited or changed.
    const current = await revalidateRematchTarget(
      match,
      (target) => readTmuxCapture(['display-message', '-p', '-t', target, '#{window_id}']),
      (id) => ctx.registry.get(id),
    )
    if (!current) return null
    const claimExtra: ClaimCurrentWindowPatch = {
      displayName: current.name,
      lastResumeError: null,
      wakeStartedAt: null,
    }
    if (current.command && !record.launchCommand) {
      claimExtra.launchCommand = current.command
    }
    const updated = ctx.db.claimCurrentWindow(record.sessionId, current.tmuxWindow, claimExtra)
    if (!updated) {
      return null
    }
    const hydrated = hydrateWakeSession(current, updated)
    ctx.registry.replaceSessions(
      ctx.registry.getAll().map((session) =>
        session.id === hydrated.id ? hydrated : session
      )
    )
    ctx.refresh.updateDormantAgentSessions()
    logger.info('session_wake_rematch_success', {
      sessionId: record.sessionId,
      window: match.tmuxWindow,
      displayName: match.name,
    })
    return { session: hydrated, record: updated }
  } catch (error) {
    logger.warn('session_wake_rematch_failed', {
      sessionId: record.sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

export async function handleSessionWake(
  ctx: SessionOpsContext,
  message: Extract<ClientMessage, { type: 'session-wake' }>,
  ws: ServerWebSocket<WSData>
) {
  const sessionId = message.sessionId
  if (!isValidSessionId(sessionId)) {
    logger.warn('session_wake_failed', { sessionId, reason: 'invalid_id' })
    const error: WakeError = {
      code: 'NOT_FOUND',
      message: 'Invalid session id',
    }
    ctx.send(ws, { type: 'session-wake-result', sessionId, ok: false, error })
    return
  }

  const record = ctx.db.getSessionById(sessionId)
  if (!record) {
    logger.warn('session_wake_failed', { sessionId, reason: 'not_found' })
    const error: WakeError = { code: 'NOT_FOUND', message: 'Session not found' }
    ctx.send(ws, { type: 'session-wake-result', sessionId, ok: false, error })
    return
  }

  if (record.currentWindow) {
    // Idempotent ack when the session is already live AND we can confirm it
    // in the registry — protects against stale messages from a reconnect
    // storm. If the registry doesn't know about it we fall through to the
    // error so the client can refresh rather than silently trusting stale DB.
    const liveSession =
      ctx.registry.get(record.currentWindow) ??
      ctx.registry.getAll().find((session) => session.agentSessionId?.trim() === sessionId)
    if (liveSession) {
      if (record.wakeStartedAt || record.lastResumeError) {
        try {
          ctx.db.updateSession(sessionId, {
            wakeStartedAt: null,
            lastResumeError: null,
          })
          ctx.refresh.updateDormantAgentSessions()
        } catch (error) {
          logger.warn('session_wake_marker_clear_failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      logger.info('session_wake_noop', {
        sessionId,
        agentType: record.agentType,
        displayName: record.displayName,
      })
      ctx.send(ws, { type: 'session-wake-result', sessionId, ok: true, session: liveSession })
      return
    }
    logger.warn('session_wake_failed', { sessionId, reason: 'already_active_stale_registry' })
    const error: WakeError = {
      code: 'ALREADY_ACTIVE',
      message: 'Session is already active',
    }
    ctx.send(ws, { type: 'session-wake-result', sessionId, ok: false, error })
    return
  }

  if (wakeInFlight.has(sessionId)) {
    logger.info('session_wake_noop', {
      sessionId,
      reason: 'wake_in_flight',
      agentType: record.agentType,
      displayName: record.displayName,
    })
    const error: WakeError = {
      code: 'WAKE_IN_PROGRESS',
      message: 'Wake already in progress for this session',
    }
    ctx.send(ws, { type: 'session-wake-result', sessionId, ok: false, error })
    return
  }

  wakeInFlight.add(sessionId)
  let createdWindowToCleanup: string | null = null

  try {
    const latest = ctx.db.getSessionById(sessionId) ?? record
    if (latest.currentWindow) {
      const liveSession =
        ctx.registry.get(latest.currentWindow) ??
        ctx.registry.getAll().find((session) => session.agentSessionId?.trim() === sessionId)
      if (liveSession) {
        ctx.send(ws, { type: 'session-wake-result', sessionId, ok: true, session: liveSession })
        return
      }
    }

    const rematched = await tryRematchDormantSession(ctx, latest)
    if (rematched) {
      ctx.send(ws, { type: 'session-wake-result', sessionId, ok: true, session: rematched.session })
      ctx.broadcast({
        type: 'session-activated',
        session: toAgentSession(rematched.record),
        window: rematched.session.tmuxWindow,
      })
      return
    }

    const templateError = validateWakeTemplate(latest)
    if (templateError) {
      logger.error('session_wake_failed', {
        sessionId,
        reason: 'bad_template',
        agentType: latest.agentType,
      })
      recordWakeFailure(ctx, sessionId, templateError.message)
      ctx.send(ws, { type: 'session-wake-result', sessionId, ok: false, error: templateError })
      return
    }

    const command = buildResumeCommand(latest)
    const projectPath =
      latest.projectPath ||
      process.env.HOME ||
      process.env.USERPROFILE ||
      '.'
    const wakeStartedAt = new Date().toISOString()
    const marked = ctx.db.updateSession(sessionId, {
      wakeStartedAt,
      lastResumeError: null,
    })
    if (!marked) {
      throw new Error('Session not found')
    }

    const startedAt = Date.now()
    // Name is driven by the stored displayName—createWindow will auto-suffix
    // on genuine collisions with other live sessions (excludeSessionId keeps
    // the session's own prior name from matching itself).
    const created = stampLocalSession(ctx.sessionManager.createWindow(
      projectPath,
      latest.displayName,
      command,
      { excludeSessionId: sessionId }
    ))
    createdWindowToCleanup = created.tmuxWindow
    // Atomic claim: only persist the new window if no other writer (LogPoller
    // rematch, concurrent wake) claimed current_window between our initial
    // read and createWindow. If the claim fails, kill the new window so we
    // don't leak a tmux window with a duplicate agent process.
    const updatedRecord = ctx.db.claimCurrentWindow(sessionId, created.tmuxWindow, {
      displayName: created.name,
      lastResumeError: null,
      wakeStartedAt: null,
    })
    if (!updatedRecord) {
      const reread = ctx.db.getSessionById(sessionId)
      if (reread?.currentWindow === created.tmuxWindow) {
        const resolvedRecord =
          reread.wakeStartedAt || reread.lastResumeError
            ? ctx.db.updateSession(sessionId, {
                wakeStartedAt: null,
                lastResumeError: null,
              }) ?? reread
            : reread
        createdWindowToCleanup = null
        ctx.refresh.noteOptimisticMutation()
        const hydrated = hydrateWakeSession(created, resolvedRecord)
        const currentSessions = ctx.registry
          .getAll()
          .filter((session) =>
            session.id !== hydrated.id &&
            session.tmuxWindow !== hydrated.tmuxWindow
          )
        ctx.registry.replaceSessions([hydrated, ...currentSessions])
        ctx.refresh.updateDormantAgentSessions()
        ctx.refresh.refreshSessions()
        ctx.send(ws, { type: 'session-wake-result', sessionId, ok: true, session: hydrated })
        ctx.broadcast({
          type: 'session-activated',
          session: toAgentSession(resolvedRecord),
          window: hydrated.tmuxWindow,
        })
        logger.info('session_wake_success', {
          sessionId,
          reason: 'window_claimed_concurrently',
          agentType: latest.agentType,
          displayName: latest.displayName,
          tmuxWindow: created.tmuxWindow,
          durationMs: Date.now() - startedAt,
        })
        return
      }

      const ownerOfCreatedWindow = ctx.db.getSessionByWindow(created.tmuxWindow)
      if (ownerOfCreatedWindow && ownerOfCreatedWindow.sessionId !== sessionId) {
        createdWindowToCleanup = null
        try {
          ctx.db.updateSession(sessionId, { wakeStartedAt: null })
        } catch (error) {
          logger.warn('session_wake_marker_clear_failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        ctx.refresh.refreshSessionsSync()
        ctx.refresh.updateDormantAgentSessions()
        logger.info('session_wake_noop', {
          sessionId,
          reason: 'created_window_claimed_by_other_session',
          claimedBySessionId: ownerOfCreatedWindow.sessionId,
          agentType: latest.agentType,
          displayName: latest.displayName,
          tmuxWindow: created.tmuxWindow,
        })
        const err: WakeError = {
          code: 'WAKE_IN_PROGRESS',
          message: 'Wake window was claimed by another session; retry shortly',
        }
        ctx.send(ws, { type: 'session-wake-result', sessionId, ok: false, error: err })
        return
      }

      try { ctx.sessionManager.killWindow(created.tmuxWindow) } catch { /* may already be gone */ }
      createdWindowToCleanup = null
      try {
        ctx.db.updateSession(sessionId, { wakeStartedAt: null })
      } catch (error) {
        logger.warn('session_wake_marker_clear_failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      // Sync refresh so the registry reflects the racing claim before we look
      // up the live session — the rematcher updates DB before its own
      // session-activated emission, so without this we may miss it.
      ctx.refresh.refreshSessionsSync()
      const latestRecord = ctx.db.getSessionById(sessionId)
      const liveSession = latestRecord?.currentWindow
        ? ctx.registry.get(latestRecord.currentWindow) ??
          ctx.registry.getAll().find((s) => s.agentSessionId?.trim() === sessionId)
        : undefined
      logger.info('session_wake_noop', {
        sessionId,
        reason: 'window_claimed_concurrently',
        agentType: latest.agentType,
        displayName: latest.displayName,
      })
      if (liveSession) {
        ctx.send(ws, { type: 'session-wake-result', sessionId, ok: true, session: liveSession })
      } else {
        // Claim was lost but we can't surface the racing session yet — return
        // an error so the client toasts and the user can retry instead of
        // silently doing nothing.
        const err: WakeError = {
          code: 'WAKE_IN_PROGRESS',
          message: 'Wake raced with another claim; retry shortly',
        }
        ctx.send(ws, { type: 'session-wake-result', sessionId, ok: false, error: err })
      }
      return
    }
    createdWindowToCleanup = null
    // Add session to registry immediately so terminal can attach
    // (async refresh will update with any additional data later)
    ctx.refresh.noteOptimisticMutation()
    const currentSessions = ctx.registry.getAll()
    const hydrated = hydrateWakeSession(created, updatedRecord)
    ctx.registry.replaceSessions([hydrated, ...currentSessions])
    ctx.refresh.updateDormantAgentSessions()
    ctx.refresh.refreshSessions()
    ctx.send(ws, { type: 'session-wake-result', sessionId, ok: true, session: hydrated })
    ctx.broadcast({
      type: 'session-activated',
      session: toAgentSession(updatedRecord),
      window: hydrated.tmuxWindow,
    })
    logger.info('session_wake_success', {
      sessionId,
      agentType: latest.agentType,
      displayName: latest.displayName,
      tmuxWindow: created.tmuxWindow,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    if (createdWindowToCleanup) {
      try {
        ctx.sessionManager.killWindow(createdWindowToCleanup)
      } catch (cleanupError) {
        logger.warn('session_wake_cleanup_failed', {
          sessionId,
          tmuxWindow: createdWindowToCleanup,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        })
      }
    }
    const message =
      error instanceof Error ? error.message : 'Unable to wake session'
    // Persist the failure reason so every tab sees an error badge via the
    // normal agent-sessions broadcast, not just the tab that triggered the
    // wake. Hibernating sessions stay in the Hibernating rail.
    recordWakeFailure(ctx, sessionId, message)
    logger.error('session_wake_failed', {
      sessionId,
      reason: 'create_window_failed',
      agentType: record.agentType,
      error: message,
    })
    const err: WakeError = { code: 'WAKE_FAILED', message }
    ctx.send(ws, { type: 'session-wake-result', sessionId, ok: false, error: err })
  } finally {
    wakeInFlight.delete(sessionId)
  }
}
