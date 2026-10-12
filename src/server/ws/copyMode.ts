// tmux copy-mode sync for attached terminals: cancel copy-mode when the user
// starts typing after scrolling, and answer the client's copy-mode/fullscreen
// probe. The per-socket `copyModeCheckInFlight` flag and the attach-sequence
// staleness check are load-bearing race guards and moved verbatim from
// index.ts.
import type { ServerWebSocket } from 'bun'
import { config } from '../config'
import { isTerminalSession } from '../../shared/types'
import type { TerminalSession } from '../../shared/types'
import type { SessionRegistry } from '../SessionRegistry'
import type { RemoteCommandResult } from '../sessions/context'
import { readTmuxCapture } from '../tmuxCapture'
import type { ConnectionHub } from './ConnectionHub'
import type { WSData } from './wsTypes'

export interface CopyModeContext {
  registry: SessionRegistry
  hub: ConnectionHub
  /** Remote tmux control-plane call (RemoteSessionService.runTmux). */
  runRemoteTmux: (host: string, args: string[]) => Promise<RemoteCommandResult>
}

function resolveCopyModeTarget(
  sessionId: string,
  ws: ServerWebSocket<WSData>,
  session: TerminalSession
): string {
  if (ws.data.currentSessionId === sessionId && ws.data.currentTmuxTarget) {
    return ws.data.currentTmuxTarget
  }
  return session.tmuxWindow
}

export async function handleCancelCopyMode(
  ctx: CopyModeContext,
  sessionId: string,
  ws: ServerWebSocket<WSData>
) {
  const session = ctx.registry.get(sessionId)
  if (!session || !isTerminalSession(session)) return
  if (session.remote && !config.remoteAllowAttach) return

  try {
    // Exit tmux copy-mode quietly. Async spawn: a sync spawnSync here stalls
    // the event loop (and with it keystroke dispatch + terminal streaming)
    // for the full command duration whenever the tmux server is slow.
    // NOTE: async also means a keystroke racing this cancel can reach tmux
    // first (worst case one key consumed by copy-mode navigation) — a race
    // that already existed on the remote path.
    const target = resolveCopyModeTarget(sessionId, ws, session)
    if (session.remote && session.host) {
      await ctx.runRemoteTmux(session.host, ['send-keys', '-X', '-t', target, 'cancel'])
    } else {
      await readTmuxCapture(['send-keys', '-X', '-t', target, 'cancel'])
    }
  } catch {
    // Ignore errors - copy-mode may not be active
  }
}

export async function handleCheckCopyMode(
  ctx: CopyModeContext,
  sessionId: string,
  ws: ServerWebSocket<WSData>
) {
  const session = ctx.registry.get(sessionId)
  if (!session || !isTerminalSession(session)) return
  if (session.remote && !config.remoteAllowAttach) return
  // The client polls this every 750ms. With a loaded tmux server an async
  // probe can outlast that period; letting a second probe race the first
  // would let an older reply land after a newer one and stale-flip the
  // copy-mode state. Skip instead — the next poll delivers fresh state.
  if (ws.data.copyModeCheckInFlight) return
  ws.data.copyModeCheckInFlight = true

  // A probe can now outlive the attachment it was issued against (session
  // switch, detach, socket close). Capture generation + resolved target before
  // awaiting and discard the reply if either moved — the in-flight guard alone
  // cannot stop a probe for an old attachment from completing after a switch.
  const attachSeq = ws.data.terminalAttachSeq
  const target = resolveCopyModeTarget(sessionId, ws, session)

  try {
    // Query tmux for pane copy-mode status plus fullscreen-app detection:
    //   pane_in_mode  -> tmux copy-mode active
    //   alternate_on  -> pane on the alternate screen buffer
    //   mouse_any_flag-> the in-pane app requested mouse tracking (owns the mouse)
    // Async spawn (readTmuxCapture) rather than Bun.spawnSync: this runs on
    // the main event loop, and a sync spawn blocks keystroke dispatch and
    // terminal-output sends for the full command duration whenever the tmux
    // server is busy serving many windows.
    const fmt = '#{pane_in_mode},#{alternate_on},#{mouse_any_flag}'
    let output: string
    if (session.remote && session.host) {
      const result = await ctx.runRemoteTmux(session.host, ['display-message', '-p', '-t', target, fmt])
      output = result.stdout?.trim() ?? ''
    } else {
      output = (await readTmuxCapture(['display-message', '-p', '-t', target, fmt]))?.trim() ?? ''
    }
    const [inCopyModeField, altScreenField, appMouseField] = output.split(',')
    const inCopyMode = inCopyModeField === '1'
    const altScreen = altScreenField === '1'
    const appMouse = appMouseField === '1'
    if (!copyModeReplyStillCurrent(ctx, ws, sessionId, attachSeq, target)) return
    ctx.hub.send(ws, { type: 'tmux-copy-mode-status', sessionId, inCopyMode, altScreen, appMouse })
  } catch {
    // On error, assume not in copy mode and no fullscreen app
    if (!copyModeReplyStillCurrent(ctx, ws, sessionId, attachSeq, target)) return
    ctx.hub.send(ws, { type: 'tmux-copy-mode-status', sessionId, inCopyMode: false, altScreen: false, appMouse: false })
  } finally {
    ws.data.copyModeCheckInFlight = false
  }
}

/**
 * True when a copy-mode probe's reply still describes the attachment it was
 * issued against: the socket is still open, no new attachment started, and the
 * resolved pane target is unchanged.
 */
function copyModeReplyStillCurrent(
  ctx: CopyModeContext,
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  attachSeq: number,
  target: string
): boolean {
  if (!ctx.hub.sockets.has(ws)) return false
  if (ws.data.terminalAttachSeq !== attachSeq) return false
  const session = ctx.registry.get(sessionId)
  if (!session || !isTerminalSession(session)) return false
  return resolveCopyModeTarget(sessionId, ws, session) === target
}
