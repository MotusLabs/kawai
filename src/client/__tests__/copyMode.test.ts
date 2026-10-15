// Direct unit tests for TmuxCopyModeState (terminal/copyMode.ts): the
// optimistic enter with its mouse-tracking disable, the paired exit, the
// debounced status check, the 750ms status poll, and the app-mouse tracking
// writes driven by status reports. Previously only reachable through
// useTerminal.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TmuxCopyModeState, ENABLE_MOUSE_TRACKING, DISABLE_MOUSE_TRACKING } from '../terminal/copyMode'

const globalAny = globalThis as unknown as { window?: unknown }

const originalWindow = globalAny.window

class TerminalMock {
  writes: string[] = []
  cols = 80
  rows = 24
  hasSelectionValue = false
  buffer = { active: { viewportY: 0, baseY: 0 } }

  write(data: string) {
    this.writes.push(data)
  }

  hasSelection() {
    return this.hasSelectionValue
  }
}

interface Harness {
  state: TmuxCopyModeState
  terminal: TerminalMock
  sends: Array<Record<string, unknown>>
  modeChanges: boolean[]
  flushes: number[]
  scrollReports: boolean[]
  readySession: { current: string | null }
  attachedSession: { current: string | null }
  inCopyMode: { current: boolean }
  appMouse: { current: boolean }
  altScreen: { current: boolean }
}

function createHarness(): Harness {
  const terminal = new TerminalMock()
  const sends: Array<Record<string, unknown>> = []
  const modeChanges: boolean[] = []
  const flushes: number[] = []
  const scrollReports: boolean[] = []
  const readySession = { current: 'session-1' as string | null }
  const attachedSession = { current: 'session-1' as string | null }
  const inCopyMode = { current: false }
  const appMouse = { current: false }
  const altScreen = { current: false }

  const state = new TmuxCopyModeState({
    send: (message) => { sends.push(message as Record<string, unknown>) },
    getTerminal: () => terminal as unknown as import('@xterm/xterm').Terminal,
    getReadySession: () => readySession.current,
    getAttachedSession: () => attachedSession.current,
    inCopyModeRef: inCopyMode,
    appMouseRef: appMouse,
    altScreenRef: altScreen,
    flushOutputBeforeControl: () => { flushes.push(1) },
    onModeChange: (value) => { modeChanges.push(value) },
    getOnScrollChange: () => (isAtBottom: boolean) => { scrollReports.push(isAtBottom) },
  })

  return { state, terminal, sends, modeChanges, flushes, scrollReports, readySession, attachedSession, inCopyMode, appMouse, altScreen }
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

describe('TmuxCopyModeState', () => {
  test('entering copy-mode optimistically disables xterm mouse tracking', () => {
    const h = createHarness()

    h.state.set(true)
    expect(h.inCopyMode.current).toBe(true)
    expect(h.modeChanges).toEqual([true])
    expect(h.terminal.writes).toEqual([DISABLE_MOUSE_TRACKING])
    // Backpressure order preserved: the disable follows a forced flush.
    expect(h.flushes.length).toBe(1)
    // The scroll report follows the copy-mode flip (never at-bottom inside copy-mode).
    expect(h.scrollReports).toEqual([false])
  })

  test('exiting copy-mode writes nothing; tmux re-enables tracking itself', () => {
    const h = createHarness()

    h.state.set(true)
    h.state.set(false)
    expect(h.modeChanges).toEqual([true, false])
    expect(h.terminal.writes).toEqual([DISABLE_MOUSE_TRACKING])
  })

  test('set is a no-op when the value is unchanged', () => {
    const h = createHarness()

    h.state.set(false)
    expect(h.modeChanges).toEqual([])
    expect(h.terminal.writes).toEqual([])

    h.state.set(true)
    h.state.set(true)
    expect(h.modeChanges).toEqual([true])
    expect(h.terminal.writes).toEqual([DISABLE_MOUSE_TRACKING])
  })

  test('exit cancels server-side copy-mode only when active', () => {
    const h = createHarness()

    h.state.exit('session-1')
    expect(h.sends).toEqual([])

    h.state.set(true)
    h.state.exit('session-1')
    expect(h.sends).toEqual([{ type: 'tmux-cancel-copy-mode', sessionId: 'session-1' }])
    expect(h.inCopyMode.current).toBe(false)
  })

  test('requestCheck debounces rapid scroll checks by 150ms', async () => {
    const h = createHarness()

    h.state.requestCheck()
    h.state.requestCheck()
    h.state.requestCheck()
    expect(h.sends).toEqual([])

    await sleep(200)
    expect(h.sends).toEqual([{ type: 'tmux-check-copy-mode', sessionId: 'session-1' }])
  })

  test('requestCheck does nothing without a ready session', async () => {
    const h = createHarness()
    h.readySession.current = null

    h.state.requestCheck()
    await sleep(200)
    expect(h.sends).toEqual([])
  })

  test('clearCheckTimer cancels a pending debounced check', async () => {
    const h = createHarness()

    h.state.requestCheck()
    h.state.clearCheckTimer()
    await sleep(200)
    expect(h.sends).toEqual([])
  })

  test('poll checks the attached session every 750ms and stopPoll ends it', async () => {
    const h = createHarness()

    h.state.startPoll('session-1')
    await sleep(800)
    h.state.stopPoll()
    expect(h.sends.filter((m) => m.type === 'tmux-check-copy-mode').length).toBe(1)

    await sleep(800)
    expect(h.sends.filter((m) => m.type === 'tmux-check-copy-mode').length).toBe(1)
  })

  test('poll skips sends when the attached session no longer matches', async () => {
    const h = createHarness()
    h.attachedSession.current = 'session-2'

    h.state.startPoll('session-1')
    await sleep(800)
    h.state.stopPoll()
    expect(h.sends).toEqual([])
  })

  test('status report app-mouse false→true asserts xterm mouse tracking once', () => {
    const h = createHarness()

    h.state.handleStatus({ appMouse: true, inCopyMode: false, altScreen: true })
    expect(h.appMouse.current).toBe(true)
    expect(h.altScreen.current).toBe(true)
    expect(h.terminal.writes).toEqual([ENABLE_MOUSE_TRACKING])
    expect(h.flushes.length).toBe(1)

    // A second report with appMouse still true writes nothing more.
    h.state.handleStatus({ appMouse: true, inCopyMode: false, altScreen: true })
    expect(h.terminal.writes).toEqual([ENABLE_MOUSE_TRACKING])
  })

  test('copy-mode in the status report wins over app mouse', () => {
    const h = createHarness()

    h.state.handleStatus({ appMouse: true, inCopyMode: true, altScreen: false })
    // nextAppMouse = appMouse && !inCopyMode → false: no ENABLE write.
    expect(h.appMouse.current).toBe(false)
    expect(h.terminal.writes).toEqual([DISABLE_MOUSE_TRACKING])
    expect(h.inCopyMode.current).toBe(true)
  })

  test('wheel scroll-up sends SGR mouse sequences and enters copy-mode optimistically', async () => {
    const h = createHarness()
    const wheel = { deltaY: -60 } as WheelEvent

    const handled = h.state.handleWheelEvent(wheel, h.terminal as unknown as import('@xterm/xterm').Terminal)
    expect(handled).toBe(false)
    const inputs = h.sends.filter((m) => m.type === 'terminal-input')
    expect(inputs).toHaveLength(2) // 60px = 2 steps of 30
    expect(inputs[0].data).toBe('\x1b[<64;40;12M')
    expect(inputs[1].data).toBe('\x1b[<64;40;12M')
    expect(h.inCopyMode.current).toBe(true)

    // The debounced status check fires after the scroll.
    await sleep(200)
    expect(h.sends).toContainEqual({ type: 'tmux-check-copy-mode', sessionId: 'session-1' })
  })

  test('wheel scroll-down does not enter copy-mode', () => {
    const h = createHarness()

    const handled = h.state.handleWheelEvent({ deltaY: 30 } as WheelEvent, h.terminal as unknown as import('@xterm/xterm').Terminal)
    expect(handled).toBe(false)
    expect(h.sends.filter((m) => m.type === 'terminal-input')).toHaveLength(1)
    expect(h.inCopyMode.current).toBe(false)
  })

  test('wheel with app mouse active forwards without copy-mode side effects', async () => {
    const h = createHarness()
    h.state.handleStatus({ appMouse: true, inCopyMode: false, altScreen: false })

    const handled = h.state.handleWheelEvent({ deltaY: -30 } as WheelEvent, h.terminal as unknown as import('@xterm/xterm').Terminal)
    expect(handled).toBe(false)
    expect(h.sends.filter((m) => m.type === 'terminal-input')).toHaveLength(1)
    expect(h.inCopyMode.current).toBe(false)

    await sleep(200)
    expect(h.sends).not.toContainEqual({ type: 'tmux-check-copy-mode', sessionId: 'session-1' })
  })

  test('wheel passthrough: no session, over inputs, with selection, or shift', () => {
    const h = createHarness()
    h.readySession.current = null
    expect(h.state.handleWheelEvent({ deltaY: -30 } as WheelEvent, h.terminal as unknown as import('@xterm/xterm').Terminal)).toBe(true)

    const h2 = createHarness()
    expect(h2.state.handleWheelEvent({ deltaY: -30, target: { closest: () => true } as unknown as EventTarget } as unknown as WheelEvent, h2.terminal as unknown as import('@xterm/xterm').Terminal)).toBe(true)

    const h3 = createHarness()
    h3.terminal.hasSelectionValue = true
    expect(h3.state.handleWheelEvent({ deltaY: -30 } as WheelEvent, h3.terminal as unknown as import('@xterm/xterm').Terminal)).toBe(true)

    const h4 = createHarness()
    expect(h4.state.handleWheelEvent({ deltaY: -30, shiftKey: true } as WheelEvent, h4.terminal as unknown as import('@xterm/xterm').Terminal)).toBe(true)
  })

  test('input data is dropped only for mouse sequences while in copy-mode', () => {
    const h = createHarness()

    expect(h.state.shouldDropInputData('\x1b[<0;10;20M')).toBe(false)
    h.state.set(true)
    expect(h.state.shouldDropInputData('\x1b[<0;10;20M')).toBe(true)
    expect(h.state.shouldDropInputData('\x1b[<0;10;20m')).toBe(true)
    expect(h.state.shouldDropInputData('k')).toBe(false)
  })
})
