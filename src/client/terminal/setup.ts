// One-time terminal mount setup: create the terminal + addons, open after
// fonts are ready (so the WebGL texture atlas uses correct glyph metrics),
// wire link hover, the custom key handler (shortcut bypass, copy, paste via
// the paste channel, word-delete), input forwarding, tmux scrollback wheel
// handling, and the paste capture listener — plus the matching teardown.
import type { MutableRefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import type { SerializeAddon } from '@xterm/addon-serialize'
import type { ProgressAddon } from '@xterm/addon-progress'
import type { SendClientMessage } from '@shared/types'
import { clientLog } from '../utils/clientLog'
import { useSettingsStore } from '../stores/settingsStore'
import { getEffectiveModifier, getIsMac, matchesModifier } from '../utils/device'
import { createTerminalWithAddons, type CreateTerminalOptions } from './createTerminal'
import { createLinkTooltip, installLinkHandlers } from './linkHover'
import { loadWebglAddon, disposeWebglAddon, type WebglAddonRef } from './webgl'
import type { TmuxCopyModeState } from './copyMode'
import type { PasteChannel } from './pasteChannel'

export interface TerminalSetupDeps {
  getContainer: () => HTMLDivElement | null
  /** True when a terminal instance already exists (skip re-init). */
  isInitialized: () => boolean
  createOptions: CreateTerminalOptions
  onAddonsLoaded: (addons: {
    searchAddon: SearchAddon
    serializeAddon: SerializeAddon
    progressAddon: ProgressAddon
  }) => void
  /** Store the created terminal + fit addon (hook-owned refs). */
  onTerminalCreated: (terminal: Terminal, fitAddon: FitAddon) => void
  /** Clear the terminal/addon refs after teardown disposed them. */
  onTerminalDisposed: () => void
  useWebGLRef: { current: boolean }
  webglAddonRef: WebglAddonRef
  logWebglContextLoss: () => void
  hasLoggedInitRef: MutableRefObject<boolean>
  isIOS: boolean
  copyMode: TmuxCopyModeState
  pasteChannel: PasteChannel
  getReadySession: () => string | null
  send: SendClientMessage
  fitTimerRef: MutableRefObject<number | null>
  resizeTimerRef: MutableRefObject<number | null>
  fitAndResize: () => void
}

/**
 * Terminal initialization — only once on mount. Returns the effect cleanup.
 */
export function setupTerminal(deps: TerminalSetupDeps): () => void {
  const container = deps.getContainer()
  if (!container) return () => {}

  // Already initialized
  if (deps.isInitialized()) return () => {}

  // Track if effect has been cleaned up (for async font loading)
  let cancelled = false

  // Clear container
  container.innerHTML = ''

  const { terminal, fitAddon, searchAddon, serializeAddon, progressAddon } =
    createTerminalWithAddons(deps.createOptions)
  deps.onAddonsLoaded({ searchAddon, serializeAddon, progressAddon })

  // Function to complete terminal initialization after fonts are ready
  // This ensures the WebGL renderer builds its texture atlas with correct font metrics
  const openTerminal = () => {
    if (cancelled) return

    if (deps.useWebGLRef.current) {
      loadWebglAddon(terminal, deps.webglAddonRef, deps.logWebglContextLoss)
    }

    terminal.open(container)
    fitAddon.fit()

    if (!deps.hasLoggedInitRef.current) {
      deps.hasLoggedInitRef.current = true
      clientLog('terminal_init', {
        isiOS: deps.isIOS,
        useWebGL: deps.useWebGLRef.current,
        hasWebGL: !!deps.webglAddonRef.current,
        userAgent: navigator.userAgent.slice(0, 120),
        platform: navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints,
      }, 'info')
    }

    // Append tooltip after terminal.open() sets terminal.element
    if (tooltip && terminal.element) {
      terminal.element.appendChild(tooltip.root)
    }
  }

  // Wait for fonts to be ready before opening terminal to ensure WebGL
  // texture atlas is built with correct glyph metrics for all font weights
  if (document.fonts?.ready) {
    document.fonts.ready.then(openTerminal).catch(openTerminal)
  } else {
    // Fallback for environments without document.fonts
    openTerminal()
  }

  // Create tooltip element inside terminal (with xterm-hover class to prevent
  // interference) and wire link hover/activation (terminal/linkHover.ts)
  const tooltip = createLinkTooltip()
  const removeLinkHandling = installLinkHandlers(terminal, container, tooltip)

  const pasteModifier = getIsMac() ? 'metaKey' : 'ctrlKey' as const

  terminal.attachCustomKeyEventHandler((event) => {
    // Let Agentboard's window-level direct-navigation handler receive the
    // configured modifier + 1..9 before xterm translates or cancels it.
    // Read the store synchronously so modifier changes take effect without
    // recreating the terminal instance.
    if (
      event.type === 'keydown' &&
      /^Digit[1-9]$/.test(event.code) &&
      matchesModifier(
        event,
        getEffectiveModifier(useSettingsStore.getState().shortcutModifier)
      )
    ) {
      return false
    }

    // Cmd/Ctrl+C: copy selection (only non-whitespace to avoid clearing images from clipboard)
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      if (terminal.hasSelection()) {
        const selection = terminal.getSelection()
        if (selection?.trim() && navigator.clipboard) {
          void navigator.clipboard.writeText(selection)
        }
        return false
      }
    }

    // Ctrl+V on macOS desktop: dedicated image-paste shortcut (see
    // PasteChannel.handleMacImagePasteKey).
    if (getIsMac() && !deps.isIOS && event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'v' && event.type === 'keydown') {
      return deps.pasteChannel.handleMacImagePasteKey()
    }

    // Cmd+V on macOS / Ctrl+V on other platforms: intercept paste to handle
    // Finder file copies and normal text paste (see PasteChannel.handlePasteKey).
    // We use a capture-phase paste listener to grab clipboardData
    // synchronously and suppress ClipboardAddon, avoiding double-paste
    // without any Clipboard API permission dependency.
    if (event[pasteModifier] && event.key.toLowerCase() === 'v' && event.type === 'keydown') {
      return deps.pasteChannel.handlePasteKey()
    }

    // Ctrl+Backspace: delete word backward (browser eats this otherwise)
    if (event.ctrlKey && event.key === 'Backspace' && event.type === 'keydown') {
      const attached = deps.getReadySession()
      if (attached) {
        deps.send({ type: 'terminal-input', sessionId: attached, data: '\x17' })
      }
      return false
    }

    return true
  })

  // Capture-phase paste listener (installed by the paste channel): when a
  // paste keydown has an active resolver, grab the clipboard text
  // synchronously and suppress the event so ClipboardAddon doesn't also paste.
  const removePasteListener = deps.pasteChannel.installCaptureListener(container)

  // Handle input - only send to attached session
  terminal.onData((data) => {
    const attached = deps.getReadySession()
    if (!attached) return
    // When in copy-mode, drop mouse sequences so clicks don't exit
    // copy-mode; xterm then handles selection locally (Safari desktop).
    if (deps.copyMode.shouldDropInputData(data)) {
      return // Drop mouse event, let xterm handle selection locally
    }

    // If we scrolled in tmux copy-mode, exit it before sending keyboard input
    deps.copyMode.exit(attached)
    deps.send({ type: 'terminal-input', sessionId: attached, data })
  })

  // Forward wheel events to tmux for scrollback (like Blink terminal)
  // This enters tmux copy-mode instead of using xterm.js local scrollback
  terminal.attachCustomWheelEventHandler((ev) => deps.copyMode.handleWheelEvent(ev, terminal))

  deps.onTerminalCreated(terminal, fitAddon)

  // Handle resize - with longer debounce to prevent flickering
  const handleResize = () => {
    if (deps.resizeTimerRef.current) {
      window.clearTimeout(deps.resizeTimerRef.current)
    }

    // Longer debounce to prevent rapid resize events
    deps.resizeTimerRef.current = window.setTimeout(() => {
      deps.fitAndResize()
    }, 150)
  }
  const resizeObserver = new ResizeObserver(handleResize)
  resizeObserver.observe(container)

  // Initial fit
  handleResize()

  return () => {
    // Cancel any pending async operations (font loading)
    cancelled = true
    // Clean up link handling state (mousedown listener, tooltip, addon)
    removeLinkHandling()
    // Remove paste intercept handler and cancel any pending paste request
    removePasteListener()
    deps.pasteChannel.cancelPending()
    disposeWebglAddon(deps.webglAddonRef)
    try {
      terminal.dispose()
    } catch {
      // Ignore
    }
    if (container) {
      container.innerHTML = ''
    }
    deps.onTerminalDisposed()
    if (deps.fitTimerRef.current) {
      window.clearTimeout(deps.fitTimerRef.current)
    }
    deps.copyMode.clearCheckTimer()
    resizeObserver.disconnect()
    if (deps.resizeTimerRef.current) {
      window.clearTimeout(deps.resizeTimerRef.current)
    }
  }
}
