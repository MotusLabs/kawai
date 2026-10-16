// The header layout hook (chat-header-layout D6, chat-transcript-layout D4):
// steps from the header's own width in chat-font ems, observed with
// ResizeObserver, sized for the identity/actions row.
import { afterEach, expect, test } from 'bun:test'
import { useRef } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { FULL_MIN_EM, ICONS_MIN_EM, headerLayoutForWidth, useHeaderLayout, type HeaderLayout } from '../hooks/useHeaderLayout'

const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
afterEach(() => { (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original })

test('the steps follow width in ems on each side of both thresholds', () => {
  expect(headerLayoutForWidth(FULL_MIN_EM * 15, 15)).toBe('full')
  expect(headerLayoutForWidth(FULL_MIN_EM * 15 - 1, 15)).toBe('icons')
  expect(headerLayoutForWidth(ICONS_MIN_EM * 15, 15)).toBe('icons')
  expect(headerLayoutForWidth(ICONS_MIN_EM * 15 - 1, 15)).toBe('menu')
})

test('the steps are sized for the identity/actions row, not the former panel switcher', () => {
  // A 640px header at the default 15px font fits the labelled Team button.
  expect(headerLayoutForWidth(640, 15)).toBe('full')
  expect(headerLayoutForWidth(520, 15)).toBe('icons')
  expect(headerLayoutForWidth(480, 15)).toBe('menu')
})

test('a larger chat font needs a wider header for the same layout', () => {
  const width = 600 // 50 ems at 12px, 30 ems at 20px
  expect(headerLayoutForWidth(width, 12)).toBe('full')
  expect(headerLayoutForWidth(width, 20)).toBe('menu')
})

class FakeObserver {
  static instances: FakeObserver[] = []
  observed: unknown[] = []
  disconnected = false
  constructor(public callback: (entries: Array<{ contentRect: { width: number } }>) => void) { FakeObserver.instances.push(this) }
  observe(element: unknown) { this.observed.push(element) }
  disconnect() { this.disconnected = true }
  resize(width: number) { this.callback([{ contentRect: { width } }]) }
}

function Probe({ fontSize, seen }: { fontSize: number; seen: HeaderLayout[] }) {
  const ref = useRef<HTMLElement | null>({} as HTMLElement)
  seen.push(useHeaderLayout(ref, fontSize))
  return null
}

test('the hook reads the observed width, follows resizes and font size, and disconnects on unmount', () => {
  FakeObserver.instances = []
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeObserver
  const seen: HeaderLayout[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<Probe fontSize={15} seen={seen} />) })
  expect(seen.at(-1)).toBe('full')
  const observer = FakeObserver.instances[0]!
  expect(observer.observed).toHaveLength(1)
  act(() => observer.resize(ICONS_MIN_EM * 15))
  expect(seen.at(-1)).toBe('icons')
  act(() => observer.resize(300))
  expect(seen.at(-1)).toBe('menu')
  act(() => observer.resize(FULL_MIN_EM * 15))
  expect(seen.at(-1)).toBe('full')
  act(() => renderer.update(<Probe fontSize={20} seen={seen} />))
  expect(seen.at(-1)).toBe('menu')
  act(() => renderer.unmount())
  expect(observer.disconnected).toBe(true)
})

test('without ResizeObserver the layout is full', () => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined
  const seen: HeaderLayout[] = []
  act(() => { TestRenderer.create(<Probe fontSize={15} seen={seen} />) })
  expect(seen.at(-1)).toBe('full')
})
