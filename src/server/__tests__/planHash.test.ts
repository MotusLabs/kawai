// Plan hashing (durable-plans 1.1): SHA-256 over the canonical inputs —
// stable across key order, bound to the strategy pin.
import { describe, expect, test } from 'bun:test'
import { normalizePlanContent } from '../../shared/plans'
import { planInput } from '../../shared/__tests__/planFixtures'
import { hashPlanDraft, hashPlanRevision } from '../plans/planHash'

describe('plan hashes', () => {
  test('two key orders hash equally', () => {
    const a = normalizePlanContent(planInput())
    const b = normalizePlanContent(Object.fromEntries(Object.entries(planInput()).reverse()))
    expect(hashPlanDraft(a)).toBe(hashPlanDraft(b))
    expect(hashPlanRevision(a, null)).toBe(hashPlanRevision(b, null))
    expect(hashPlanDraft(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('changing only the pin changes the revision hash', () => {
    const content = normalizePlanContent(planInput())
    const pin = { strategyId: 'strategy-1', revision: 2, hash: 'abc' }
    expect(hashPlanRevision(content, pin)).not.toBe(hashPlanRevision(content, null))
    expect(hashPlanRevision(content, pin)).not.toBe(hashPlanRevision(content, { ...pin, hash: 'abd' }))
  })
})
