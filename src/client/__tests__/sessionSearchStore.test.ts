import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import type { SessionSearchResponse, SessionSearchResult } from '@shared/sessionSearch'
import {
  SEARCH_DEBOUNCE_MS,
  flattenSearchItems,
  useSessionSearchStore,
} from '../stores/sessionSearchStore'

const originalFetch = globalThis.fetch

function result(sessionId: string, eventIds: string[]): SessionSearchResult {
  return {
    sessionId, name: sessionId, projectPath: `/work/${sessionId}`, matchCount: eventIds.length, nameMatch: false,
    lastMatchAt: '2026-10-15T09:00:00.000Z',
    snippets: eventIds.map(eventId => ({
      eventId, anchorId: `tool:${eventId}`, kind: 'tool_result' as const, tool: 'Bash',
      at: '2026-10-15T09:00:00.000Z', text: 'x #147', ranges: [{ start: 2, end: 6 }],
    })),
  }
}
const respond = (query: string, results: SessionSearchResult[] = []): SessionSearchResponse =>
  ({ query, results, truncated: false, unsearchable: 0 })

interface Deferred { url: string; signal: AbortSignal | undefined; resolve: (body: unknown, ok?: boolean) => void; reject: (e: Error) => void }

/** Replace fetch with one whose replies the test resolves by hand (and may ignore aborts). */
function stubFetch(): Deferred[] {
  const calls: Deferred[] = []
  globalThis.fetch = ((url: string, init?: RequestInit) => new Promise((resolve, reject) => {
    calls.push({
      url, signal: init?.signal ?? undefined,
      resolve: (body, ok = true) => resolve({ ok, status: ok ? 200 : 500, json: async () => body } as Response),
      reject,
    })
  })) as unknown as typeof fetch
  return calls
}

/** Microtask turns only: setTimeout is faked in these tests. */
async function flushPromises() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('sessionSearchStore', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    useSessionSearchStore.getState().clear()
  })
  afterEach(() => {
    useSessionSearchStore.getState().clear()
    jest.useRealTimers()
    globalThis.fetch = originalFetch
  })

  test('an unsearchable query neither loads nor fetches', () => {
    const calls = stubFetch()
    useSessionSearchStore.getState().setQuery('a')
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2)
    expect(calls).toHaveLength(0)
    expect(useSessionSearchStore.getState()).toMatchObject({ query: 'a', status: 'idle', response: null })
  })

  test('debounces typing into one request for the trimmed query', async () => {
    const calls = stubFetch()
    const store = useSessionSearchStore.getState()
    store.setQuery('#1')
    store.setQuery('#14')
    store.setQuery(' #147 ')
    expect(useSessionSearchStore.getState().status).toBe('loading')
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1)
    expect(calls).toHaveLength(0)
    jest.advanceTimersByTime(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/chat/search?q=%23147')
    calls[0]!.resolve(respond('#147', [result('a', ['e1'])]))
    await flushPromises()
    expect(useSessionSearchStore.getState()).toMatchObject({ status: 'ready', error: null })
    expect(useSessionSearchStore.getState().response?.results[0]!.sessionId).toBe('a')
  })

  test('ignores a stale reply that arrives after the newer one', async () => {
    const calls = stubFetch()
    const store = useSessionSearchStore.getState()
    store.setQuery('#14')
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    store.setQuery('#147')
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.signal?.aborted).toBe(true)
    calls[1]!.resolve(respond('#147', [result('new', ['n1'])]))
    await flushPromises()
    calls[0]!.resolve(respond('#14', [result('old', ['o1'])]))
    await flushPromises()
    expect(useSessionSearchStore.getState().response?.query).toBe('#147')
    expect(useSessionSearchStore.getState().response?.results[0]!.sessionId).toBe('new')
  })

  test('a reply for a query that has since become unsearchable is dropped', async () => {
    const calls = stubFetch()
    const store = useSessionSearchStore.getState()
    store.setQuery('#147')
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    store.setQuery('')
    calls[0]!.resolve(respond('#147', [result('a', ['e1'])]))
    await flushPromises()
    expect(useSessionSearchStore.getState()).toMatchObject({ status: 'idle', response: null })
  })

  test('http and network failures settle as an error; a stale failure is ignored', async () => {
    const calls = stubFetch()
    const store = useSessionSearchStore.getState()
    store.setQuery('#147')
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    calls[0]!.resolve({}, false)
    await flushPromises()
    expect(useSessionSearchStore.getState()).toMatchObject({ status: 'error', error: 'Search failed (500)' })

    store.setQuery('#148')
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    store.setQuery('#149')
    calls[1]!.reject(new Error('late'))
    await flushPromises()
    expect(useSessionSearchStore.getState().status).toBe('loading')

    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    calls[2]!.reject(new Error('offline'))
    await flushPromises()
    expect(useSessionSearchStore.getState()).toMatchObject({ status: 'error', error: 'offline' })
  })

  test('a non-Error rejection gets a generic message', async () => {
    const calls = stubFetch()
    useSessionSearchStore.getState().setQuery('#147')
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    calls[0]!.reject('nope' as unknown as Error)
    await flushPromises()
    expect(useSessionSearchStore.getState().error).toBe('Search failed')
  })

  test('clear aborts the request, cancels the timer, and resets everything', async () => {
    const calls = stubFetch()
    const store = useSessionSearchStore.getState()
    store.setQuery('#147')
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    store.clear()
    expect(calls[0]!.signal?.aborted).toBe(true)
    store.setQuery('#148')
    store.clear()
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2)
    expect(calls).toHaveLength(1)
    expect(useSessionSearchStore.getState()).toMatchObject({ query: '', status: 'idle', response: null, activeIndex: -1 })
  })

  describe('keyboard active item', () => {
    async function withResults() {
      const calls = stubFetch()
      useSessionSearchStore.getState().setQuery('#147')
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
      calls[0]!.resolve(respond('#147', [result('a', ['a1', 'a2']), result('b', ['b1'])]))
      await flushPromises()
    }

    test('flattens headers and snippets in display order with DOM-safe ids', async () => {
      await withResults()
      const items = flattenSearchItems(useSessionSearchStore.getState().response)
      expect(items.map(i => i.id)).toEqual([
        'search-opt-a', 'search-opt-a-a1', 'search-opt-a-a2', 'search-opt-b', 'search-opt-b-b1',
      ])
      expect(items[1]).toMatchObject({ kind: 'snippet', sessionId: 'a', eventId: 'a1', anchorId: 'tool:a1' })
      expect(flattenSearchItems(null)).toEqual([])
    })

    test('nothing is active until the first down; up from none stays none', async () => {
      await withResults()
      const store = useSessionSearchStore.getState()
      expect(store.activeIndex).toBe(-1)
      store.moveActive(-1)
      expect(useSessionSearchStore.getState().activeIndex).toBe(-1)
      store.moveActive(1)
      expect(useSessionSearchStore.getState().activeIndex).toBe(0)
    })

    test('clamps at both ends', async () => {
      await withResults()
      const store = useSessionSearchStore.getState()
      for (let i = 0; i < 9; i++) store.moveActive(1)
      expect(useSessionSearchStore.getState().activeIndex).toBe(4)
      for (let i = 0; i < 9; i++) store.moveActive(-1)
      expect(useSessionSearchStore.getState().activeIndex).toBe(0)
    })

    test('does nothing without results', () => {
      useSessionSearchStore.getState().moveActive(1)
      expect(useSessionSearchStore.getState().activeIndex).toBe(-1)
    })

    test('new results and a changed query reset the active item', async () => {
      await withResults()
      useSessionSearchStore.getState().moveActive(1)
      useSessionSearchStore.getState().moveActive(1)
      expect(useSessionSearchStore.getState().activeIndex).toBe(1)
      useSessionSearchStore.getState().setQuery('#1478')
      expect(useSessionSearchStore.getState().activeIndex).toBe(-1)
    })
  })

  test('requestFocus bumps the token', () => {
    const before = useSessionSearchStore.getState().focusToken
    useSessionSearchStore.getState().requestFocus()
    expect(useSessionSearchStore.getState().focusToken).toBe(before + 1)
  })
})
