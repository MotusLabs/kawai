// Live appearance application: theme swaps, and font/metric updates that
// keep an integer cell height (so cell sizing stays stable across fractional
// line-height rendering) followed by a fit and a resize notification.
import type { Terminal, ITheme } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

export interface FontSettings {
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
}

/** Apply a new theme to a live terminal. */
export function applyTheme(terminal: Terminal | null, theme: ITheme): void {
  if (terminal) {
    terminal.options.theme = theme
  }
}

/**
 * Apply new font family/size/metrics, refit, and report the new dimensions
 * (the caller forwards them as terminal-resize for the attached session).
 */
export function applyFontSettings(
  terminal: Terminal | null,
  fitAddon: FitAddon | null,
  settings: FontSettings,
  onResized: (cols: number, rows: number) => void
): void {
  if (!terminal || !fitAddon) return
  terminal.options.fontFamily = settings.fontFamily
  terminal.options.fontSize = settings.fontSize
  // Recalculate lineHeight for integer cell height
  terminal.options.lineHeight = Math.round(settings.fontSize * settings.lineHeight) / settings.fontSize
  terminal.options.letterSpacing = settings.letterSpacing
  fitAddon.fit()
  onResized(terminal.cols, terminal.rows)
}
