// useHistoryAnchor (chat-history-window D4): the first visible row is put
// back to its on-screen offset across a prepend, and the one stick skip is
// armed only when the transcript's first event id differs across the page —
// a stale or dropped page, like a live append during the flight, leaves the
// next append sticking as usual.
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

  function Harness({ box, loading, firstEventId }: {
    box: AnchorScroller; loading: boolean; firstEventId: string | null
  }) {
    const ref = useRef<AnchorScroller | null>(null)
    ref.current = box
    const handle = useHistoryAnchor(ref, loading, firstEventId)
    exposed = handle
    return null
  }

  let renderer: TestRenderer.ReactTestRenderer | null = null
  beforeEach(() => { exposed = null })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function mount(box: AnchorScroller, loading: boolean, firstEventId: string | null) {
    const element = (loading: boolean, firstEventId: string | null) =>
      <Harness box={box} loading={loading} firstEventId={firstEventId} />
    act(() => { renderer = TestRenderer.create(element(loading, firstEventId)) })
  }
  const update = (box: AnchorScroller, loading: boolean, firstEventId: string | null) => {
    const current = renderer
    if (!current) throw new Error('not mounted')
    act(() => current.update(<Harness box={box} loading={loading} firstEventId={firstEventId} />))
  }

  test('a prepend restores the row offset and arms the one stick skip', () => {
    const box = stubBox(100)
    mount(box, false, 'e0')
    exposed!.capture()
    // The page request flies: loading flips true with no new events yet.
    update(box, true, 'e0')
    expect(box.scrollTop).toBe(1230)
    // The reply prepends two events above the pinned row (the transcript's
    // first id is now e2) and loading resolves.
    ;(box.querySelector('[data-anchor-id="hist-row"]') as unknown as { getBoundingClientRect: () => DOMRect })
      .getBoundingClientRect = () => ({ top: 620 } as DOMRect)
    update(box, false, 'e2')
    // offset = 620 - 0 + 1230 = 1850; scrollTop = 1850 - 100 = 1750: the row
    // sits 100px below the box top again.
    expect(box.scrollTop).toBe(1750)
    expect(exposed!.skipStickOnce.current).toBe(true)
  })

  test('a page that brings nothing new (stale, dropped, all-duplicate) leaves the skip disarmed', () => {
    const box = stubBox(100)
    mount(box, false, 'e0')
    exposed!.capture()
    update(box, true, 'e0')
    // A stale reply or a disconnect's strand-clear resolves the claim with
    // no new first event: the row is restored to the same place — and, still
    // on the same content, no stick skip is armed.
    update(box, false, 'e0')
    expect(exposed!.skipStickOnce.current).toBe(false)
    expect(box.scrollTop).toBe(1230)
    // So the next live append sticks to the bottom as usual (ChatView's
    // stick effect reads the flag; it is still false here).
    update(box, false, 'e0')
    expect(exposed!.skipStickOnce.current).toBe(false)
  })

  test('a live append during the page load followed by a dropped page leaves the skip disarmed', () => {
    const box = stubBox(100)
    mount(box, false, 'e0')
    exposed!.capture()
    update(box, true, 'e0')
    // While the page flies a live append lands at the bottom — the
    // transcript grows, but its first event id is still e0. The page then
    // resolves dropped (stale reply): a prepend-count check saw the growth
    // and wrongly armed here; the first-event-id check does not.
    update(box, false, 'e0')
    expect(exposed!.skipStickOnce.current).toBe(false)
    expect(box.scrollTop).toBe(1230)
  })
})
