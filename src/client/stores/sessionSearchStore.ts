// Navigator chat search state (chat-session-search D4): the query, the latest
// settled response, and the keyboard-active item. Typing debounces a fetch to
// GET /api/chat/search; a newer query aborts the older request, and a
// response is adopted only while its query is still the current one, so an
// out-of-order reply can never replace newer results. Client-only: nothing
// here is persisted.
import { create } from 'zustand'
import { normalizeSearchQuery, type SessionSearchResponse } from '@shared/sessionSearch'

export const SEARCH_DEBOUNCE_MS = 250

/** DOM id of the results listbox the search box controls. */
export const SEARCH_LISTBOX_ID = 'session-search-results'

export type SearchStatus = 'idle' | 'loading' | 'ready' | 'error'

/** One keyboard-navigable row of the results: a group header or a snippet. */
export type SearchItem =
  | { id: string; kind: 'header'; sessionId: string }
  | { id: string; kind: 'snippet'; sessionId: string; eventId: string; anchorId: string }

/** Header and snippets of each group, in display order; ids are DOM-safe option ids. */
export function flattenSearchItems(response: SessionSearchResponse | null): SearchItem[] {
  const items: SearchItem[] = []
  for (const result of response?.results ?? []) {
    items.push({ id: `search-opt-${result.sessionId}`, kind: 'header', sessionId: result.sessionId })
    for (const snippet of result.snippets) {
      items.push({
        id: `search-opt-${result.sessionId}-${snippet.eventId}`, kind: 'snippet',
        sessionId: result.sessionId, eventId: snippet.eventId, anchorId: snippet.anchorId,
      })
    }
  }
  return items
}

interface SessionSearchStore {
  query: string
  status: SearchStatus
  /** Latest settled response; kept while a newer query loads. */
  response: SessionSearchResponse | null
  error: string | null
  /** Index into flattenSearchItems(response); -1 = none active. */
  activeIndex: number
  /** Bumped to ask the search box to take focus (the modifier+K shortcut). */
  focusToken: number
  setQuery: (raw: string) => void
  clear: () => void
  /** ↑/↓: none → first on ↓ only; clamped at both ends. */
  moveActive: (delta: 1 | -1) => void
  requestFocus: () => void
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let inFlight: AbortController | null = null

function cancelPending() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  inFlight?.abort()
  inFlight = null
}

export const useSessionSearchStore = create<SessionSearchStore>((set, get) => {
  async function run(normalized: string) {
    const controller = new AbortController()
    inFlight = controller
    try {
      const reply = await fetch(`/api/chat/search?q=${encodeURIComponent(normalized)}`, { signal: controller.signal })
      if (!reply.ok) throw new Error(`Search failed (${reply.status})`)
      const body = await reply.json() as SessionSearchResponse
      if (controller.signal.aborted || normalizeSearchQuery(get().query) !== normalized) return
      set({ status: 'ready', response: body, error: null, activeIndex: -1 })
    } catch (error) {
      if (controller.signal.aborted || normalizeSearchQuery(get().query) !== normalized) return
      set({ status: 'error', error: error instanceof Error ? error.message : 'Search failed' })
    }
  }

  return {
    query: '',
    status: 'idle',
    response: null,
    error: null,
    activeIndex: -1,
    focusToken: 0,
    setQuery: raw => {
      cancelPending()
      const normalized = normalizeSearchQuery(raw)
      if (normalized === null) {
        set({ query: raw, status: 'idle', response: null, error: null, activeIndex: -1 })
        return
      }
      set({ query: raw, status: 'loading', error: null, activeIndex: -1 })
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void run(normalized)
      }, SEARCH_DEBOUNCE_MS)
    },
    clear: () => {
      cancelPending()
      set({ query: '', status: 'idle', response: null, error: null, activeIndex: -1 })
    },
    moveActive: delta => {
      const count = flattenSearchItems(get().response).length
      const current = get().activeIndex
      if (count === 0 || (current === -1 && delta < 0)) return
      const next = current === -1 ? 0 : Math.min(count - 1, Math.max(0, current + delta))
      if (next !== current) set({ activeIndex: next })
    },
    requestFocus: () => set(state => ({ focusToken: state.focusToken + 1 })),
  }
})
