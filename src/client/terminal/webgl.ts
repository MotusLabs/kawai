// WebGL renderer addon management: create-and-load with context-loss
// fallback to the canvas renderer, dispose, runtime preference sync, and the
// iOS resume path that force-recreates a silently-dead context.
import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'
import { clientLog } from '../utils/clientLog'

export type WebglAddonRef = { current: WebglAddon | null }

/**
 * Create and load the WebGL addon onto a terminal. Registers a context-loss
 * handler that disposes the addon (so xterm falls back to the canvas renderer
 * instead of rendering through a dead context) and clears the ref. Returns
 * false when the addon is unavailable — it is always optional.
 */
export function loadWebglAddon(
  terminal: Terminal,
  webglAddonRef: WebglAddonRef,
  onContextLoss?: (addon: WebglAddon) => void
): boolean {
  try {
    const webglAddon = new WebglAddon()
    webglAddon.onContextLoss(() => {
      onContextLoss?.(webglAddon)
      try { webglAddon.dispose() } catch { /* ignore */ }
      webglAddonRef.current = null
    })
    terminal.loadAddon(webglAddon)
    webglAddonRef.current = webglAddon
    return true
  } catch {
    // WebGL addon is optional
    return false
  }
}

/** Dispose the current WebGL addon, if any, and clear the ref. */
export function disposeWebglAddon(webglAddonRef: WebglAddonRef): void {
  if (webglAddonRef.current) {
    try {
      webglAddonRef.current.dispose()
    } catch {
      // Ignore disposal errors
    }
    webglAddonRef.current = null
  }
}

/**
 * Apply a runtime WebGL preference change: enable loads the addon when it is
 * not already loaded; disable disposes it so xterm falls back to canvas.
 * Skips the first render — the mount-time open path handles initialization.
 */
export function syncWebglPreference(
  terminal: Terminal | null,
  webglAddonRef: WebglAddonRef,
  useWebGLRef: { current: boolean },
  useWebGL: boolean
): void {
  if (!terminal) return

  const wasEnabled = useWebGLRef.current
  useWebGLRef.current = useWebGL

  // Skip on first render (initialization handles it)
  if (wasEnabled === useWebGL) return

  if (useWebGL) {
    // Enable WebGL
    if (!webglAddonRef.current) {
      try {
        const webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => {
          try { webglAddon.dispose() } catch { /* ignore */ }
          webglAddonRef.current = null
        })
        terminal.loadAddon(webglAddon)
        webglAddonRef.current = webglAddon
      } catch {
        // WebGL addon is optional
      }
    }
  } else {
    // Disable WebGL - dispose addon to fall back to canvas
    if (webglAddonRef.current) {
      try {
        webglAddonRef.current.dispose()
      } catch {
        // Ignore disposal errors
      }
      webglAddonRef.current = null
    }
  }
}

/**
 * iOS can silently kill the WebGL context during background without firing
 * onContextLoss. Force-recreate the addon to get a fresh context; without
 * this, xterm renders through a dead WebGL context → blank screen. Called
 * from multiple resume handlers because iOS doesn't reliably fire
 * visibilitychange (WebKit #202399) — focus is often the only event.
 */
export function recreateWebglAddonIfLive(
  terminal: Terminal | null,
  webglAddonRef: WebglAddonRef,
  useWebGLRef: { current: boolean },
  getSessionId: () => string | null,
  trigger: string
): void {
  if (terminal && webglAddonRef.current && useWebGLRef.current) {
    try {
      webglAddonRef.current.dispose()
    } catch { /* ignore */ }
    webglAddonRef.current = null
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        clientLog('webgl_context_loss', { sessionId: getSessionId() }, 'info')
        try { webglAddon.dispose() } catch { /* ignore */ }
        webglAddonRef.current = null
      })
      terminal.loadAddon(webglAddon)
      webglAddonRef.current = webglAddon
      clientLog('ios_webgl_recreated', { trigger }, 'info')
    } catch {
      clientLog('ios_webgl_recreate_failed', { trigger }, 'info')
    }
  }
}
