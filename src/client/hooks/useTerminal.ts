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
import type { AgentType, SendClientMessage, SubscribeServerMessage } from '@shared/types'
import { clientLog } from '../utils/clientLog'
import type { ConnectionStatus } from '../stores/sessionStore'
import { clearSnapshotCache } from '../terminal/snapshotCache'
import { logFirstOutputAfterSwitch, logTerminalOutputDropped } from '../terminal/droppedOutputLog'
import { cancelIosRepaint, installVisibilityHandlers, type IosRepaintTarget } from '../terminal/iosRepaint'
import { handleTerminalReady, type TerminalReadyDeps } from '../terminal/terminalReady'
import { usePendingClipboardOffer } from '../terminal/clipboardOffer'
import { applyTheme, applyFontSettings } from '../terminal/appearance'
import { syncWebglPreference } from '../terminal/webgl'
import { TmuxCopyModeState } from '../terminal/copyMode'
import { syncAttachment } from '../terminal/attachState'
import { TerminalOutputStream } from '../terminal/outputStream'
import { PasteChannel, deliverClipboardOffer } from '../terminal/pasteChannel'
import { setupTerminal } from '../terminal/setup'
import { forceTextPresentation } from '../terminal/textPresentation'
import { isIOSDevice } from '../utils/device'

// Public helpers re-exported so existing importers keep their paths; the
// implementations live in the terminal/ modules.
export {
  invalidateSnapshotCache,
  clearSnapshotCache,
} from '../terminal/snapshotCache'
export { resetDroppedOutputRateLimiterForTests } from '../terminal/droppedOutputLog'
export { sanitizeLink } from '../terminal/linkSanitize'
export { forceTextPresentation } from '../terminal/textPresentation'


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
  const {
    pending: pendingClipboardOffer,
    offer: offerClipboardCopy,
    copy: copyPendingClipboardOffer,
    dismiss: dismissPendingClipboardOffer,
  } = usePendingClipboardOffer()

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

  // Write backpressure (design D7): the buffering, flush timers, and
  // generation token live in the TerminalOutputStream (terminal/outputStream.ts).
  // This ref lets controls drain held output before writing directly to xterm
  // and is armed only while the output subscription is live.
  const flushOutputBeforeControlRef = useRef<(() => void) | null>(null)

  // Deferred reset: defer terminal.reset() until history arrives to avoid blank flash
  const needsResetRef = useRef(false)
  const [isSwitching, setIsSwitching] = useState(false)

  // iOS compositor repaint — shared by visibility and subscriber effects,
  // unified so only one repaint can be in-flight at a time. The module holds
  // the timer/raf state; accessors read the hook's live refs (design D2).
  const iosRepaintTarget: IosRepaintTarget = {
    getContainer: () => containerRef.current,
    getTerminal: () => terminalRef.current,
    getSessionId: () => attachedSessionRef.current,
  }

  // Keep latest callbacks/options in refs for the stable module instances.
  useEffect(() => {
    sendMessageRef.current = sendMessage
    agentTypeRef.current = agentType
    onScrollChangeRef.current = onScrollChange
  }, [sendMessage, agentType, onScrollChange])


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
      getOnScrollChange: () => onScrollChangeRef.current,
    })
  }
  const copyMode = copyModeRef.current

  const setTmuxCopyMode = useCallback(
    (nextValue: boolean) => copyMode.set(nextValue),
    [copyMode]
  )

  // Output stream (terminal/outputStream.ts): buffer + flush timers +
  // backpressure with the generation token.
  const outputStreamRef = useRef<TerminalOutputStream | null>(null)
  if (!outputStreamRef.current) {
    outputStreamRef.current = new TerminalOutputStream({
      getTerminal: () => terminalRef.current,
      getSessionId: () => attachedSessionRef.current,
      isIOS: isiOS,
      needsResetRef,
      onWriteSettled: () => copyMode.checkScrollPosition(),
    })
  }
  const output = outputStreamRef.current

  // Paste channel (terminal/pasteChannel.ts): resolver machinery + image paths.
  const pasteChannelRef = useRef<PasteChannel | null>(null)
  if (!pasteChannelRef.current) {
    pasteChannelRef.current = new PasteChannel({
      send: (message) => sendMessageRef.current(message),
      getReadySession: () => readySessionRef.current,
      getAttachedSession: () => attachedSessionRef.current,
      getAgentType: () => agentTypeRef.current,
      getOnPasteFiles: () => onPasteFilesRef.current,
      onPasteError: (message) => onPasteErrorRef.current?.(message),
      canReadHostClipboard,
      isIOS: isiOS,
      exitCopyMode: (sessionId) => copyMode.exit(sessionId),
    })
  }
  const pasteChannel = pasteChannelRef.current

  // Invalidate pending-write accounting at a lifecycle boundary (session
  // switch, detach/disconnect, cleanup): the stream advances its generation
  // so acks from superseded writes become no-ops.
  const invalidateWriteBackpressure = useCallback(() => output.invalidate(), [output])

  // terminal-ready handling deps (terminal/terminalReady.ts), reading live refs.
  const terminalReadyDeps: TerminalReadyDeps = {
    getTerminal: () => terminalRef.current,
    output,
    needsResetRef,
    switchStartRef,
    focusAfterAttachSessionRef,
    updateReadySession,
    setIsSwitching,
    invalidateWriteBackpressure,
    isIOS: isiOS,
    repaintTarget: iosRepaintTarget,
  }

  // Terminal initialization - only once on mount (terminal/setup.ts):
  // create + open after fonts, links, key routing, paste capture, input,
  // wheel, and the matching teardown.
  useEffect(() => {
    return setupTerminal({
      getContainer: () => containerRef.current,
      createOptions: {
        fontFamily,
        fontSize,
        lineHeight,
        letterSpacing,
        theme,
        screenReaderMode: isiOS,
        onClipboardWriteFailed: offerClipboardCopy,
      },
      refs: {
        terminal: terminalRef,
        fitAddon: fitAddonRef,
        searchAddon: searchAddonRef,
        serializeAddon: serializeAddonRef,
        progressAddon: progressAddonRef,
        fitTimer,
        resizeTimer,
      },
      useWebGLRef,
      webglAddonRef,
      logWebglContextLoss: () => clientLog('webgl_context_loss', { sessionId }, 'info'),
      hasLoggedInitRef,
      isIOS: isiOS,
      copyMode,
      pasteChannel,
      getReadySession: () => readySessionRef.current,
      getAttachedSession: () => attachedSessionRef.current,
      send: (message) => sendMessageRef.current(message),
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update theme
  useEffect(() => {
    applyTheme(terminalRef.current, theme)
  }, [theme])

  // Update font size, lineHeight, letterSpacing, and fontFamily (maintaining integer cell height)
  useEffect(() => {
    applyFontSettings(
      terminalRef.current,
      fitAddonRef.current,
      { fontFamily, fontSize, lineHeight, letterSpacing },
      (cols, rows) => {
        // Notify server of new dimensions
        const attached = attachedSessionRef.current
        if (attached) {
          sendMessageRef.current({
            type: 'terminal-resize',
            sessionId: attached,
            cols,
            rows,
          })
        }
      }
    )
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
      drainOutputBuffer: () => output.clear(),
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
  }, [sessionId, tmuxTarget, allowAttach, connectionStatus, connectionEpoch, setTmuxCopyMode, invalidateWriteBackpressure, updateReadySession])

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
    const flushBeforeControl = () => output.flushBeforeControl()
    flushOutputBeforeControlRef.current = flushBeforeControl

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
          logFirstOutputAfterSwitch(message, switchStart, () => {
            switchStartRef.current = null
          })
        }

        output.push(
          isiOS ? forceTextPresentation(message.data) : message.data
        )
      }

      if (
        message.type === 'terminal-ready' &&
        attachedSession &&
        message.sessionId === attachedSession
      ) {
        handleTerminalReady(message.sessionId, terminalReadyDeps)
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
        deliverClipboardOffer(message.text, message.source, {
          isIOS: isiOS,
          onManualCopy: offerClipboardCopy,
        })
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
      output.flush({ force: true })
      invalidateWriteBackpressure()
      cancelIosRepaint(iosRepaintTarget)
    }
  }, [subscribe, setTmuxCopyMode, offerClipboardCopy, invalidateWriteBackpressure, updateReadySession])

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
