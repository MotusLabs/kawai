// Output buffering with idle-based flushing and write backpressure
// (design D7): batches terminal-output chunks until the stream goes idle to
// avoid splitting escape sequences, holds data while earlier terminal.write()
// calls are still pending (a slow terminal throttles the stream instead of
// growing xterm's write queue unboundedly), and forces held data through
// after 50ms. The generation token invalidates acks across lifecycle
// boundaries (session switch, detach/disconnect, cleanup, terminal-ready
// forced write) so a stale callback can never consume newer accounting.
// Constructed once per hook instance; the needsReset ref stays hook-owned
// and is shared with the attach state (design D2).
import type { MutableRefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { clientLog } from '../utils/clientLog'

// Tuning: flush when idle for 2ms, or at most every 16ms; data held back by
// backpressure forces through 50ms after the first deferred flush at the latest
const IDLE_FLUSH_MS = 2
const MAX_FLUSH_MS = 16
const FORCE_FLUSH_MS = 50

export interface OutputStreamDeps {
  getTerminal: () => Terminal | null
  getSessionId: () => string | null
  isIOS: boolean
  needsResetRef: MutableRefObject<boolean>
  /** Called after a write's callback settles (scroll-position check). */
  onWriteSettled: () => void
}

export class TerminalOutputStream {
  private buffer: string[] = []
  private idleTimer: number | null = null
  private maxTimer: number | null = null
  private pendingWrites = 0
  private deferredFlush = false
  private forceFlushTimer: number | null = null
  private writeGeneration = 0

  constructor(private deps: OutputStreamDeps) {}

  /** Number of chunks currently buffered (not yet flushed to xterm). */
  get bufferedLength(): number {
    return this.buffer.length
  }

  /** The deferred reset is armed (attach marked the next flush atomic). */
  get needsReset(): boolean {
    return this.deps.needsResetRef.current
  }

  /** Buffer a chunk and (re)arm the idle/max flush timers. */
  push(data: string): void {
    this.buffer.push(data)
    this.scheduleFlush()
  }

  /**
   * Flush buffered chunks to xterm. Forced flushes bypass the backpressure
   * hold (the 50ms cap and the terminal-ready atomic reset+history write)
   * so output can never stall indefinitely; controls must drain held output
   * before writing directly to xterm via flushBeforeControl.
   */
  flush(options?: { force?: boolean }): void {
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.maxTimer !== null) {
      window.clearTimeout(this.maxTimer)
      this.maxTimer = null
    }

    const terminal = this.deps.getTerminal()
    const chunks = this.buffer
    if (!terminal || chunks.length === 0) return

    // Backpressure (design D7): hold the data while earlier writes are still
    // pending, so a slow terminal throttles this stream.
    if (!options?.force && this.pendingWrites > 0) {
      this.deferredFlush = true
      // Single non-restarting cap from the first deferred flush: later
      // chunks extend the held data but must not push the deadline out.
      if (this.forceFlushTimer === null) {
        this.forceFlushTimer = window.setTimeout(() => {
          this.forceFlushTimer = null
          this.flush({ force: true })
        }, FORCE_FLUSH_MS)
      }
      return
    }

    this.buffer = []
    this.deferredFlush = false
    const data = chunks.join('')

    // Atomically swap: reset + write in same JS task = one rAF frame, no blank
    if (this.deps.needsResetRef.current) {
      terminal.reset()
      this.deps.needsResetRef.current = false
    }

    const writeStart = performance.now()
    const dataLen = data.length
    const writeTerminal = terminal
    const writeGeneration = this.writeGeneration
    this.pendingWrites += 1

    writeTerminal.write(data, () => {
      // Stale ack: the terminal instance was replaced, or a session switch,
      // cleanup or terminal-ready forced write advanced the generation. A
      // boolean guard would let write A's ack consume write B issued after
      // a forced flush — the identity+generation pair closes that hole.
      if (
        this.deps.getTerminal() !== writeTerminal ||
        this.writeGeneration !== writeGeneration
      ) {
        return
      }
      this.pendingWrites -= 1

      const writeMs = Math.round(performance.now() - writeStart)
      // Log slow writes (>50ms) to catch render bottlenecks
      if (writeMs > 50) {
        clientLog('switch_write_slow', {
          sessionId: this.deps.getSessionId(),
          writeMs,
          bytes: dataLen,
        })
      }
      if (this.deps.isIOS && writeMs > 50) {
        clientLog('ios_write_slow', {
          sessionId: this.deps.getSessionId(),
          writeMs,
          bytes: dataLen,
        })
      }
      this.deps.onWriteSettled()

      // All issued writes have drained: disarm the cap (it exists only
      // while data is held) and, if data was deferred behind them, flush
      // it now (byte order preserved — it was buffered after them).
      if (this.pendingWrites === 0) {
        if (this.forceFlushTimer !== null) {
          window.clearTimeout(this.forceFlushTimer)
          this.forceFlushTimer = null
        }
        if (this.deferredFlush) {
          this.deferredFlush = false
          this.flush()
        }
      }
    })
  }

  /** Drain held output before writing control sequences (mouse tracking). */
  flushBeforeControl(): void {
    this.flush({ force: true })
  }

  /**
   * Drop buffered chunks and cancel the idle/max flush timers — the
   * attach path does this before arming a new session's deferred reset, so
   * the old session's data cannot consume the new session's one-shot reset.
   */
  clear(): void {
    this.buffer = []
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.maxTimer !== null) {
      window.clearTimeout(this.maxTimer)
      this.maxTimer = null
    }
  }

  /**
   * Invalidate pending-write accounting at a lifecycle boundary: advances
   * the generation so acks from superseded writes become no-ops, and clears
   * the count, deferred flag and force cap.
   */
  invalidate(): void {
    this.writeGeneration += 1
    this.pendingWrites = 0
    this.deferredFlush = false
    if (this.forceFlushTimer !== null) {
      window.clearTimeout(this.forceFlushTimer)
      this.forceFlushTimer = null
    }
  }

  private scheduleFlush(): void {
    // Reset idle timer on each new chunk
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer)
    }
    this.idleTimer = window.setTimeout(() => this.flush(), IDLE_FLUSH_MS)

    // Start max timer if not already running
    if (this.maxTimer === null) {
      this.maxTimer = window.setTimeout(() => this.flush(), MAX_FLUSH_MS)
    }
  }
}
