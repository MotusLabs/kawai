// Keeps the row the reader is looking at still while a history page
// prepends above it (chat-history-window D4): the load-earlier click
// records the first visible row's anchor id and its offset in the
// viewport; after the page lands, a layout effect scrolls that row back to
// the recorded offset. The scroller disables the browser's own scroll
// anchoring (overflow-anchor: none in ChatView) so this adjustment is the
// only one — otherwise the two compound. The one skipped bottom-stick
// belongs to the prepend, not to a live append — the view's stick effect
// consumes the flag once.
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
  loading: boolean
): {
  /** Record the first visible row at the moment of the load-earlier click. */
  capture: () => void
  /** True once after a restore, so the bottom stick skips the prepend. */
  skipStickOnce: { current: boolean }
} {
  const armed = useRef<{ anchorId: string; viewportOffset: number } | null>(null)
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
      if (anchorId) armed.current = { anchorId, viewportOffset: rect.top - top }
      return
    }
  }, [scroller])

  useLayoutEffect(() => {
    const held = armed.current
    if (!held || loading) return
    armed.current = null
    const box = scroller.current
    if (!box) return
    const selector = `[data-anchor-id="${held.anchorId.replace(/["\\]/g, '\\$&')}"]`
    const row = box.querySelector(selector)
    if (!row) return
    const offset = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    box.scrollTop = offset - held.viewportOffset
    skipStickOnce.current = true
  }, [loading, scroller])

  return { capture, skipStickOnce }
}
