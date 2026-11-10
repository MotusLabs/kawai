// Tables SN and AN of manual-task-stall-alerts (design "Acceptance oracles"),
// committed verbatim against the shared `stallOf` derivation.
import { describe, expect, test } from 'bun:test'
import type { TaskStatus } from '../teamTasks'
import { STALL_ELAPSED_MS, STALL_MESSAGE_THRESHOLD, stallOf, type StallInput, type StallMail } from '../taskStall'

const T0 = Date.parse('2026-11-10T08:00:00.000Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN

const agent = (ms: number, session = 'chat-a'): StallMail => ({ createdAt: at(ms), fromKind: 'agent', fromSession: session, fromGroup: null })
const human = (ms: number): StallMail => ({ createdAt: at(ms), fromKind: 'human', fromSession: null, fromGroup: null })
const system = (ms: number): StallMail => ({ createdAt: at(ms), fromKind: 'system', fromSession: null, fromGroup: null })
const agents = (n: number, from = 1) => Array.from({ length: n }, (_, i) => agent((from + i) * 1000))

function input(over: Partial<StallInput> = {}): StallInput {
  return {
    status: 'active', owned: false, createdAt: at(0), revisionAt: null, resultAt: null, reviewAt: null, noticeAt: null,
    mail: [], now: at(0), ...over,
  }
}

describe('SN: stallOf(...).due', () => {
  const rows: Array<[string, TaskStatus, boolean, number, number, boolean]> = [
    ['SN1', 'active', false, STALL_MESSAGE_THRESHOLD, STALL_ELAPSED_MS, true],
    ['SN1 open', 'open', false, 12, 4 * HOUR, true],
    ['SN2', 'active', false, STALL_MESSAGE_THRESHOLD, STALL_ELAPSED_MS - 1, false],
    ['SN3', 'active', false, STALL_MESSAGE_THRESHOLD - 1, STALL_ELAPSED_MS, false],
    ['SN4', 'open', false, 3, 10 * MIN, false],
    ['SN5', 'active', true, 12, 4 * HOUR, false],
    ['SN6 blocked', 'blocked', false, 12, 4 * HOUR, false],
    ['SN6 done', 'done', false, 12, 4 * HOUR, false],
    ['SN6 cancelled', 'cancelled', false, 12, 4 * HOUR, false],
  ]
  for (const [id, status, owned, count, elapsed, due] of rows) {
    test(`${id}: ${status}, owned ${owned}, ${count} messages, elapsed ${elapsed} ms → due ${due}`, () => {
      const state = stallOf(input({ status, owned, mail: agents(count), now: at(elapsed) }))
      expect(state.count).toBe(count)
      expect(state.elapsedMs).toBe(elapsed)
      expect(state.due).toBe(due)
    })
  }

  // @covers: task-stall-notices › A notice is sent when both thresholds are met › Many messages in a short time
  test('SN2 scenario: fifteen messages in 40 minutes are not due', () => {
    expect(stallOf(input({ mail: agents(15), now: at(40 * MIN) })).due).toBe(false)
  })

  // @covers: task-stall-notices › A notice is sent when both thresholds are met › An execution's task is left to plan supervision
  test('SN5 scenario: an owned task past both thresholds is not due', () => {
    expect(stallOf(input({ owned: true, mail: agents(20), now: at(5 * HOUR) })).due).toBe(false)
  })

  // @covers: task-stall-notices › A notice is sent when both thresholds are met › A blocked task is not noticed
  test('SN6 scenario: a blocked task past both thresholds is not due', () => {
    expect(stallOf(input({ status: 'blocked', mail: agents(20), now: at(5 * HOUR) })).due).toBe(false)
  })
})

describe('AN: anchor and count', () => {
  test('AN1: no progress after creation anchors at creation and counts agent and human mail', () => {
    const state = stallOf(input({ mail: [agent(1000, 'chat-a'), agent(2000, 'chat-b'), agent(3000, 'chat-a'), human(4000)], now: at(HOUR) }))
    expect([state.anchorKind, state.anchorAt, state.count]).toEqual(['created', at(0), 4])
    expect(state.senders).toEqual(['chat-a', 'chat-b', 'human'])
  })

  // @covers: task-stall-notices › A stall episode is measured from the task's last progress › A revision restarts the count
  test('AN2: a revision anchors the count, so mail before it is not counted', () => {
    const before = stallOf(input({ mail: agents(9), now: at(HOUR) }))
    expect([before.count, before.due]).toEqual([9, false])
    const state = stallOf(input({ revisionAt: at(20_000), mail: [...agents(9), agent(30_000)], now: at(HOUR) }))
    expect([state.anchorKind, state.anchorAt, state.count, state.due]).toEqual(['revision', at(20_000), 1, false])
  })

  test('AN3: a submitted result anchors the count', () => {
    const state = stallOf(input({ resultAt: at(10_000), mail: [agent(5000), ...agents(5, 20)], now: at(HOUR) }))
    expect([state.anchorKind, state.anchorAt, state.count]).toEqual(['result', at(10_000), 5])
  })

  test('AN4: a counted review anchors the count; without one the anchor stays at creation', () => {
    const mail = [agent(5000), agent(6000), agent(30_000), agent(40_000)]
    const reviewed = stallOf(input({ reviewAt: at(20_000), mail, now: at(HOUR) }))
    expect([reviewed.anchorKind, reviewed.anchorAt, reviewed.count]).toEqual(['review', at(20_000), 2])
    // An uncounted review is never handed in as reviewAt (the module reads counted submissions only).
    const unreviewed = stallOf(input({ reviewAt: null, mail, now: at(HOUR) }))
    expect([unreviewed.anchorKind, unreviewed.count]).toEqual(['created', 4])
  })

  test('AN5: the previous notice anchors the next episode', () => {
    const state = stallOf(input({ revisionAt: at(1000), noticeAt: at(3 * HOUR + 5000), mail: [...agents(11, 2), ...agents(4, 3 * 3600 + 10)], now: at(4 * HOUR) }))
    expect([state.anchorKind, state.anchorAt, state.count]).toEqual(['notice', at(3 * HOUR + 5000), 4])
  })

  // @covers: task-stall-notices › A stall episode is measured from the task's last progress › Kawai's mail is not counted
  test('AN6: Kawai\'s own mail is never counted', () => {
    const state = stallOf(input({ mail: Array.from({ length: 12 }, (_, i) => system((i + 1) * 1000)), now: at(4 * HOUR) }))
    expect([state.anchorKind, state.count, state.due]).toEqual(['created', 0, false])
  })

  test('AN7: mail at exactly the anchor time is not after it', () => {
    const state = stallOf(input({ revisionAt: at(10_000), mail: [agent(10_000), agent(10_001)], now: at(HOUR) }))
    expect([state.anchorKind, state.count]).toEqual(['revision', 1])
  })

  test('AN8: a revision and a result at the same time anchor as the revision', () => {
    const state = stallOf(input({ revisionAt: at(10_000), resultAt: at(10_000), mail: [agent(20_000), agent(30_000)], now: at(HOUR) }))
    expect([state.anchorKind, state.anchorAt, state.count]).toEqual(['revision', at(10_000), 2])
  })

  test('AN9: an anchor later than now reads as elapsed 0 and is not due', () => {
    const state = stallOf(input({ resultAt: at(5 * HOUR), mail: agents(10, 5 * 3600 + 1), now: at(4 * HOUR) }))
    expect([state.anchorKind, state.count, state.elapsedMs, state.due]).toEqual(['result', 10, 0, false])
  })
})
