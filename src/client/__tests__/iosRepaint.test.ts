// Direct unit tests for createIosRepaint (terminal/iosRepaint.ts), pinning
// the per-instance semantics the review restored: one instance's cancel must
// not clear another instance's pending repaint (the pre-move code held this
// state in per-hook refs).
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createIosRepaint, type IosRepaintTarget } from '../terminal/iosRepaint'

const globalAny = globalThis as unknown as {
  window?: unknown
  requestAnimationFrame?: (callback: () => void) => number
  cancelAnimationFrame?: (handle: number) => void
}

const originalWindow = globalAny.window
const originalRaf = globalAny.requestAnimationFrame
const originalCancelRaf = globalAny.cancelAnimationFrame

function createTarget() {
  const displayLog: string[] = []
  const container = {
    style: {
      get display() { return displayLog.length ? displayLog[displayLog.length - 1] : '' },
      set display(value: string) { displayLog.push(value) },
    },
  } as unknown as HTMLDivElement
  const target: IosRepaintTarget = {
    getContainer: () => container,
    getTerminal: () => null,
    getSessionId: () => 'session-1',
  }
  return { target, displayLog }
}

beforeEach(() => {
  globalAny.window = {
    setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  }
})

afterEach(() => {
  globalAny.window = originalWindow
  globalAny.requestAnimationFrame = originalRaf
  globalAny.cancelAnimationFrame = originalCancelRaf
})

describe('createIosRepaint', () => {
  test('one instance cancel does not clear another instance pending repaint', async () => {
    // rAF never fires here: a pending repaint is observable as display 'none'.
    globalAny.requestAnimationFrame = () => 1
    globalAny.cancelAnimationFrame = () => {}

    const a = createTarget()
    const b = createTarget()
    const repaintA = createIosRepaint(a.target)
    const repaintB = createIosRepaint(b.target)

    repaintA.schedule(10, 'a')
    repaintB.schedule(10, 'b')
    // Instance B cancels its own repaint; A's must survive.
    repaintB.cancel()

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(a.displayLog).toContain('none') // A's repaint ran
    expect(b.displayLog).toEqual([]) // B's was cancelled before firing

    repaintA.cancel()
  })

  test('cancel restores the display value when caught mid-toggle', async () => {
    // rAF never fires, so the toggle stays mid-flight after the timer runs.
    globalAny.requestAnimationFrame = () => 1
    globalAny.cancelAnimationFrame = () => {}

    const { target, displayLog } = createTarget()
    const repaint = createIosRepaint(target)
    displayLog.push('block')

    repaint.schedule(5, 'test')
    await new Promise((resolve) => setTimeout(resolve, 15))
    // The timer fired and blanked the container; the rAF restore is pending.
    expect(displayLog).toEqual(['block', 'none'])

    repaint.cancel()
    // Mid-toggle restore puts the previous value back.
    expect(displayLog).toEqual(['block', 'none', 'block'])
  })

  test('schedule replaces a pending repaint without double-blanking', async () => {
    globalAny.requestAnimationFrame = () => 1
    globalAny.cancelAnimationFrame = () => {}

    const { target, displayLog } = createTarget()
    const repaint = createIosRepaint(target)

    repaint.schedule(5, 'first')
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(displayLog).toEqual(['none'])

    // Rescheduling mid-toggle restores the pre-toggle value first...
    repaint.schedule(5, 'second')
    expect(displayLog).toEqual(['none', ''])

    // ...then blanks once again when the replacement timer fires.
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(displayLog).toEqual(['none', '', 'none'])

    repaint.cancel()
  })
})
