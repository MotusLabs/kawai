// Terminal ownership hook: xterm lifecycle and attach/detach, output
// streaming with backpressure, paste and image handling, tmux copy-mode,
// and iOS/WebGL renderer workarounds. The concerns live in sibling
// terminal/ modules; the hook owns the refs and composes them.
import { useEffect, useRef, useCallback, useLayoutEffect, useState } from 'react'
import type { Terminal, ITheme } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { WebglAddon } from '@xterm/addon-webgl'
import type { SearchAddon } from '@xterm/addon-search'
import type { SerializeAddon } from '@xterm/addon-serialize'
import type { ProgressAddon } from '@xterm/addon-progress'
import type { AgentType, ClipboardOfferSource, SendClientMessage, ServerMessageWithDiagnostics, SubscribeServerMessage } from '@shared/types'
import { clientLog } from '../utils/clientLog'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { copyText } from '../utils/copyText'
import { getEffectiveModifier, getIsMac, matchesModifier } from '../utils/device'
import { bracketedPaste, sanitizeImagePath } from '../utils/paste'
import { clipboardFiles } from '../utils/browserFiles'
import { clearSnapshotCache } from '../terminal/snapshotCache'
import { logTerminalOutputDropped } from '../terminal/droppedOutputLog'
import { cancelIosRepaint, installVisibilityHandlers, scheduleIosRepaint, type IosRepaintTarget } from '../terminal/iosRepaint'
import { disposeWebglAddon, loadWebglAddon, syncWebglPreference } from '../terminal/webgl'
import { TmuxCopyModeState } from '../terminal/copyMode'
import { syncAttachment } from '../terminal/attachState'
import { createTerminalWithAddons } from '../terminal/createTerminal'
import { createLinkTooltip, installLinkHandlers } from '../terminal/linkHover'
import { isIOSDevice } from '../utils/device'

// Public helpers re-exported so existing importers keep their paths; the
// implementations live in the terminal/ modules.
export {
  invalidateSnapshotCache,
  clearSnapshotCache,
} from '../terminal/snapshotCache'
export { resetDroppedOutputRateLimiterForTests } from '../terminal/droppedOutputLog'
export { sanitizeLink } from '../terminal/linkSanitize'

/** Empty bracket paste sequence — signals a paste event without text content. */
const BRACKET_PASTE_EMPTY = '\x1b[200~\x1b[201~'
const CTRL_V = '\x16'

/**
 * Upload an image blob to the server and return the stored file path.
 * Returns null on any failure. Bun derives the multipart File.type from the
 * filename extension (not the declared blob type), so the filename carries the
 * real extension.
 */
async function uploadImageBlob(blob: Blob): Promise<string | null> {
  try {
    const ext = (blob.type.split('/')[1] || 'png').toLowerCase()
    const form = new FormData()
    form.append('image', blob, `paste.${ext}`)
    const res = await fetch('/api/paste-image', { method: 'POST', body: form })
    if (!res.ok) return null
    const data = (await res.json()) as { path?: unknown }
    return typeof data.path === 'string' ? data.path : null
  } catch {
    return null
  }
}

/**
 * Ask the server to read the macOS pasteboard and return a file path for an
 * image (a Finder file URL, or a temp file the server wrote from raw clipboard
 * image data). Returns null when the clipboard holds no image.
 */
async function fetchClipboardImagePath(): Promise<string | null> {
  try {
    const res = await fetch('/api/clipboard-file-path')
    if (!res.ok) return null
    const data = (await res.json()) as { path?: unknown; isImage?: unknown }
    if (data.isImage === true && typeof data.path === 'string') return data.path
    return null
  } catch {
    return null
  }
}

/**
 * Resolve the terminal-input payload that makes the attached agent attach a
 * pasted image.
 *
 * Claude Code attaches an image when it receives the image's file PATH inside a
 * bracketed paste — not as raw-typed text, and not via an empty bracket paste.
 * The old empty-bracket signal relied on Claude reading the macOS system
 * clipboard itself, which its fullscreen/no-flicker renderer no longer does, so
 * we now deliver an explicit path: upload the clipboard blob when we have it,
 * otherwise ask the server to resolve a pasteboard path. Codex keeps its
 * literal Ctrl+V signal (its own native image-paste path).
 */
async function resolveImagePasteData(
  agentType: AgentType | undefined,
  source: { blob?: Blob | null; path?: string | null }
): Promise<string | null> {
  if (agentType === 'codex') return CTRL_V
  let path = source.path ?? null
  if (!path && source.blob) path = await uploadImageBlob(source.blob)
  if (!path) path = await fetchClipboardImagePath()
  // Fall back to the empty-bracket signal so the classic renderer's native
  // clipboard read still works when no path could be resolved.
  return path ? bracketedPaste(sanitizeImagePath(path)) : BRACKET_PASTE_EMPTY
}

const MAC_SHARED_PASTEBOARD_PATH_PATTERN =
  /\/Users\/[^/\n]+\/Library\/Group Containers\/group\.com\.apple\.coreservices\.useractivityd\/shared-pasteboard\/items\//

function isMacSharedPasteboardPathText(text: string): boolean {
  return MAC_SHARED_PASTEBOARD_PATH_PATTERN.test(text)
}

interface PastePayload {
  files: File[]
  text: string
  hasImage: boolean
  hasFiles: boolean
  imageBlob: Blob | null
}

interface PendingClipboardOffer {
  id: number
  text: string
  source: ClipboardOfferSource
}

function clipboardHasImage(clipboardData: DataTransfer | null | undefined): boolean {
  if (!clipboardData) return false

  for (const file of Array.from(clipboardData.files ?? [])) {
    if (file?.type?.startsWith('image/')) return true
  }

  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item?.type?.startsWith('image/')) return true
  }
  return false
}

/**
 * Extract the first image blob from clipboard data, if one is present and
 * directly readable. Returns null when the image can't be pulled as a File
 * (e.g. metadata-only items), in which case callers fall back to a
 * server-side pasteboard read.
 */
function getClipboardImageBlob(
  clipboardData: DataTransfer | null | undefined
): Blob | null {
  if (!clipboardData) return null

  for (const file of Array.from(clipboardData.files ?? [])) {
    if (file?.type?.startsWith('image/')) return file
  }

  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item?.kind === 'file' && item.type?.startsWith('image/')) {
      const file = item.getAsFile?.()
      if (file) return file
    }
  }
  return null
}

// Text presentation selector - forces text rendering instead of emoji
const TEXT_VS = '\uFE0E'

// Characters that iOS Safari renders as emoji but should be text
// Only add characters here that are verified to cause issues
const EMOJI_TO_TEXT_CHARS = [
  '\u23FA', // ⏺ Black Circle for Record (Claude's bullet)
] as const
const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const EMOJI_TO_TEXT_REGEX = new RegExp(
  EMOJI_TO_TEXT_CHARS.map(escapeRegExp).join('|'),
  'g'
)

/**
 * Add text presentation selector after characters that iOS renders as emoji.
 * This forces the browser to render them as text glyphs instead.
 */
export function forceTextPresentation(data: string): string {
  // Hot path: most terminal output doesn't contain emoji-like glyphs.
  // Avoid per-character concatenation (expensive) and skip work when not needed.
  for (const char of EMOJI_TO_TEXT_CHARS) {
    if (data.indexOf(char) === -1) {
      continue
    }
    return data.replace(EMOJI_TO_TEXT_REGEX, `$&${TEXT_VS}`)
  }
  return data
}

interface UseTerminalOptions {
  sessionId: string | null
  tmuxTarget: string | null
  agentType?: AgentType
  allowAttach?: boolean
  connectionStatus?: ConnectionStatus
  connectionEpoch?: number
  sendMessage: SendClientMessage
  subscribe: SubscribeServerMessage
  theme: ITheme
  fontSize: number
  lineHeight: number
  letterSpacing: number
  fontFamily: string
  useWebGL: boolean
  onPasteFiles?: (payload: { text: string; files: File[] }) => void
  onPasteError?: (message: string) => void
  onScrollChange?: (isAtBottom: boolean) => void
}

export function useTerminal({
  sessionId,
  tmuxTarget,
  agentType,
  allowAttach = true,
  connectionStatus = 'connected',
  connectionEpoch = 0,
  sendMessage,
  subscribe,
  theme,
  fontSize,
  lineHeight,
  letterSpacing,
  fontFamily,
  useWebGL,
  onScrollChange,
  onPasteFiles,
  onPasteError,
}: UseTerminalOptions) {
  const onPasteFilesRef = useRef(onPasteFiles)
  onPasteFilesRef.current = onPasteFiles
  const onPasteErrorRef = useRef(onPasteError)
  onPasteErrorRef.current = onPasteError
  const canReadHostClipboard = () => !onPasteFilesRef.current || (typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname))
  const isiOS = isIOSDevice()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const hasLoggedInitRef = useRef(false)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const webglAddonRef = useRef<WebglAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const serializeAddonRef = useRef<SerializeAddon | null>(null)
  const progressAddonRef = useRef<ProgressAddon | null>(null)
  const resizeTimer = useRef<number | null>(null)
  const fitTimer = useRef<number | null>(null)
  const attachDebounceRef = useRef<number | null>(null)

  const inTmuxCopyModeRef = useRef<boolean>(false)
  const [isTmuxCopyMode, setIsTmuxCopyMode] = useState(false)
  const appMouseRef = useRef<boolean>(false)
  const altScreenRef = useRef<boolean>(false)
  const clipboardOfferIdRef = useRef(0)
  const [pendingClipboardOffer, setPendingClipboardOffer] = useState<PendingClipboardOffer | null>(null)

  const offerClipboardCopy = useCallback((text: string, source: ClipboardOfferSource) => {
    if (!text?.trim()) return
    clipboardOfferIdRef.current += 1
    setPendingClipboardOffer({
      id: clipboardOfferIdRef.current,
      text,
      source,
    })
  }, [])

  const copyPendingClipboardOffer = useCallback(() => {
    if (!pendingClipboardOffer) return
    copyText(pendingClipboardOffer.text)
    clientLog('clipboard_manual_copy', {
      source: pendingClipboardOffer.source,
      chars: pendingClipboardOffer.text.length,
    }, 'info')
    setPendingClipboardOffer(null)
  }, [pendingClipboardOffer])

  const dismissPendingClipboardOffer = useCallback(() => {
    setPendingClipboardOffer(null)
  }, [])

  // Track the currently attached session to prevent race conditions
  const attachedSessionRef = useRef<string | null>(null)
  // During a session transition, input is allowed only after the server
  // acknowledges the same attachment. Initial mount retains the existing
  // startup behavior; every later selection/reconnect revokes readiness first.
  const readySessionRef = useRef<string | null>(
    sessionId && allowAttach && connectionStatus === 'connected' ? sessionId : null
  )
  // Refs gate event handlers immediately; state also updates rendered controls
  // when readiness changes without a change to the loading indicator.
  const [readySessionId, setReadySessionId] = useState(readySessionRef.current)
  const updateReadySession = useCallback((id: string | null) => {
    readySessionRef.current = id
    setReadySessionId(id)
  }, [])
  const attachedTargetRef = useRef<string | null>(null)
  const attachedConnectionEpochRef = useRef<number>(-1)
  const focusAfterAttachSessionRef = useRef<string | null>(null)
  const switchStartRef = useRef<number | null>(null)
  const sendMessageRef = useRef(sendMessage)
  const agentTypeRef = useRef(agentType)
  const onScrollChangeRef = useRef(onScrollChange)
  const useWebGLRef = useRef(useWebGL)

  // Output buffering with idle-based flushing
  const outputBufferRef = useRef<string[]>([])
  const idleTimerRef = useRef<number | null>(null)
  const maxTimerRef = useRef<number | null>(null)

  // Write backpressure (design D7): hold buffered output while earlier
  // terminal.write() calls are still being processed, so a slow terminal
  // throttles the stream instead of growing xterm's write queue unboundedly.
  // The generation token invalidates acks across lifecycle boundaries
  // (session switch, detach/disconnect, cleanup, terminal-ready forced write).
  // Controls must drain held output before writing directly to xterm.
  const flushOutputBeforeControlRef = useRef<(() => void) | null>(null)
  const pendingWritesRef = useRef(0)
  const deferredFlushRef = useRef(false)
  const forceFlushTimerRef = useRef<number | null>(null)
  const writeGenerationRef = useRef(0)

  // Deferred reset: defer terminal.reset() until history arrives to avoid blank flash
  const needsResetRef = useRef(false)
  const [isSwitching, setIsSwitching] = useState(false)

  // Tuning: flush when idle for 2ms, or at most every 16ms; data held back by
  // backpressure forces through 50ms after the first deferred flush at the latest
  const IDLE_FLUSH_MS = 2
  const MAX_FLUSH_MS = 16
  const FORCE_FLUSH_MS = 50

  // Invalidate pending-write accounting at a lifecycle boundary: advances the
  // generation so acks from superseded writes become no-ops, and clears the
  // count, deferred flag and force cap.
  const invalidateWriteBackpressure = useCallback(() => {
    writeGenerationRef.current += 1
    pendingWritesRef.current = 0
    deferredFlushRef.current = false
    if (forceFlushTimerRef.current !== null) {
      window.clearTimeout(forceFlushTimerRef.current)
      forceFlushTimerRef.current = null
    }
  }, [])

  // iOS compositor repaint — shared by visibility and subscriber effects,
  // unified so only one repaint can be in-flight at a time. The module holds
  // the timer/raf state; accessors read the hook's live refs (design D2).
  const iosRepaintTarget: IosRepaintTarget = {
    getContainer: () => containerRef.current,
    getTerminal: () => terminalRef.current,
    getSessionId: () => attachedSessionRef.current,
  }

  useEffect(() => {
    sendMessageRef.current = sendMessage
  }, [sendMessage])

  useEffect(() => {
    agentTypeRef.current = agentType
  }, [agentType])

  useEffect(() => {
    onScrollChangeRef.current = onScrollChange
  }, [onScrollChange])

  // Check if terminal is scrolled to bottom
  const checkScrollPosition = useCallback(() => {
    const terminal = terminalRef.current
    if (!terminal || !onScrollChangeRef.current) return

    const buffer = terminal.buffer.active
    const isAtBottom = !inTmuxCopyModeRef.current && buffer.viewportY >= buffer.baseY
    onScrollChangeRef.current(isAtBottom)
  }, [])

  // tmux copy-mode tracking (terminal/copyMode.ts): the class owns the
  // debounce/poll timers and wheel accumulator; the hook owns the React
  // refs and state it is handed (design D2).
  const copyModeRef = useRef<TmuxCopyModeState | null>(null)
  if (!copyModeRef.current) {
    copyModeRef.current = new TmuxCopyModeState({
      send: (message) => sendMessageRef.current(message),
      getTerminal: () => terminalRef.current,
      getReadySession: () => readySessionRef.current,
      getAttachedSession: () => attachedSessionRef.current,
      inCopyModeRef: inTmuxCopyModeRef,
      appMouseRef,
      altScreenRef,
      flushOutputBeforeControl: () => flushOutputBeforeControlRef.current?.(),
      onModeChange: setIsTmuxCopyMode,
      onScrollPositionChange: checkScrollPosition,
    })
  }
  const copyMode = copyModeRef.current

  const setTmuxCopyMode = useCallback(
    (nextValue: boolean) => copyMode.set(nextValue),
    [copyMode]
  )

  const fitAndResize = useCallback(() => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (!terminal || !fitAddon) return

    fitAddon.fit()

    const attached = attachedSessionRef.current
    if (attached) {
      sendMessageRef.current({
        type: 'terminal-resize',
        sessionId: attached,
        cols: terminal.cols,
        rows: terminal.rows,
      })
    }
  }, [])

  // Terminal initialization - only once on mount
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Already initialized
    if (terminalRef.current) return

    // Track if effect has been cleaned up (for async font loading)
    let cancelled = false

    // Clear container
    container.innerHTML = ''

    const { terminal, fitAddon, searchAddon, serializeAddon, progressAddon } =
      createTerminalWithAddons({
        fontFamily,
        fontSize,
        lineHeight,
        letterSpacing,
        theme,
        screenReaderMode: isiOS,
        onClipboardWriteFailed: offerClipboardCopy,
      })
    searchAddonRef.current = searchAddon
    serializeAddonRef.current = serializeAddon
    progressAddonRef.current = progressAddon

    // Function to complete terminal initialization after fonts are ready
    // This ensures the WebGL renderer builds its texture atlas with correct font metrics
    const openTerminal = () => {
      if (cancelled) return

      if (useWebGLRef.current) {
        loadWebglAddon(terminal, webglAddonRef, () => {
          clientLog('webgl_context_loss', { sessionId }, 'info')
        })
      }

      terminal.open(container)
      fitAddon.fit()

      if (!hasLoggedInitRef.current) {
        hasLoggedInitRef.current = true
        clientLog('terminal_init', {
          isiOS,
          useWebGL: useWebGLRef.current,
          hasWebGL: !!webglAddonRef.current,
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

    // Create tooltip element inside terminal (with xterm-hover class to prevent interference)
    // and wire link hover/activation (terminal/linkHover.ts)
    const tooltip = createLinkTooltip()
    const removeLinkHandling = installLinkHandlers(terminal, container, tooltip)


    // Paste interception state: each keydown creates a resolver that the
    // capture-phase paste listener fulfills with clipboardData text/metadata.
    // This per-request model prevents race conditions with rapid pastes
    // and avoids double-paste without depending on the async Clipboard API.
    let pasteResolver: ((payload: PastePayload) => void) | null = null
    let pasteTimeoutId: ReturnType<typeof setTimeout> | null = null

    const pasteModifier = getIsMac() ? 'metaKey' : 'ctrlKey' as const

    // Paste delivery often resolves after async work (clipboard read, image
    // upload). Only forward input if the session captured when the paste began
    // is still the attached one, so a mid-paste session switch can't deliver to
    // the wrong (or a no-longer-viewed) session.
    const sendInputIfStillAttached = (expected: string, data: string | null) => {
      if (
        data &&
        attachedSessionRef.current === expected &&
        readySessionRef.current === expected
      ) {
        if (inTmuxCopyModeRef.current) {
          sendMessageRef.current({ type: 'tmux-cancel-copy-mode', sessionId: expected })
          setTmuxCopyMode(false)
        }
        sendMessageRef.current({ type: 'terminal-input', sessionId: expected, data })
      }
    }

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

      // Ctrl+V on macOS desktop: dedicated image-paste shortcut. There's no
      // browser paste event (so no clipboard blob), so we ask the server to
      // resolve a pasteboard image path and deliver it as a bracketed paste for
      // Claude to attach natively; Codex gets a literal Ctrl+V byte.
      // Ctrl+V doesn't trigger a browser paste event, so there's no double-paste risk.
      // Excluded on iOS: no Finder/osascript, and Ctrl+V with hardware keyboard
      // should not trigger desktop image paste behavior.
      if (getIsMac() && !isiOS && event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'v' && event.type === 'keydown') {
        const attached = readySessionRef.current
        if (attached) {
          if (!canReadHostClipboard()) {
            onPasteErrorRef.current?.('Use browser paste or choose a file from this device.')
            return false
          }
          if (inTmuxCopyModeRef.current) {
            sendMessageRef.current({ type: 'tmux-cancel-copy-mode', sessionId: attached })
            setTmuxCopyMode(false)
          }
          void (async () => {
            const data = await resolveImagePasteData(agentTypeRef.current, {})
            sendInputIfStillAttached(attached, data)
          })()
        }
        return !attached // Only swallow when attached
      }

      // Cmd+V on macOS / Ctrl+V on other platforms: intercept paste to handle
      // Finder file copies and normal text paste.
      // We use a capture-phase paste listener (installed below) to grab
      // clipboardData synchronously and suppress ClipboardAddon, avoiding
      // double-paste without any Clipboard API permission dependency.
      if (event[pasteModifier] && event.key.toLowerCase() === 'v' && event.type === 'keydown') {
        // Create a per-request promise so the capture-phase paste listener
        // can deliver clipboardData text directly to this paste attempt.
        // Timeout ensures we don't hang if the paste event never fires.
        // Cancel any pending paste request to prevent overlapping resolvers
        if (pasteTimeoutId !== null) {
          clearTimeout(pasteTimeoutId)
          pasteTimeoutId = null
        }
        pasteResolver = null
        const pastePromise = new Promise<PastePayload | null>((resolve) => {
          pasteTimeoutId = setTimeout(() => {
            pasteTimeoutId = null
            pasteResolver = null
            resolve(null)
          }, 100)
          pasteResolver = (payload: PastePayload) => {
            if (pasteTimeoutId !== null) {
              clearTimeout(pasteTimeoutId)
              pasteTimeoutId = null
            }
            resolve(payload)
          }
        })
        void (async () => {
          try {
            const attached = readySessionRef.current
            if (!attached) return

            // Wait for the paste event to deliver text (up to 100ms timeout).
            // Falls back to clipboard API if paste event didn't fire.
            const payload = await pastePromise
            // With browser uploads enabled, native paste owns clipboard access.
            // Do not issue a second asynchronous read if the browser is slow.
            if (!payload && onPasteFilesRef.current) return
            let text = payload?.text ?? null
            if (text === null) {
              try { text = await navigator.clipboard.readText() } catch { text = '' }
            }

            if (payload?.files.length && onPasteFilesRef.current) {
              if (attachedSessionRef.current === attached && readySessionRef.current === attached) {
                // File copies can also expose just their names as text. Do not
                // insert those names alongside their uploaded paths.
                const names = payload.files.map((file) => file.name).join('\n')
                onPasteFilesRef.current({ files: payload.files, text: text.trim() === names ? '' : text })
              }
              return
            }

            if (payload?.hasImage && getIsMac() && !isiOS) {
              if (!canReadHostClipboard()) {
                if (payload.imageBlob) {
                  const blob = payload.imageBlob
                  onPasteFilesRef.current?.({ text: '', files: [new File([blob], `clipboard.${blob.type.split('/')[1] || 'png'}`, { type: blob.type })] })
                } else onPasteErrorRef.current?.('The browser did not provide image data. Choose the file to upload it.')
                return
              }
              // Upload the clipboard image and deliver its path as a bracketed
              // paste so Claude attaches it natively (works in both renderers).
              const data = await resolveImagePasteData(agentTypeRef.current, { blob: payload.imageBlob })
              sendInputIfStillAttached(attached, data)
              return
            }

            // Finder copies may expose the filename as text alongside file metadata.
            // Resolve the full path before treating that filename as ordinary text.
            if (payload?.hasFiles && !canReadHostClipboard()) {
              onPasteErrorRef.current?.('The browser did not provide file data. Drop the file onto the terminal or choose it to upload.')
              return
            }
            if ((!text || payload?.hasFiles) && getIsMac() && !isiOS && canReadHostClipboard()) {
              try {
                const res = await fetch('/api/clipboard-file-path')
                if (res.ok) {
                  const { path, isImage } = (await res.json()) as { path: string | null; isImage?: boolean }
                  if (path) {
                    if (isImage) {
                      // Deliver the resolved image path as a bracketed paste.
                      const data = await resolveImagePasteData(agentTypeRef.current, { path })
                      sendInputIfStillAttached(attached, data)
                      return
                    }
                    // Send as raw input (no bracket paste) so Claude Code
                    // doesn't detect a paste and read the system clipboard
                    sendInputIfStillAttached(attached, sanitizeImagePath(path))
                    return
                  }
                }
              } catch { /* not on macOS or endpoint unavailable */ }
            }

            if (text && !isMacSharedPasteboardPathText(text)) {
              // Deliver as an explicit paste so the server can bracket it via
              // tmux (paste-buffer -p). Relying on xterm's terminal.paste()
              // would only bracket when the browser's own bracketedPasteMode is
              // on — which it isn't when we attach to an already-running app
              // (e.g. Claude Code in no-flicker/fullscreen), causing multi-line
              // pastes to auto-submit on the first newline. Guard on the live
              // ref (like sendInputIfStillAttached) so a session switch during
              // the async clipboard read doesn't paste into the wrong session.
              if (
                attachedSessionRef.current === attached &&
                readySessionRef.current === attached
              ) {
                // Exit tmux copy-mode first (as onData does for typed input):
                // paste-buffer into a pane still in copy-mode is swallowed by
                // the copy-mode key table instead of reaching the program.
                if (inTmuxCopyModeRef.current) {
                  sendMessageRef.current({ type: 'tmux-cancel-copy-mode', sessionId: attached })
                  setTmuxCopyMode(false)
                }
                sendMessageRef.current({ type: 'terminal-paste', sessionId: attached, data: text })
              }
              return
            }

            // Shared Mac clipboard image pastes can expose only a protected
            // useractivityd path to the browser. Sending that path to an agent
            // is useless; ask the server to resolve a real pasteboard image path
            // (falling back to the empty-bracket signal) so the CLI can attach it.
            if (getIsMac() && !isiOS && canReadHostClipboard()) {
              const data = await resolveImagePasteData(agentTypeRef.current, {})
              sendInputIfStillAttached(attached, data)
            }
          } finally {
            pasteResolver = null
          }
        })()
        // Browser file uploads are handled by the capture-phase paste listener.
        // Safari needs the key's default action to dispatch that native event.
        // On Windows/Linux, continuing through xterm would emit ^V and cancel
        // the browser default. macOS Cmd+V has no such xterm mapping.
        return Boolean(onPasteFilesRef.current) && pasteModifier === 'metaKey'
      }

      // Ctrl+Backspace: delete word backward (browser eats this otherwise)
      if (event.ctrlKey && event.key === 'Backspace' && event.type === 'keydown') {
        const attached = readySessionRef.current
        if (attached) {
          sendMessageRef.current({ type: 'terminal-input', sessionId: attached, data: '\x17' })
        }
        return false
      }

      return true
    })

    // Capture-phase paste listener: when our keydown handler has an active
    // pasteResolver, grab the clipboard text synchronously from clipboardData
    // (no permissions needed) and suppress the event so ClipboardAddon doesn't
    // also paste (preventing double-paste).
    const handlePaste = (e: ClipboardEvent) => {
      if (!pasteResolver) {
        const files = clipboardFiles(e.clipboardData)
        const text = e.clipboardData?.getData('text/plain') ?? ''
        if ((!files.length && !text) || !onPasteFilesRef.current) return
        e.preventDefault()
        e.stopPropagation()
        if (readySessionRef.current && readySessionRef.current === attachedSessionRef.current) {
          const names = files.map(file => file.name).join('\n')
          onPasteFilesRef.current({ text: files.length && text.trim() === names ? '' : text, files })
        }
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const text = e.clipboardData?.getData('text/plain') ?? ''
      const imageBlob = getClipboardImageBlob(e.clipboardData)
      const hasImage = imageBlob !== null || clipboardHasImage(e.clipboardData)
      const resolver = pasteResolver
      pasteResolver = null
      const hasFiles = (e.clipboardData?.files?.length ?? 0) > 0
        || Array.from(e.clipboardData?.items ?? []).some((item) => item.kind === 'file')
        || Array.from(e.clipboardData?.types ?? []).includes('Files')
      resolver({ text, hasImage, hasFiles, imageBlob, files: clipboardFiles(e.clipboardData) })
    }
    container.addEventListener('paste', handlePaste, { capture: true })

    // Handle input - only send to attached session
    terminal.onData((data) => {
      const attached = readySessionRef.current
      if (!attached) return
      // When in copy-mode, drop mouse sequences so clicks don't exit
      // copy-mode; xterm then handles selection locally (Safari desktop).
      if (copyMode.shouldDropInputData(data)) {
        return // Drop mouse event, let xterm handle selection locally
      }

      // If we scrolled in tmux copy-mode, exit it before sending keyboard input
      copyMode.exit(attached)
      sendMessageRef.current({ type: 'terminal-input', sessionId: attached, data })
    })

    // Forward wheel events to tmux for scrollback (like Blink terminal)
    // This enters tmux copy-mode instead of using xterm.js local scrollback
    terminal.attachCustomWheelEventHandler((ev) => copyMode.handleWheelEvent(ev, terminal))

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    return () => {
      // Cancel any pending async operations (font loading)
      cancelled = true
      // Clean up link handling state (mousedown listener, tooltip, addon)
      removeLinkHandling()
      // Remove paste intercept handler
      container.removeEventListener('paste', handlePaste, true)
      if (pasteTimeoutId !== null) {
        clearTimeout(pasteTimeoutId)
        pasteTimeoutId = null
      }
      pasteResolver = null
      disposeWebglAddon(webglAddonRef)
      try {
        terminal.dispose()
      } catch {
        // Ignore
      }
      if (container) {
        container.innerHTML = ''
      }
      terminalRef.current = null
      fitAddonRef.current = null
      searchAddonRef.current = null
      serializeAddonRef.current = null
      progressAddonRef.current = null
      if (fitTimer.current) {
        window.clearTimeout(fitTimer.current)
      }
      copyMode.clearCheckTimer()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitAndResize])

  // Update theme
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = theme
    }
  }, [theme])

  // Update font size, lineHeight, letterSpacing, and fontFamily (maintaining integer cell height)
  useEffect(() => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (terminal && fitAddon) {
      terminal.options.fontFamily = fontFamily
      terminal.options.fontSize = fontSize
      // Recalculate lineHeight for integer cell height
      terminal.options.lineHeight = Math.round(fontSize * lineHeight) / fontSize
      terminal.options.letterSpacing = letterSpacing
      fitAddon.fit()
      // Notify server of new dimensions
      const attached = attachedSessionRef.current
      if (attached) {
        sendMessageRef.current({
          type: 'terminal-resize',
          sessionId: attached,
          cols: terminal.cols,
          rows: terminal.rows,
        })
      }
    }
  }, [fontSize, lineHeight, letterSpacing, fontFamily])

  // Handle WebGL toggle at runtime
  useEffect(() => {
    syncWebglPreference(terminalRef.current, webglAddonRef, useWebGLRef, useWebGL)
  }, [useWebGL])

  // Revoke input synchronously when selection or connection intent changes.
  // The full attach routine remains passive because xterm is initialized in a
  // passive effect, but this layout effect closes the old-pane input window
  // before the browser can deliver another user event.
  useLayoutEffect(() => {
    if (
      readySessionRef.current !== sessionId ||
      !allowAttach ||
      connectionStatus !== 'connected' ||
      (attachedConnectionEpochRef.current >= 0 &&
        attachedConnectionEpochRef.current !== connectionEpoch)
    ) {
      updateReadySession(null)
      if (sessionId && allowAttach && connectionStatus === 'connected') {
        setIsSwitching(true)
      }
    }
  }, [sessionId, allowAttach, connectionStatus, connectionEpoch, updateReadySession])

  // Handle session changes and websocket reconnects - attach/detach.
  useEffect(() => {
    return syncAttachment({
      sessionId,
      tmuxTarget,
      allowAttach,
      connectionStatus,
      connectionEpoch,
      send: (message) => sendMessageRef.current(message),
      getTerminal: () => terminalRef.current,
      getFitAddon: () => fitAddonRef.current,
      serialize: () => serializeAddonRef.current?.serialize(),
      drainOutputBuffer: () => {
        outputBufferRef.current = []
        if (idleTimerRef.current !== null) {
          window.clearTimeout(idleTimerRef.current)
          idleTimerRef.current = null
        }
        if (maxTimerRef.current !== null) {
          window.clearTimeout(maxTimerRef.current)
          maxTimerRef.current = null
        }
      },
      updateReadySession,
      setTmuxCopyMode,
      invalidateWriteBackpressure,
      setIsSwitching,
      refs: {
        attachedSession: attachedSessionRef,
        attachedTarget: attachedTargetRef,
        attachedConnectionEpoch: attachedConnectionEpochRef,
        focusAfterAttachSession: focusAfterAttachSessionRef,
        attachDebounce: attachDebounceRef,
        switchStart: switchStartRef,
        needsReset: needsResetRef,
      },
    })
  }, [sessionId, tmuxTarget, allowAttach, connectionStatus, connectionEpoch, checkScrollPosition, setTmuxCopyMode, invalidateWriteBackpressure, updateReadySession])

  useEffect(() => {
    copyMode.stopPoll()

    if (!sessionId || !allowAttach || connectionStatus !== 'connected') return

    copyMode.startPoll(sessionId)

    return () => {
      copyMode.stopPoll()
    }
  }, [sessionId, allowAttach, connectionStatus])

  // Subscribe to terminal output with idle-based buffering
  // Batches chunks until the stream goes idle to avoid splitting escape sequences
  useEffect(() => {
    const flush = (options?: { force?: boolean }) => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
      if (maxTimerRef.current !== null) {
        window.clearTimeout(maxTimerRef.current)
        maxTimerRef.current = null
      }

      const terminal = terminalRef.current
      const chunks = outputBufferRef.current
      if (!terminal || chunks.length === 0) return

      // Backpressure (design D7): hold the data while earlier writes are still
      // pending, so a slow terminal throttles this stream. Forced flushes (the
      // 50ms cap below and the terminal-ready atomic reset+history write)
      // bypass the hold so output can never stall indefinitely.
      if (!options?.force && pendingWritesRef.current > 0) {
        deferredFlushRef.current = true
        // Single non-restarting cap from the first deferred flush: later
        // chunks extend the held data but must not push the deadline out.
        if (forceFlushTimerRef.current === null) {
          forceFlushTimerRef.current = window.setTimeout(() => {
            forceFlushTimerRef.current = null
            flush({ force: true })
          }, FORCE_FLUSH_MS)
        }
        return
      }

      outputBufferRef.current = []
      deferredFlushRef.current = false
      const data = chunks.join('')

      // Atomically swap: reset + write in same JS task = one rAF frame, no blank
      if (needsResetRef.current) {
        terminal.reset()
        needsResetRef.current = false
      }

      const writeStart = performance.now()
      const dataLen = data.length
      const writeTerminal = terminal
      const writeGeneration = writeGenerationRef.current
      pendingWritesRef.current += 1

      writeTerminal.write(data, () => {
        // Stale ack: the terminal instance was replaced, or a session switch,
        // cleanup or terminal-ready forced write advanced the generation. A
        // boolean guard would let write A's ack consume write B issued after
        // a forced flush — the identity+generation pair closes that hole.
        if (
          terminalRef.current !== writeTerminal ||
          writeGenerationRef.current !== writeGeneration
        ) {
          return
        }
        pendingWritesRef.current -= 1

        const writeMs = Math.round(performance.now() - writeStart)
        // Log slow writes (>50ms) to catch render bottlenecks
        if (writeMs > 50) {
          clientLog('switch_write_slow', {
            sessionId: attachedSessionRef.current,
            writeMs,
            bytes: dataLen,
          })
        }
        if (isiOS && writeMs > 50) {
          clientLog('ios_write_slow', {
            sessionId: attachedSessionRef.current,
            writeMs,
            bytes: dataLen,
          })
        }
        checkScrollPosition()

        // All issued writes have drained: disarm the cap (it exists only
        // while data is held) and, if data was deferred behind them, flush
        // it now (byte order preserved — it was buffered after them).
        if (pendingWritesRef.current === 0) {
          if (forceFlushTimerRef.current !== null) {
            window.clearTimeout(forceFlushTimerRef.current)
            forceFlushTimerRef.current = null
          }
          if (deferredFlushRef.current) {
            deferredFlushRef.current = false
            flush()
          }
        }
      })
    }

    const flushBeforeControl = () => flush({ force: true })
    flushOutputBeforeControlRef.current = flushBeforeControl

    const scheduleFlush = () => {
      // Reset idle timer on each new chunk
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current)
      }
      idleTimerRef.current = window.setTimeout(flush, IDLE_FLUSH_MS)

      // Start max timer if not already running
      if (maxTimerRef.current === null) {
        maxTimerRef.current = window.setTimeout(flush, MAX_FLUSH_MS)
      }
    }

    const unsubscribe = subscribe((message) => {
      const attachedSession = attachedSessionRef.current

      // Log dropped terminal-output to diagnose missing history after kill.
      // Rate-limited (design D8): one report per 5s with a suppressed count.
      if (
        message.type === 'terminal-output' &&
        (!attachedSession || message.sessionId !== attachedSession)
      ) {
        logTerminalOutputDropped({
          messageSessionId: message.sessionId,
          attachedSession,
          bytes: message.data.length,
          hasSwitchStart: switchStartRef.current !== null,
        })
      }

      if (
        message.type === 'terminal-output' &&
        attachedSession &&
        message.sessionId === attachedSession
      ) {
        // Log time from attach-send to first output (server roundtrip)
        const switchStart = switchStartRef.current
        if (switchStart) {
          clientLog('switch_first_output', {
            sessionId: message.sessionId,
            serverRoundtripMs: Math.round(performance.now() - switchStart),
            bytes: message.data.length,
            parseMs: (message as ServerMessageWithDiagnostics)._parseMs ?? -1,
            rawLength: (message as ServerMessageWithDiagnostics)._rawLength ?? -1,
          })
          // Clear so we only log for the first output after a switch
          switchStartRef.current = null
        }

        outputBufferRef.current.push(
          isiOS ? forceTextPresentation(message.data) : message.data
        )
        scheduleFlush()
      }

      if (
        message.type === 'terminal-ready' &&
        attachedSession &&
        message.sessionId === attachedSession
      ) {
        updateReadySession(message.sessionId)
        // If output is buffered but unflushed, flush now so reset+write
        // stay atomic (avoids blank flash from resetting before flush fires).
        // If no output arrived at all (empty pane or server dedup), reset
        // to clear stale content from the previous session.
        if (needsResetRef.current && outputBufferRef.current.length > 0) {
          // Bypass backpressure for the atomic reset+history write, and
          // advance the generation first: acks from writes issued before
          // this boundary (same terminal, prior lifecycle) must not consume
          // the new accounting (design D7).
          invalidateWriteBackpressure()
          flush({ force: true })
        } else if (needsResetRef.current) {
          terminalRef.current?.reset()
          needsResetRef.current = false
        }
        setIsSwitching(false)

        const readySwitchStart = switchStartRef.current
        // switchStartRef may already be cleared by terminal-output above; only log if still set
        if (readySwitchStart) {
          clientLog('switch_ready', {
            sessionId: message.sessionId,
            totalMs: Math.round(performance.now() - readySwitchStart),
          })
          switchStartRef.current = null
        }

        if (focusAfterAttachSessionRef.current === message.sessionId) {
          terminalRef.current?.focus()
          focusAfterAttachSessionRef.current = null
        }

        // Force iOS compositor repaint after reconnect data delivery.
        // The visibilitychange repaint fires early and may only show stale
        // content; this second repaint catches the fresh data from reconnect.
        // Flush pending output first so the repaint captures fresh data.
        // Uses shared scheduleIosRepaint so it coalesces with any pending
        // visibility-triggered repaint (no double-flicker).
        if (isiOS) {
          flush()
          scheduleIosRepaint(50, 'terminal-ready', iosRepaintTarget)
        }
      }

      // Clear switching state on terminal-error so spinner doesn't get stuck
      if (
        message.type === 'terminal-error' &&
        attachedSession &&
        (!message.sessionId || message.sessionId === attachedSession)
      ) {
        updateReadySession(null)
        needsResetRef.current = false
        setIsSwitching(false)
      }

      if (
        message.type === 'clipboard-offer' &&
        attachedSession &&
        message.sessionId === attachedSession
      ) {
        const text = message.text
        if (!text?.trim()) return

        if (!isiOS && navigator.clipboard?.writeText) {
          const startedAt = performance.now()
          void navigator.clipboard.writeText(text)
            .then(() => {
              clientLog('clipboard_write_success', {
                source: message.source,
                chars: text.length,
                durationMs: Math.round(performance.now() - startedAt),
              })
            })
            .catch((error) => {
              clientLog('clipboard_write_failed', {
                source: message.source,
                chars: text.length,
                error: error instanceof Error ? error.message : String(error),
              }, 'warn')
              offerClipboardCopy(text, message.source)
            })
        } else {
          offerClipboardCopy(text, message.source)
        }
      }

      // Handle tmux copy-mode status response
      if (
        message.type === 'tmux-copy-mode-status' &&
        attachedSession &&
        message.sessionId === attachedSession
      ) {
        copyMode.handleStatus(message)
      }
    })

    return () => {
      unsubscribe()
      if (flushOutputBeforeControlRef.current === flushBeforeControl) {
        flushOutputBeforeControlRef.current = null
      }
      // Flush any remaining buffer on cleanup — forced, so backpressure cannot
      // hold data past teardown — then invalidate: the final write's ack must
      // not touch accounting after the subscription is gone.
      flush({ force: true })
      invalidateWriteBackpressure()
      cancelIosRepaint(iosRepaintTarget)
    }
  }, [subscribe, checkScrollPosition, setTmuxCopyMode, offerClipboardCopy, invalidateWriteBackpressure, updateReadySession])

  // Handle resize - with longer debounce to prevent flickering
  useEffect(() => {
    const container = containerRef.current
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current

    if (!container || !terminal || !fitAddon) return

    const handleResize = () => {
      if (resizeTimer.current) {
        window.clearTimeout(resizeTimer.current)
      }

      // Longer debounce to prevent rapid resize events
      resizeTimer.current = window.setTimeout(() => {
        fitAndResize()
      }, 150)
    }

    const observer = new ResizeObserver(handleResize)
    observer.observe(container)

    // Initial fit
    handleResize()

    return () => {
      observer.disconnect()
      if (resizeTimer.current) {
        window.clearTimeout(resizeTimer.current)
      }
    }
  }, [])

  // Force iOS compositor repaint on visibility resume (terminal/iosRepaint.ts):
  // WKWebView shows a stale cached snapshot after background/foreground, and
  // iOS can silently kill the WebGL context — visibility/pageshow/focus each
  // trigger a recreate + repaint, coalesced through the shared scheduler.
  useEffect(() => {
    return installVisibilityHandlers({
      isIOS: isiOS,
      getTerminal: () => terminalRef.current,
      webglAddonRef,
      useWebGLRef,
      getSessionId: () => attachedSessionRef.current,
      repaintTarget: iosRepaintTarget,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isInputReady =
    !!sessionId &&
    allowAttach &&
    connectionStatus === 'connected' &&
    readySessionId === sessionId &&
    readySessionRef.current === sessionId

  return {
    containerRef,
    terminalRef,
    searchAddonRef,
    serializeAddonRef,
    progressAddonRef,
    inTmuxCopyModeRef,
    isTmuxCopyMode,
    appMouseRef,
    setTmuxCopyMode,
    isSwitching,
    isInputReady,
    pendingClipboardOffer,
    copyPendingClipboardOffer,
    dismissPendingClipboardOffer,
  }
}
