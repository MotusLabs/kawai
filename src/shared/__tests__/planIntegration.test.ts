// integration-candidates task 1.3: the pure chain, reference, and promotion functions (D4, D11).
import { describe, expect, test } from 'bun:test'
import { candidateChain, candidatePromoted, promotedThrough, referenceCommit, type IntegrationCandidate } from '../planIntegration'

function candidate(seq: number, state: IntegrationCandidate['state'], extra: Partial<IntegrationCandidate> = {}): IntegrationCandidate {
  return {
    id: `cand-${seq}`, teamId: 'team', branch: 'wave/int', seq, kind: 'increment',
    executionId: 'exec-1', change: `c${seq}`, resultId: null, roundId: null, promotionId: null,
    baselineSha: `base${seq}`, commitSha: `sha${seq}`, treeSha: `tree${seq}`, outside: null, state,
    createdAt: `2026-10-18T10:0${seq}:00.000Z`, decidedAt: `2026-10-18T10:0${seq}:30.000Z`, ...extra,
  }
}

const branch = { branch: 'wave/int', createdSha: 'created', createdAt: '2026-10-18T09:00:00.000Z' }

describe('candidateChain', () => {
  test('is newest first, and a failed candidate stays beside the one that replaced it', () => {
    const chain = candidateChain([candidate(1, 'landed'), candidate(2, 'failed', { change: 'b' }), candidate(3, 'landed', { change: 'b' })])
    expect(chain.map(entry => entry.seq)).toEqual([3, 2, 1])
    expect(chain.map(entry => entry.state)).toEqual(['landed', 'failed', 'landed'])
  })

  test('keeps only the named branch', () => {
    const chain = candidateChain([candidate(1, 'landed'), candidate(2, 'landed', { branch: 'other' })], 'wave/int')
    expect(chain.map(entry => entry.seq)).toEqual([1])
  })
})

describe('referenceCommit', () => {
  test('is the creation commit while nothing has landed', () => {
    expect(referenceCommit(branch, [])).toBe('created')
    expect(referenceCommit(branch, [candidate(1, 'passed'), candidate(2, 'failed')])).toBe('created')
  })

  test('is the last landed candidate', () => {
    expect(referenceCommit(branch, [candidate(1, 'landed'), candidate(2, 'landed'), candidate(3, 'failed')])).toBe('sha2')
  })

  test('is the creation commit when the branch was created again after the landing', () => {
    const recreated = { ...branch, createdSha: 'recreated', createdAt: '2026-10-18T11:00:00.000Z' }
    expect(referenceCommit(recreated, [candidate(1, 'landed')])).toBe('recreated')
  })

  test('a superseded promotion candidate is not the reference', () => {
    const promotion = candidate(2, 'superseded', { kind: 'promotion', change: null, promotionId: 'promo-1' })
    expect(referenceCommit(branch, [candidate(1, 'landed'), promotion])).toBe('sha1')
  })
})

describe('promotedThrough', () => {
  test('only merged promotions count, the highest through_seq per branch', () => {
    const through = promotedThrough([
      { branch: 'wave/int', outcome: 'merged', throughSeq: 1 },
      { branch: 'wave/int', outcome: 'merged', throughSeq: 2 },
      { branch: 'wave/int', outcome: 'failed:ci-failed', throughSeq: 3 },
      { branch: 'wave/int', outcome: 'cancelled', throughSeq: 3 },
      { branch: 'wave/int', outcome: null, throughSeq: 3 },
    ])
    expect(through.get('wave/int')).toBe(2)
    expect(promotedThrough([{ branch: 'x', outcome: 'cancelled', throughSeq: 4 }]).has('x')).toBe(false)
  })

  test('a fact is promoted when its candidate seq is at most through_seq', () => {
    const through = promotedThrough([{ branch: 'wave/int', outcome: 'merged', throughSeq: 2 }])
    expect([1, 2, 3].map(seq => candidatePromoted(candidate(seq, 'landed'), through))).toEqual([true, true, false])
    expect(candidatePromoted(candidate(1, 'failed'), through)).toBe(false)
    expect(candidatePromoted(candidate(1, 'landed', { branch: 'other' }), through)).toBe(false)
  })
})
