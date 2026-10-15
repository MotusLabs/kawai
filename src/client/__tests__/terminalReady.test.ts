// Direct unit tests for handleTerminalReady (terminal/terminalReady.ts):
// the atomic buffered-flush vs bare-reset decision, switch-ready timing,
// focus return, and the iOS pre-repaint flush. Asserts only local state —
// no module mocks, so nothing here leaks into other test files; the iOS
// repaint schedule is observed through the recorded timer, and the pending
// repaint is cancelled after each test (iosRepaint is a module singleton).
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { handleTerminalReady, type TerminalReadyDeps } from '../terminal/terminalReady'
import { createIosRepaint, type IosRepaintController, type IosRepaintTarget } from '../terminal/iosRepaint'

const globalAny = globalThis as unknown as {
  window?: unknown
  requestAnimationFrame?: (callback: () => void) => number
  cancelAnimationFrame?: (handle: number) => void
}

const originalWindow = globalAny.window
const originalRaf = globalAny.requestAnimationFrame
const originalCancelRaf = globalAny.cancelAnimationFrame

class TerminalMock {
  resets = 0
  focusCalls = 0
  reset() { this.resets += 1 }
  focus() { this.focusCalls += 1 }
}

interface OutputMock {
  needsReset: boolean
  bufferedLength: number
  flushes: Array<{ force?: boolean } | undefined>
}

/** Timer schedules made through the window shim (ms per schedule). */
const scheduledTimers: number[] = []

let lastRepaint: IosRepaintController | null = null

function createDeps(output: OutputMock) {
  const terminal = new TerminalMock()
  const readySessions: Array<string | null> = []
  const switching: boolean[] = []
  const invalidates: number[] = []
  const needsResetRef = { current: output.needsReset }
  const switchStartRef = { current: null as number | null }
  const focusAfterAttachSessionRef = { current: 'session-1' as string | null }
  const repaintTarget: IosRepaintTarget = {
    getContainer: () => ({ style: {} }) as unknown as HTMLDivElement,
    getTerminal: () => null,
    getSessionId: () => 'session-1',
  }
  const repaint = createIosRepaint(repaintTarget)
  lastRepaint = repaint
  const deps: TerminalReadyDeps = {
    getTerminal: () => terminal as unknown as import('@xterm/xterm').Terminal,
    output: {
      get needsReset() { return output.needsReset },
      get bufferedLength() { return output.bufferedLength },
      flush: (options?: { force?: boolean }) => { output.flushes.push(options) },
    } as unknown as TerminalReadyDeps['output'],
    needsResetRef,
    switchStartRef,
    focusAfterAttachSessionRef,
    updateReadySession: (id) => { readySessions.push(id) },
    setIsSwitching: (value) => { switching.push(value) },
    invalidateWriteBackpressure: () => { invalidates.push(1) },
    isIOS: false,
    repaint,
  }
  return { deps, terminal, readySessions, switching, invalidates, needsResetRef, switchStartRef, focusAfterAttachSessionRef }
}

beforeEach(() => {
  scheduledTimers.length = 0
  globalAny.window = {
    setTimeout: (handler: () => void, ms?: number) => {
      scheduledTimers.push(ms ?? 0)
      return setTimeout(handler, ms) as unknown as number
    },
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  }
  globalAny.requestAnimationFrame = (callback: () => void) =>
    setTimeout(callback, 0) as unknown as number
  globalAny.cancelAnimationFrame = (handle: number) =>
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
})

afterEach(() => {
  // Cancel any pending singleton repaint before tearing down the shims.
  lastRepaint?.cancel()
  globalAny.window = originalWindow
  globalAny.requestAnimationFrame = originalRaf
  globalAny.cancelAnimationFrame = originalCancelRaf
})

describe('handleTerminalReady', () => {
  test('flushes buffered output atomically when a reset is pending', () => {
    const output = { needsReset: true, bufferedLength: 2, flushes: [] as Array<{ force?: boolean } | undefined> }
    const h = createDeps(output)

    handleTerminalReady('session-1', h.deps)
    // Atomic path: invalidate first, then a forced flush; no bare reset.
    expect(h.invalidates).toHaveLength(1)
    expect(output.flushes).toEqual([{ force: true }])
    expect(h.terminal.resets).toBe(0)
    expect(h.readySessions).toEqual(['session-1'])
    expect(h.switching).toEqual([false])
  })

  test('resets bare when no output arrived', () => {
    const output = { needsReset: true, bufferedLength: 0, flushes: [] as Array<{ force?: boolean } | undefined> }
    const h = createDeps(output)

    handleTerminalReady('session-1', h.deps)
    expect(h.terminal.resets).toBe(1)
    expect(h.needsResetRef.current).toBe(false)
    expect(output.flushes).toEqual([])
    expect(h.invalidates).toHaveLength(0)
  })

  test('clears the switch start on the first ready report only', () => {
    const output = { needsReset: false, bufferedLength: 0, flushes: [] as Array<{ force?: boolean } | undefined> }
    const h = createDeps(output)
    h.switchStartRef.current = 100

    handleTerminalReady('session-1', h.deps)
    expect(h.switchStartRef.current).toBeNull()

    handleTerminalReady('session-1', h.deps)
    expect(h.switchStartRef.current).toBeNull()
  })

  test('returns focus when the ready session matches the focus hint', () => {
    const output = { needsReset: false, bufferedLength: 0, flushes: [] as Array<{ force?: boolean } | undefined> }
    const h = createDeps(output)

    handleTerminalReady('session-1', h.deps)
    expect(h.terminal.focusCalls).toBe(1)
    expect(h.focusAfterAttachSessionRef.current).toBeNull()

    // A later ready for a session that no longer matches does not focus.
    h.focusAfterAttachSessionRef.current = 'other'
    handleTerminalReady('session-1', h.deps)
    expect(h.terminal.focusCalls).toBe(1)
  })

  test('iOS flushes again before scheduling the post-data repaint', () => {
    const output = { needsReset: false, bufferedLength: 0, flushes: [] as Array<{ force?: boolean } | undefined> }
    const h = createDeps(output)
    ;(h.deps as { isIOS: boolean }).isIOS = true

    handleTerminalReady('session-1', h.deps)
    expect(output.flushes).toEqual([undefined]) // the pre-repaint drain
    // The repaint itself is the scheduled 50ms timer.
    expect(scheduledTimers).toContain(50)
  })

  test('non-iOS schedules no repaint', () => {
    const output = { needsReset: false, bufferedLength: 0, flushes: [] as Array<{ force?: boolean } | undefined> }
    const h = createDeps(output)

    handleTerminalReady('session-1', h.deps)
    expect(output.flushes).toEqual([])
    expect(scheduledTimers).toEqual([])
  })
})
