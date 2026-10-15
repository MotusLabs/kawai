// Terminal construction: the xterm instance with its addon set (fit,
// clipboard, search, serialize, progress). The safe clipboard provider keeps
// OSC 52 writes from clearing non-text clipboard content.
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ClipboardAddon, type ClipboardSelectionType, type IClipboardProvider } from '@xterm/addon-clipboard'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { ProgressAddon } from '@xterm/addon-progress'
import type { ClipboardOfferSource } from '@shared/types'
import { clientLog } from '../utils/clientLog'

interface SafeClipboardCallbacks {
  onWriteFailed?: (text: string, source: ClipboardOfferSource) => void
}

/**
 * Custom clipboard provider that prevents empty writes (matching Ghostty's behavior).
 * OSC 52 with empty base64 data clears clipboard in reference xterm, but this can
 * accidentally wipe images or other non-text content the user has copied.
 */
class SafeClipboardProvider implements IClipboardProvider {
  constructor(private callbacks: SafeClipboardCallbacks = {}) {}

  async readText(selection: ClipboardSelectionType): Promise<string> {
    if (selection !== 'c') return ''
    try {
      return await navigator.clipboard.readText()
    } catch {
      return ''
    }
  }

  async writeText(selection: ClipboardSelectionType, text: string): Promise<void> {
    // Only write to system clipboard, and only if there's actual non-whitespace content
    // This prevents OSC 52 sequences from clearing images/rich content from the clipboard
    if (selection !== 'c' || !text?.trim()) return
    const startedAt = performance.now()
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('navigator.clipboard.writeText unavailable')
      }
      await navigator.clipboard.writeText(text)
      clientLog('clipboard_write_success', {
        source: 'osc52',
        chars: text.length,
        durationMs: Math.round(performance.now() - startedAt),
      })
    } catch (error) {
      clientLog('clipboard_write_failed', {
        source: 'osc52',
        chars: text.length,
        error: error instanceof Error ? error.message : String(error),
      }, 'warn')
      this.callbacks.onWriteFailed?.(text, 'osc52')
    }
  }
}

export interface CreateTerminalOptions {
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
  theme: ITheme
  screenReaderMode: boolean
  onClipboardWriteFailed?: (text: string, source: ClipboardOfferSource) => void
}

export interface TerminalBundle {
  terminal: Terminal
  fitAddon: FitAddon
  searchAddon: SearchAddon
  serializeAddon: SerializeAddon
  progressAddon: ProgressAddon
}

/**
 * Create the Terminal and load its addon set. Line height is rounded to keep
 * an integer cell height for any fontSize, so cell sizing stays stable across
 * fractional line-height rendering.
 */
export function createTerminalWithAddons({
  fontFamily,
  fontSize,
  lineHeight,
  letterSpacing,
  theme,
  screenReaderMode,
  onClipboardWriteFailed,
}: CreateTerminalOptions): TerminalBundle {
  // Calculate lineHeight that produces integer cell height for any fontSize
  // This keeps cell sizing stable across fractional line-height rendering
  const calcLineHeight = (size: number, lh: number) => Math.round(size * lh) / size
  const computedLineHeight = calcLineHeight(fontSize, lineHeight)

  const terminal = new Terminal({
    fontFamily,
    fontSize,
    lineHeight: computedLineHeight,
    letterSpacing,
    scrollback: 0, // Disabled - we use tmux scrollback instead
    cursorBlink: false,
    cursorStyle: 'underline',
    // PTY/tmux output already carries cursor movement. Rewriting LF as CRLF
    // corrupts cursor-column state for fullscreen applications.
    convertEol: false,
    theme,
    screenReaderMode,
    // Ensure text is readable even when apps use true color (24-bit RGB) sequences
    // that bypass our theme colors (e.g., Pi using black text on dark backgrounds)
    minimumContrastRatio: 4.5,
  })

  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(new ClipboardAddon(undefined, new SafeClipboardProvider({
    onWriteFailed: onClipboardWriteFailed,
  })))

  // Load search addon for terminal buffer search
  const searchAddon = new SearchAddon()
  terminal.loadAddon(searchAddon)

  // Load serialize addon for exporting terminal state
  const serializeAddon = new SerializeAddon()
  terminal.loadAddon(serializeAddon)

  // Load progress addon for OSC 9;4 progress sequences
  const progressAddon = new ProgressAddon()
  terminal.loadAddon(progressAddon)

  return { terminal, fitAddon, searchAddon, serializeAddon, progressAddon }
}
