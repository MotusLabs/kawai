// Oracle table RM (review-findings-ledger design D9, "Re-map — table RM"):
// the events a publication writes for each open finding, over the pure
// model. Each title starts with its row id.
import { describe, expect, test } from 'bun:test'
import type { ImplementationContract } from '../implementationContract'
import { foldLedger, remapOnPublication, type LedgerEvent, type LedgerRow } from '../findingsLedger'
import type { FindingState } from '../reviewFindings'

const R2 = 'r2#aaaaaaaaaaaa'
const R3 = 'r3#bbbbbbbbbbbb'
const contract = (...ids: string[]): ImplementationContract => ({
  version: 1, acceptance: ids.filter(id => id.startsWith('A')).map(id => ({ id, text: `clause ${id}` })),
  invariants: [], scope: ['src/**'], verification: [], excluded: [],
})
const row = (id: string, clause: string | null, clauseId: string | null, state: FindingState = 'accepted', level: LedgerRow['level'] = 'P1'): LedgerRow => ({
  id, level, clause, clauseId, locus: '', state, regressed: false, preDispute: null, disputeEventId: null, disputedThisEntry: false,
  resolvedSeq: null, transitions: [],
})

describe('table RM — re-map on publication', () => {
  // @covers: review-findings › A new contract re-maps open findings › The clause survives
  test('RM1 a clause the new contract has → remapped to the new identity, by id', () => {
    // The clause text names A9; only the id may decide (a text-based re-map would supersede).
    const events = remapOnPublication([row('F2', `${R2} › A9`, 'A1')], R2, { identity: R3, contract: contract('A1') })
    expect(events).toEqual([{ findingId: 'F2', kind: 'remapped', clause: `${R3} › A1` }])
  })
  // @covers: review-findings › A new contract re-maps open findings › The clause is gone
  test('RM2 a clause the new contract lacks → superseded', () => {
    const events = remapOnPublication([row('F4', `${R2} › A1`, 'A5')], R2, { identity: R3, contract: contract('A1', 'A2') })
    expect(events).toEqual([{ findingId: 'F4', kind: 'superseded', clause: null }])
  })
  test('RM3 a revision identity, no contract → remapped to the new identity', () => {
    const events = remapOnPublication([row('F1', R2, null)], R2, { identity: R3, contract: null })
    expect(events).toEqual([{ findingId: 'F1', kind: 'remapped', clause: R3 }])
  })
  test('RM4 a revision identity, the new revision has a contract → superseded', () => {
    const events = remapOnPublication([row('F1', R2, null)], R2, { identity: R3, contract: contract('A1') })
    expect(events).toEqual([{ findingId: 'F1', kind: 'superseded', clause: null }])
  })
  test('RM5 a clause, the new revision has no contract → superseded', () => {
    const events = remapOnPublication([row('F1', `${R2} › A1`, 'A1')], R2, { identity: R3, contract: null })
    expect(events).toEqual([{ findingId: 'F1', kind: 'superseded', clause: null }])
  })
  test('RM6 the same identity hash (only the revision number moved) → none', () => {
    const rows = [row('F1', `${R2} › A1`, 'A1'), row('F2', R2, null)]
    expect(remapOnPublication(rows, R2, { identity: 'r3#aaaaaaaaaaaa', contract: null })).toEqual([])
  })
  test('RM7 findings neither blocking nor disputed → none; a disputed one re-maps', () => {
    const states: FindingState[] = ['resolved', 'rejected', 'superseded', 'unsupported', 'out-of-contract', 'advisory']
    const quiet = states.map((state, index) => row(`F${index + 1}`, `${R2} › A1`, 'A1', state))
    const p2 = row('F7', `${R2} › A1`, 'A1', 'accepted', 'P2')
    const disputed = row('F8', `${R2} › A1`, 'A1', 'disputed')
    const events = remapOnPublication([...quiet, p2, disputed], R2, { identity: R3, contract: contract('A1') })
    expect(events).toEqual([{ findingId: 'F8', kind: 'remapped', clause: `${R3} › A1` }])
  })
  test('the fold keeps the state on remapped and stops blocking on superseded', () => {
    const items = (findingId: string, clauseId: string) => ({
      findingId, itemKind: 'finding' as const, level: 'P1' as const, clause: `${R2} › ${clauseId}`, clauseId, evidence: 'a.ts:1', impact: 'x',
      reproduction: null, locus: 'a.ts', class: 'accepted' as const, reason: null, disposition: null, regressed: false,
    })
    const submissions = [{ id: 's1', resultId: 'R1', ledgerSeq: 1, contractIdentity: R2, createdAt: '2026-11-09T00:00:00Z', items: [items('F1', 'A1'), items('F2', 'A5')] }]
    const event = (id: string, findingId: string, kind: LedgerEvent['kind'], clause: string | null, ledgerSeq: number): LedgerEvent => ({
      id, findingId, ledgerSeq, kind, resultId: null, cardId: null, decisionId: null, contractIdentity: R3, clause, text: null, createdAt: '2026-11-09T00:00:01Z',
    })
    const rows = foldLedger(submissions, [event('e1', 'F1', 'remapped', `${R3} › A1`, 2), event('e2', 'F2', 'superseded', null, 3)])
    expect(rows.map(entry => [entry.id, entry.state, entry.clause])).toEqual([['F1', 'accepted', `${R3} › A1`], ['F2', 'superseded', `${R2} › A5`]])
  })
})
