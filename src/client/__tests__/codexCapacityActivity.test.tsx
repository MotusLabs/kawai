// codex-capacity-retry W7, L15 and L11's activity (design D6, "Acceptance
// oracles", task 3.1): a capacity backoff's activity through Kawai's
// production composition — the in-tree package session, the Codex adapter's
// projection, ChatSessionManager's push sink and snapshot — into the client
// store and ChatActivityRow. The app-server and the capacity clock are the
// scripted ones of src/server/__tests__/helpers/codexCapacityManager.ts; the
// row's clock is pinned to the capacity clock's epoch with fake timers.
import { afterEach, describe, expect, jest, setSystemTime, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatActivity } from '@shared/chat'
import ChatActivityRow from '../components/chat/ChatActivityRow'
import { useChatStore } from '../stores/chatStore'
import { EPOCH0 } from '../../../packages/agent-runtime/__tests__/helpers/capacityAppServer'
import { until } from '../../server/__tests__/codexDriverHarness'
import { capacityManager, type CapacityManager } from '../../server/__tests__/helpers/codexCapacityManager'

export const W7_ROW = ['W7', 'Capacity backoff activity delivered through production snapshot/push and client row', 'Actual attempt/countdown/deadline visible; no false 1/1 maximum; ordinary upstream retry rendering remains compatible'] as const

let h: CapacityManager | null = null
const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(async () => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount())
  jest.useRealTimers()
  setSystemTime()
  await h?.cleanup()
  h = null
})

const started = (id: string) => ({ turn: { id, status: 'inProgress', items: [], error: null } })
const failed = (id: string) => ({ turn: { id, status: 'failed', items: [], error: { message: 'over capacity', codexErrorInfo: 'serverOverloaded', additionalDetails: null } } })

async function bind(s: CapacityManager, attempt: string) {
  s.server.reply(s.server.turnStarts().at(-1)!.id, started(attempt))
  s.server.notify('turn/started', started(attempt))
  await s.server.flush()
}

/** A human turn whose first attempt failed on capacity: the chat waits for retry 1 (r = 0: 1,000 ms). */
async function backoff(): Promise<CapacityManager> {
  h = await capacityManager()
  const s = h
  expect((await s.manager.send(s.id, 'build it')).ok).toBe(true)
  await until(() => s.server.turnStarts().length === 1)
  await bind(s, 'a1')
  s.server.notify('turn/completed', failed('a1'))
  await until(() => s.clock.pending === 1 && s.activities.at(-1)?.phase === 'retrying')
  return s
}

const fields = ({ elapsedMs: _elapsed, ...rest }: ChatActivity) => rest
const snapshotActivity = (s: CapacityManager) => s.manager.getSnapshot(s.id)?.activity ?? null

/** The client row of the store's current activity for the chat, rendered on a client clock at the capacity clock's epoch. */
function row(sessionId: string) {
  const anchored = useChatStore.getState().sessions[sessionId]?.activity
  if (!anchored) throw new Error('no activity in the store')
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<ChatActivityRow activity={anchored.value} phaseStartedAt={anchored.phaseStartedAt} />)
  })
  renderers.push(renderer)
  return () => {
    const label = renderer.root.findByProps({ 'data-testid': 'chat-activity-label' }).children
    return label.join('')
  }
}

/** Pin the client clock to the package's epoch now (the row computes countdowns from Date.now()). */
function clientClockAt(epoch: number) {
  jest.useFakeTimers()
  setSystemTime(new Date(epoch))
}

describe('codex-capacity-retry capacity activity', () => {
  test('the W7 row is committed verbatim', () => {
    expect(W7_ROW).toEqual(['W7', 'Capacity backoff activity delivered through production snapshot/push and client row', 'Actual attempt/countdown/deadline visible; no false 1/1 maximum; ordinary upstream retry rendering remains compatible'])
  })

  test('W7: capacity backoff activity reaches the push and the snapshot, and the row shows the attempt, a ticking countdown and the deadline with no maximum', async () => {
    const s = await backoff()
    const expected: Omit<ChatActivity, 'elapsedMs'> = { phase: 'retrying', attempt: 1, retryOwner: 'capacity', nextRetryAt: EPOCH0 + 1_000, retryDeadline: EPOCH0 + 600_000 }
    // The push and the snapshot carry the same projected fields; no maximum is invented.
    const pushed = s.activities.at(-1)!
    expect(fields(pushed)).toEqual(expected)
    const snapshot = s.manager.getSnapshot(s.id)!
    expect(fields(snapshot.activity!)).toEqual(expected)
    expect(snapshot.status).toBe('working')
    for (const source of ['snapshot', 'push'] as const) {
      clientClockAt(s.clock.epoch())
      if (source === 'snapshot') useChatStore.getState().snapshot(s.manager.getSnapshot(s.id)!)
      else useChatStore.getState().setActivity(s.id, pushed)
      const label = row(s.id)
      expect(label()).toBe('Model at capacity, retry 1 in 1s (gives up in 10m 00s)…')
      expect(label()).not.toContain('/')
      // The countdowns tick on the client clock with no server traffic.
      await act(async () => { jest.advanceTimersByTime(1_000) })
      expect(label()).toBe('Model at capacity, retry 1 in 0s (gives up in 9m 59s)…')
      for (const renderer of renderers.splice(0)) act(() => renderer.unmount())
      jest.useRealTimers()
      setSystemTime()
    }
  })

  test('W7: an expiring capacity retry shows only the window close, and an ordinary upstream retry keeps its attempt/maximum label', async () => {
    const s = await backoff()
    // Codex's own upstream retry during the continuation: the provider's activity, rendered as before.
    s.clock.advance(1_000)
    await until(() => s.server.turnStarts().length === 2)
    await bind(s, 'a2')
    s.server.notify('error', { turnId: 'a2', willRetry: true, error: { message: 'busy', codexErrorInfo: 'serverOverloaded', additionalDetails: null } })
    await until(() => s.activities.at(-1)?.phase === 'retrying')
    expect(fields(s.activities.at(-1)!)).toEqual({ phase: 'retrying', attempt: 1, maxRetries: 1 })
    useChatStore.getState().setActivity(s.id, s.activities.at(-1)!)
    expect(row(s.id)()).toBe('Retrying (1/1)…')
    // The continuation fails 1,000 ms before the deadline: retry 2 (2,000 ms) cannot fit, only the window close is shown.
    s.clock.advance(598_000)
    s.server.notify('turn/completed', failed('a2'))
    await until(() => s.activities.at(-1)?.retryOwner === 'capacity')
    const expiring = s.activities.at(-1)!
    expect(fields(expiring)).toEqual({ phase: 'retrying', attempt: 1, retryOwner: 'capacity', retryDeadline: EPOCH0 + 600_000 })
    expect(fields(snapshotActivity(s)!)).toEqual(fields(expiring))
    clientClockAt(s.clock.epoch())
    useChatStore.getState().setActivity(s.id, expiring)
    expect(row(s.id)()).toBe('Model at capacity, no retry fits before the window closes (gives up in 1s)…')
  })

  // @covers: codex-chat-sessions › Capacity retries are visible and cancellable › Browser reconnect
  test('L15: a reconnect snapshot during backoff restores the attempt and deadline, sends no request and leaves one pending retry', async () => {
    const s = await backoff()
    const first = s.manager.getSnapshot(s.id)!
    const requests = s.server.requests.length
    // A browser that reconnects reads the snapshot again: same activity, no request, still one wakeup.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const again = s.manager.getSnapshot(s.id)!
    expect(fields(again.activity!)).toEqual(fields(first.activity!))
    expect(fields(again.activity!)).toMatchObject({ retryOwner: 'capacity', attempt: 1, nextRetryAt: EPOCH0 + 1_000, retryDeadline: EPOCH0 + 600_000 })
    await s.server.flush()
    expect(s.server.requests.length).toBe(requests)
    expect(s.clock.pending).toBe(1)
    clientClockAt(s.clock.epoch())
    useChatStore.getState().snapshot(again)
    expect(row(s.id)()).toBe('Model at capacity, retry 1 in 1s (gives up in 10m 00s)…')
  })

  test('L11: Stop during capacity backoff clears the retry activity from the push and the snapshot', async () => {
    const s = await backoff()
    expect(s.manager.interrupt(s.id).ok).toBe(true)
    await until(() => s.manager.getSnapshot(s.id)?.status !== 'working')
    expect(s.activities.at(-1)).toBeNull()
    expect(snapshotActivity(s)).toBeNull()
    expect(s.clock.pending).toBe(0)
  })
})
