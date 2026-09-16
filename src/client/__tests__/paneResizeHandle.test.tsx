// paneResizeHandle.test.tsx - Resize control contract: ARIA separator
// semantics, pointer drag with capture and a stubbed container measurement,
// drag clamping at both bounds, and keyboard stepping through the same
// clamped callback.
import { describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import PaneResizeHandle from '../components/PaneResizeHandle'

function stubContainer(height: number) {
  return {
    current: {
      getBoundingClientRect: () => ({ top: 0, bottom: height, height, width: 240 }),
    },
  } as unknown as React.RefObject<HTMLElement | null>
}

function makeTarget() {
  const captured: number[] = []
  const released: number[] = []
  return {
    captured,
    released,
    target: {
      setPointerCapture: (pointerId: number) => captured.push(pointerId),
      hasPointerCapture: (pointerId: number) => captured.includes(pointerId),
      releasePointerCapture: (pointerId: number) => released.push(pointerId),
    },
  }
}

function renderHandle(overrides: Partial<Parameters<typeof PaneResizeHandle>[0]> = {}) {
  const props: Parameters<typeof PaneResizeHandle>[0] = {
    label: 'Remote',
    fraction: 0.25,
    onResize: () => {},
    containerRef: stubContainer(1000),
    ...overrides,
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<PaneResizeHandle {...props} />)
  })
  const handle = renderer.root.findByProps({ 'data-testid': 'pane-resize-handle' })
  return { renderer, handle, props }
}

describe('PaneResizeHandle ARIA contract', () => {
  test('exposes separator semantics with whole-percent values', () => {
    const { handle } = renderHandle()
    expect(handle.props.role).toBe('separator')
    expect(handle.props['aria-orientation']).toBe('horizontal')
    expect(handle.props['aria-label']).toBe('Resize Remote pane')
    expect(handle.props['aria-valuenow']).toBe(25)
    expect(handle.props['aria-valuemin']).toBe(10)
    expect(handle.props['aria-valuemax']).toBe(60)
    expect(handle.props.tabIndex).toBe(0)
    expect(handle.props.style.touchAction).toBe('none')
  })

  test('reports custom bounds and rounds the current value to whole percents', () => {
    const { handle } = renderHandle({ fraction: 0.333, min: 0.05, max: 0.5 })
    expect(handle.props['aria-valuenow']).toBe(33)
    expect(handle.props['aria-valuemin']).toBe(5)
    expect(handle.props['aria-valuemax']).toBe(50)
  })
})

describe('PaneResizeHandle pointer drag', () => {
  test('dragging up grows the pane by the pointer delta over the container height', () => {
    const resizes: number[] = []
    const { handle } = renderHandle({ onResize: (f) => resizes.push(f) })
    const { target, captured } = makeTarget()

    act(() => {
      handle.props.onPointerDown({ clientY: 800, pointerId: 7, currentTarget: target })
    })
    expect(captured).toEqual([7])

    act(() => {
      handle.props.onPointerMove({ clientY: 700 })
    })
    // 0.25 + 100px of a 1000px container = 0.35.
    expect(resizes).toEqual([0.35])
  })

  test('dragging past the bounds clamps instead of exceeding them', () => {
    const resizes: number[] = []
    const { handle } = renderHandle({ onResize: (f) => resizes.push(f) })
    const { target } = makeTarget()

    act(() => {
      handle.props.onPointerDown({ clientY: 500, pointerId: 1, currentTarget: target })
    })
    act(() => {
      handle.props.onPointerMove({ clientY: -10000 })
    })
    act(() => {
      handle.props.onPointerMove({ clientY: 10000 })
    })
    expect(resizes).toEqual([0.6, 0.1])
  })

  test('pointerup releases capture and ends the drag', () => {
    const resizes: number[] = []
    const { handle } = renderHandle({ onResize: (f) => resizes.push(f) })
    const { target, released } = makeTarget()

    act(() => {
      handle.props.onPointerDown({ clientY: 800, pointerId: 3, currentTarget: target })
    })
    act(() => {
      handle.props.onPointerUp({ clientY: 700, pointerId: 3, currentTarget: target })
    })
    expect(released).toEqual([3])

    // Movement after the drag ended reports nothing.
    act(() => {
      handle.props.onPointerMove({ clientY: 100 })
    })
    expect(resizes).toEqual([])
  })

  test('pointermove without an active drag is ignored', () => {
    const resizes: number[] = []
    const { handle } = renderHandle({ onResize: (f) => resizes.push(f) })
    act(() => {
      handle.props.onPointerMove({ clientY: 100 })
    })
    expect(resizes).toEqual([])
  })

  test('a missing or zero-height container never starts a drag', () => {
    const resizes: number[] = []
    const { handle } = renderHandle({
      onResize: (f) => resizes.push(f),
      containerRef: stubContainer(0),
    })
    const { target, captured } = makeTarget()
    act(() => {
      handle.props.onPointerDown({ clientY: 800, pointerId: 9, currentTarget: target })
    })
    expect(captured).toEqual([])
    act(() => {
      handle.props.onPointerMove({ clientY: 700 })
    })
    expect(resizes).toEqual([])
  })
})

describe('PaneResizeHandle keyboard resize', () => {
  test('arrow keys step the fraction and Home/End jump to the bounds', () => {
    const resizes: number[] = []
    const { handle } = renderHandle({ onResize: (f) => resizes.push(f) })

    act(() => {
      handle.props.onKeyDown({ key: 'ArrowUp', preventDefault: () => {} })
    })
    act(() => {
      handle.props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} })
    })
    act(() => {
      handle.props.onKeyDown({ key: 'End', preventDefault: () => {} })
    })
    act(() => {
      handle.props.onKeyDown({ key: 'Home', preventDefault: () => {} })
    })
    expect(resizes).toEqual([0.27, 0.23, 0.6, 0.1])
  })

  test('keyboard steps clamp at the bounds', () => {
    const resizes: number[] = []
    const { handle } = renderHandle({ fraction: 0.59, onResize: (f) => resizes.push(f) })
    act(() => {
      handle.props.onKeyDown({ key: 'ArrowUp', preventDefault: () => {} })
    })
    expect(resizes).toEqual([0.6])
  })

  test('unhandled keys neither resize nor swallow the event', () => {
    const resizes: number[] = []
    let prevented = false
    const { handle } = renderHandle({ onResize: (f) => resizes.push(f) })
    act(() => {
      handle.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented = true } })
    })
    expect(resizes).toEqual([])
    expect(prevented).toBe(false)
  })
})
