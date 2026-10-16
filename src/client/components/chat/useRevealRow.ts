// Scrolls to and briefly highlights the transcript row a chat search result
// pointed at (chat-session-search D5). The search sets `pendingReveal` in the
// chat store; this hook, mounted by the chat view of that session, waits until
// the transcript has loaded, finds the row by its `data-anchor-id`, opens it
// when it is a collapsed tool card, scrolls it to the middle, and marks it
// with `.chat-reveal` for two seconds. A row that is not there (the history
// moved on) is dropped silently — the chat is simply open at its usual place.
import { useEffect, useRef, type RefObject } from 'react'
import { useChatStore } from '../../stores/chatStore'

export const REVEAL_MS = 2000

/** The slice of an element the reveal touches. */
export interface RevealTarget {
  tagName?: string
  open?: boolean
  scrollIntoView(options?: ScrollIntoViewOptions): void
  classList: { add(token: string): void; remove(token: string): void }
}

export interface RevealContainer {
  querySelector(selector: string): RevealTarget | null
}

export function useRevealRow(options: {
  sessionId: string
  /** The session's transcript has been received (a snapshot landed). */
  loaded: boolean
  container: RefObject<RevealContainer | null>
}): void {
  const { sessionId, loaded, container } = options
  const reveal = useChatStore(state => (state.pendingReveal?.sessionId === sessionId ? state.pendingReveal : null))
  const marked = useRef<{ target: RevealTarget; timer: ReturnType<typeof setTimeout> } | null>(null)

  useEffect(() => {
    if (!reveal || !loaded) return
    const anchor = reveal.anchorId.replace(/["\\]/g, '\\$&')
    const target = container.current?.querySelector(`[data-anchor-id="${anchor}"]`) ?? null
    useChatStore.getState().clearReveal()
    if (!target) return
    if (marked.current) {
      clearTimeout(marked.current.timer)
      marked.current.target.classList.remove('chat-reveal')
    }
    // A collapsed tool card hides the matched text: open it so the match shows.
    if (target.tagName === 'DETAILS') target.open = true
    target.scrollIntoView({ block: 'center' })
    target.classList.add('chat-reveal')
    const timer = setTimeout(() => {
      target.classList.remove('chat-reveal')
      marked.current = null
    }, REVEAL_MS)
    marked.current = { target, timer }
  }, [reveal, loaded, container])

  useEffect(() => () => {
    if (!marked.current) return
    clearTimeout(marked.current.timer)
    marked.current.target.classList.remove('chat-reveal')
    marked.current = null
  }, [])
}
