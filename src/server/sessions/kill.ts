// Session kill: audit-logged teardown for local managed sessions (with a
// pinned-state rollback around the tmux kill) and optimistic SSH kills for
// remote managed sessions. Lifted verbatim from index.ts.
import type { ServerWebSocket } from 'bun'
import { logger } from '../logger'
import { config } from '../config'
import { toAgentSession } from '../agentSessions'
import { isTerminalSession } from '../../shared/types'
import type { Session, SessionKillSource, AgentSession } from '../../shared/types'
import type { WSData } from '../ws/wsTypes'
import type { SessionOpsContext } from './context'

function restorePinnedState(
  ctx: SessionOpsContext,
  previousPinnedState: Map<string, boolean>
) {
  for (const [agentSessionId, isPinned] of previousPinnedState) {
    try {
      ctx.db.updateSession(agentSessionId, { isPinned })
    } catch {
      // Best effort rollback; the original failure remains the primary error.
    }
  }
}

const SESSION_KILL_SOURCES: readonly SessionKillSource[] = [
  'keyboard_shortcut',
  'session_list_context_menu',
  'terminal_confirm_modal',
  'unknown',
]

function normalizeSessionKillSource(source: unknown): SessionKillSource {
  if (
    typeof source === 'string' &&
    (SESSION_KILL_SOURCES as readonly string[]).includes(source)
  ) {
    return source as SessionKillSource
  }
  return 'unknown'
}

function getKillAuditFields(
  ws: ServerWebSocket<WSData>,
  requestedSessionId: string,
  killSource: SessionKillSource,
  session?: Session,
) {
  return {
    requestedSessionId,
    killSource,
    connectionId: ws.data.connectionId,
    remoteAddress: ws.data.remoteAddress ?? ws.remoteAddress ?? null,
    userAgent: ws.data.userAgent,
    sessionFound: Boolean(session),
    sessionId: session?.id ?? null,
    tmuxWindow: session?.tmuxWindow ?? null,
    name: session?.name ?? null,
    projectPath: session?.projectPath ?? null,
    agentSessionId: session?.agentSessionId ?? null,
    agentSessionIds: null as string[] | null,
    agentSessionName: session?.agentSessionName ?? null,
    agentType: session?.agentType ?? null,
    sessionSource: session?.source ?? null,
    host: session?.host ?? null,
    remote: session?.remote ?? null,
  }
}

function sendKillFailed(
  ctx: SessionOpsContext,
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  message: string,
  auditFields: ReturnType<typeof getKillAuditFields>,
  startedAt: number,
  reason: string,
) {
  logger.warn('session_kill_failed', {
    ...auditFields,
    reason,
    error: message,
    durationMs: Date.now() - startedAt,
  })
  ctx.send(ws, { type: 'kill-failed', sessionId, message })
}

export async function handleKill(
  ctx: SessionOpsContext,
  sessionId: string,
  ws: ServerWebSocket<WSData>,
  source?: SessionKillSource,
) {
  const startedAt = Date.now()
  const killSource = normalizeSessionKillSource(source)
  const session = ctx.registry.get(sessionId)
  let auditFields = getKillAuditFields(ws, sessionId, killSource, session)
  logger.info('session_kill_requested', auditFields)

  if (!session) {
    sendKillFailed(ctx, ws, sessionId, 'Session not found', auditFields, startedAt, 'not_found')
    return
  }
  if (!isTerminalSession(session)) {
    ctx.chatSessionManager.kill(sessionId)
    return
  }
  if (session.remote && !config.remoteAllowControl) {
    sendKillFailed(
      ctx,
      ws,
      sessionId,
      'Remote sessions are read-only',
      auditFields,
      startedAt,
      'remote_read_only',
    )
    return
  }
  if (session.remote && config.remoteAllowControl && session.host) {
    if (session.source !== 'managed') {
      sendKillFailed(
        ctx,
        ws,
        sessionId,
        'Cannot kill external remote sessions',
        auditFields,
        startedAt,
        'external_remote_session',
      )
      return
    }
    try {
      const result = await ctx.runRemoteTmux(session.host, ['kill-window', '-t', session.tmuxWindow])
      if (result.exitCode !== 0) {
        const stderr = result.stderr?.trim() ?? 'Unknown error'
        sendKillFailed(ctx, ws, sessionId, stderr, auditFields, startedAt, 'remote_kill_failed')
        return
      }
      ctx.remoteSessionNameOverrides.delete(sessionId)
      ctx.remoteSessionTombstones.set(sessionId, Date.now())
      const remaining = ctx.registry.getAll().filter((item) => item.id !== sessionId)
      ctx.registry.replaceSessions(remaining)
      logger.info('session_kill_completed', {
        ...auditFields,
        durationMs: Date.now() - startedAt,
      })
    } catch (error) {
      sendKillFailed(
        ctx,
        ws,
        sessionId,
        error instanceof Error ? error.message : 'Unable to kill remote session',
        auditFields,
        startedAt,
        'remote_kill_exception',
      )
    }
    return
  }
  if (session.source !== 'managed' && !config.allowKillExternal) {
    sendKillFailed(
      ctx,
      ws,
      sessionId,
      'Cannot kill external sessions',
      auditFields,
      startedAt,
      'external_session',
    )
    return
  }

  const recordByWindow = ctx.db.getSessionByWindow(session.tmuxWindow)
  const agentSessionIds = new Set<string>()
  if (session.agentSessionId?.trim()) {
    agentSessionIds.add(session.agentSessionId.trim())
  }
  if (recordByWindow) {
    agentSessionIds.add(recordByWindow.sessionId)
  }
  auditFields = {
    ...auditFields,
    agentSessionIds: Array.from(agentSessionIds),
  }
  const previousPinnedState = new Map<string, boolean>()

  try {
    for (const agentSessionId of agentSessionIds) {
      const current = ctx.db.getSessionById(agentSessionId)
      if (!current) continue
      previousPinnedState.set(agentSessionId, current.isPinned)
      const updated = ctx.db.updateSession(agentSessionId, { isPinned: false })
      if (!updated) {
        throw new Error('Failed to clear hibernation marker')
      }
    }
  } catch (error) {
    restorePinnedState(ctx, previousPinnedState)
    sendKillFailed(
      ctx,
      ws,
      sessionId,
      error instanceof Error ? error.message : 'Unable to prepare session kill',
      auditFields,
      startedAt,
      'prepare_failed',
    )
    return
  }

  try {
    ctx.sessionManager.killWindow(session.tmuxWindow)
  } catch (error) {
    restorePinnedState(ctx, previousPinnedState)
    sendKillFailed(
      ctx,
      ws,
      sessionId,
      error instanceof Error ? error.message : 'Unable to kill session',
      auditFields,
      startedAt,
      'kill_failed',
    )
    return
  }

  // Bump generation so any in-flight refresh discards its stale result
  ctx.refresh.noteOptimisticMutation()
  const orphaned = new Map<string, AgentSession>()
  for (const agentSessionId of agentSessionIds) {
    try {
      const orphanedSession = ctx.db.updateSession(agentSessionId, {
        currentWindow: null,
        isPinned: false,
      })
      if (orphanedSession) {
        orphaned.set(agentSessionId, toAgentSession(orphanedSession))
      }
    } catch (error) {
      logger.error('session_kill_orphan_update_failed', {
        sessionId: agentSessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (orphaned.size > 0) {
    ctx.refresh.updateDormantAgentSessions()
    for (const orphanedSession of orphaned.values()) {
      ctx.broadcast({ type: 'session-orphaned', session: orphanedSession })
    }
  }
  const remaining = ctx.registry.getAll().filter((item) => item.id !== sessionId)
  ctx.registry.replaceSessions(remaining)
  logger.info('session_kill_completed', {
    ...auditFields,
    durationMs: Date.now() - startedAt,
  })
  // Don't call ctx.refresh.refreshSessions() here — the registry is already updated
  // synchronously.  An async refresh would race with the tmux process
  // dying and could re-add the killed window to the registry before the
  // process exits, causing stale broadcasts that resurrect the session
  // on the client.  The periodic refresh handles reconciliation.
}
