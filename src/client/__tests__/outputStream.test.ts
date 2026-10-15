// Direct unit tests for the TerminalOutputStream (terminal/outputStream.ts):
// buffering, idle/max flush, the backpressure hold with its 50ms force cap,
// and the generation token that discards stale write acks across lifecycle
// boundaries. Previously this logic was only reachable through useTerminal.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TerminalOutputStream } from '../terminal/outputStream'

const globalAny = globalThis as unknown as { window?: unknown }

const originalWindow = globalAny.window

class TerminalMock {
  writes: string[] = []
  writeCallbacks: Array<() => void> = []
  resets = 0

  write(data: string, callback?: () => void) {
    this.writes.push(data)
    if (callback) this.writeCallbacks.push(callback)
  }

  reset() {
    this.resets += 1
  }

  /** Resolve the oldest unresolved write callback. */
  ack(): void {
    this.writeCallbacks.shift()?.()
  }
}

function createStream(getTerminal: () => TerminalMock | null) {
  const settled: number[] = []
  const needsResetRef = { current: false }
  const stream = new TerminalOutputStream({
    getTerminal: () => getTerminal() as unknown as import('@xterm/xterm').Terminal | null,
    getSessionId: () => 'session-1',
    isIOS: false,
    needsResetRef,
    onWriteSettled: () => settled.push(1),
  })
  return { stream, settled, needsResetRef }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  globalAny.window = {
    setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  }
})

afterEach(() => {
  globalAny.window = originalWindow
})

describe('TerminalOutputStream', () => {
  test('buffers chunks and flushes them joined', () => {
    const terminal = new TerminalMock()
    const { stream } = createStream(() => terminal)

    stream.push('a')
    stream.push('b')
    expect(terminal.writes).toEqual([])

    stream.flush()
    expect(terminal.writes).toEqual(['ab'])
    expect(stream.bufferedLength).toBe(0)
  })

  test('flush with an empty buffer writes nothing and stays clean', () => {
    const terminal = new TerminalMock()
    const { stream } = createStream(() => terminal)

    stream.flush()
    stream.flush({ force: true })
    expect(terminal.writes).toEqual([])
  })

  test('consumes the deferred reset atomically with the first write', async () => {
    const terminal = new TerminalMock()
    const { stream, needsResetRef } = createStream(() => terminal)
    needsResetRef.current = true

    stream.push('history')
    stream.flush()
    expect(terminal.resets).toBe(1)
    expect(terminal.writes).toEqual(['history'])
    expect(needsResetRef.current).toBe(false)

    // The reset is one-shot: a later flush must not reset again. The first
    // write is still pending, so the idle timer's flush defers behind it —
    // ack it, then let the idle timer flush 'more' through.
    stream.push('more')
    terminal.ack()
    await sleep(20)
    expect(terminal.resets).toBe(1)
    expect(terminal.writes).toEqual(['history', 'more'])
  })

  test('clear drops buffered chunks and cancels pending flushes', async () => {
    const terminal = new TerminalMock()
    const { stream } = createStream(() => terminal)

    stream.push('stale')
    stream.clear()
    await sleep(20) // the idle timer (2ms) would have fired by now
    expect(terminal.writes).toEqual([])
    expect(stream.bufferedLength).toBe(0)
  })

  test('holds data behind a pending write and drains it when the ack lands', () => {
    const terminal = new TerminalMock()
    const { stream, settled } = createStream(() => terminal)

    stream.push('first')
    stream.flush()
    expect(terminal.writes).toEqual(['first'])

    // First write still pending: a normal flush must defer, not write.
    stream.push('second')
    stream.flush()
    expect(terminal.writes).toEqual(['first'])

    // The ack drains the count and flushes the held data in order.
    terminal.ack()
    expect(settled.length).toBe(1)
    expect(terminal.writes).toEqual(['first', 'second'])
  })

  test('forced flush bypasses the backpressure hold', () => {
    const terminal = new TerminalMock()
    const { stream } = createStream(() => terminal)

    stream.push('first')
    stream.flush()
    stream.push('held')
    stream.flush({ force: true })
    expect(terminal.writes).toEqual(['first', 'held'])
  })

  test('held data forces through after 50ms despite a stuck write', async () => {
    const terminal = new TerminalMock()
    const { stream } = createStream(() => terminal)

    stream.push('first')
    stream.flush()
    stream.push('held')
    stream.flush() // defers behind the pending write

    await sleep(70)
    expect(terminal.writes).toEqual(['first', 'held'])
  })

  test('invalidate discards a pending write ack via the generation token', () => {
    const terminal = new TerminalMock()
    const { stream, settled } = createStream(() => terminal)

    stream.push('stale-session')
    stream.flush()
    expect(terminal.writes).toEqual(['stale-session'])

    stream.invalidate() // session-switch boundary
    terminal.ack() // the stale ack must be a no-op

    expect(settled.length).toBe(0)
    // Accounting was cleared, so a fresh flush is not deferred.
    stream.push('fresh')
    stream.flush()
    expect(terminal.writes).toEqual(['stale-session', 'fresh'])
  })

  test('a stale ack from a replaced terminal instance is discarded', () => {
    const first = new TerminalMock()
    let current: TerminalMock = first
    const { stream, settled } = createStream(() => current)

    stream.push('old-terminal')
    stream.flush()
    expect(first.writes).toEqual(['old-terminal'])

    // Terminal instance replaced (remount) before the ack landed.
    current = new TerminalMock()
    first.ack() // identity mismatch must make this a no-op

    expect(settled.length).toBe(0)
    // pendingWrites is still 1, so a normal flush defers behind the ghost.
    stream.push('new-terminal')
    stream.flush()
    expect(current.writes).toEqual([])
    // ...and a forced flush gets the new data through.
    stream.flush({ force: true })
    expect(current.writes).toEqual(['new-terminal'])
  })

  test('invalidate clears the deferred flag and force cap', async () => {
    const terminal = new TerminalMock()
    const { stream } = createStream(() => terminal)

    stream.push('first')
    stream.flush()
    stream.push('held')
    stream.flush() // arms the 50ms force cap behind the pending write

    stream.invalidate()
    await sleep(70) // the disarmed cap must not write the held data
    expect(terminal.writes).toEqual(['first'])
    expect(stream.bufferedLength).toBe(1)
  })
})
