// The chat header's layout from its own width (chat-header-layout D6), not
// the viewport's: the navigator takes part of the window. Width is measured
// in chat-font ems so the steps stay right when the user changes the chat
// font size. The header's width is set by its container, never its content,
// so switching layouts cannot feed back into the measurement. Without
// ResizeObserver (the test renderer) the layout is 'full'.
// Thresholds (chat-transcript-layout D4) size the identity/actions row alone —
// status, a name of at least 12em, Team, Auto-approve, and the menu — since
// metadata, the context meter, and task context have rows of their own. Below
// the menu step that row wraps the actions under the name rather than clip.
import { useLayoutEffect, useState, type RefObject } from 'react'

export type HeaderLayout = 'full' | 'icons' | 'menu'

/** Minimum header width, in chat-font ems, for the labelled Team button. */
export const FULL_MIN_EM = 42
/** Minimum header width, in chat-font ems, for the icon-only Team button. */
export const ICONS_MIN_EM = 34

export function headerLayoutForWidth(widthPx: number, fontSizePx: number): HeaderLayout {
  const em = widthPx / fontSizePx
  if (em >= FULL_MIN_EM) return 'full'
  if (em >= ICONS_MIN_EM) return 'icons'
  return 'menu'
}

export function useHeaderLayout(ref: RefObject<HTMLElement | null>, fontSizePx: number): HeaderLayout {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const entry = entries[entries.length - 1]
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width === null ? 'full' : headerLayoutForWidth(width, fontSizePx)
}
