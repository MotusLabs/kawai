// Oracle table RG (review-findings-ledger design D8, "Re-gate guard"): when
// a failed round's result is gated again, over the pure guard. Each title
// starts with its row id.
import { describe, expect, test } from 'bun:test'
import type { LedgerRow } from '../../shared/findingsLedger'
import type { FindingState } from '../../shared/reviewFindings'
import { regateRefusal, type RegateFacts } from '../plans/execution/regateRefuted'

const row = (id: string, state: FindingState, level: LedgerRow['level'] = 'P1'): LedgerRow => ({
  id, level, clause: 'r1#aaaaaaaaaaaa', clauseId: null, locus: '', state, regressed: false, preDispute: null, disputeEventId: null,
  disputedThisEntry: false, resolvedSeq: null, transitions: [],
})
const facts = (patch: Partial<RegateFacts> = {}): RegateFacts => ({
  newest: { id: 'round-1', outcome: 'fail', resultId: 'R1', blockingIds: ['F1', 'F2'] },
  alreadyRegated: false, newestResultId: 'R1', resultRevision: 1, taskRevision: 1,
  ledger: [row('F1', 'rejected'), row('F2', 'rejected'), row('F3', 'advisory', 'P2')],
  fixAttempt: { status: 'out', answersRound: 'round-1' },
  ...patch,
})

describe('table RG — the re-gate guard', () => {
  test('RG1 every blocker rejected, nothing open, fix out → re-gate', () => {
    expect(regateRefusal(facts())).toBeNull()
  })
  test('RG2 a dispute still undecided → wait', () => {
    expect(regateRefusal(facts({ ledger: [row('F1', 'rejected'), row('F2', 'disputed')] }))).toContain('undecided')
  })
  test('RG3 a newer result → none', () => {
    expect(regateRefusal(facts({ newestResultId: 'R2' }))).toContain('newer result')
  })
  test('RG4 a round failed on CI (or on a text verdict) records no blockers → none', () => {
    expect(regateRefusal(facts({ newest: { ...facts().newest!, blockingIds: null } }))).toContain('structured review')
  })
  test('RG5 a blocker upheld → none', () => {
    expect(regateRefusal(facts({ ledger: [row('F1', 'rejected'), row('F2', 'accepted')] }))).toContain('blocks')
  })
  test('RG6 already re-gated → none', () => {
    expect(regateRefusal(facts({ alreadyRegated: true }))).toContain('already')
  })
  test('RG7 the newest round passed or was superseded → none', () => {
    expect(regateRefusal(facts({ newest: { ...facts().newest!, outcome: 'pass' } }))).toContain('did not fail')
    expect(regateRefusal(facts({ newest: { ...facts().newest!, outcome: 'superseded' } }))).toContain('did not fail')
    expect(regateRefusal(facts({ newest: null }))).toContain('did not fail')
  })
  test('RG8 one blocker rejected, the other superseded by a re-map → none', () => {
    expect(regateRefusal(facts({ ledger: [row('F1', 'rejected'), row('F2', 'superseded')] }))).toBe('not refuted: F2')
  })
  test('RG9 the result is pinned to an older revision → none', () => {
    expect(regateRefusal(facts({ resultRevision: 1, taskRevision: 2 }))).toContain('older revision')
  })
  test('RG10 the fix attempt is answered, missing, or answers another round → none', () => {
    expect(regateRefusal(facts({ fixAttempt: { status: 'answered', answersRound: 'round-1' } }))).toContain('fix attempt')
    expect(regateRefusal(facts({ fixAttempt: null }))).toContain('fix attempt')
    expect(regateRefusal(facts({ fixAttempt: { status: 'out', answersRound: 'round-0' } }))).toContain('fix attempt')
  })
  test('a failed round with no recorded blocker is never re-gated', () => {
    expect(regateRefusal(facts({ newest: { ...facts().newest!, blockingIds: [] } }))).toContain('not refuted')
  })
})
