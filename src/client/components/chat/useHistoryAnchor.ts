// Keeps the row the reader is looking at still while a history page
// prepends above it (chat-history-window D4): the load-earlier click
// records the first visible row's anchor id and its offset in the
// viewport; after the page lands, a layout effect scrolls that row back to
// the recorded offset. The scroller disables the browser's own scroll
// anchoring (overflow-anchor: none in ChatView) so this adjustment is the
// only one — otherwise the two compound. The one skipped bottom-stick
// belongs to the prepend, not to a live append — the flag is armed only
// when the transcript's first event id differs across the page (events
// landed above the held content), so a live append during the flight or a
// dropped page leaves the next append sticking as usual.
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

/** The slice of the scroll container the anchor logic touches. */
export interface AnchorScroller {
  getBoundingClientRect(): DOMRect
  scrollTop: number
  querySelector(selector: string): Element | null
  querySelectorAll(selector: string): NodeListOf<Element>
}

export function useHistoryAnchor(
  scroller: RefObject<AnchorScroller | null>,
  /** The page request in flight; the restore runs when it resolves. */
  loading: boolean,
  /** The transcript's first event id; a prepend puts a different one at the front. */
  firstEventId: string | null
): {
  /** Record the first visible row at the moment of the load-earlier click. */
  capture: () => void
  /** True once after a restore, so the bottom stick skips the prepend. */
  skipStickOnce: { current: boolean }
} {
  const armed = useRef<{ anchorId: string; viewportOffset: number; firstEventId: string | null } | null>(null)
  const skipStickOnce = useRef(false)

  const capture = useCallback(() => {
    const box = scroller.current
    if (!box) return
    const top = box.getBoundingClientRect().top
    for (const row of box.querySelectorAll('[data-anchor-id]')) {
      // The first row still visible in the viewport: everything above it is
      // scrolled past and stays where it is.
      const rect = row.getBoundingClientRect()
      if (rect.bottom < top) continue
      const anchorId = row.getAttribute('data-anchor-id')
      if (anchorId) armed.current = { anchorId, viewportOffset: rect.top - top, firstEventId }
      return
    }
  }, [scroller, firstEventId])

  useLayoutEffect(() => {
    const held = armed.current
    if (!held || loading) return
    armed.current = null
    const box = scroller.current
    if (!box) return
    const selector = `[data-anchor-id="${held.anchorId.replace(/["\\]/g, '\\$&')}"]`
    const row = box.querySelector(selector)
    // Arm the one stick skip only for a real prepend: the transcript's first
    // event id changes only when events landed above the held content. A
    // page that landed stale, was dropped, or brought nothing new keeps the
    // id — as does a live append during the flight — and must leave the next
    // live append sticking to the bottom as usual.
    if (!row || firstEventId === held.firstEventId) return
    const offset = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    box.scrollTop = offset - held.viewportOffset
    skipStickOnce.current = true
  }, [loading, firstEventId, scroller])

  return { capture, skipStickOnce }
}
