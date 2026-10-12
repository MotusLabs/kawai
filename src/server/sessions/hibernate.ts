// Session hibernate: pin the agent-session row, kill the live window, and
// move the session into the Hibernating rail — with marker rollback when the
// kill fails and an idempotent ack for already-hibernating sessions. Lifted
// verbatim from index.ts.
import type { ServerWebSocket } from 'bun'
import { logger } from '../logger'
import { isValidSessionId } from '../validators'
import { toAgentSession } from '../agentSessions'
import { isTerminalSession } from '../../shared/types'
import type { AgentSessionRecord } from '../db'
import type { WSData } from '../ws/wsTypes'
import type { SessionOpsContext } from './context'

export function handleSessionHibernate(
  ctx: SessionOpsContext,
  sessionId: string,
  ws: ServerWebSocket<WSData>
) {
  if (!isValidSessionId(sessionId)) {
    logger.warn('session_hibernate_failed', { sessionId, reason: 'invalid_id' })
    ctx.send(ws, { type: 'session-hibernate-result', sessionId, ok: false, error: 'Invalid session id' })
    return
  }

  const record = ctx.db.getSessionById(sessionId)
  if (!record) {
    logger.warn('session_hibernate_failed', { sessionId, reason: 'not_found' })
    ctx.send(ws, { type: 'session-hibernate-result', sessionId, ok: false, error: 'Session not found' })
    return
  }

  // Idempotent ack: already hibernating. A reconnect-storm replay or a double
  // click shouldn't surface a spurious error to the user.
  if (record.isPinned && !record.currentWindow) {
    logger.info('session_hibernate_noop', {
      sessionId,
      agentType: record.agentType,
      displayName: record.displayName,
    })
    ctx.send(ws, {
      type: 'session-hibernate-result',
      sessionId,
      ok: true,
      session: toAgentSession(record),
    })
    return
  }

  if (!record.currentWindow) {
    logger.warn('session_hibernate_failed', { sessionId, reason: 'not_active' })
    ctx.send(ws, { type: 'session-hibernate-result', sessionId, ok: false, error: 'Session is not active' })
    return
  }

  const liveSession =
    ctx.registry.get(record.currentWindow) ??
    ctx.registry.getAll().find((session) => session.agentSessionId?.trim() === sessionId)

  if (
    !liveSession ||
    !isTerminalSession(liveSession) ||
    liveSession.remote ||
    liveSession.source !== 'managed'
  ) {
    logger.warn('session_hibernate_failed', {
      sessionId,
      reason: 'not_local_managed',
      agentType: record.agentType,
    })
    ctx.send(ws, {
      type: 'session-hibernate-result',
      sessionId,
      ok: false,
      error: 'Only local managed sessions can be hibernated',
    })
    return
  }

  const originalMarker = record.isPinned
  const originalResumeError = record.lastResumeError
  const liveTmuxWindow = liveSession.tmuxWindow
  const markerPatch: Partial<Omit<AgentSessionRecord, 'id' | 'sessionId'>> = {
    isPinned: true,
    lastResumeError: null,
  }
  if (liveSession.command && !record.launchCommand) {
    markerPatch.launchCommand = liveSession.command
  }
  const startedAt = Date.now()
  let marked: ReturnType<typeof ctx.db.updateSession>
  try {
    marked = ctx.db.updateSession(sessionId, markerPatch)
  } catch (error) {
    logger.error('session_hibernate_failed', {
      sessionId,
      reason: 'db_marker_update_failed',
      agentType: record.agentType,
      error: error instanceof Error ? error.message : String(error),
    })
    ctx.send(ws, {
      type: 'session-hibernate-result',
      sessionId,
      ok: false,
      error: 'Failed to update session state',
    })
    return
  }
  if (!marked) {
    logger.error('session_hibernate_failed', {
      sessionId,
      reason: 'db_marker_update_failed',
      agentType: record.agentType,
    })
    ctx.send(ws, {
      type: 'session-hibernate-result',
      sessionId,
      ok: false,
      error: 'Failed to update session state',
    })
    return
  }

  try {
    ctx.sessionManager.killWindow(liveTmuxWindow)
  } catch (error) {
    let targetStillExists = true
    try {
      targetStillExists = ctx.sessionManager
        .listWindows()
        .some((session) => session.tmuxWindow === liveTmuxWindow)
    } catch (listError) {
      logger.warn('session_hibernate_recheck_failed', {
        sessionId,
        tmuxWindow: liveTmuxWindow,
        killError: error instanceof Error ? error.message : String(error),
        listError: listError instanceof Error ? listError.message : String(listError),
      })
    }

    if (!targetStillExists) {
      logger.info('session_hibernate_target_already_gone', {
        sessionId,
        agentType: record.agentType,
        displayName: record.displayName,
        tmuxWindow: liveTmuxWindow,
      })
    } else {
      try {
        ctx.db.updateSession(sessionId, {
          isPinned: originalMarker,
          lastResumeError: originalResumeError,
          launchCommand: record.launchCommand,
        })
      } catch {
        // Best effort rollback; preserve the original kill failure for the user.
      }
      const message = error instanceof Error ? error.message : 'Unable to hibernate session'
      logger.error('session_hibernate_failed', {
        sessionId,
        reason: 'kill_failed',
        error: message,
        agentType: record.agentType,
      })
      ctx.send(ws, {
        type: 'session-hibernate-result',
        sessionId,
        ok: false,
        error: message,
      })
      return
    }
  }

  ctx.refresh.noteOptimisticMutation()
  let updated: ReturnType<typeof ctx.db.updateSession>
  try {
    updated = ctx.db.updateSession(sessionId, {
      currentWindow: null,
      isPinned: true,
      lastResumeError: null,
    })
  } catch (error) {
    logger.error('session_hibernate_failed', {
      sessionId,
      reason: 'db_update_failed',
      error: error instanceof Error ? error.message : String(error),
      agentType: record.agentType,
    })
    ctx.send(ws, { type: 'session-hibernate-result', sessionId, ok: false, error: 'Failed to update session state' })
    return
  }
  if (!updated) {
    logger.error('session_hibernate_failed', {
      sessionId,
      reason: 'db_update_failed',
      agentType: record.agentType,
    })
    ctx.send(ws, { type: 'session-hibernate-result', sessionId, ok: false, error: 'Failed to update session state' })
    return
  }

  logger.info('session_hibernate_success', {
    sessionId,
    agentType: record.agentType,
    displayName: record.displayName,
    tmuxWindow: liveTmuxWindow,
    durationMs: Date.now() - startedAt,
  })

  ctx.send(ws, {
    type: 'session-hibernate-result',
    sessionId,
    ok: true,
    session: toAgentSession(updated),
  })

  const remaining = ctx.registry.getAll().filter((session) => session.id !== liveSession.id)
  ctx.registry.replaceSessions(remaining)
  ctx.refresh.updateDormantAgentSessions()
}
