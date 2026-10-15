// Attach/detach bookkeeping for the terminal's session: detach-reset
// (nulling the attachment refs, optionally telling the server), pending
// attach-debounce cancellation, and the attach effect body — session
// switches, reconnects, epoch changes, and snapshot restore. Refs stay
// hook-owned and are passed in (design D2).
import type { MutableRefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SendClientMessage } from '@shared/types'
import type { ConnectionStatus } from '../stores/sessionStore'
import { clientLog } from '../utils/clientLog'
import { cacheSnapshot, clearSnapshotCache, getCachedSnapshot } from './snapshotCache'

export interface AttachStateRefs {
  attachedSession: MutableRefObject<string | null>
  attachedTarget: MutableRefObject<string | null>
  attachedConnectionEpoch: MutableRefObject<number>
  focusAfterAttachSession: MutableRefObject<string | null>
  attachDebounce: MutableRefObject<number | null>
  switchStart: MutableRefObject<number | null>
  needsReset: MutableRefObject<boolean>
}

export interface SyncAttachmentDeps {
  send: SendClientMessage
  getTerminal: () => Terminal | null
  getFitAddon: () => FitAddon | null
  serialize: () => string | undefined
  drainOutputBuffer: () => void
  updateReadySession: (id: string | null) => void
  setTmuxCopyMode: (value: boolean) => void
  invalidateWriteBackpressure: () => void
  setIsSwitching: (value: boolean) => void
  refs: AttachStateRefs
}

export interface SyncAttachmentParams extends SyncAttachmentDeps {
  sessionId: string | null
  tmuxTarget: string | null
  allowAttach: boolean
  connectionStatus: ConnectionStatus
  connectionEpoch: number
}

/** Null the attachment refs: no session, no target, no epoch, no focus hint. */
export function resetAttachRefs(refs: AttachStateRefs): void {
  refs.attachedSession.current = null
  refs.attachedTarget.current = null
  refs.attachedConnectionEpoch.current = -1
  refs.focusAfterAttachSession.current = null
}

/** Tell the server a session is detached, then reset the attachment refs. */
export function detachFrom(
  send: SendClientMessage,
  prevAttached: string,
  refs: AttachStateRefs
): void {
  send({ type: 'terminal-detach', sessionId: prevAttached })
  resetAttachRefs(refs)
}

/** Cancel a pending debounced attach, if one is scheduled. */
export function cancelPendingAttach(attachDebounce: MutableRefObject<number | null>): void {
  if (attachDebounce.current !== null) {
    window.clearTimeout(attachDebounce.current)
    attachDebounce.current = null
  }
}

/**
 * Handle session changes and websocket reconnects — attach/detach. Returns
 * the effect cleanup (cancelling any pending debounced attach).
 */
export function syncAttachment(opts: SyncAttachmentParams): (() => void) | undefined {
  const { send, refs } = opts
  const {
    sessionId,
    tmuxTarget,
    allowAttach,
    connectionStatus,
    connectionEpoch,
  } = opts
  const terminal = opts.getTerminal()
  if (!terminal) return

  const prevAttached = refs.attachedSession.current
  const prevTarget = refs.attachedTarget.current

  if (!allowAttach) {
    opts.updateReadySession(null)
    cancelPendingAttach(refs.attachDebounce)
    if (prevAttached) {
      send({ type: 'terminal-detach', sessionId: prevAttached })
      resetAttachRefs(refs)
      opts.setTmuxCopyMode(false)
    }
    terminal.reset()
    refs.needsReset.current = false
    opts.invalidateWriteBackpressure()
    opts.setIsSwitching(false)
    return
  }

  // Reattach when websocket comes back: server-side ws.currentSessionId is
  // cleared on disconnect, so input is ignored until a fresh terminal-attach.
  if (connectionStatus !== 'connected') {
    opts.updateReadySession(null)
    cancelPendingAttach(refs.attachDebounce)
    if (prevAttached) {
      clientLog('terminal_detach_on_disconnect', { connectionStatus, prevAttached })
      resetAttachRefs(refs)
      opts.setTmuxCopyMode(false)
    }
    // Server state may have changed — all snapshots are potentially stale
    clearSnapshotCache()
    refs.needsReset.current = false
    opts.invalidateWriteBackpressure()
    opts.setIsSwitching(false)
    return
  }

  // Detach from previous session first
  if (prevAttached && prevAttached !== sessionId) {
    opts.updateReadySession(null)
    // Capture terminal snapshot before detach for instant restore on switch-back
    try {
      const serialized = opts.serialize()
      if (serialized) {
        cacheSnapshot(prevAttached, serialized)
      }
    } catch {
      // serialize() can fail on a disposed terminal — ignore
    }
    send({ type: 'terminal-detach', sessionId: prevAttached })
    resetAttachRefs(refs)
    // Reset copy-mode state - each session has its own scroll position
    opts.setTmuxCopyMode(false)
  }

  // Attach to new session
  const attachedEpoch = refs.attachedConnectionEpoch.current
  const needsReattachForConnection = connectionEpoch !== attachedEpoch

  if (sessionId && (sessionId !== prevAttached || tmuxTarget !== prevTarget || needsReattachForConnection)) {
    clientLog('terminal_attach', {
      sessionId,
      tmuxTarget,
      prevAttached,
      prevTarget,
      connectionStatus,
      connectionEpoch,
      attachedEpoch,
    })
    const switchStart = performance.now()

    // Defer reset until history arrives (no blank flash).
    // Drain stale output buffer first — prevents old session's data
    // from consuming the one-shot reset meant for new session's history.
    opts.drainOutputBuffer()
    // Supersede pending writes from the previous session: their acks must
    // not touch the new attachment's accounting (design D7).
    opts.invalidateWriteBackpressure()
    refs.needsReset.current = true
    opts.setIsSwitching(true)
    if (prevAttached !== null) {
      opts.updateReadySession(null)
    }

    // Instantly show cached snapshot for the target session (if available)
    const cached = getCachedSnapshot(sessionId)
    if (cached) {
      terminal.reset()
      // Isolated lifecycle boundary (design D7 audit): the snapshot restore
      // runs right after backpressure invalidation above, unaccounted —
      // pre-switch acks are already stale and the streaming path starts
      // clean at count zero when live history flushes.
      terminal.write(cached)
      // needsResetRef stays true — live history will replace the snapshot
    }

    // Fit terminal first to get accurate dimensions
    const fitAddon = opts.getFitAddon()
    if (fitAddon) {
      fitAddon.fit()
    }
    const fitDone = performance.now()

    // Mark refs before sending so the output subscriber can match
    // incoming messages to the correct session. Input is naturally suppressed
    // because terminal-input uses attachedSessionRef which won't reach the
    // server until ws.data.currentSessionId is set by the server's handler.
    refs.attachedSession.current = sessionId
    refs.attachedTarget.current = tmuxTarget ?? null
    refs.attachedConnectionEpoch.current = connectionEpoch
    refs.focusAfterAttachSession.current = sessionId

    // Store the start time so the output subscriber can measure end-to-end
    refs.switchStart.current = switchStart

    // Cancel any pending attach from a rapid epoch change
    cancelPendingAttach(refs.attachDebounce)

    const attachMsg = {
      type: 'terminal-attach' as const,
      sessionId,
      tmuxTarget: tmuxTarget ?? undefined,
      cols: terminal.cols,
      rows: terminal.rows,
    }

    const isSessionSwitch = prevAttached !== null && prevAttached !== sessionId

    // Session switch (e.g. after kill): use microtask so the message is sent
    // after the current React commit phase but before the browser yields to
    // new tasks — cannot be cancelled by effect cleanup unlike setTimeout.
    // Reconnection / epoch change: use 50ms debounce to deduplicate rapid
    // re-attaches from rapid epoch changes.
    if (isSessionSwitch) {
      const attachTarget = sessionId
      queueMicrotask(() => {
        // Guard: skip if a newer switch already changed the target
        if (refs.attachedSession.current !== attachTarget) return
        send(attachMsg)
        send({ type: 'tmux-check-copy-mode', sessionId })
      })
    } else {
      refs.attachDebounce.current = window.setTimeout(() => {
        refs.attachDebounce.current = null
        send(attachMsg)
        send({ type: 'tmux-check-copy-mode', sessionId })
      }, 50)
    }

    clientLog('switch_attach_sent', {
      sessionId,
      fitMs: Math.round(fitDone - switchStart),
      totalMs: Math.round(performance.now() - switchStart),
      from: prevAttached ?? null,
      immediate: isSessionSwitch,
    })
  }

  // No attach needed — already attached to this session+target
  if (
    sessionId &&
    sessionId === prevAttached &&
    tmuxTarget === prevTarget &&
    !needsReattachForConnection
  ) {
    clientLog('terminal_attach_skip', {
      sessionId,
      prevAttached,
      connectionStatus,
      connectionEpoch,
      attachedEpoch,
    })
  }
  // Handle deselection — cancel any pending debounced attach
  if (!sessionId && prevAttached) {
    cancelPendingAttach(refs.attachDebounce)
    resetAttachRefs(refs)
    opts.updateReadySession(null)
    // Detach boundary: old acks must not touch later accounting (design D7)
    opts.invalidateWriteBackpressure()
  }

  // Cancel pending debounced attach on effect re-run or unmount
  return () => {
    if (refs.attachDebounce.current !== null) {
      clientLog('attach_debounce_cancelled', {
        sessionId,
        attachedSession: refs.attachedSession.current,
      }, 'info')
      window.clearTimeout(refs.attachDebounce.current)
      refs.attachDebounce.current = null
    }
  }
}
