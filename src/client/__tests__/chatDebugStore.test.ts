import { afterEach, describe, expect, test } from 'bun:test'
import type { ChatWireFrame } from '@shared/chat'
import type { ServerMessage } from '@shared/types'
import { MAX_DEBUG_FRAMES, applyDebugFrames, closedDebugView, mergeFrames, useChatDebugStore } from '../stores/chatDebugStore'

type FramesMessage = Extract<ServerMessage, { type: 'chat-debug-frames' }>
const frame = (seq: number): ChatWireFrame => ({ seq, at: '2026-10-05T12:00:00.000Z', dir: 'in', raw: `{"n":${seq}}` })
const frames = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => frame(from + index))
const seqs = (list: ChatWireFrame[]) => list.map(item => item.seq)
const page = (list: ChatWireFrame[], hasOlder: boolean): FramesMessage => ({ type: 'chat-debug-frames', sessionId: 'chat-1', frames: list, page: true, hasOlder })
const live = (list: ChatWireFrame[]): FramesMessage => ({ type: 'chat-debug-frames', sessionId: 'chat-1', frames: list })
const opening = () => ({ ...closedDebugView(), open: true, awaitingOpen: true })

afterEach(() => useChatDebugStore.setState({ views: {} }))

describe('chat debug store', () => {
  test('mergeFrames dedupes by seq and sorts', () => {
    expect(seqs(mergeFrames([frame(3), frame(1)], [frame(2), frame(3)]))).toEqual([1, 2, 3])
  })

  test('live frames that arrive before the open page are kept with no duplicates', () => {
    let view = applyDebugFrames(opening(), live([frame(10), frame(11)]))
    view = applyDebugFrames(view, page(frames(5, 10), true))
    expect(seqs(view.frames)).toEqual([5, 6, 7, 8, 9, 10, 11])
    expect(view.hasOlder).toBe(true)
    expect(view.awaitingOpen).toBe(false)
  })

  test('a re-open after reconnect replaces stale frames instead of leaving a gap', () => {
    let view = applyDebugFrames(opening(), page(frames(1, 3), false))
    view = { ...view, awaitingOpen: true }
    view = applyDebugFrames(view, page(frames(500, 502), true))
    expect(seqs(view.frames)).toEqual([500, 501, 502])
    expect(view.hasOlder).toBe(true)
  })

  test('older pages prepend in order and update hasOlder', () => {
    let view = applyDebugFrames(opening(), page(frames(4, 6), true))
    view = { ...view, loadingOlder: true }
    view = applyDebugFrames(view, page(frames(1, 3), false))
    expect(seqs(view.frames)).toEqual([1, 2, 3, 4, 5, 6])
    expect(view.hasOlder).toBe(false)
    expect(view.loadingOlder).toBe(false)
  })

  test('out-of-order live batches end up sorted', () => {
    let view = applyDebugFrames(opening(), page([], false))
    view = applyDebugFrames(view, live([frame(3)]))
    view = applyDebugFrames(view, live([frame(1), frame(2)]))
    expect(seqs(view.frames)).toEqual([1, 2, 3])
  })

  test('live growth past the cap drops the oldest frames and marks older available', () => {
    let view = applyDebugFrames(opening(), page(frames(1, MAX_DEBUG_FRAMES), false))
    view = applyDebugFrames(view, live(frames(MAX_DEBUG_FRAMES + 1, MAX_DEBUG_FRAMES + 10)))
    expect(view.frames).toHaveLength(MAX_DEBUG_FRAMES)
    expect(view.frames[0]!.seq).toBe(11)
    expect(view.hasOlder).toBe(true)
  })

  test('frames for a closed view are ignored', () => {
    const view = closedDebugView()
    expect(applyDebugFrames(view, live([frame(1)]))).toBe(view)
  })

  test('store actions open, load older, apply, and close per session', () => {
    const store = useChatDebugStore.getState()
    store.beginOpen('chat-1')
    store.apply(page(frames(4, 5), true))
    store.beginLoadOlder('chat-1')
    expect(useChatDebugStore.getState().views['chat-1']).toMatchObject({ open: true, loadingOlder: true })
    store.apply(page(frames(1, 3), false))
    expect(seqs(useChatDebugStore.getState().views['chat-1']!.frames)).toEqual([1, 2, 3, 4, 5])
    store.apply({ ...live([frame(9)]), sessionId: 'chat-other' })
    expect(useChatDebugStore.getState().views['chat-other']!.frames).toEqual([])
    store.close('chat-1')
    expect(useChatDebugStore.getState().views['chat-1']).toBeUndefined()
  })
})
