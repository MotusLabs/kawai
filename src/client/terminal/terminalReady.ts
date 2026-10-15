// terminal-ready handling for the output subscription: grant input
// readiness, flush buffered output atomically with the deferred reset (or
// reset bare when no output arrived — avoiding a blank flash), clear the
// switching state, log end-to-end switch timing, return focus to the pane,
// and schedule the iOS post-data compositor repaint.
import type { MutableRefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { clientLog } from '../utils/clientLog'
import { scheduleIosRepaint, type IosRepaintTarget } from './iosRepaint'
import type { TerminalOutputStream } from './outputStream'

export interface TerminalReadyDeps {
  getTerminal: () => Terminal | null
  output: TerminalOutputStream
  needsResetRef: MutableRefObject<boolean>
  switchStartRef: MutableRefObject<number | null>
  focusAfterAttachSessionRef: MutableRefObject<string | null>
  updateReadySession: (id: string | null) => void
  setIsSwitching: (value: boolean) => void
  invalidateWriteBackpressure: () => void
  isIOS: boolean
  repaintTarget: IosRepaintTarget
}

/** Apply a terminal-ready report for the attached session. */
export function handleTerminalReady(sessionId: string, deps: TerminalReadyDeps): void {
  deps.updateReadySession(sessionId)
  // If output is buffered but unflushed, flush now so reset+write
  // stay atomic (avoids blank flash from resetting before flush fires).
  // If no output arrived at all (empty pane or server dedup), reset
  // to clear stale content from the previous session.
  if (deps.output.needsReset && deps.output.bufferedLength > 0) {
    // Bypass backpressure for the atomic reset+history write, and
    // advance the generation first: acks from writes issued before
    // this boundary (same terminal, prior lifecycle) must not consume
    // the new accounting (design D7).
    deps.invalidateWriteBackpressure()
    deps.output.flush({ force: true })
  } else if (deps.output.needsReset) {
    deps.getTerminal()?.reset()
    deps.needsResetRef.current = false
  }
  deps.setIsSwitching(false)

  const readySwitchStart = deps.switchStartRef.current
  // switchStartRef may already be cleared by terminal-output above; only log if still set
  if (readySwitchStart) {
    clientLog('switch_ready', {
      sessionId,
      totalMs: Math.round(performance.now() - readySwitchStart),
    })
    deps.switchStartRef.current = null
  }

  if (deps.focusAfterAttachSessionRef.current === sessionId) {
    deps.getTerminal()?.focus()
    deps.focusAfterAttachSessionRef.current = null
  }

  // Force iOS compositor repaint after reconnect data delivery.
  // The visibilitychange repaint fires early and may only show stale
  // content; this second repaint catches the fresh data from reconnect.
  // Flush pending output first so the repaint captures fresh data.
  // Uses shared scheduleIosRepaint so it coalesces with any pending
  // visibility-triggered repaint (no double-flicker).
  if (deps.isIOS) {
    deps.output.flush()
    scheduleIosRepaint(50, 'terminal-ready', deps.repaintTarget)
  }
}
