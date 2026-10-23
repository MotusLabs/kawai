// The attempt status table (revision-control PR E, H″ O1): owed, out, and
// answered for each kind; the anchored key test (`attempt:1:` never matches
// `attempt:11:…` nor a `:retry:` re-send); a stamped, superseded row is not
// owed; a row a round records is not owed — and the crash window: an
// unstamped row whose exact-key assignment exists is out, so the owed step
// re-sends nothing. The retired `attempt:update:` shape never anchors, and
// the shared agent-held stage table (O3′) reads beside it.
import { describe, expect, test } from 'bun:test'
import { attemptStatus, agentHeldStage } from '../plans/execution/attemptStatus'

const row = (over: Partial<Parameters<typeof attemptStatus>[0]> = {}): Parameters<typeof attemptStatus>[0] => ({
  id: 'attempt-a', executionId: 'e1', change: 'api', number: 1, assignmentId: null, ...over,
})
const keys = (...requestKeys: Array<string | null>): Array<{ requestKey: string | null }> => requestKeys.map(requestKey => ({ requestKey }))
const rounds = (...attemptIds: string[]): Array<{ attemptId: string }> => attemptIds.map(attemptId => ({ attemptId }))

describe('attemptStatus (H″ O1)', () => {
  test.each(['implement', 'fix', 'update'] as const)('a %s row never dispatched and unanswered is owed', () => {
    expect(attemptStatus(row({ number: 2 }), keys('rk-other'), [])).toBe('owed')
    expect(attemptStatus(row(), keys(null), [])).toBe('owed')
    expect(attemptStatus(row(), keys(), [])).toBe('owed')
  })

  test.each(['implement', 'fix', 'update'] as const)('a %s row whose assignment carries its exact key is out', () => {
    expect(attemptStatus(row({ id: 'attempt-k', number: 2 }), keys(`exec:e1:api:attempt:2:0`), [])).toBe('out')
    // Unstamped but dispatched: the exact key alone marks it out (the crash window).
    expect(attemptStatus(row({ assignmentId: null, number: 2 }), keys(`exec:e1:api:attempt:2:7`), [])).toBe('out')
    expect(attemptStatus(row({ assignmentId: 'asg-1' }), keys('rk-anything'), [])).toBe('out')
  })

  test('the anchor: attempt:1: never matches attempt:11: nor a :retry: re-send', () => {
    // A key for a different attempt number must not read this row dispatched.
    expect(attemptStatus(row({ number: 1 }), keys('exec:e1:api:attempt:11:0'), [])).toBe('owed')
    // A human Retry's re-send keeps the generation suffix and adds :retry:<n>:
    // it is not the row's own dispatch key.
    expect(attemptStatus(row({ number: 1 }), keys('exec:e1:api:attempt:1:0:retry:2'), [])).toBe('owed')
    // A key of another change or execution reads owed all the same.
    expect(attemptStatus(row(), keys('exec:e1:web:attempt:1:0'), [])).toBe('owed')
    expect(attemptStatus(row(), keys('exec:e2:api:attempt:1:0'), [])).toBe('owed')
    // A truncated or extended key is not the row's dispatch.
    expect(attemptStatus(row(), keys('exec:e1:api:attempt:1:'), [])).toBe('owed')
    expect(attemptStatus(row(), keys('exec:e1:api:attempt:1:0:extra'), [])).toBe('owed')
  })

  test('a stamped row whose assignment was later superseded is not owed', () => {
    // The clauses are AND: the stamp alone decides against owed — the
    // superseded assignment's instruction went out, and the supersession is
    // the restart's story (I2), not the dispatch's.
    expect(attemptStatus(row({ assignmentId: 'asg-old' }), keys('exec:e1:api:attempt:1:0', 'exec:e1:api:attempt:1:1:retry:1'), [])).toBe('out')
  })

  test('a row a round records is not owed, even unstamped', () => {
    // A result recorded under a hold attributes to the newest row: the work
    // is in the round pipeline, so the owed step must never re-send it.
    expect(attemptStatus(row(), keys(), rounds('attempt-a'))).toBe('answered')
    expect(attemptStatus(row(), keys('rk-review-1'), rounds('attempt-other', 'attempt-a'))).toBe('answered')
  })

  test('answered wins over the key clauses', () => {
    expect(attemptStatus(row({ assignmentId: 'asg-1' }), keys('exec:e1:api:attempt:1:0'), rounds('attempt-a'))).toBe('answered')
  })

  test('the crash window: an unstamped row whose exact-key assignment exists is neither owed nor re-sent', () => {
    expect(attemptStatus(row({ assignmentId: null, number: 3 }), keys('exec:e1:api:attempt:3:1'), [])).toBe('out')
  })

  test('the retired attempt:update: key shape never anchors a row (A1)', () => {
    // Update attempts carry the uniform key now; an old-shape key in the
    // task's history must not read any row dispatched — its prefix breaks at
    // `update:`, which is not a generation.
    expect(attemptStatus(row({ number: 2 }), keys('exec:e1:api:attempt:update:2:7'), [])).toBe('owed')
    expect(attemptStatus(row({ number: 1 }), keys('exec:e1:api:attempt:update:2:7'), [])).toBe('owed')
  })
})

describe('agentHeldStage (O3′)', () => {
  const stage = agentHeldStage
  const newest = (kind: 'implement' | 'fix' | 'update', status: 'answered' | 'owed' | 'out') => ({ kind, status })

  test('implementing is agent-held unless the newest row is owed', () => {
    expect(stage({ state: 'implementing', step: null }, null)).toBe('implement')
    expect(stage({ state: 'implementing', step: null }, newest('fix', 'out'))).toBe('fix')
    expect(stage({ state: 'implementing', step: null }, newest('implement', 'answered'))).toBe('implement')
    // H7 (H″ O1): an owed newest attempt names no holder.
    expect(stage({ state: 'implementing', step: null }, newest('fix', 'owed'))).toBe(null)
    expect(stage({ state: 'implementing', step: 'releasing' }, newest('fix', 'owed'))).toBe(null)
  })

  test('a reviewing change is agent-held at the review', () => {
    expect(stage({ state: 'gating', step: 'reviewing' }, newest('implement', 'answered'))).toBe('review')
    expect(stage({ state: 'gating', step: 'reviewing' }, null)).toBe('review')
  })

  test('a gating change with an update attempt out is agent-held at the attempt (A1)', () => {
    expect(stage({ state: 'gating', step: null }, newest('update', 'out'))).toBe('update')
    // Owed (the send never committed) names no holder; the owed step sends it.
    expect(stage({ state: 'gating', step: null }, newest('update', 'owed'))).toBe(null)
    // Any other gating step stays Kawai-held.
    expect(stage({ state: 'gating', step: 'awaiting-ci' }, newest('update', 'out'))).toBe(null)
    expect(stage({ state: 'gating', step: 'up-to-date' }, newest('implement', 'answered'))).toBe(null)
  })

  test('landing, waiting, and closed states are never agent-held', () => {
    expect(stage({ state: 'landing', step: 'merging' }, newest('implement', 'answered'))).toBe(null)
    expect(stage({ state: 'waiting', step: null }, null)).toBe(null)
    expect(stage({ state: 'stopped', step: null }, newest('fix', 'out'))).toBe(null)
    expect(stage({ state: 'landed', step: null }, null)).toBe(null)
  })
})
