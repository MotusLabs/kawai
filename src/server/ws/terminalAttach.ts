// Terminal attach/detach and input routing for one WebSocket connection:
// resolves the session, swaps the proxy (see terminalProxy), captures and
// streams the visible scrollback in congestion-window-sized chunks, then
// acknowledges with terminal-ready; also forwards input/paste/resize to the
// attached proxy and arms the clipboard watch on mouse selections. The
// per-socket `terminalAttachSeq` guard and the attach dedup window are
// load-bearing race fixes and moved verbatim from index.ts.
import type { ServerWebSocket } from 'bun'
import { config } from '../config'
import { logger } from '../logger'
import type { ITerminalProxy } from '../terminal'
import { normalizeCapturedHistory } from '../terminal/tmuxText'
import { isTerminalSession } from '../../shared/types'
import type { ClientMessage } from '../../shared/types'
import type { SessionRegistry } from '../SessionRegistry'
import type { SessionRefreshLoop } from '../refresh/SessionRefreshLoop'
import { readTmuxCapture } from '../tmuxCapture'
import { isValidSessionId, isValidTmuxTarget } from '../validators'
import {
  CLIPBOARD_BUFFER_ARM_MS,
  containsClipboardArmingMouseInput,
  startClipboardBufferWatch,
  stopClipboardBufferWatch,
  type ClipboardWatchContext,
} from './clipboardWatch'
import {
  clearAttachDedup,
  ensureCorrectProxyType,
  handleTerminalError,
  isTerminalAttachCurrent,
  sendTerminalError,
  type TerminalProxyContext,
} from './terminalProxy'
import type { WSData } from './wsTypes'

export interface TerminalAttachContext extends TerminalProxyContext {
  registry: SessionRegistry
  refresh: SessionRefreshLoop
  clipboard: ClipboardWatchContext
}

export async function attachTerminalPersistent(
  ctx: TerminalAttachContext,
  ws: ServerWebSocket<WSData>,
  message: Extract<ClientMessage, { type: 'terminal-attach' }>,
  attachSeq: number
) {
  const { sessionId, tmuxTarget, cols, rows } = message

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return
  }

  if (!isValidSessionId(sessionId)) {
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ctx, ws, sessionId, 'ERR_INVALID_WINDOW', 'Invalid session id', false)
    }
    return
  }

  const session = ctx.registry.get(sessionId)
  if (!session) {
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ctx, ws, sessionId, 'ERR_INVALID_WINDOW', 'Session not found', false)
    }
    return
  }
  // Chat sessions have no tmux window to attach a terminal to; the client
  // renders ChatView for them and never sends terminal-attach, but refuse
  // cleanly if one arrives (e.g. stale tab).
  if (!isTerminalSession(session)) {
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ctx, ws, sessionId, 'ERR_INVALID_WINDOW', 'Chat sessions have no terminal', false)
    }
    return
  }
  if (session.remote && !config.remoteAllowAttach) {
    const host = session.host ? ` on ${session.host}` : ''
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ctx, ws, sessionId, 'ERR_INVALID_WINDOW', `Remote session${host} is read-only`, false)
    }
    return
  }
  stopClipboardBufferWatch(ws)

  const target = tmuxTarget ?? session.tmuxWindow
  if (!isValidTmuxTarget(target)) {
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ctx, ws, sessionId, 'ERR_INVALID_WINDOW', 'Invalid tmux target', false)
    }
    return
  }

  const t0 = performance.now()

  let terminal: ITerminalProxy | null = null
  try {
    terminal = await ensureCorrectProxyType(ctx, ws, session, attachSeq)
    if (!terminal) return
  } catch (error) {
    if (ctx.hub.sockets.has(ws) && isTerminalAttachCurrent(ws, attachSeq)) {
      handleTerminalError(ctx, ws, sessionId, error, 'ERR_TMUX_ATTACH_FAILED')
    }
    return
  }

  const tProxy = performance.now()

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return
  }

  if (typeof cols === 'number' && typeof rows === 'number') {
    terminal.resize(cols, rows)
  }

  const effectiveTarget = terminal.ensureEffectiveTarget(target)

  // Deduplicate rapid re-attaches to the same session+target (e.g. two
  // terminal-attach messages arriving within ~34ms).  Skip the expensive
  // scrollback capture and just acknowledge readiness.
  const attachKey = `${sessionId}:${effectiveTarget}`
  const now = performance.now()
  const ATTACH_DEDUP_MS = 500

  if (ws.data.lastAttachKey === attachKey &&
      now - ws.data.lastAttachTs < ATTACH_DEDUP_MS) {
    logger.debug('terminal_attach_dedup', {
      sessionId, target, effectiveTarget, attachSeq,
      elapsedMs: Math.round(now - ws.data.lastAttachTs),
      connectionId: ws.data.connectionId,
    })
    try {
      await terminal.switchTo(target)
      if (!isTerminalAttachCurrent(ws, attachSeq)) {
        return
      }
      ws.data.currentSessionId = sessionId
      ws.data.currentTmuxTarget = effectiveTarget
      startClipboardBufferWatch(ctx.clipboard, ws, sessionId, session)
      ctx.hub.send(ws, { type: 'terminal-ready', sessionId })
    } catch (error) {
      if (ctx.hub.sockets.has(ws) && isTerminalAttachCurrent(ws, attachSeq)) {
        handleTerminalError(ctx, ws, sessionId, error, 'ERR_TMUX_SWITCH_FAILED')
      }
    }
    return
  }

  // Capture scrollback history BEFORE switching to avoid race with live output
  const history = session.remote && session.host
    ? await ctx.remote.captureHistoryRemote(effectiveTarget, session.host)
    : await captureTmuxHistory(effectiveTarget)

  const tCapture = performance.now()

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return
  }

  try {
    await terminal.switchTo(target, () => {
      if (!isTerminalAttachCurrent(ws, attachSeq)) return
      ws.data.currentSessionId = sessionId
      ws.data.currentTmuxTarget = effectiveTarget
      // Send history in chunks sized to fit TCP's initial congestion window
      // (~14.6KB). On high-latency connections (5G/Tailscale), the first chunk
      // arrives before slow start ramps up, letting the client render partial
      // content immediately instead of waiting for the full payload.
      if (history) {
        const HISTORY_CHUNK_SIZE = 12_000
        const tStr = performance.now()
        let totalBytes = 0
        let chunks = 0
        for (let offset = 0; offset < history.length; offset += HISTORY_CHUNK_SIZE) {
          const chunk = history.slice(offset, offset + HISTORY_CHUNK_SIZE)
          // Routed through send() so history chunks join the coalesced output
          // stream; the terminal-ready acknowledgement drains them first.
          ctx.hub.send(ws, { type: 'terminal-output', sessionId, data: chunk })
          totalBytes += Buffer.byteLength(chunk, 'utf8')
          chunks += 1
        }
        const stringifyMs = Math.round(performance.now() - tStr)
        logger.debug('terminal_history_send', {
          sessionId,
          stringifyMs,
          payloadBytes: totalBytes,
          historyChars: history.length,
          chunks,
          connectionId: ws.data.connectionId,
        })
      }
    })
    // Yield to flush WebSocket buffers immediately after sending history.
    // Without this, Bun buffers the ws.send() data and doesn't flush until
    // the event loop is free — which can be seconds if other sync work follows.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const tSwitch = performance.now()
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      return
    }
    ws.data.currentSessionId = sessionId
    ws.data.currentTmuxTarget = effectiveTarget
    // Record dedup key only after successful switch — prevents a second
    // attach from hitting the dedup fast-path while the first is still in flight.
    ws.data.lastAttachKey = attachKey
    ws.data.lastAttachTs = performance.now()
    startClipboardBufferWatch(ctx.clipboard, ws, sessionId, session)
    logger.info('terminal_attach_profile', {
      sessionId,
      target,
      effectiveTarget,
      remote: !!session.remote,
      proxyMs: Math.round(tProxy - t0),
      captureMs: Math.round(tCapture - tProxy),
      switchMs: Math.round(tSwitch - tCapture),
      totalMs: Math.round(tSwitch - t0),
      historyBytes: history?.length ?? 0,
      connectionId: ws.data.connectionId,
    })
    ctx.hub.send(ws, { type: 'terminal-ready', sessionId })
  } catch (error) {
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      return
    }
    logger.warn('terminal_switch_failed', {
      sessionId,
      target,
      effectiveTarget,
      error: error instanceof Error ? error.message : String(error),
      connectionId: ws.data.connectionId,
    })
    if (ctx.hub.sockets.has(ws) && isTerminalAttachCurrent(ws, attachSeq)) {
      handleTerminalError(ctx, ws, sessionId, error, 'ERR_TMUX_SWITCH_FAILED')
    }
  }
}

async function captureTmuxHistory(target: string): Promise<string | null> {
  try {
    // Capture only the visible pane so initial attach paints the current view
    // immediately instead of replaying the entire scrollback buffer.
    // Async spawn: this runs on the main event loop during attach, and a sync
    // spawnSync would block keystroke dispatch and output streaming for the
    // full capture duration on text-heavy panes.
    const colorArgs = config.terminalColorsEnabled ? ['-e'] : []
    const output = await readTmuxCapture([
      'capture-pane',
      '-t',
      target,
      '-p',
      '-J',
      ...colorArgs,
    ])
    if (output === null) {
      return null
    }
    // Only return if there's actual content
    if (output.trim().length === 0) {
      return null
    }
    return normalizeCapturedHistory(output)
  } catch {
    return null
  }
}

export function detachTerminalPersistent(ws: ServerWebSocket<WSData>, sessionId: string) {
  // Cancel any in-flight attach/switch operations so stale completions don't
  // clobber the newly-selected session.
  ws.data.terminalAttachSeq += 1
  stopClipboardBufferWatch(ws)
  if (ws.data.currentSessionId === sessionId) {
    ws.data.currentSessionId = null
    ws.data.currentTmuxTarget = null
  }
  // Clear dedup so a fast A→B→A switch doesn't skip scrollback for A
  clearAttachDedup(ws)
}

export function handleTerminalInputPersistent(
  ctx: TerminalAttachContext,
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  data: string
) {
  if (sessionId !== ws.data.currentSessionId) {
    return
  }

  const session = ctx.registry.get(sessionId)
  if (session?.remote && !config.remoteAllowAttach) return

  if (!session?.remote && containsClipboardArmingMouseInput(data)) {
    const now = Date.now()
    ws.data.clipboardBufferArmedUntil = now + CLIPBOARD_BUFFER_ARM_MS
    // No slack: we arm here BEFORE forwarding the input to tmux below, so any
    // buffer this gesture creates is stamped at/after this whole second. A
    // slack would instead let a pre-existing buffer created just before the
    // gesture be mis-offered as the user's copy.
    ws.data.clipboardArmedAtSec = Math.floor(now / 1000)
  }

  ws.data.terminal?.write(data)

  // On Enter key: immediately set "working" status and schedule refresh
  if (data.includes('\r') || data.includes('\n')) {
    if (!session?.remote) {
      ctx.refresh.setForceWorking(sessionId)
      ctx.refresh.scheduleEnterRefresh()
      ctx.refresh.scheduleLastUserMessageCapture(sessionId)
    }
  }
}

export function handleTerminalPastePersistent(
  ctx: TerminalAttachContext,
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  data: string
) {
  if (sessionId !== ws.data.currentSessionId) {
    return
  }

  const session = ctx.registry.get(sessionId)
  if (session?.remote && !config.remoteAllowAttach) return

  // Pasting stages text in the pane's input; it is NOT a submit, so unlike
  // terminal-input we deliberately skip the Enter/"working" status heuristics.
  ws.data.terminal?.paste(data)
}

export function handleTerminalResizePersistent(
  ctx: TerminalAttachContext,
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  cols: number,
  rows: number
) {
  if (sessionId !== ws.data.currentSessionId) {
    return
  }

  const session = ctx.registry.get(sessionId)
  if (session?.remote && !config.remoteAllowAttach) return

  ws.data.terminal?.resize(cols, rows)
}

export function cleanupTerminals(ws: ServerWebSocket<WSData>) {
  stopClipboardBufferWatch(ws)
  if (ws.data.terminal) {
    void ws.data.terminal.dispose()
    ws.data.terminal = null
  }
  ws.data.currentSessionId = null
  ws.data.currentTmuxTarget = null
  ws.data.terminalHost = null
  // Drop output buffered for the detached terminal; the coalescer itself stays
  // alive so a later attach on this still-open socket delivers output again.
  ws.data.outputCoalescer?.clearPending()
  clearAttachDedup(ws)
}
