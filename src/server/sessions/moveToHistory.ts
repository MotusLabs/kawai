// Move a hibernating agent session to History: clears the pinned marker so
// the row leaves the Hibernating rail. Lifted verbatim from index.ts.
import type { ServerWebSocket } from 'bun'
import { isValidSessionId } from '../validators'
import { toAgentSession } from '../agentSessions'
import type { WSData } from '../ws/wsTypes'
import type { SessionOpsContext } from './context'

export function handleMoveToHistory(
  ctx: SessionOpsContext,
  sessionId: string,
  ws: ServerWebSocket<WSData>
) {
  if (!isValidSessionId(sessionId)) {
    ctx.send(ws, { type: 'session-move-to-history-result', sessionId, ok: false, error: 'Invalid session id' })
    return
  }

  const record = ctx.db.getSessionById(sessionId)
  if (!record) {
    ctx.send(ws, { type: 'session-move-to-history-result', sessionId, ok: false, error: 'Session not found' })
    return
  }
  if (record.currentWindow) {
    ctx.send(ws, { type: 'session-move-to-history-result', sessionId, ok: false, error: 'Session is active' })
    return
  }

  const updated = ctx.db.setPinned(sessionId, false)
  if (!updated) {
    ctx.send(ws, { type: 'session-move-to-history-result', sessionId, ok: false, error: 'Failed to move session to History' })
    return
  }

  ctx.send(ws, {
    type: 'session-move-to-history-result',
    sessionId,
    ok: true,
    session: toAgentSession(updated),
  })

  // Update all active sessions that match (in case of edge cases with multiple windows).
  for (const session of ctx.registry.getAll()) {
    if (session.agentSessionId === sessionId) {
      ctx.registry.updateSession(session.id, { isPinned: false })
    }
  }

  ctx.refresh.updateDormantAgentSessions()
}
