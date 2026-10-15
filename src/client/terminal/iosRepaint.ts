// iOS compositor repaint workaround: WKWebView shows a stale cached snapshot
// after background/foreground or reconnect, so we blank the container for two
// animation frames to force a fresh composite. Singleton state — one terminal
// is live at a time; only one repaint can be in-flight and cancel() restores
// the display value if caught mid-toggle.
import type { Terminal } from '@xterm/xterm'
import { clientLog } from '../utils/clientLog'
import { recreateWebglAddonIfLive, type WebglAddonRef } from './webgl'

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

export interface VisibilityHandlerDeps {
  isIOS: boolean
  getTerminal: () => Terminal | null
  webglAddonRef: WebglAddonRef
  useWebGLRef: { current: boolean }
  getSessionId: () => string | null
  repaintTarget: IosRepaintTarget
}

/**
 * Install the visibility resume handling: a visibilitychange diagnostic log
 * on every platform, plus (iOS only) WebGL context force-recreate and a
 * compositor repaint on visibilitychange/pageshow/focus — iOS doesn't
 * reliably fire visibilitychange (WebKit #202399), so focus is often the
 * only event. Returns the cleanup.
 */
export function installVisibilityHandlers(deps: VisibilityHandlerDeps): () => void {
  const { isIOS, repaintTarget } = deps
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
    return () => {}
  }

  // Log visibility changes unconditionally for diagnostics
  const handleVisibilityDiag = () => {
    if (document.visibilityState !== 'hidden') {
      clientLog('terminal_visibility_resume', {
        isiOS: isIOS,
        hasWebGL: !!deps.webglAddonRef.current,
        useWebGL: deps.useWebGLRef.current,
        hasTerminal: !!deps.getTerminal(),
        bufferLines: deps.getTerminal()?.buffer.active.length ?? 0,
        sessionId: deps.getSessionId(),
      }, 'info')
    }
  }
  document.addEventListener('visibilitychange', handleVisibilityDiag)

  if (!isIOS) {
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityDiag)
    }
  }

  const handleVisibility = () => {
    // Skip hidden transitions. Don't require 'visible' specifically —
    // visibilityState can be wrong in iOS PWA standalone (WebKit #202399).
    if (document.visibilityState === 'hidden') return
    recreateWebglAddonIfLive(deps.getTerminal(), deps.webglAddonRef, deps.useWebGLRef, deps.getSessionId, 'visibilitychange')
    scheduleIosRepaint(200, 'visibilitychange', repaintTarget)
  }

  const handlePageShow = (e: PageTransitionEvent) => {
    // pageshow fires on BFCache/freeze restore — more reliable than
    // visibilitychange in iOS PWA standalone mode.
    if (!e.persisted) return
    recreateWebglAddonIfLive(deps.getTerminal(), deps.webglAddonRef, deps.useWebGLRef, deps.getSessionId, 'pageshow')
    scheduleIosRepaint(200, 'pageshow', repaintTarget)
  }

  const handleFocus = () => {
    // Fallback: window 'focus' reliably fires when an iOS PWA returns
    // to the foreground, even when visibilitychange doesn't fire
    // (WebKit #202399) and the WebSocket stays alive (no reconnect).
    recreateWebglAddonIfLive(deps.getTerminal(), deps.webglAddonRef, deps.useWebGLRef, deps.getSessionId, 'focus')
    scheduleIosRepaint(200, 'focus', repaintTarget)
  }

  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('pageshow', handlePageShow)
  window.addEventListener('focus', handleFocus)
  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityDiag)
    document.removeEventListener('visibilitychange', handleVisibility)
    window.removeEventListener('pageshow', handlePageShow)
    window.removeEventListener('focus', handleFocus)
    cancelIosRepaint(repaintTarget)
  }
}
