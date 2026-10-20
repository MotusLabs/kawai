// integration-candidates 5.1, D9: every Promote precondition refuses by
// name with an actionable message, unreadable values fail closed, and
// every failing entry is listed in order.
import { describe, expect, test } from 'bun:test'
import { evaluatePromotePreconditions, PROMOTE_PRECONDITIONS, type PromoteCheckContext } from '../plans/landing/integration/promotionPreconditions'

const HEAD = 'a'.repeat(40)

function ready(overrides: Partial<PromoteCheckContext> = {}): PromoteCheckContext {
  return {
    request: { planId: 'plan', branch: 'wave/x', fromSha: HEAD, commandId: 'c' },
    branchRecord: { teamId: 't', branch: 'wave/x', planId: 'plan', targetBranch: 'master', createdBy: 'exec', createdSha: 'b'.repeat(40), createdAt: '' },
    runningExecution: null, runningPromotion: null, originHead: HEAD, targetContains: false, allowMergeCommit: true,
    probeFindings: [], promotionBranch: 'wave/x--promote-1', promotionBranchExists: false, nextPromotionBranch: 'wave/x--promote-1',
    ...overrides,
  } as PromoteCheckContext
}

const names = (ctx: PromoteCheckContext) => evaluatePromotePreconditions(ctx).map(failure => failure.name)

describe('PROMOTE_PRECONDITIONS (D9)', () => {
  test('the eight entries, in order', () => {
    expect(PROMOTE_PRECONDITIONS.map(entry => entry.name)).toEqual([
      'integration-branch-known', 'no-execution', 'no-promotion', 'from-current', 'something-to-promote',
      'merge-commits-allowed', 'landing-ready', 'promotion-name-free',
    ])
  })

  test('a ready context passes', () => {
    expect(evaluatePromotePreconditions(ready())).toEqual([])
  })

  const cases: Array<[string, Partial<PromoteCheckContext>]> = [
    ['integration-branch-known', { branchRecord: null }],
    ['no-execution', { runningExecution: { id: 'exec-1' } }],
    ['no-promotion', { runningPromotion: { id: 'p', number: 1, step: 'ci' } }],
    ['from-current', { originHead: 'c'.repeat(40) }],
    ['from-current', { originHead: null }],
    ['something-to-promote', { targetContains: true }],
    ['something-to-promote', { targetContains: null }],
    ['merge-commits-allowed', { allowMergeCommit: false }],
    ['merge-commits-allowed', { allowMergeCommit: null }],
    ['landing-ready', { probeFindings: [{ code: 'gh-auth', message: 'gh is not logged in.' }] as PromoteCheckContext['probeFindings'] }],
    ['promotion-name-free', { promotionBranchExists: true }],
    ['promotion-name-free', { promotionBranchExists: null }],
    ['promotion-name-free', { nextPromotionBranch: 'wave/x--promote-2' }],
  ]
  for (const [name, overrides] of cases) {
    test(`${name} refuses ${JSON.stringify(Object.values(overrides)[0])} by name`, () => {
      const failures = evaluatePromotePreconditions(ready(overrides))
      expect(failures.map(failure => failure.name)).toEqual([name])
      expect(failures[0]!.message.length).toBeGreaterThan(10)
    })
  }

  test('every failing entry is listed, in order', () => {
    expect(names(ready({ runningExecution: { id: 'e' }, allowMergeCommit: false, promotionBranchExists: true }))).toEqual(['no-execution', 'merge-commits-allowed', 'promotion-name-free'])
  })
})
