// The attempt status table (revision-control PR E, H″ O1): owed, out, and
// answered for each kind; the anchored key test (`attempt:1:` never matches
// `attempt:11:…` nor a `:retry:` re-send); a stamped, superseded row is not
// owed; a row a round records is not owed — and the crash window: an
// unstamped row whose exact-key assignment exists is out, so the owed step
// re-sends nothing.
import { describe, expect, test } from 'bun:test'
import { attemptStatus } from '../plans/execution/attemptStatus'

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
})
