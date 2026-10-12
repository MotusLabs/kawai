// Shared WebSocket connection state: the per-socket data record created at
// upgrade time and carried on every ServerWebSocket handle. The clipboard
// watch, copy-mode, and terminal-attach fields carry their own race guards
// (generation counters, in-flight flags); see the ws/ modules that own them.
import type { ITerminalProxy } from '../terminal'
import type { TerminalOutputCoalescer } from '../terminal/outputCoalescer'

export interface WSData {
  terminal: ITerminalProxy | null
  currentSessionId: string | null
  currentTmuxTarget: string | null
  connectionId: string
  remoteAddress: string | null
  userAgent: string | null
  terminalHost: string | null
  terminalAttachSeq: number
  lastAttachKey: string | null
  lastAttachTs: number
  clipboardPollTimer: ReturnType<typeof setInterval> | null
  clipboardPollInFlight: boolean
  lastClipboardBufferKey: string | null
  clipboardBufferArmedUntil: number
  // Unix seconds of the arming gesture. Only buffers created at or after this
  // are offered, so an unrelated/pre-existing buffer change during the armed
  // window can't clobber the clipboard.
  clipboardArmedAtSec: number
  // Incremented on every stop/restart of the clipboard watch. Async work
  // (baseline read, in-flight poll) captures the generation at launch and bails
  // if it no longer matches, so a stale completion can't mutate a newer watch.
  clipboardWatchGen: number
  // Copy-mode checks are async now; with a loaded tmux server a spawn can
  // outlast the client's 750ms poll period and out-of-order replies would
  // stale-flip the copy-mode state. Skip while one is in flight (latest-state
  // semantics, mirroring clipboardPollInFlight).
  copyModeCheckInFlight: boolean
  // Per-connection terminal-output frame coalescer. Lives for the socket
  // lifetime; terminal cleanup only clears its pending buffer.
  outputCoalescer: TerminalOutputCoalescer | null
}
