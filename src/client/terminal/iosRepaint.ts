// iOS compositor repaint workaround: WKWebView shows a stale cached snapshot
// after background/foreground or reconnect, so we blank the container for two
// animation frames to force a fresh composite. Singleton state — one terminal
// is live at a time; only one repaint can be in-flight and cancel() restores
// the display value if caught mid-toggle.
import type { Terminal } from '@xterm/xterm'
import { clientLog } from '../utils/clientLog'

/** Live accessors for the owning hook's refs (design D2: refs stay hook-owned). */
export interface IosRepaintTarget {
  getContainer(): HTMLDivElement | null
  getTerminal(): Terminal | null
  getSessionId(): string | null
}

let repaintTimer: number | null = null
let repaintRaf: number | null = null
let repaintPrevDisplay: string | null = null // non-null when mid-toggle

// Cancel any pending iOS repaint, restoring display if mid-toggle.
export function cancelIosRepaint(target: IosRepaintTarget): void {
  if (repaintTimer !== null) {
    window.clearTimeout(repaintTimer)
    repaintTimer = null
  }
  if (repaintRaf !== null) {
    cancelAnimationFrame(repaintRaf)
    repaintRaf = null
  }
  if (repaintPrevDisplay !== null) {
    const container = target.getContainer()
    if (container) container.style.display = repaintPrevDisplay
    repaintPrevDisplay = null
  }
}

// Schedule an iOS compositor repaint after delayMs.
// Cancels any in-flight repaint first (safely restoring display).
export function scheduleIosRepaint(
  delayMs: number,
  trigger: string | undefined,
  target: IosRepaintTarget
): void {
  const container = target.getContainer()
  if (!container) return

  cancelIosRepaint(target)

  clientLog('ios_repaint_schedule', { delayMs, trigger, sessionId: target.getSessionId() })

  repaintTimer = window.setTimeout(() => {
    repaintTimer = null
    // Force xterm.js to re-render all visible rows so the DOM has
    // fresh content before the compositor is forced to repaint.
    const terminal = target.getTerminal()
    if (terminal) terminal.refresh(0, terminal.rows - 1)

    const hasContent = terminal ? terminal.buffer.active.length > 0 : false
    clientLog('ios_repaint_exec', {
      trigger,
      hasContent,
      bufferLines: terminal?.buffer.active.length ?? 0,
      sessionId: target.getSessionId(),
    })

    repaintPrevDisplay = container.style.display
    container.style.display = 'none'
    // Split restore across two animation frames so the compositor
    // registers the removal before we restore.
    repaintRaf = requestAnimationFrame(() => {
      repaintRaf = requestAnimationFrame(() => {
        repaintRaf = null
        container.style.display = repaintPrevDisplay ?? ''
        repaintPrevDisplay = null
      })
    })
  }, delayMs)
}
