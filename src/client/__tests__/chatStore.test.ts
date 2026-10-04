import { afterEach, describe, expect, test } from 'bun:test'
import type { ChatEvent } from '@shared/chat'
import { applyChatEvents, emptyTranscript, useChatStore } from '../stores/chatStore'

const delta = (sequence: number, delta: string): Extract<ChatEvent, { type: 'assistant_delta' }> => ({
  type: 'assistant_delta', id: `event-${sequence}`, sequence, at: 'now', turnId: 'turn-1', messageId: 'message-1', delta,
})
afterEach(() => useChatStore.setState({ sessions: {} }))

describe('chat store', () => {
  test('ordered deltas merge and final text replaces the preview', () => {
    const first = applyChatEvents(emptyTranscript(), [delta(1, 'Hel'), delta(2, 'lo')])
    expect(first.events).toHaveLength(1)
    expect(first.events[0]).toMatchObject({ type: 'assistant_text', text: 'Hello' })
    const final: ChatEvent = { ...delta(3, ''), type: 'assistant_text', text: 'Hello!' }
    const next = applyChatEvents(first, [final])
    expect(next.events).toHaveLength(1)
    expect(next.events[0]).toMatchObject({ text: 'Hello!' })
    expect(first.events[0]).toMatchObject({ text: 'Hello' })
  })

  test('duplicate ids and old sequences are ignored', () => {
    const first = applyChatEvents(emptyTranscript(), [delta(1, 'Hello')])
    const next = applyChatEvents(first, [delta(1, 'Hello'), { ...delta(1, 'duplicate'), id: 'other-id' }])
    expect(next.events).toEqual(first.events)
  })

  test('approvals and questions are removed by resolution and cancellation', () => {
    const approval: ChatEvent = { id: 'a', sequence: 1, at: 'now', turnId: 't', type: 'approval_request', requestId: 'r1', tool: 'Bash', input: {} }
    const question: ChatEvent = { id: 'q', sequence: 2, at: 'now', turnId: 't', type: 'question_request', requestId: 'r2', questions: [] }
    const pending = applyChatEvents(emptyTranscript(), [approval, question])
    expect(pending.pendingRequests.map(request => request.kind)).toEqual(['approval', 'question'])
    expect(pending.status).toBe('permission')
    const resolved = applyChatEvents(pending, [{ id: 'r', sequence: 3, at: 'now', type: 'request_resolved', requestId: 'r1', outcome: 'allowed' }])
    expect(resolved.pendingRequests).toHaveLength(1)
    expect(resolved.status).toBe('permission')
    const cancelled = applyChatEvents(resolved, [{ id: 'c', sequence: 4, at: 'now', type: 'request_resolved', requestId: 'r2', outcome: 'cancelled' },
      { id: 's', sequence: 5, at: 'now', type: 'turn_interrupted', turnId: 't' }])
    expect(cancelled.pendingRequests).toEqual([])
    expect(cancelled.status).toBe('waiting')
  })

  test('a snapshot replaces stale state and its pending requests are authoritative', () => {
    const store = useChatStore.getState()
    store.apply('chat-1', [delta(1, 'old')])
    store.snapshot({ type: 'chat-snapshot', sessionId: 'chat-1', events: [delta(2, 'restored')], pendingRequests: [], status: 'working', throughSequence: 2 })
    const state = useChatStore.getState().sessions['chat-1']
    expect(state.events).toHaveLength(1)
    expect(state.events[0]).toMatchObject({ text: 'restored' })
    store.apply('chat-1', [delta(2, 'restored'), delta(3, '!')])
    expect(useChatStore.getState().sessions['chat-1'].events[0]).toMatchObject({ text: 'restored!' })
  })

  test('replayed history remains ordered despite sequence zero and is deduplicated by id', () => {
    const first = { ...delta(0, 'history'), id: 'history-a' }
    const second = { ...delta(0, ' more'), id: 'history-b' }
    const state = applyChatEvents(emptyTranscript(), [first, second, first])
    expect(state.events[0]).toMatchObject({ text: 'history more' })
    expect(state.seen.size).toBe(2)
  })

  test('kill clears only the removed session', () => {
    const store = useChatStore.getState()
    store.apply('chat-1', [delta(1, 'one')])
    store.apply('chat-2', [delta(1, 'two')])
    store.remove('chat-1')
    expect(useChatStore.getState().sessions['chat-1']).toBeUndefined()
    expect(useChatStore.getState().sessions['chat-2'].events).toHaveLength(1)
  })
})
