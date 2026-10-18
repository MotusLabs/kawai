// useHistoryAnchor (chat-history-window D4): the first visible row is put
// back to its on-screen offset across a prepend, and the one stick skip is
// armed only when the transcript actually grew — a stale or dropped page
// leaves the next append sticking as usual.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { useRef } from 'react'
import { useHistoryAnchor, type AnchorScroller } from '../components/chat/useHistoryAnchor'

interface StubBox extends AnchorScroller {
  scrollTop: number
}

function stubBox(rowTop: number, anchorId = 'hist-row'): StubBox {
  const row = {
    getBoundingClientRect: () => ({ top: rowTop } as DOMRect),
    getAttribute: () => anchorId,
  }
  const box: StubBox = {
    getBoundingClientRect: () => ({ top: 0 } as DOMRect),
    scrollTop: 1230,
    querySelector: selector => (selector.includes(anchorId) ? (row as unknown as Element) : null),
    querySelectorAll: () => [row as unknown as Element] as unknown as NodeListOf<Element>,
  }
  return box
}

describe('useHistoryAnchor', () => {
  let exposed: { capture: () => void; skipStickOnce: { current: boolean } } | null = null

  function Harness({ box, loading, eventCount }: {
    box: AnchorScroller; loading: boolean; eventCount: number
  }) {
    const ref = useRef<AnchorScroller | null>(null)
    ref.current = box
    const handle = useHistoryAnchor(ref, loading, eventCount)
    exposed = handle
    return null
  }

  let renderer: TestRenderer.ReactTestRenderer | null = null
  beforeEach(() => { exposed = null })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function mount(box: AnchorScroller, loading: boolean, eventCount: number) {
    const element = (loading: boolean, eventCount: number) =>
      <Harness box={box} loading={loading} eventCount={eventCount} />
    act(() => { renderer = TestRenderer.create(element(loading, eventCount)) })
  }
  const update = (box: AnchorScroller, loading: boolean, eventCount: number) => {
    const current = renderer
    if (!current) throw new Error('not mounted')
    act(() => current.update(<Harness box={box} loading={loading} eventCount={eventCount} />))
  }

  test('a prepend restores the row offset and arms the one stick skip', () => {
    const box = stubBox(100)
    mount(box, false, 2)
    exposed!.capture()
    // The page request flies: loading flips true with no growth yet.
    update(box, true, 2)
    expect(box.scrollTop).toBe(1230)
    // The reply prepends 520px above the pinned row and loading resolves.
    ;(box.querySelector('[data-anchor-id="hist-row"]') as unknown as { getBoundingClientRect: () => DOMRect })
      .getBoundingClientRect = () => ({ top: 620 } as DOMRect)
    update(box, false, 5)
    // offset = 620 - 0 + 1230 = 1850; scrollTop = 1850 - 100 = 1750: the row
    // sits 100px below the box top again.
    expect(box.scrollTop).toBe(1750)
    expect(exposed!.skipStickOnce.current).toBe(true)
  })

  test('a page that grows nothing (stale, dropped, all-duplicate) leaves the skip disarmed', () => {
    const box = stubBox(100)
    mount(box, false, 2)
    exposed!.capture()
    update(box, true, 2)
    // A stale reply or a disconnect's strand-clear resolves the claim with
    // no growth: the row is restored to the same place — and, still on the
    // same content, no stick skip is armed.
    update(box, false, 2)
    expect(exposed!.skipStickOnce.current).toBe(false)
    expect(box.scrollTop).toBe(1230)
    // So the next live append sticks to the bottom as usual (ChatView's
    // stick effect reads the flag; it is still false here).
    update(box, false, 3)
    expect(exposed!.skipStickOnce.current).toBe(false)
  })
})
