/**
 * terminalOutputCoalescer.test.ts
 *
 * Unit tests for the per-connection terminal-output coalescer (design D2):
 * one frame per event-loop turn, the drain-before-control ordering rule,
 * UTF-8 byte accounting with early flush at the cap, single-session frames,
 * open-predicate gating, and dispose/cleanup lifecycle semantics.
 */

import { describe, expect, test } from 'bun:test'
import { TerminalOutputCoalescer } from '../terminal/outputCoalescer'

interface SentFrame {
  payload: string
}

function createFakeSocket() {
  const sent: SentFrame[] = []
  let open = true
  return {
    sent,
    isOpen: () => open,
    close: () => {
      open = false
    },
    messages: () => sent.map((f) => JSON.parse(f.payload)),
    terminalOutputs: () =>
      sent
        .map((f) => JSON.parse(f.payload))
        .filter((m) => m.type === 'terminal-output'),
  }
}

/** Yields to the event loop so a scheduled setTimeout(0) flush runs. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1))
}

describe('TerminalOutputCoalescer', () => {
  test('chunks in one event-loop turn become a single frame', async () => {
    const socket = createFakeSocket()
    const coalescer = new TerminalOutputCoalescer({
      send: (payload) => socket.sent.push({ payload }),
      isOpen: socket.isOpen,
    })

    coalescer.enqueue('s1', 'a')
    coalescer.enqueue('s1', 'b')
    coalescer.enqueue('s1', 'c')
    expect(socket.sent).toHaveLength(0) // nothing until the turn ends

    await nextTurn()
    expect(socket.sent).toHaveLength(1)
    expect(socket.messages()[0]).toEqual({
      type: 'terminal-output',
      sessionId: 's1',
      data: 'abc',
    })

    // A later turn gets its own frame.
    coalescer.enqueue('s1', 'd')
    await nextTurn()
    expect(socket.sent).toHaveLength(2)
    expect(socket.terminalOutputs()[1].data).toBe('d')

    coalescer.dispose()
  })

  test('concatenated frame data equals the un-coalesced stream (ANSI + Unicode)', async () => {
    const socket = createFakeSocket()
    const coalescer = new TerminalOutputCoalescer({
      send: (payload) => socket.sent.push({ payload }),
      isOpen: socket.isOpen,
    })
    const chunks = [
      '\x1b[31mred\x1b[0m',
      'héllo — ',
      '你好🚀',
      '\r\n\x1b[?1049h',
      '\x00\x1b[B',
    ]

    for (const chunk of chunks) {
      coalescer.enqueue('s1', chunk)
    }
    await nextTurn()

    const outputs = socket.terminalOutputs()
    expect(outputs).toHaveLength(1)
    expect(outputs[0].data).toBe(chunks.join(''))

    coalescer.dispose()
  })

  test('sendOrdered drains pending output before the control message', async () => {
    const socket = createFakeSocket()
    const coalescer = new TerminalOutputCoalescer({
      send: (payload) => socket.sent.push({ payload }),
      isOpen: socket.isOpen,
    })

    // Attach history chunks, then the ready acknowledgement must follow them.
    coalescer.enqueue('s1', 'history-1\n')
    coalescer.enqueue('s1', 'history-2\n')
    coalescer.sendOrdered({ type: 'terminal-ready', sessionId: 's1' })

    // Ordering is established synchronously — no turn yield needed.
    expect(socket.messages()).toEqual([
      { type: 'terminal-output', sessionId: 's1', data: 'history-1\nhistory-2\n' },
      { type: 'terminal-ready', sessionId: 's1' },
    ])

    // Pending output also precedes terminal-error notifications.
    coalescer.enqueue('s1', 'partial ')
    coalescer.sendOrdered({
      type: 'terminal-error',
      sessionId: 's1',
      code: 'ERR_X',
      message: 'boom',
      retryable: false,
    })
    expect(socket.messages()[2]).toEqual({
      type: 'terminal-output',
      sessionId: 's1',
      data: 'partial ',
    })
    expect(socket.messages()[3].type).toBe('terminal-error')

    coalescer.dispose()
  })

  test('buffered output flushes early at the UTF-8 byte cap', () => {
    const socket = createFakeSocket()
    const coalescer = new TerminalOutputCoalescer({
      send: (payload) => socket.sent.push({ payload }),
      isOpen: socket.isOpen,
      maxBufferedBytes: 16,
    })

    // 3 bytes each in UTF-8 (é = 2 bytes + 1 ascii): fills to exactly 15 < 16.
    for (let i = 0; i < 5; i++) {
      coalescer.enqueue('s1', 'aé')
    }
    expect(socket.sent).toHaveLength(0)

    // Crossing the cap flushes immediately, mid-turn.
    coalescer.enqueue('s1', 'aé')
    expect(socket.sent).toHaveLength(1)
    expect(socket.terminalOutputs()[0].data).toBe('aéaéaéaéaéaé')
    expect(Buffer.byteLength('aéaéaéaéaéaé', 'utf8')).toBe(18)

    // Buffering resumes for the remainder.
    coalescer.enqueue('s1', 'tail')
    expect(socket.sent).toHaveLength(1)

    coalescer.dispose()
  })

  test('a single oversize chunk flushes immediately as one frame', () => {
    const socket = createFakeSocket()
    const coalescer = new TerminalOutputCoalescer({
      send: (payload) => socket.sent.push({ payload }),
      isOpen: socket.isOpen,
      maxBufferedBytes: 10,
    })

    const big = 'x'.repeat(4096)
    coalescer.enqueue('s1', big)
    expect(socket.sent).toHaveLength(1)
    expect(socket.terminalOutputs()[0].data).toBe(big)

    coalescer.dispose()
  })

  test('a session-id change drains the old buffer without a control message', () => {
    const socket = createFakeSocket()
    const coalescer = new TerminalOutputCoalescer({
      send: (payload) => socket.sent.push({ payload }),
      isOpen: socket.isOpen,
    })

    coalescer.enqueue('s1', 'one')
    coalescer.enqueue('s1', 'two')
    coalescer.enqueue('s2', 'three')

    const messages = socket.messages()
    expect(messages).toEqual([
      { type: 'terminal-output', sessionId: 's1', data: 'onetwo' },
    ])
    // s2's chunk is now pending alone and still flushes on the turn timer.
    // (Asserted via the drain triggered by the next session change instead,
    // keeping this test synchronous.)
    coalescer.enqueue('s3', 'four')
    expect(socket.messages()).toEqual([
      { type: 'terminal-output', sessionId: 's1', data: 'onetwo' },
      { type: 'terminal-output', sessionId: 's2', data: 'three' },
    ])

    coalescer.dispose()
  })

  test('nothing is sent once the open predicate reports closed', async () => {
    const socket = createFakeSocket()
    const coalescer = new TerminalOutputCoalescer({
      send: (payload) => socket.sent.push({ payload }),
      isOpen: socket.isOpen,
    })

    coalescer.enqueue('s1', 'buffered')
    socket.close()
    await nextTurn()
    expect(socket.sent).toHaveLength(0)

    // Chunks enqueued after close are dropped, control messages suppressed.
    coalescer.enqueue('s1', 'dropped')
    coalescer.sendOrdered({ type: 'terminal-ready', sessionId: 's1' })
    await nextTurn()
    expect(socket.sent).toHaveLength(0)

    coalescer.dispose()
  })

  test('clearPending drops buffered output but the coalescer stays usable', async () => {
    const socket = createFakeSocket()
    const coalescer = new TerminalOutputCoalescer({
      send: (payload) => socket.sent.push({ payload }),
      isOpen: socket.isOpen,
    })

    coalescer.enqueue('s1', 'stale-output-from-old-attachment')
    coalescer.clearPending()
    await nextTurn()
    expect(socket.sent).toHaveLength(0)

    // Reattach on the same open socket still delivers output.
    coalescer.enqueue('s2', 'fresh')
    await nextTurn()
    expect(socket.terminalOutputs()).toEqual([
      { type: 'terminal-output', sessionId: 's2', data: 'fresh' },
    ])

    coalescer.dispose()
  })

  test('dispose drops pending output and disables the coalescer', async () => {
    const socket = createFakeSocket()
    const coalescer = new TerminalOutputCoalescer({
      send: (payload) => socket.sent.push({ payload }),
      isOpen: socket.isOpen,
    })

    coalescer.enqueue('s1', 'never-sent')
    coalescer.dispose()
    await nextTurn()
    expect(socket.sent).toHaveLength(0)
    expect(coalescer.isDisposed()).toBe(true)

    coalescer.enqueue('s1', 'after-dispose')
    coalescer.sendOrdered({ type: 'terminal-ready', sessionId: 's1' })
    await nextTurn()
    expect(socket.sent).toHaveLength(0)
  })
})
