// codex-capacity-retry lifecycle rows L1-L10 and L17 and timing table T1-T6,
// committed verbatim (design "Acceptance oracles", tasks 1.2, 2.1, 2.2), over
// the real package session, a scripted app-server and the fake capacity
// clock. The cancellation rows L11-L20 are in codexCapacityCancellation.test.ts.
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { capacityRetryDelay, capacitySchedule, capacityWake } from '../src/codex/capacityRetry.js'
import { CODEX_CAPACITY_CONTINUATION } from '../src/codex/continuation.js'
import { frames, THREAD } from './helpers/scriptedCodex.js'
import { bindAttempt, completeAttempt, failAttempt, limitFailures, opened, recovery, scripted, stopScripted, wake } from './helpers/capacitySteps.js'

afterEach(stopScripted)

export const LIFECYCLE_TABLE_A = [
  ['L1', 'stale', '*', 'any', "No dispatch, terminal event, activity replacement, or budget extension; the one permitted effect is a single cleanup interrupt scoped to the already-dispatched cancelled attempt's original client, thread, and attempt id, never a newer attempt"],
  ['L2', 'current', 'A', 'matching capacity completion, next due < deadline', 'Remain working; publish retry timing; schedule exactly one wakeup'],
  ['L3', 'current', 'A', 'matching capacity completion, now < deadline <= next due', 'Remain working until deadline; no further attempt; publish expiring recovery'],
  ['L4', 'current', 'A', 'matching capacity completion, now >= deadline', 'One terminal capacity error/completion; waiting; no quota outcome'],
  ['L5', 'current', 'A', 'matching success completion', 'One success completion; waiting; no timer'],
  ['L6', 'current', 'A', 'matching non-capacity failure or start RPC rejection', 'Existing terminal error/quota handling once; no capacity timer'],
  ['L7', 'current', 'A', 'upstream error notification', 'No competing dispatch or completion; show upstream retry activity only if willRetry'],
  ['L8', 'current', 'B', 'wakeup, now < deadline and now < next due', 'No dispatch; retain one wakeup for due time'],
  ['L9', 'current', 'B', 'wakeup, next due <= now < deadline', 'One continuation request, same thread/model; working'],
  ['L10', 'current', 'B', 'wakeup, now >= deadline', 'One exhausted-capacity completion/error; waiting; no continuation'],
  ['L17', 'current', 'A', 'item / usage / approval / question frames', 'Existing streaming/request behavior; usage baseline spans attempts'],
] as const

export const TIMING_TABLE = [
  ['T1', 'n=1, r=0', 'Retry delay 1,000 ms'],
  ['T2', 'n=2, r approaching 1', 'Retry delay 4,000 ms'],
  ['T3', 'n>=6, any r', 'Retry delay in [30,000, 60,000] ms'],
  ['T4', 'due exactly deadline or later', 'No continuation dispatch'],
  ['T5', 'timer scheduled before deadline, callback executes at deadline or later', 'No continuation dispatch'],
  ['T6', 'wall clock jumps while monotonic time is stable', 'Dispatch eligibility and remaining budget unchanged'],
] as const

/** Run attempts until the attempt that fails at monotonic `at` (the first failure at 0 fixed the deadline 600_000). */
async function failingAt(at: number, randoms: number[] = []) {
  const s = scripted('bounded')
  const handle = await opened(s)
  await failAttempt(s, 'a1')
  const request = await wake(s)
  await bindAttempt(s, request!, 'a2')
  s.clock.advance(at - s.clock.now)
  s.clock.randoms.push(...randoms)
  await failAttempt(s, 'a2')
  return { s, handle }
}

describe('codex-capacity-retry lifecycle rows L1-L10, L17', () => {
  test('the lifecycle and timing tables are committed verbatim', () => {
    expect(LIFECYCLE_TABLE_A.map((row) => row[0])).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L17'])
    expect(TIMING_TABLE.map((row) => row[0])).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6'])
  })

  // @covers: codex-chat-sessions › Codex internal retries retain control of their attempt › Terminal duplicate
  test('L1: a duplicate completion, a late item and a stale wakeup of a retired attempt change nothing', async () => {
    const s = scripted('bounded')
    await opened(s)
    await failAttempt(s, 'a1')
    const deadline = (s.events.find((e) => e.type === 'capacity_retry') as { deadline: string }).deadline
    const stale = [...s.clock.timers.values()][0]!.fire
    const activities = s.activities.length
    await failAttempt(s, 'a1')
    s.notify('item/started', { turnId: 'a1', item: { type: 'reasoning', id: 'r-late' } })
    s.notify(...frames.started('a1'))
    s.notify(...frames.completed('a1'))
    await s.flush()
    expect(recovery(s)).toEqual({ timers: 1, retries: 1, continuations: 0, terminals: 0, state: 'active' })
    expect(s.activities.length).toBe(activities)
    // The armed wakeup dispatches once; the captured duplicate callback afterwards does nothing.
    const request = await wake(s)
    expect(request).not.toBeNull()
    stale()
    await s.flush()
    expect(recovery(s)).toMatchObject({ timers: 0, continuations: 1, terminals: 0 })
    expect((s.events.filter((e) => e.type === 'capacity_retry') as Array<{ deadline: string }>).map((e) => e.deadline)).toEqual([deadline])
    // The retired id's late turn/started never binds the new attempt: only its own reply does.
    await bindAttempt(s, request!, 'a2')
    await completeAttempt(s, 'a2')
    expect(recovery(s)).toMatchObject({ terminals: 1, state: 'idle' })
    expect(s.interrupts()).toEqual([])
  })

  // @covers: codex-chat-sessions › Codex internal retries retain control of their attempt › Stale start response after Stop
  test('L1: a start reply after Stop sends exactly one cleanup interrupt for that attempt, never a newer one', async () => {
    for (const order of ['reply-first', 'started-first'] as const) {
      const s = scripted('bounded')
      await opened(s)
      await failAttempt(s, 'a1')
      const request = (await wake(s))!
      await s.driver.interrupt()
      await s.flush()
      expect(s.interrupts()).toEqual([])
      if (order === 'started-first') s.notify(...frames.started('a2'))
      s.reply(request.id, { turn: { id: 'a2' } })
      s.notify(...frames.started('a2'))
      await s.flush()
      expect(s.interrupts().map((r) => r.params)).toEqual([{ threadId: THREAD, turnId: 'a2' }])
      // A newer logical turn is untouched by the old attempt's frames.
      const next = await s.driver.send('new work')
      await s.flush()
      s.reply(s.turnStarts().at(-1)!.id, { turn: { id: 'b1' } })
      s.notify(...frames.started('b1'))
      s.notify(...frames.failed('a2', 'serverOverloaded'))
      s.notify(...frames.completed('b1'))
      await s.flush()
      expect((await next.result).outcome).toBe('success')
      expect(s.interrupts().map((r) => r.params.turnId)).toEqual(['a2'])
      expect(recovery(s)).toMatchObject({ continuations: 1, timers: 0, state: 'idle' })
    }
  })

  test('L1: a late start RPC rejection of a retired attempt does not fail the recovery', async () => {
    const s = scripted('bounded')
    await s.driver.start()
    const handle = await s.driver.send('hello')
    await s.flush()
    const first = s.turnStarts()[0]!
    // The attempt binds from turn/started alone; its turn/start reply is still outstanding when it fails.
    s.notify(...frames.started('a1'))
    await failAttempt(s, 'a1')
    s.fail(first.id, 'request timed out', 'serverOverloaded')
    await s.flush()
    expect(recovery(s)).toEqual({ timers: 1, retries: 1, continuations: 0, terminals: 0, state: 'active' })
    await bindAttempt(s, (await wake(s))!, 'a2')
    await completeAttempt(s, 'a2')
    expect((await handle.result).outcome).toBe('success')
    expect(s.types().filter((t) => t === 'error')).toEqual([])
  })

  test('L1: late frames, requests and tool calls naming a retired attempt reach no fact, card or host code', async () => {
    const s = scripted('bounded')
    const handle = await opened(s)
    await failAttempt(s, 'a1')
    const events = s.events.length
    const activities = s.activities.length
    s.notify('item/completed', { turnId: 'a1', item: { type: 'contextCompaction', id: 'cmp-late' } })
    s.notify('item/started', { turnId: 'a1', item: { type: 'commandExecution', id: 'cmd-late', command: 'rm -rf x', cwd: '/', status: 'inProgress' } })
    s.notify('thread/tokenUsage/updated', { turnId: 'a1', tokenUsage: { total: { inputTokens: 999, cachedInputTokens: 0, outputTokens: 999, reasoningOutputTokens: 0, totalTokens: 1998 }, last: { inputTokens: 999, cachedInputTokens: 0, outputTokens: 999, reasoningOutputTokens: 0, totalTokens: 1998 }, modelContextWindow: 1000 } })
    s.notify(...frames.retryError('a1', 'usageLimitExceeded'))
    const approval = await s.ask('item/commandExecution/requestApproval', { turnId: 'a1', itemId: 'cmd-late', command: 'rm -rf x' })
    await s.flush()
    expect(s.events.length).toBe(events)
    expect(s.activities.length).toBe(activities)
    expect(s.limits).toEqual([])
    expect(s.driver.pendingRequests()).toEqual([])
    expect(approval.result).toMatchObject({ decision: expect.stringMatching(/cancel|decline|denied/) })
    // An account-level push without a turn id still flows.
    s.notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1_795_100_000 } } })
    await bindAttempt(s, (await wake(s))!, 'a2')
    await completeAttempt(s, 'a2')
    const result = await handle.result
    expect(result).toMatchObject({ outcome: 'success', usage: null, toolCallCount: 0, compactionCount: 0 })
  })

  // @covers: codex-chat-sessions › Codex turns stream into the chat transcript › Capacity attempt fails
  test('L2: a capacity completion before the deadline keeps the turn working, publishes retry timing and arms exactly one wakeup', async () => {
    const s = scripted('bounded')
    const handle = await opened(s)
    let settled = false
    void handle.result.then(() => (settled = true))
    await failAttempt(s, 'a1')
    expect(recovery(s)).toEqual({ timers: 1, retries: 1, continuations: 0, terminals: 0, state: 'active' })
    expect(s.types()).toEqual(['turn_started', 'user_message', 'capacity_retry'])
    expect(s.events.at(-1)).toMatchObject({ type: 'capacity_retry', turnId: handle.turnId, ordinal: 1, nextRetryAt: new Date(s.clock.epoch() + 1000).toISOString(), deadline: new Date(s.clock.epoch() + 600_000).toISOString(), expiring: false })
    // reduceActivity and projectActivity each default to an independent
    // Date.now (common/activity.ts) and the fake capacity clock does not
    // freeze the wall clock, so only a finite nonnegative elapsed is guaranteed.
    const activity = s.activities.at(-1)!
    expect(activity).toEqual({ phase: 'retrying', attempt: 1, owner: 'capacity', ordinal: 1, nextRetryAt: s.clock.epoch() + 1000, deadline: s.clock.epoch() + 600_000, elapsedMs: expect.any(Number) })
    expect(Number.isFinite(activity.elapsedMs)).toBe(true)
    expect(activity.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(settled).toBe(false)
  })

  // Regression for the CI 45423279103 flake class: reduceActivity and
  // projectActivity (common/activity.ts) each default to an independent
  // Date.now, so a wall tick between the two reads is a legitimate elapsed
  // value, not a broken zero. With the wall clock advancing 1 ms per read,
  // the retrying activity must still carry the L2 shape and a positive
  // finite elapsed. The stub restores even on failure so it never leaks.
  test('L2: a 1 ms tick per Date.now read leaves the retrying activity positive and finite', async () => {
    const s = scripted('bounded')
    await opened(s)
    let ticks = 0
    const base = Date.now()
    const now = spyOn(Date, 'now').mockImplementation(() => base + ++ticks)
    try {
      await failAttempt(s, 'a1')
    } finally {
      now.mockRestore()
    }
    expect(recovery(s)).toEqual({ timers: 1, retries: 1, continuations: 0, terminals: 0, state: 'active' })
    const activity = s.activities.at(-1)!
    expect(activity).toEqual({ phase: 'retrying', attempt: 1, owner: 'capacity', ordinal: 1, nextRetryAt: s.clock.epoch() + 1000, deadline: s.clock.epoch() + 600_000, elapsedMs: expect.any(Number) })
    expect(Number.isFinite(activity.elapsedMs)).toBe(true)
    expect(activity.elapsedMs).toBeGreaterThan(0)
  })

  test('L3: a capacity completion whose next due reaches the deadline publishes expiring recovery and sends no further attempt', async () => {
    const { s, handle } = await failingAt(598_000, [0])
    expect(recovery(s)).toEqual({ timers: 1, retries: 2, continuations: 1, terminals: 0, state: 'active' })
    expect(s.events.at(-1)).toMatchObject({ type: 'capacity_retry', ordinal: 1, nextRetryAt: null, expiring: true })
    expect(s.activities.at(-1)).toMatchObject({ phase: 'retrying', owner: 'capacity', ordinal: 1 })
    expect(s.activities.at(-1)).not.toHaveProperty('nextRetryAt')
    expect([...s.clock.timers.values()].map((t) => t.at)).toEqual([600_000])
    s.clock.advance(1_999)
    await s.flush()
    expect(recovery(s)).toMatchObject({ continuations: 1, terminals: 0, state: 'active' })
    await wake(s)
    expect((await handle.result).outcome).toBe('failed')
    expect(recovery(s)).toEqual({ timers: 0, retries: 2, continuations: 1, terminals: 1, state: 'idle' })
  })

  // @covers: codex-chat-sessions › Codex capacity failures recover within a bounded window › Attempt crosses the deadline
  test('L4: a capacity completion at or after the deadline ends the turn once with the capacity error and no quota outcome', async () => {
    for (const at of [600_000, 700_000]) {
      const { s, handle } = await failingAt(at)
      const result = await handle.result
      expect(result).toMatchObject({ outcome: 'failed', error: { code: 'serverOverloaded' } })
      expect(recovery(s)).toEqual({ timers: 0, retries: 1, continuations: 1, terminals: 1, state: 'idle' })
      expect(s.types().slice(-3)).toEqual(['notice', 'turn_completed', 'error'])
      expect(limitFailures(s)).toEqual([])
    }
  })

  // @covers: codex-chat-sessions › Codex capacity failures recover within a bounded window › Capacity clears
  test('L5: a success completion of a capacity attempt completes the logical turn once and leaves no timer', async () => {
    const s = scripted('bounded')
    const handle = await opened(s)
    await failAttempt(s, 'a1')
    await bindAttempt(s, (await wake(s))!, 'a2')
    await completeAttempt(s, 'a2', 'recovered')
    const result = await handle.result
    expect(result).toMatchObject({ outcome: 'success', finalText: 'recovered', turnId: handle.turnId, messageUuid: handle.messageUuid })
    expect(recovery(s)).toEqual({ timers: 0, retries: 1, continuations: 1, terminals: 1, state: 'idle' })
    expect(s.results).toHaveLength(1)
    expect(s.activities.at(-1)).toBeNull()
  })

  // @covers: codex-chat-sessions › Codex capacity failures recover within a bounded window › Other errors
  test('L6: a non-capacity failure or a refused continuation start ends the turn once with no capacity timer', async () => {
    for (const ending of ['usageLimitExceeded', 'contextWindowExceeded', 'rpc'] as const) {
      const s = scripted('bounded')
      const handle = await opened(s)
      await failAttempt(s, 'a1')
      const request = (await wake(s))!
      if (ending === 'rpc') s.fail(request.id, 'turn refused', 'serverOverloaded')
      else {
        await bindAttempt(s, request, 'a2')
        s.notify(...frames.failed('a2', ending))
      }
      await s.flush()
      expect((await handle.result).outcome).toBe('failed')
      expect(recovery(s)).toEqual({ timers: 0, retries: 1, continuations: 1, terminals: 1, state: 'idle' })
      expect(s.types().filter((t) => t === 'error')).toHaveLength(1)
      expect(limitFailures(s).map((e) => e.kind)).toEqual(ending === 'usageLimitExceeded' ? ['usageLimitExceeded'] : [])
    }
  })

  test('L6: after a refused continuation start the next turn binds its own native id and completes once', async () => {
    // Found by P1: the refused turn stayed first in the unbound queue and took the next turn's turn/started id.
    const s = scripted('bounded')
    await opened(s)
    await failAttempt(s, 'a1')
    s.fail((await wake(s))!.id, 'turn refused', 'serverOverloaded')
    await s.flush()
    const next = await s.driver.send('next task')
    await s.flush()
    s.notify(...frames.started('b1'))
    s.reply(s.turnStarts().at(-1)!.id, { turn: { id: 'b1' } })
    await s.flush()
    s.notify(...frames.failed('b1', 'contextWindowExceeded'))
    await s.flush()
    expect(await next.result).toMatchObject({ outcome: 'failed', turnId: next.turnId })
    expect(recovery(s)).toEqual({ timers: 0, retries: 1, continuations: 1, terminals: 2, state: 'idle' })
  })

  // @covers: codex-chat-sessions › Codex internal retries retain control of their attempt › Codex retries internally
  test('L7: an upstream error notification during an attempt starts no competing dispatch or completion', async () => {
    for (const willRetry of [true, false]) {
      const s = scripted('bounded')
      const handle = await opened(s)
      await failAttempt(s, 'a1')
      await bindAttempt(s, (await wake(s))!, 'a2')
      s.notify(...frames.retryError('a2', 'serverOverloaded', willRetry))
      await s.flush()
      expect(recovery(s)).toEqual({ timers: 0, retries: 1, continuations: 1, terminals: 0, state: 'active' })
      // reduceActivity and projectActivity each default to an independent
      // Date.now (common/activity.ts) and the fake capacity clock does not
      // freeze the wall clock, so only a finite nonnegative elapsed is guaranteed.
      const activity = s.activities.at(-1)!
      expect(activity).toEqual(willRetry ? { phase: 'retrying', attempt: 1, maxRetries: 1, elapsedMs: expect.any(Number) } : { phase: 'requesting', elapsedMs: expect.any(Number) })
      expect(Number.isFinite(activity.elapsedMs)).toBe(true)
      expect(activity.elapsedMs).toBeGreaterThanOrEqual(0)
      await completeAttempt(s, 'a2')
      expect((await handle.result).outcome).toBe('success')
    }
  })

  test('L8: an early wakeup before the due time dispatches nothing and keeps one wakeup for the due time', async () => {
    const s = scripted('bounded')
    await opened(s)
    await failAttempt(s, 'a1')
    s.clock.advance(400)
    s.clock.fireAll()
    await s.flush()
    expect(recovery(s)).toMatchObject({ timers: 1, continuations: 0, terminals: 0, state: 'active' })
    expect([...s.clock.timers.values()].map((t) => t.at)).toEqual([1000])
    expect(await wake(s)).not.toBeNull()
  })

  test('L9: a due wakeup sends one continuation on the same thread with the original policy and stays working', async () => {
    const s = scripted('bounded')
    await opened(s)
    await failAttempt(s, 'a1')
    const original = s.turnStarts()[0]!.params
    const request = (await wake(s))!
    const { input, clientUserMessageId, ...rest } = request.params
    const { input: _input, clientUserMessageId: originalId, ...originalRest } = original
    expect(rest).toEqual(originalRest)
    expect(rest.threadId).toBe(THREAD)
    expect(input).toEqual([{ type: 'text', text: CODEX_CAPACITY_CONTINUATION, text_elements: [] }])
    expect(clientUserMessageId).not.toBe(originalId)
    expect(recovery(s)).toEqual({ timers: 0, retries: 1, continuations: 1, terminals: 0, state: 'active' })
    expect(s.events.at(-1)).toMatchObject({ type: 'notice', kind: 'capacity_recovery' })
    // reduceActivity and projectActivity each default to an independent
    // Date.now (common/activity.ts) and the fake capacity clock does not
    // freeze the wall clock, so only a finite nonnegative elapsed is guaranteed.
    const activity = s.activities.at(-1)!
    expect(activity).toEqual({ phase: 'requesting', elapsedMs: expect.any(Number) })
    expect(Number.isFinite(activity.elapsedMs)).toBe(true)
    expect(activity.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  test('L9: after a turn with native images the continuation sends only its text, never the images again', async () => {
    const s = scripted('bounded')
    await s.driver.start()
    const image = { type: 'localImage' as const, path: '/assets/screen.png' }
    await s.driver.send('what is on screen', { images: [image, image] })
    await s.flush()
    s.reply(s.turnStarts()[0]!.id, { turn: { id: 'a1' } })
    s.notify(...frames.started('a1'))
    await s.flush()
    expect(s.turnStarts()[0]!.params.input).toEqual([{ type: 'text', text: 'what is on screen', text_elements: [] }, { type: 'localImage', path: image.path }, { type: 'localImage', path: image.path }])
    await failAttempt(s, 'a1')
    const request = (await wake(s))!
    expect(request.params.input).toEqual([{ type: 'text', text: CODEX_CAPACITY_CONTINUATION, text_elements: [] }])
    expect(recovery(s)).toEqual({ timers: 0, retries: 1, continuations: 1, terminals: 0, state: 'active' })
  })

  // @covers: codex-chat-sessions › Codex capacity failures recover within a bounded window › Capacity persists
  // @covers: profile-limit-handling › Codex limit failures are recorded as limit events › Exhausted capacity recovery
  test('L10: a wakeup at or after the deadline ends the turn once with the exhausted capacity error and sends no continuation', async () => {
    const s = scripted('bounded')
    const handle = await opened(s)
    await failAttempt(s, 'a1')
    s.clock.now = 600_000
    s.clock.fireAll()
    await s.flush()
    const result = await handle.result
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'serverOverloaded' } })
    expect(recovery(s)).toEqual({ timers: 0, retries: 1, continuations: 0, terminals: 1, state: 'idle' })
    expect(s.events.filter((e) => e.type === 'notice').map((e) => (e as { kind?: string }).kind)).toEqual(['capacity_recovery'])
    expect(s.events.find((e) => e.type === 'turn_completed')).toMatchObject({ isError: true, terminalReason: 'serverOverloaded' })
    expect(limitFailures(s)).toEqual([])
  })

  test('L17: item, usage and approval frames stream as before and the turn usage spans every attempt', async () => {
    const s = scripted('bounded')
    const handle = await opened(s)
    const breakdown = (input: number, output: number) => ({ inputTokens: input, cachedInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0, totalTokens: input + output })
    const tokens = (input: number, output: number) => ({ tokenUsage: { total: breakdown(input, output), last: breakdown(input, output), modelContextWindow: 1000 } })
    // The generation's consecutive thread totals: 100/10, then 160/25 (60/15 more) after the capacity retry.
    s.notify('thread/tokenUsage/updated', { turnId: 'a1', ...tokens(100, 10) })
    s.notify('item/started', { turnId: 'a1', item: { type: 'commandExecution', id: 'cmd-1', command: 'touch f', cwd: '/', status: 'inProgress' } })
    s.notify('item/completed', { turnId: 'a1', item: { type: 'commandExecution', id: 'cmd-1', command: 'touch f', cwd: '/', status: 'completed', exitCode: 0, aggregatedOutput: '' } })
    await failAttempt(s, 'a1')
    await bindAttempt(s, (await wake(s))!, 'a2')
    s.notify('thread/tokenUsage/updated', { turnId: 'a2', ...tokens(160, 25) })
    await s.flush()
    await completeAttempt(s, 'a2')
    const result = await handle.result
    expect(result.usage).toMatchObject({ inputTokens: 160, outputTokens: 25 })
    expect(result.toolCallCount).toBe(1)
    expect(s.types().filter((t) => t === 'tool_call' || t === 'tool_result')).toEqual(['tool_call', 'tool_result'])
  })

  test("L17: approval and question requests of the current attempt are served after a retry, and the retired attempt's pending one is cancelled", async () => {
    const s = scripted('bounded', undefined, { unansweredRequests: 'wait' })
    const handle = await opened(s)
    const question = { questions: [{ id: 'q1', question: 'Color?', header: 'Pick', options: [{ label: 'red' }, { label: 'blue' }], isOther: false }] }
    // a1's approval is still pending when a1 fails for capacity: the retirement cancels it and Codex hears cancel.
    const retired = s.ask('item/commandExecution/requestApproval', { turnId: 'a1', itemId: 'cmd-1', command: 'touch f' })
    await s.flush()
    const [stale] = s.driver.pendingRequests()
    expect(stale).toMatchObject({ kind: 'approval' })
    await failAttempt(s, 'a1')
    expect((await retired).result).toEqual({ decision: 'cancel' })
    expect(s.driver.pendingRequests()).toEqual([])
    expect(s.driver.resolveApproval(stale!.requestId, 'allow')).toMatchObject({ ok: false, reason: 'not-pending' })
    expect(s.events.filter((e) => e.type === 'request_resolved')).toEqual([expect.objectContaining({ requestId: stale!.requestId, outcome: 'cancelled' })])
    await bindAttempt(s, (await wake(s))!, 'a2')
    // a2's approval and question reach the caller and their answers reach Codex unchanged.
    const approval = s.ask('item/commandExecution/requestApproval', { turnId: 'a2', itemId: 'cmd-2', command: 'touch g' })
    await s.flush()
    const [live] = s.driver.pendingRequests()
    expect(live).toMatchObject({ kind: 'approval' })
    expect(s.driver.resolveApproval(live!.requestId, 'allow')).toEqual({ ok: true })
    expect((await approval).result).toEqual({ decision: 'accept' })
    const asked = s.ask('item/tool/requestUserInput', { turnId: 'a2', itemId: 'q-2', ...question })
    await s.flush()
    const [pending] = s.driver.pendingRequests()
    expect(pending).toMatchObject({ kind: 'question', questions: [{ question: 'Color?' }] })
    expect(s.driver.answerQuestion(pending!.requestId, { 'Color?': { options: ['blue'] } })).toEqual({ ok: true })
    expect((await asked).result).toEqual({ answers: { q1: { answers: ['blue'] } } })
    const types = s.types()
    expect(types.filter((t) => t === 'approval_request' || t === 'question_request')).toEqual(['approval_request', 'approval_request', 'question_request'])
    expect(s.events.filter((e) => e.type === 'request_resolved').map((e) => (e as { outcome: string }).outcome)).toEqual(['cancelled', 'allowed', 'answered'])
    expect(recovery(s)).toEqual({ timers: 0, retries: 1, continuations: 1, terminals: 0, state: 'active' })
    await completeAttempt(s, 'a2')
    expect((await handle.result).outcome).toBe('success')
  })
})

describe('codex-capacity-retry timing table T', () => {
  test('T1: retry 1 with r=0 waits 1,000 ms', async () => {
    expect(capacityRetryDelay(1, 0)).toBe(1000)
    const s = scripted('bounded')
    await opened(s)
    await failAttempt(s, 'a1')
    expect([...s.clock.timers.values()].map((t) => t.at)).toEqual([1000])
  })

  test('T2: retry 2 with r approaching 1 waits 4,000 ms', () => {
    expect(capacityRetryDelay(2, 0.999_999_9)).toBe(4000)
    expect(capacityRetryDelay(2, 1)).toBe(4000)
  })

  test('T3: retry 6 or later waits between 30,000 and 60,000 ms', () => {
    for (const n of [6, 7, 12, 40]) {
      for (const r of [0, 0.25, 0.5, 0.999_999]) {
        const delay = capacityRetryDelay(n, r)
        expect(delay).toBeGreaterThanOrEqual(30_000)
        expect(delay).toBeLessThanOrEqual(60_000)
      }
    }
    expect(capacityRetryDelay(5, 0.999_999)).toBe(32_000)
  })

  test('T4: a retry due exactly at the deadline or later is not dispatched', async () => {
    expect(capacitySchedule(598_000, 600_000, 2, 0)).toEqual({ kind: 'expiring', due: 600_000, delayMs: 2_000 })
    const { s, handle } = await failingAt(599_000, [0])
    expect(recovery(s)).toMatchObject({ timers: 1, continuations: 1 })
    await wake(s)
    expect((await handle.result).outcome).toBe('failed')
    expect(recovery(s)).toMatchObject({ continuations: 1, terminals: 1 })
  })

  test('T5: a wakeup armed before the deadline that runs at or after it dispatches nothing', async () => {
    expect(capacityWake(600_000, 1000, 600_000)).toBe('expire')
    for (const late of [600_000, 900_000]) {
      const s = scripted('bounded')
      const handle = await opened(s)
      await failAttempt(s, 'a1')
      s.clock.now = late
      s.clock.fireAll()
      await s.flush()
      expect((await handle.result).outcome).toBe('failed')
      expect(recovery(s)).toMatchObject({ continuations: 0, terminals: 1 })
    }
  })

  test('T6: a wall-clock jump leaves dispatch eligibility and the remaining budget unchanged', async () => {
    const s = scripted('bounded')
    await opened(s)
    await failAttempt(s, 'a1')
    s.clock.wallOffset = 3_600_000
    s.clock.advance(999)
    await s.flush()
    expect(recovery(s)).toMatchObject({ continuations: 0 })
    await bindAttempt(s, (await wake(s))!, 'a2')
    s.clock.wallOffset = -86_400_000
    await failAttempt(s, 'a2')
    // The second failure keeps the first deadline (monotonic 600_000); only the display epoch moved.
    expect([...s.clock.timers.values()].map((t) => t.at)[0]).toBeLessThan(600_000)
    s.clock.advance(598_000)
    await s.flush()
    expect(recovery(s).continuations).toBeGreaterThan(1)
  })
})
