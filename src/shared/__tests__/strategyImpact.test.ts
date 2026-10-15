// strategy-revision-impact 1.2: the pure gate, grouping, and review-state rules (D2).
import { describe, expect, test } from 'bun:test'
import type { PlanStrategyPin } from '../plans'
import {
  currentStrategyPin,
  impactGate,
  impactGroup,
  impactRationaleError,
  reviewState,
  type ImpactStrategyView,
} from '../strategyImpact'

const review = { id: 'impact-3' }
const strategy = (overrides: Partial<ImpactStrategyView> = {}): ImpactStrategyView => ({
  id: 'strategy-a',
  currentApprovedRevision: 3,
  revisions: [
    { revision: 1, status: 'withdrawn', contentHash: 'h1' },
    { revision: 2, status: 'superseded', contentHash: 'h2' },
    { revision: 3, status: 'approved', contentHash: 'h3' },
    { revision: 4, status: 'in_review', contentHash: 'h4' },
  ],
  ...overrides,
})
const pin = (revision: number, hash = `h${revision}`, strategyId = 'strategy-a'): PlanStrategyPin => ({ strategyId, revision, hash })
const decided = (disposition: 'continue' | 'adapt' | 'reconsider') => ({ id: `decision-${disposition}`, disposition })

describe('impactGate', () => {
  test('a pin to the current approved revision is current, whatever is decided', () => {
    const gate = impactGate(pin(3), strategy(), review, decided('reconsider'))
    expect(gate).toEqual({ state: 'current', pass: true, reviewId: null, decisionId: null, pin: pin(3) })
  })

  test('both pins empty: no record, or a record with no approved revision', () => {
    expect(impactGate(null, null, null, null).state).toBe('current')
    expect(impactGate(null, strategy({ currentApprovedRevision: null }), null, null).state).toBe('current')
  })

  test('with no strategy record, any pin is a withdrawn direction', () => {
    expect(impactGate(pin(2), null, null, decided('continue')).state).toBe('withdrawn-direction')
  })

  test('an older pin follows the effective disposition, or needs a decision without one', () => {
    expect(impactGate(pin(2), strategy(), review, decided('continue'))).toEqual({
      state: 'continue', pass: true, reviewId: 'impact-3', decisionId: 'decision-continue', pin: pin(2),
    })
    const adapt = impactGate(pin(2), strategy(), review, decided('adapt'))
    expect([adapt.state, adapt.pass, adapt.decisionId]).toEqual(['adapt', false, 'decision-adapt'])
    const reconsider = impactGate(pin(2), strategy(), review, decided('reconsider'))
    expect([reconsider.state, reconsider.pass]).toEqual(['reconsider', false])
    const none = impactGate(pin(2), strategy(), review, null)
    expect([none.state, none.pass, none.reviewId, none.decisionId]).toEqual(['decision-required', false, 'impact-3', null])
  })

  test('an empty pin while a revision is approved needs a decision, and continue lets it pass', () => {
    expect(impactGate(null, strategy(), review, null).state).toBe('decision-required')
    expect(impactGate(null, strategy(), review, decided('continue')).pass).toBe(true)
  })

  test('a withdrawn revision, another record, or any pin while none is approved ignore a recorded continue', () => {
    expect(impactGate(pin(1), strategy(), review, decided('continue')).state).toBe('withdrawn-direction')
    expect(impactGate(pin(2, 'h2', 'strategy-b'), strategy(), review, decided('continue')).state).toBe('withdrawn-direction')
    const noneApproved = strategy({ currentApprovedRevision: null })
    expect(impactGate(pin(2), noneApproved, review, decided('continue')).state).toBe('withdrawn-direction')
  })

  test('another record with the current revision number and hash is never current', () => {
    const gate = impactGate(pin(3, 'h3', 'strategy-b'), strategy(), review, decided('continue'))
    expect([gate.state, gate.pass]).toEqual(['withdrawn-direction', false])
  })

  test('a pin whose hash matches no revision ignores a recorded continue', () => {
    expect(impactGate(pin(2, 'other'), strategy(), review, decided('continue')).state).toBe('withdrawn-direction')
    expect(impactGate(pin(4), strategy(), review, decided('continue')).state).toBe('withdrawn-direction')
  })

  test('a missing current review needs a decision with no review id', () => {
    const gate = impactGate(pin(2), strategy(), null, decided('continue'))
    expect([gate.state, gate.reviewId, gate.decisionId]).toEqual(['decision-required', null, null])
  })

  test('currentStrategyPin names the approved revision and its hash', () => {
    expect(currentStrategyPin(strategy())).toEqual(pin(3))
    expect(currentStrategyPin(strategy({ currentApprovedRevision: null }))).toBeNull()
  })
})

describe('impactGroup', () => {
  test('closed plans are historical whatever their pins', () => {
    expect(impactGroup({ lifecycle: 'completed' }, [{ status: 'approved', pin: pin(1) }], strategy())).toBe('historical')
    expect(impactGroup({ lifecycle: 'cancelled' }, [{ status: 'approved', pin: pin(3) }], strategy())).toBe('historical')
  })

  test('an open plan with a standing revision that is not current is affected', () => {
    expect(impactGroup({ lifecycle: 'open' }, [{ status: 'approved', pin: pin(2) }], strategy())).toBe('affected')
    expect(impactGroup({ lifecycle: 'open' }, [
      { status: 'approved', pin: pin(3) }, { status: 'in_review', pin: null },
    ], strategy())).toBe('affected')
  })

  test('re-pinned and draft-only plans are unaffected; superseded and withdrawn revisions do not count', () => {
    expect(impactGroup({ lifecycle: 'open' }, [
      { status: 'superseded', pin: pin(2) }, { status: 'withdrawn', pin: null }, { status: 'approved', pin: pin(3) },
    ], strategy())).toBe('unaffected')
    expect(impactGroup({ lifecycle: 'open' }, [], strategy())).toBe('unaffected')
  })
})

describe('reviewState', () => {
  test('the current review needs decisions until every affected row has one', () => {
    expect(reviewState({ revision: 3 }, strategy(), [{ effectiveDecision: null }, { effectiveDecision: {} }])).toBe('needs-decisions')
    expect(reviewState({ revision: 3 }, strategy(), [{ effectiveDecision: {} }])).toBe('reviewed')
  })

  test('a current review with no affected plans is reviewed', () => {
    expect(reviewState({ revision: 3 }, strategy(), [])).toBe('reviewed')
  })

  test('an earlier review is superseded or withdrawn by its revision status', () => {
    expect(reviewState({ revision: 2 }, strategy(), [{ effectiveDecision: null }])).toBe('superseded')
    expect(reviewState({ revision: 1 }, strategy(), [])).toBe('withdrawn')
    expect(reviewState({ revision: 3 }, strategy({ currentApprovedRevision: null, revisions: [{ revision: 3, status: 'withdrawn', contentHash: 'h3' }] }), [])).toBe('withdrawn')
  })
})

describe('impactRationaleError', () => {
  test('empty and over-long rationales are refused; the limit is inclusive', () => {
    expect(impactRationaleError('   ')).toContain('required')
    expect(impactRationaleError('x'.repeat(2001))).toContain('2001 characters')
    expect(impactRationaleError('x'.repeat(2000))).toBeNull()
  })
})
