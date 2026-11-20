// codex-capacity-retry cancellation rows L11-L14, L16, L18-L20, committed
// verbatim (design "Acceptance oracles", task 2.2), over the real package
// session, a scripted app-server and the fake capacity clock. L15 (browser
// reconnect) has no package seam: it runs through Kawai's manager snapshot
// (src/server/__tests__/codexCapacityManager.test.ts). State A is an attempt
// running, B a pending backoff wakeup, E an ended logical turn.
import { afterEach, describe, expect, test } from 'bun:test'
import { CODEX_CAPACITY_CONTINUATION } from '../src/codex/continuation.js'
import { frames, THREAD, type Scripted } from './helpers/scriptedCodex.js'
import { bindAttempt, completeAttempt, failAttempt, opened, recovery, scripted, stopScripted, wake } from './helpers/capacitySteps.js'

afterEach(stopScripted)

export const LIFECYCLE_TABLE_B = [
  ['L11', 'current', 'A or B', 'Stop / interrupt', 'One interruption; no pending retry; interrupt dispatched attempt if necessary'],
  ['L12', 'current', 'A or B', 'archive / kill / shutdown / process exit', 'Existing lifecycle settlement; no pending retry or later dispatch'],
  ['L13', 'current', 'B', 'new human input', 'Old logical turn interrupted; one new human input sent on same thread; old callbacks inert'],
  ['L14', 'current', 'A', 'new human input', 'Existing active-turn steering; no parallel capacity attempt'],
  ['L15', 'current', 'A or B', 'browser disconnect / reconnect', 'No extra request; reconnect snapshot restores current activity'],
  ['L16', 'current', 'A or B', 'backend crash then restart', 'No retry restored; history readable; no automatic continuation'],
  ['L18', 'current', 'E', 'new human input', 'One new logical turn and input; fresh capacity budget if subsequently needed'],
  ['L19', 'current', 'E', 'other notification / timer / lifecycle / reconnect', 'No automatic capacity request or reopened old turn; existing idle/lifecycle behavior'],
  ['L20', 'current', 'A or B', 'urgent direct delivery', 'Existing urgent interruption after pending cards resolve; recovery generation invalidated and timer cleared before the urgent turn starts; a dispatched attempt is interrupted if one is running; no recovery resumes afterward'],
] as const

/** A turn waiting in backoff (B) after a1's capacity failure. */
async function backoff() {
  const s = scripted('bounded')
  const handle = await opened(s)
  await failAttempt(s, 'a1')
  return { s, handle, stale: [...s.clock.timers.values()][0]!.fire }
}

/** A turn whose continuation attempt a2 runs (A). */
async function running() {
  const { s, handle } = await backoff()
  await bindAttempt(s, (await wake(s))!, 'a2')
  return { s, handle }
}

/** Nothing more happens however long the clock runs and whatever stale callback fires. */
async function inert(s: Scripted, stale?: () => void): Promise<void> {
  const before = recovery(s)
  stale?.()
  s.clock.advance(3_600_000)
  await s.flush()
  expect(recovery(s)).toEqual(before)
}

describe('codex-capacity-retry cancellation rows', () => {
  test('the lifecycle table rows L11-L20 are committed verbatim', () => {
    expect(LIFECYCLE_TABLE_B.map((row) => row[0])).toEqual(['L11', 'L12', 'L13', 'L14', 'L15', 'L16', 'L18', 'L19', 'L20'])
  })

  // @covers: codex-chat-sessions › Capacity retries are visible and cancellable › Stop during backoff
  test('L11: Stop during backoff interrupts once, sends no native interrupt and leaves no pending retry', async () => {
    const { s, handle, stale } = await backoff()
    await s.driver.interrupt()
    await s.flush()
    expect((await handle.result).outcome).toBe('interrupted')
    expect(recovery(s)).toEqual({ timers: 0, retries: 1, continuations: 0, terminals: 1, state: 'idle' })
    expect(s.interrupts()).toEqual([])
    expect(s.activities.at(-1)).toBeNull()
    await inert(s, stale)
  })

  test('L11: Stop during a running capacity attempt interrupts that attempt once', async () => {
    const { s, handle } = await running()
    await s.driver.interrupt()
    await s.flush()
    expect((await handle.result).outcome).toBe('interrupted')
    expect(s.interrupts().map((r) => r.params)).toEqual([{ threadId: THREAD, turnId: 'a2' }])
    s.notify(...frames.failed('a2', 'serverOverloaded'))
    await s.flush()
    expect(recovery(s)).toEqual({ timers: 0, retries: 1, continuations: 1, terminals: 1, state: 'idle' })
    await inert(s)
  })

  // @covers: codex-chat-sessions › Capacity retries are visible and cancellable › Lifecycle termination
  test('L12: kill, shutdown and process exit during backoff or an attempt settle the turn once and dispatch nothing later', async () => {
    for (const end of ['kill', 'shutdown', 'exit'] as const) {
      for (const state of ['B', 'A'] as const) {
        const { s, handle } = state === 'B' ? await backoff() : await running()
        const stale = [...s.clock.timers.values()][0]?.fire
        if (end === 'exit') s.exit(9)
        else await s.driver[end]()
        await s.flush()
        expect((await handle.result).outcome).toBe(end === 'exit' ? 'process-ended' : 'interrupted')
        expect(recovery(s)).toMatchObject({ timers: 0, terminals: 1, continuations: state === 'B' ? 0 : 1 })
        await inert(s, stale)
      }
    }
  })

  test('L11/L12: Stop or a lifecycle end reentered from request_resolved while a capacity failure cancels a pending approval arms no retry', async () => {
    for (const end of ['interrupt', 'kill', 'shutdown'] as const) {
      for (const attempt of ['a1', 'a2'] as const) {
        let armed = false
        const s = scripted('bounded', undefined, { unansweredRequests: 'wait', onEvent: (event, driver) => {
          if (event.type === 'request_resolved' && armed) void (armed = false, driver[end]())
        } })
        const handle = await opened(s)
        if (attempt === 'a2') {
          await failAttempt(s, 'a1')
          await bindAttempt(s, (await wake(s))!, 'a2')
        }
        const retries = attempt === 'a2' ? 1 : 0
        const approval = s.ask('item/commandExecution/requestApproval', { turnId: attempt, itemId: 'cmd', command: 'touch f' })
        await s.flush()
        expect(s.driver.pendingRequests()).toHaveLength(1)
        armed = true
        await failAttempt(s, attempt)
        // A kill or shutdown ends the process before the cancel reply reaches it; an interrupt leaves it to answer.
        if (end === 'interrupt') expect((await approval).result).toEqual({ decision: 'cancel' })
        expect(s.driver.pendingRequests()).toEqual([])
        expect((await handle.result).outcome).toBe('interrupted')
        const types = s.types()
        expect(types.slice(types.indexOf('turn_interrupted')).filter((t) => t === 'capacity_retry')).toEqual([])
        expect(recovery(s)).toMatchObject({ timers: 0, retries, continuations: retries, terminals: 1 })
        await inert(s)
      }
    }
  })

  // @covers: codex-chat-sessions › Capacity retries are visible and cancellable › Human input during backoff
  test('L13: human input during backoff interrupts the old turn and only the new input goes to the same thread', async () => {
    const { s, handle, stale } = await backoff()
    await expect(s.driver.send('new instruction', { continuation: 'steer' })).rejects.toMatchObject({ code: 'turn-ended' })
    expect((await handle.result).outcome).toBe('interrupted')
    expect(s.clock.pending).toBe(0)
    const next = await s.driver.send('new instruction')
    await s.flush()
    const starts = s.turnStarts()
    expect(starts).toHaveLength(2)
    expect(starts[1]!.params).toMatchObject({ threadId: THREAD, input: [{ type: 'text', text: 'new instruction' }] })
    expect(next.turnId).not.toBe(handle.turnId)
    expect(s.interrupts()).toEqual([])
    stale()
    s.clock.advance(3_600_000)
    await s.flush()
    expect(recovery(s).continuations).toBe(0)
    expect(s.turnStarts()).toHaveLength(2)
  })

  test('L14: human input during a running capacity attempt steers that attempt and starts no parallel attempt', async () => {
    const { s, handle } = await running()
    const steered = await s.driver.send('also this', { continuation: 'steer' })
    await s.flush()
    expect(steered.turnId).toBe(handle.turnId)
    const steer = s.requests.filter((r) => r.method === 'turn/steer')
    expect(steer.map((r) => ({ expected: r.params.expectedTurnId, text: r.params.input?.[0]?.text }))).toEqual([{ expected: 'a2', text: 'also this' }])
    expect(recovery(s)).toEqual({ timers: 0, retries: 1, continuations: 1, terminals: 0, state: 'active' })
    await completeAttempt(s, 'a2')
    expect((await handle.result).outcome).toBe('success')
  })

  // @covers: codex-chat-sessions › Capacity retries are visible and cancellable › Backend restart
  test('L16: after a backend crash during backoff a resumed session restores no retry and sends no continuation', async () => {
    const { s } = await backoff()
    await s.driver.kill()
    const restarted = scripted('bounded', THREAD)
    await restarted.driver.start()
    await restarted.flush()
    expect(restarted.requests.map((r) => r.method)).toContain('thread/resume')
    await inert(restarted)
    expect(restarted.turnStarts()).toEqual([])
    expect(restarted.driver.state).toBe('idle')
  })

  test('L18: new human input after the turn ended opens one new turn with a fresh capacity budget', async () => {
    const { s, handle } = await running()
    s.clock.advance(300_000)
    await completeAttempt(s, 'a2')
    expect((await handle.result).outcome).toBe('success')
    const next = await s.driver.send('next task')
    await s.flush()
    s.reply(s.turnStarts().at(-1)!.id, { turn: { id: 'b1' } })
    s.notify(...frames.started('b1'))
    await failAttempt(s, 'b1')
    const retry = s.events.filter((e) => e.type === 'capacity_retry').at(-1) as { turnId: string; ordinal: number; deadline: string }
    expect(retry).toMatchObject({ turnId: next.turnId, ordinal: 1, deadline: new Date(s.clock.epoch() + 600_000).toISOString() })
    expect([...s.clock.timers.values()].map((t) => t.at)).toEqual([s.clock.now + 1000])
  })

  test('L19: after the turn ended, stale frames, timers and lifecycle calls reopen nothing and send no capacity request', async () => {
    const { s, handle } = await running()
    await completeAttempt(s, 'a2')
    expect((await handle.result).outcome).toBe('success')
    for (const [method, params] of [frames.failed('a2', 'serverOverloaded'), frames.failed('a1', 'serverOverloaded'), frames.started('a2'), frames.retryError('a2', 'serverOverloaded')]) s.notify(method, params)
    await s.flush()
    await inert(s)
    expect(await s.driver.interrupt()).toMatchObject({ outcome: 'no-active-turn' })
    expect(recovery(s)).toEqual({ timers: 0, retries: 1, continuations: 1, terminals: 1, state: 'idle' })
    // A turn that ended while it waited in backoff: its wakeup and late frames revive nothing either.
    const ended = await backoff()
    await ended.s.driver.interrupt()
    ended.s.notify(...frames.failed('a1', 'serverOverloaded'))
    await ended.s.flush()
    await inert(ended.s, ended.stale)
    expect(recovery(ended.s)).toEqual({ timers: 0, retries: 1, continuations: 0, terminals: 1, state: 'idle' })
  })

  // @covers: codex-chat-sessions › Capacity retries are visible and cancellable › Urgent delivery during backoff
  test('L20: an urgent interruption during backoff or an attempt invalidates recovery before the urgent turn and no recovery resumes', async () => {
    for (const state of ['B', 'A'] as const) {
      const { s, handle } = state === 'B' ? await backoff() : await running()
      const stale = [...s.clock.timers.values()][0]?.fire
      // The dispatcher interrupts the busy recipient, then delivers the envelope as a new turn.
      await s.driver.interrupt()
      expect(s.clock.pending).toBe(0)
      const envelope = '<peer-message from="lead">urgent</peer-message>'
      await s.driver.send(envelope)
      await s.flush()
      expect((await handle.result).outcome).toBe('interrupted')
      expect(s.interrupts().map((r) => r.params.turnId)).toEqual(state === 'A' ? ['a2'] : [])
      const inputs = s.turnStarts().map((r) => r.params.input?.[0]?.text)
      expect(inputs.filter((t) => t === envelope)).toHaveLength(1)
      stale?.()
      s.clock.advance(3_600_000)
      await s.flush()
      expect(s.turnStarts().map((r) => r.params.input?.[0]?.text).filter((t) => t === CODEX_CAPACITY_CONTINUATION)).toHaveLength(state === 'A' ? 1 : 0)
      expect(s.turnStarts().at(-1)!.params.input?.[0]?.text).toBe(envelope)
    }
  })
})
