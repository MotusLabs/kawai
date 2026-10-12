// Session rename: local managed windows rename via tmux, chat sessions take
// free text (chat-session-naming design D5), dormant agent sessions rename in
// the DB, and remote managed windows rename optimistically over SSH. Lifted
// verbatim from index.ts.
import type { ServerWebSocket } from 'bun'
import { config } from '../config'
import { isTerminalSession } from '../../shared/types'
import type { WSData } from '../ws/wsTypes'
import type { SessionOpsContext } from './context'

export async function handleRename(
  ctx: SessionOpsContext,
  sessionId: string,
  newName: string,
  ws: ServerWebSocket<WSData>
) {
  let session = ctx.registry.get(sessionId)
  if (!session) {
    ctx.refresh.refreshSessionsSync() // Use sync for inline operations needing immediate results
    session = ctx.registry.get(sessionId)
    if (!session) {
      const record = ctx.db.getSessionById(sessionId)
      if (record && !record.currentWindow) {
        const trimmed = newName.trim()
        if (!trimmed) {
          ctx.send(ws, { type: 'error', message: 'Name cannot be empty' })
          return
        }
        if (!/^[\w-]+$/.test(trimmed)) {
          ctx.send(ws, {
            type: 'error',
            message: 'Name can only contain letters, numbers, hyphens, and underscores',
          })
          return
        }
        if (ctx.db.displayNameExists(trimmed, sessionId)) {
          ctx.send(ws, { type: 'error', message: 'Name already exists' })
          return
        }
        const updated = ctx.db.updateSession(sessionId, { displayName: trimmed })
        if (!updated) {
          ctx.send(ws, { type: 'error', message: 'Unable to rename session' })
          return
        }
        ctx.refresh.updateDormantAgentSessions()
        return
      }
      ctx.send(ws, { type: 'error', message: 'Session not found' })
      return
    }
  }
  if (!isTerminalSession(session)) {
    // Chat names are free text (chat-session-naming design D5): a chat session
    // has no tmux window to name, and generated titles carry spaces and
    // punctuation the terminal `[\w-]+` rule would reject.
    const trimmed = newName.trim()
    if (!trimmed) {
      ctx.send(ws, { type: 'error', message: 'Name cannot be empty' })
      return
    }
    const result = ctx.chatSessionManager.rename(sessionId, trimmed)
    if (!result.ok) {
      ctx.send(ws, { type: 'error', message: result.error })
    }
    return
  }
  if (session.remote && !config.remoteAllowControl) {
    ctx.send(ws, { type: 'error', message: 'Remote sessions are read-only' })
    return
  }
  if (session.remote && config.remoteAllowControl && session.host) {
    if (session.source !== 'managed') {
      ctx.send(ws, { type: 'error', message: 'Cannot rename external remote sessions' })
      return
    }
    const trimmed = newName.trim()
    if (!trimmed) {
      ctx.send(ws, { type: 'error', message: 'Name cannot be empty' })
      return
    }
    if (!/^[\w-]+$/.test(trimmed)) {
      ctx.send(ws, { type: 'error', message: 'Name can only contain letters, numbers, hyphens, and underscores' })
      return
    }
    try {
      const result = await ctx.runRemoteTmux(session.host, ['rename-window', '-t', session.tmuxWindow, trimmed])
      if (result.exitCode !== 0) {
        const stderr = result.stderr?.trim() ?? 'Unknown error'
        ctx.send(ws, { type: 'error', message: stderr })
        return
      }
      ctx.remoteSessionNameOverrides.set(sessionId, { name: trimmed, setAt: Date.now() })
      const currentSessions = ctx.registry.getAll()
      const nextSessions = currentSessions.map((item) =>
        item.id === sessionId ? { ...item, name: trimmed } : item
      )
      ctx.registry.replaceSessions(nextSessions)
    } catch (error) {
      ctx.send(ws, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Unable to rename remote session',
      })
    }
    return
  }

  try {
    ctx.sessionManager.renameWindow(session.tmuxWindow, newName)
    ctx.refresh.refreshSessions()
  } catch (error) {
    ctx.send(ws, {
      type: 'error',
      message:
        error instanceof Error ? error.message : 'Unable to rename session',
    })
  }
}
