// Terminal proxy lifecycle for one WebSocket connection: create, start, and
// swap the per-connection tmux client proxy (local persistent proxy or SSH
// proxy for remote sessions), plus the terminal-error reporting shared by the
// attach flow. Every await re-checks `terminalAttachSeq` (via
// isTerminalAttachCurrent) so a superseded attach never installs or keeps a
// proxy; the guards moved verbatim from index.ts.
import type { ServerWebSocket } from 'bun'
import { config } from '../config'
import { logger } from '../logger'
import { createTerminalProxy, TerminalProxyError } from '../terminal'
import type { ITerminalProxy } from '../terminal'
import { SshTerminalProxy } from '../terminal/SshTerminalProxy'
import type { Session, TerminalErrorCode } from '../../shared/types'
import type { RemoteSessionService } from '../remote/RemoteSessionService'
import type { ConnectionHub } from './ConnectionHub'
import type { WSData } from './wsTypes'

export interface TerminalProxyContext {
  hub: ConnectionHub
  /** SSH options for remote proxies and remote scrollback capture. */
  remote: Pick<RemoteSessionService, 'sshOptions' | 'captureHistoryRemote'>
}

/** Clear attach dedup state so a new/replacement proxy doesn't inherit stale history. */
export function clearAttachDedup(ws: ServerWebSocket<WSData>) {
  ws.data.lastAttachKey = null
  ws.data.lastAttachTs = 0
}

export function isTerminalAttachCurrent(ws: ServerWebSocket<WSData>, attachSeq: number): boolean {
  return ws.data.terminalAttachSeq === attachSeq
}

export function sendTerminalError(
  ctx: TerminalProxyContext,
  ws: ServerWebSocket<WSData>,
  sessionId: string | null,
  code: TerminalErrorCode,
  message: string,
  retryable: boolean
) {
  logger.warn('sending_terminal_error', {
    sessionId,
    code,
    message,
    retryable,
    connectionId: ws.data.connectionId,
  })
  ctx.hub.send(ws, {
    type: 'terminal-error',
    sessionId,
    code,
    message,
    retryable,
  })
}

export function handleTerminalError(
  ctx: TerminalProxyContext,
  ws: ServerWebSocket<WSData>,
  sessionId: string | null,
  error: unknown,
  fallbackCode: TerminalErrorCode
) {
  if (error instanceof TerminalProxyError) {
    sendTerminalError(ctx, ws, sessionId, error.code, error.message, error.retryable)
    return
  }

  const message =
    error instanceof Error ? error.message : 'Terminal operation failed'
  sendTerminalError(ctx, ws, sessionId, fallbackCode, message, true)
}

export function initializePersistentTerminal(ctx: TerminalProxyContext, ws: ServerWebSocket<WSData>) {
  if (ws.data.terminal) {
    return
  }

  const terminal = createPersistentTerminal(ctx, ws)
  ws.data.terminal = terminal

  void terminal.start().catch((error) => {
    ws.data.terminal = null
    clearAttachDedup(ws)
    handleTerminalError(ctx, ws, null, error, 'ERR_TMUX_ATTACH_FAILED')
  })
}

function createPersistentTerminal(ctx: TerminalProxyContext, ws: ServerWebSocket<WSData>) {
  const sessionName = `${config.tmuxSession}-ws-${ws.data.connectionId}`

  const terminal = createTerminalProxy({
    connectionId: ws.data.connectionId,
    sessionName,
    baseSession: config.tmuxSession,
    monitorTargets: config.terminalMonitorTargets,
    onData: (data) => {
      // Guard: ignore output from proxies that have been replaced.
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      if (!sessionId) {
        return
      }
      ctx.hub.send(ws, { type: 'terminal-output', sessionId, data })
    },
    onExit: () => {
      // Guard: skip if this proxy was already replaced (e.g. by SSH proxy)
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      ws.data.currentSessionId = null
      ws.data.currentTmuxTarget = null
      ws.data.terminal = null
      clearAttachDedup(ws)
      void terminal.dispose()
      if (ctx.hub.sockets.has(ws)) {
        sendTerminalError(
          ctx,
          ws,
          sessionId,
          'ERR_TMUX_ATTACH_FAILED',
          'tmux client exited',
          true
        )
      }
    },
  })

  return terminal
}

async function ensurePersistentTerminal(
  ctx: TerminalProxyContext,
  ws: ServerWebSocket<WSData>,
  attachSeq: number
): Promise<ITerminalProxy | null> {
  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return null
  }

  if (!ws.data.terminal) {
    const created = createPersistentTerminal(ctx, ws)
    // If a newer attach/detach arrived while creating the proxy, dispose it.
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      await created.dispose()
      return null
    }
    ws.data.terminal = created
  }

  const terminal = ws.data.terminal
  try {
    await terminal.start()
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      return null
    }
    return terminal
  } catch (error) {
    if (ws.data.terminal === terminal) {
      ws.data.terminal = null
      clearAttachDedup(ws)
    }
    throw error
  }
}

export async function ensureCorrectProxyType(
  ctx: TerminalProxyContext,
  ws: ServerWebSocket<WSData>,
  session: Session,
  attachSeq: number
): Promise<ITerminalProxy | null> {
  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return null
  }

  const needsSsh = session.remote === true && !!session.host
  const currentHost = ws.data.terminalHost

  // Same type — reuse existing proxy
  if (!needsSsh && !currentHost) {
    return ensurePersistentTerminal(ctx, ws, attachSeq)
  }
  if (needsSsh && currentHost === session.host) {
    if (ws.data.terminal) {
      const terminal = ws.data.terminal
      try {
        await terminal.start()
        if (!isTerminalAttachCurrent(ws, attachSeq)) {
          return null
        }
        return terminal
      } catch (error) {
        if (ws.data.terminal === terminal) {
          ws.data.terminal = null
          ws.data.terminalHost = null
          clearAttachDedup(ws)
        }
        throw error
      }
    }
  }

  // Type mismatch — dispose old proxy and create new one
  if (ws.data.terminal) {
    const oldTerminal = ws.data.terminal
    // Clear references BEFORE dispose so the onExit guard sees the proxy was replaced
    // (dispose triggers process exit → onExit callback, which checks ws.data.terminal !== terminal)
    if (isTerminalAttachCurrent(ws, attachSeq) && ws.data.terminal === oldTerminal) {
      ws.data.terminal = null
      ws.data.terminalHost = null
      ws.data.currentSessionId = null
      ws.data.currentTmuxTarget = null
      clearAttachDedup(ws)
    }
    await oldTerminal.dispose()
  }

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return null
  }

  if (needsSsh) {
    return createAndStartSshProxy(ctx, ws, session.host!, attachSeq)
  } else {
    return ensurePersistentTerminal(ctx, ws, attachSeq)
  }
}

async function createAndStartSshProxy(
  ctx: TerminalProxyContext,
  ws: ServerWebSocket<WSData>,
  host: string,
  attachSeq: number
): Promise<ITerminalProxy | null> {
  const sshOptions = ctx.remote.sshOptions()
  const sessionName = `${config.tmuxSession}-ws-${ws.data.connectionId}`

  const terminal = new SshTerminalProxy({
    connectionId: ws.data.connectionId,
    sessionName,
    baseSession: '', // not used for SSH standalone sessions
    host,
    sshOptions,
    commandTimeoutMs: config.remoteTimeoutMs,
    onData: (data) => {
      // Guard: ignore output from proxies that have been replaced.
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      if (!sessionId) return
      ctx.hub.send(ws, { type: 'terminal-output', sessionId, data })
    },
    onExit: () => {
      // Guard: skip if this proxy was already replaced
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      logger.warn('ssh_proxy_onExit', {
        sessionName,
        sessionId,
        host,
        connectionId: ws.data.connectionId,
      })
      ws.data.currentSessionId = null
      ws.data.currentTmuxTarget = null
      ws.data.terminal = null
      ws.data.terminalHost = null
      clearAttachDedup(ws)
      void terminal.dispose()
      if (ctx.hub.sockets.has(ws)) {
        sendTerminalError(ctx, ws, sessionId, 'ERR_TMUX_ATTACH_FAILED', 'SSH tmux client exited', true)
      }
    },
  })

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    await terminal.dispose()
    return null
  }

  ws.data.terminal = terminal
  ws.data.terminalHost = host

  try {
    await terminal.start()
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      await terminal.dispose()
      return null
    }
    if (ws.data.terminal !== terminal) {
      // Another attach request replaced this proxy while it was starting.
      await terminal.dispose()
      return null
    }
    return terminal
  } catch (error) {
    if (ws.data.terminal === terminal) {
      ws.data.terminal = null
      ws.data.terminalHost = null
      clearAttachDedup(ws)
    }
    throw error
  }
}
