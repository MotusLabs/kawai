// Scrolls to and briefly highlights the transcript row a chat search result
// pointed at (chat-session-search D5). The search sets `pendingReveal` in the
// chat store; this hook, mounted by the chat view of that session, waits until
// the transcript has loaded, finds the row by its `data-anchor-id`, opens it
// when it is a collapsed tool card, scrolls it to the middle, and marks it
// with `.chat-reveal` for two seconds. A row that is not there is given one
// chance from older history (chat-history-window D5): while older history
// exists it requests one page with `throughId = anchor` and re-attempts when
// the page lands; if the entry still is not found it falls back silently —
// the chat is simply open at its usual place. One request per reveal, no loop.
import { useEffect, useRef, type RefObject } from 'react'
import type { ClientMessage } from '@shared/types'
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
  /** Sends the one history page (chat-history-window D5); omit to never page. */
  sendMessage?: (message: ClientMessage) => void
  /** Grows when events land (a page included); the reveal re-attempts then. */
  eventCount?: number
}): void {
  const { sessionId, loaded, container, sendMessage, eventCount } = options
  const reveal = useChatStore(state => (state.pendingReveal?.sessionId === sessionId ? state.pendingReveal : null))
  const marked = useRef<{ target: RevealTarget; timer: ReturnType<typeof setTimeout> } | null>(null)
  /** The anchor the one page request already went out for. */
  const pagedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!reveal || !loaded) return
    const anchor = reveal.anchorId.replace(/["\\]/g, '\\$&')
    const target = container.current?.querySelector(`[data-anchor-id="${anchor}"]`) ?? null
    if (!target) {
      const state = useChatStore.getState()
      const transcript = state.sessions[sessionId]
      if (sendMessage && transcript?.historyHasOlder === true) {
        if (pagedFor.current !== reveal.anchorId) {
          pagedFor.current = reveal.anchorId
          const request = state.requestOlder(sessionId, reveal.anchorId)
          if (request) {
            sendMessage(request)
            return // the reveal re-attempts once the page lands
          }
        }
        if (transcript.historyLoading) return // a page is already on its way
      }
      // Nothing older to search: today's no-error fallback.
      pagedFor.current = null
      state.clearReveal()
      return
    }
    pagedFor.current = null
    useChatStore.getState().clearReveal()
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
  }, [reveal, loaded, container, sessionId, sendMessage, eventCount])

  useEffect(() => () => {
    if (!marked.current) return
    clearTimeout(marked.current.timer)
    marked.current.target.classList.remove('chat-reveal')
    marked.current = null
  }, [])
}
