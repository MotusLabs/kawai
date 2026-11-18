// codex-capacity-retry start ownership (L1, P3; design D4, journal
// "BINDING-OWNERSHIP CORRECTION DESIGN"): turn/started names no request, so
// while a Stop-cancelled continuation still awaits its turn/start reply a
// successor's native id must not exist yet. A new turn's turn/start waits for
// that reply or its rejection; the cancelled attempt gets exactly one cleanup
// interrupt and the successor binds only its own id, in every order of the
// reply and the notifications. Real package session over the scripted
// app-server and the fake capacity clock.
import { afterEach, describe, expect, test } from 'bun:test'
import { CODEX_CAPACITY_CONTINUATION } from '../src/codex/continuation.js'
import { frames, type Scripted } from './helpers/scriptedCodex.js'
import { failAttempt, opened, scripted, stopScripted, wake } from './helpers/capacitySteps.js'

afterEach(stopScripted)

/** A continuation a2 dispatched with its reply withheld, then Stop, then new human input B. */
async function cancelledThenNewer() {
  const s = scripted('bounded')
  await opened(s)
  await failAttempt(s, 'a1')
  const cancelled = (await wake(s))!
  expect(cancelled.params.input?.[0]?.text).toBe(CODEX_CAPACITY_CONTINUATION)
  await s.driver.interrupt()
  const next = await s.driver.send('new human request')
  await s.flush()
  return { s, cancelled, next }
}

const humanStarts = (s: Scripted) => s.turnStarts().filter((r) => r.params.input?.[0]?.text === 'new human request')

/** B's own reply and turn/started in the given order, then its success. */
type Order = 'reply-first' | 'started-first'

async function bindNewer(s: Scripted, order: Order) {
  const start = humanStarts(s).at(-1)!
  if (order === 'started-first') s.notify(...frames.started('b1'))
  s.reply(start.id, { turn: { id: 'b1' } })
  if (order === 'reply-first') s.notify(...frames.started('b1'))
  await s.flush()
  s.notify(...frames.completed('b1', [{ type: 'agentMessage', id: 'm-b1', text: 'b done' }]))
  await s.flush()
}

/** The cancelled continuation's reply and turn/started in one order, then B's in another. */
async function bothOrders(cancelledOrder: Order, newerOrder: Order) {
  const { s, cancelled, next } = await cancelledThenNewer()
  // No successor turn/start is written while the cancelled continuation's reply is outstanding.
  expect(humanStarts(s)).toHaveLength(0)
  if (cancelledOrder === 'started-first') s.notify(...frames.started('a2'))
  s.reply(cancelled.id, { turn: { id: 'a2' } })
  if (cancelledOrder === 'reply-first') s.notify(...frames.started('a2'))
  await s.flush()
  expect(humanStarts(s)).toHaveLength(1)
  await bindNewer(s, newerOrder)
  expect(s.interrupts().map((r) => r.params.turnId)).toEqual(['a2'])
  expect(await next.result).toMatchObject({ outcome: 'success', finalText: 'b done', turnId: next.turnId })
  expect(s.driver.state).toBe('idle')
}

describe('codex-capacity-retry start ownership', () => {
  test('L1: a newer turn\'s turn/start waits for the cancelled continuation\'s reply, so its turn/started cannot precede that reply', async () => {
    // The advisor's reproduction needs B's turn/start on the wire before a2's reply: it is not written.
    const { s, cancelled, next } = await cancelledThenNewer()
    s.clock.advance(60_000)
    await s.flush()
    expect(humanStarts(s)).toHaveLength(0)
    expect(s.interrupts()).toEqual([])
    s.reply(cancelled.id, { turn: { id: 'a2' } })
    await s.flush()
    expect(s.interrupts().map((r) => r.params.turnId)).toEqual(['a2'])
    expect(humanStarts(s)).toHaveLength(1)
    // Then B's turn/started before B's reply (the advisor's order for B) binds B, never the cancelled attempt.
    await bindNewer(s, 'started-first')
    expect(s.interrupts().map((r) => r.params.turnId)).toEqual(['a2'])
    expect((await next.result).outcome).toBe('success')
  })

  test('L1: the advisor\'s order (newer turn/started, newer reply, then the cancelled reply) interrupts only a2 and the newer turn succeeds', async () => {
    const { s, cancelled, next } = await cancelledThenNewer()
    // Each frame is sent as soon as its request is on the wire: B's started and reply first if B's start was written.
    let bound = false
    if (humanStarts(s).length) {
      s.notify(...frames.started('b1'))
      await s.flush()
      s.reply(humanStarts(s)[0]!.id, { turn: { id: 'b1' } })
      bound = true
    }
    s.reply(cancelled.id, { turn: { id: 'a2' } })
    await s.flush()
    if (bound) {
      s.notify(...frames.completed('b1', [{ type: 'agentMessage', id: 'm-b1', text: 'b done' }]))
      await s.flush()
    } else await bindNewer(s, 'started-first')
    expect(s.interrupts().map((r) => r.params.turnId)).toEqual(['a2'])
    expect(await next.result).toMatchObject({ outcome: 'success', finalText: 'b done' })
  })

  test('L1: cancelled continuation reply-first then newer turn reply-first: one cleanup interrupt of a2, the newer turn binds b1', async () => {
    await bothOrders('reply-first', 'reply-first')
  })

  test('L1: cancelled continuation reply-first then newer turn started-first: one cleanup interrupt of a2, the newer turn binds b1', async () => {
    await bothOrders('reply-first', 'started-first')
  })

  test('L1: cancelled continuation started-first then newer turn reply-first: one cleanup interrupt of a2, the newer turn binds b1', async () => {
    await bothOrders('started-first', 'reply-first')
  })

  test('L1: cancelled continuation started-first then newer turn started-first: one cleanup interrupt of a2, the newer turn binds b1', async () => {
    await bothOrders('started-first', 'started-first')
  })

  test('L1: a rejected cancelled continuation releases the waiting newer turn, which binds its own id', async () => {
    const { s, cancelled, next } = await cancelledThenNewer()
    s.fail(cancelled.id, 'turn refused', 'serverOverloaded')
    await s.flush()
    expect(humanStarts(s)).toHaveLength(1)
    await bindNewer(s, 'started-first')
    expect(s.interrupts()).toEqual([])
    expect((await next.result).outcome).toBe('success')
  })

  test('L11: Stop of the newer turn while it waits sends no turn/start for it and the next turn binds its own id', async () => {
    const { s, cancelled, next } = await cancelledThenNewer()
    await s.driver.interrupt()
    expect((await next.result).outcome).toBe('interrupted')
    s.reply(cancelled.id, { turn: { id: 'a2' } })
    await s.flush()
    expect(humanStarts(s)).toHaveLength(0)
    expect(s.interrupts().map((r) => r.params.turnId)).toEqual(['a2'])
    const third = await s.driver.send('third')
    await s.flush()
    const start = s.turnStarts().at(-1)!
    expect(start.params.input?.[0]?.text).toBe('third')
    s.notify(...frames.started('c1'))
    s.reply(start.id, { turn: { id: 'c1' } })
    await s.flush()
    s.notify(...frames.completed('c1'))
    await s.flush()
    expect(await third.result).toMatchObject({ outcome: 'success', turnId: third.turnId })
    expect(s.interrupts().map((r) => r.params.turnId)).toEqual(['a2'])
  })

  test('L12: a process exit while the newer turn waits ends it once and writes nothing later', async () => {
    const { s, next } = await cancelledThenNewer()
    s.exit(9)
    await s.flush()
    expect((await next.result).outcome).toBe('process-ended')
    s.clock.advance(3_600_000)
    await s.flush()
    expect(humanStarts(s)).toHaveLength(0)
  })

  test('L14: without an outstanding continuation reply a new turn/start is written synchronously as before', async () => {
    for (const option of ['bounded', undefined] as const) {
      const s = scripted(option)
      await s.driver.start()
      void s.driver.send('plain')
      // The send resolves after the write: the request exists before any flush.
      await Promise.resolve()
      await s.flush()
      expect(s.turnStarts().map((r) => r.params.input?.[0]?.text)).toEqual(['plain'])
    }
  })
})
