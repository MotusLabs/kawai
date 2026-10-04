/**
 * outputCoalescer.ts
 *
 * Per-WebSocket-connection coalescing of terminal-output frames (design D2 of
 * the fix-terminal-keystroke-lag change). Pty data callbacks and history
 * replay can each produce many small chunks per event-loop turn; sending one
 * WebSocket frame per chunk multiplies per-frame overhead on the keystroke-
 * echo path. This module combines chunks destined for one connection that
 * arrive within the same event-loop turn into a single frame, with two hard
 * invariants:
 *
 *   1. Ordering — every non-output message drains pending output first
 *      (`sendOrdered`), so history chunks always precede the terminal-ready
 *      acknowledgement and pending output always precedes terminal-error.
 *   2. Single-session frames — enqueueing a chunk for a different session
 *      drains the old buffer even without an intervening control message.
 *
 * The cap is counted in UTF-8 bytes, not JavaScript string length. A single
 * oversize chunk may exceed the cap and flushes immediately.
 *
 * Lifecycle: the coalescer lives for the socket lifetime. Terminal cleanup
 * clears pending data/timers (`clearPending`) but leaves it reusable for the
 * next attach on the same open socket; socket close `dispose`s it for good.
 */

export interface TerminalOutputCoalescerOptions {
  /** Raw frame send (an open, ready WebSocket send). */
  send: (payload: string) => void
  /** Injected socket-open predicate; nothing is sent once it reports false. */
  isOpen: () => boolean
  /** Early-flush cap in UTF-8 bytes. Default 512 KiB. */
  maxBufferedBytes?: number
}

/** One coalesced terminal-output frame's worth of buffered chunks. */
interface PendingBuffer {
  sessionId: string
  chunks: string[]
  bytes: number
}

const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024

export class TerminalOutputCoalescer {
  private readonly sendFrame: (payload: string) => void
  private readonly isOpen: () => boolean
  private readonly maxBufferedBytes: number
  private pending: PendingBuffer | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(options: TerminalOutputCoalescerOptions) {
    this.sendFrame = options.send
    this.isOpen = options.isOpen
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
  }

  /**
   * Queue one terminal-output chunk for coalesced delivery. Chunks for the
   * same session that arrive before the turn's flush are concatenated into
   * one frame; a chunk for a different session drains the old buffer first.
   */
  enqueue(sessionId: string, data: string): void {
    if (this.disposed) return
    if (!this.isOpen()) {
      // Socket went away; nothing buffered now can ever be delivered.
      this.clearPending()
      return
    }
    if (this.pending && this.pending.sessionId !== sessionId) {
      this.flush()
    }
    if (!this.pending) {
      this.pending = { sessionId, chunks: [], bytes: 0 }
    }
    this.pending.chunks.push(data)
    this.pending.bytes += Buffer.byteLength(data, 'utf8')
    if (this.pending.bytes >= this.maxBufferedBytes) {
      // Early flush at the cap keeps buffered memory bounded; a single
      // oversize chunk lands here too and goes out as one frame.
      this.flush()
      return
    }
    if (this.flushTimer === null) {
      // One timer per event-loop turn: the first chunk arms it, later chunks
      // in the same turn just accumulate.
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        this.flush()
      }, 0)
    }
  }

  /**
   * Send a non-terminal-output message, draining any pending output first —
   * the single ordering rule that keeps control messages strictly after the
   * output they follow on the wire.
   */
  sendOrdered(message: unknown): void {
    if (this.disposed) return
    this.flush()
    if (!this.isOpen()) return
    this.sendFrame(JSON.stringify(message))
  }

  /** Drain pending output now (used by broadcast and sendOrdered). */
  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const pending = this.pending
    this.pending = null
    if (!pending || pending.chunks.length === 0) return
    if (!this.isOpen()) return
    this.sendFrame(
      JSON.stringify({
        type: 'terminal-output',
        sessionId: pending.sessionId,
        data: pending.chunks.join(''),
      })
    )
  }

  /**
   * Drop pending output and cancel the flush timer without disabling the
   * coalescer — terminal cleanup on a socket that stays open and can be
   * re-attached.
   */
  clearPending(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pending = null
  }

  /** Permanent teardown on socket close. */
  dispose(): void {
    this.clearPending()
    this.disposed = true
  }

  isDisposed(): boolean {
    return this.disposed
  }
}
