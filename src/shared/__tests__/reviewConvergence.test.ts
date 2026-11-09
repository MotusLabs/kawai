// Tables SG and WN of review-convergence's design (task 1.1), committed
// verbatim as table-driven tests over the pure module: the signals over a
// window, and the window over a task's counted reviews.
import { describe, expect, test } from 'bun:test'
import { foldLedger, type LedgerItem, type LedgerSubmission } from '../findingsLedger'
import { convergenceOf, convergenceSignals, convergenceWindow, reviewSnapshots, signalFindings, type ConvergenceSignal, type ReviewSnapshot } from '../reviewConvergence'
import type { FindingClass, FindingLevel } from '../reviewFindings'

const H1 = 'r1#aaaaaaaaaaaa'
const H2 = 'r2#bbbbbbbbbbbb'

const finding = (id: string, clauseId: string | null, cls: FindingClass = 'accepted', level: FindingLevel = 'P1'): LedgerItem => ({
  findingId: id, itemKind: 'finding', level, clause: clauseId === null ? H1 : `${H1} › ${clauseId}`, clauseId,
  evidence: `src/${id}.ts:1 wrong`, impact: 'wrong', reproduction: null, locus: `src/${id}.ts`, class: cls, reason: null, disposition: null, regressed: false,
})
const disposition = (id: string, clauseId: string | null, kind: 'resolved' | 'still-open' = 'resolved'): LedgerItem => ({
  findingId: id, itemKind: 'disposition', level: 'P1', clause: null, clauseId, evidence: kind === 'resolved' ? null : 'still wrong',
  impact: null, reproduction: null, locus: `src/${id}.ts`, class: null, reason: null, disposition: kind, regressed: false,
})
const reviews = (...itemLists: LedgerItem[][]): LedgerSubmission[] => itemLists.map((items, index) => ({
  id: `sub-${index + 1}`, resultId: `res-${index + 1}`, ledgerSeq: index + 1, contractIdentity: H1, createdAt: `2026-11-0${index + 1}T00:00:00Z`, items,
}))
const signalsOf = (submissions: LedgerSubmission[]): ConvergenceSignal[] => convergenceOf(submissions, [], null).signals
const kinds = (submissions: LedgerSubmission[]) => signalsOf(submissions).map(signal => signal.kind)

/**
 * Table SG — signals over a window (`convergenceSignals`; the reviews are the
 * window's, newest last; `*` means any value).
 *
 * | id | reviews in window | condition on the window | fires |
 * |---|---|---|---|
 * | SG1 | ≥1 | newest raises a finding with ≥2 `reopened` transitions | S1 |
 * | SG2 | ≥1 | newest raises a finding's first reopen | — |
 * | SG3 | ≥2 | both of the last two: clause C resolved one finding and raised another blocking one | S2 |
 * | SG4 | ≥2 | as SG3 but on different clauses | — |
 * | SG5 | ≥2 | as SG3 but the findings cite the revision (`clauseId` null) | — |
 * | SG6 | ≥2 | raised over the last two ≥ resolved, and raised ≥ 1 | S3 |
 * | SG7 | ≥2 | raised < resolved | — |
 * | SG8 | ≥2 | raised = resolved = 0 | — |
 * | SG9 | ≥3 | openAfter non-decreasing over the last three, newest > 0 | S4 |
 * | SG10 | ≥3 | openAfter falls at least once among the last three | — |
 * | SG11 | ≥3 | non-decreasing and newest = 0 | — (unreachable when the round failed; kept for the manual notice) |
 * | SG12 | ≥2 | each of the last two raised an out-of-contract finding | S5 |
 * | SG13 | ≥2 | only the newest raised one | — |
 * | SG14 | 1 | any | only S1 can fire |
 * | SG15 | 0 | any | none |
 */
describe('table SG — signals over a window', () => {
  // @covers: review-convergence › S1 fires when a finding is reopened a second time › A second reopen fires S1
  test('SG1 a second reopen fires S1 naming the finding', () => {
    const subs = reviews([finding('F2', 'A1')], [disposition('F2', 'A1')], [finding('F2', 'A1')], [disposition('F2', 'A1')], [finding('F2', 'A1')])
    expect(signalsOf(subs).find(signal => signal.kind === 'S1')).toEqual({ kind: 'S1', findings: ['F2'] })
  })
  // @covers: review-convergence › S1 fires when a finding is reopened a second time › A first reopen does not
  test('SG2 a first reopen does not fire S1', () => {
    const subs = reviews([finding('F2', 'A1')], [disposition('F2', 'A1')], [finding('F2', 'A1')])
    expect(kinds(subs)).not.toContain('S1')
  })
  // @covers: review-convergence › S2 fires when a fix keeps moving the defect within a clause › Two reviews move the defect on one clause
  test('SG3 two reviews resolving and raising on one clause fire S2 naming the clause and findings', () => {
    const subs = reviews([finding('F1', 'A2')], [disposition('F1', 'A2'), finding('F4', 'A2')], [disposition('F4', 'A2'), finding('F5', 'A2')])
    expect(signalsOf(subs).find(signal => signal.kind === 'S2')).toEqual({ kind: 'S2', clause: 'A2', findings: ['F1', 'F4', 'F5'] })
  })
  // @covers: review-convergence › S2 fires when a fix keeps moving the defect within a clause › Different clauses do not fire
  test('SG4 the same pattern on different clauses does not fire S2', () => {
    const subs = reviews([finding('F1', 'A2')], [disposition('F1', 'A2'), finding('F4', 'A2')], [disposition('F4', 'A2'), finding('F5', 'A3')])
    expect(kinds(subs)).not.toContain('S2')
  })
  // @covers: review-convergence › S2 fires when a fix keeps moving the defect within a clause › Revision citations never fire
  test('SG5 revision citations never fire S2', () => {
    const subs = reviews([finding('F1', null)], [disposition('F1', null), finding('F4', null)], [disposition('F4', null), finding('F5', null)])
    expect(kinds(subs)).not.toContain('S2')
  })
  // @covers: review-convergence › S3 fires when new defects keep pace with fixes › Churn fires
  test('SG6 raised at least resolved, and at least one, fires S3', () => {
    const subs = reviews([finding('F1', 'A1'), finding('F2', 'A1')], [disposition('F1', 'A1'), disposition('F2', 'A1'), finding('F3', 'A2')],
      [disposition('F3', 'A2'), finding('F4', 'A3'), finding('F5', 'A4')])
    expect(signalsOf(subs).find(signal => signal.kind === 'S3')).toEqual({ kind: 'S3', findings: ['F3', 'F4', 'F5'], raised: 3, resolved: 3 })
  })
  // @covers: review-convergence › S3 fires when new defects keep pace with fixes › Converging work does not fire
  test('SG7 raised below resolved does not fire S3', () => {
    const subs = reviews([finding('F1', 'A1'), finding('F2', 'A1')], [disposition('F1', 'A1'), disposition('F2', 'A1'), finding('F3', 'A2')], [disposition('F3', 'A2')])
    expect(kinds(subs)).not.toContain('S3')
  })
  test('SG8 nothing raised and nothing resolved does not fire S3', () => {
    const subs = reviews([finding('F1', 'A1')], [disposition('F1', 'A1', 'still-open')], [disposition('F1', 'A1', 'still-open')])
    expect(kinds(subs)).not.toContain('S3')
  })
  // @covers: review-convergence › S4 fires when the open count stops falling › A flat count fires
  test('SG9 a non-decreasing open count above zero over three reviews fires S4', () => {
    const still = [disposition('F1', 'A1', 'still-open'), disposition('F2', 'A1', 'still-open'), disposition('F3', 'A1', 'still-open')]
    const subs = reviews([finding('F1', 'A1'), finding('F2', 'A1'), finding('F3', 'A1')], still, still)
    expect(signalsOf(subs).find(signal => signal.kind === 'S4')).toEqual({ kind: 'S4', counts: [3, 3, 3] })
  })
  // @covers: review-convergence › S4 fires when the open count stops falling › A falling count does not fire
  test('SG10 a count that falls once among the three does not fire S4', () => {
    const subs = reviews([finding('F1', 'A1'), finding('F2', 'A1'), finding('F3', 'A1'), finding('F4', 'A1'), finding('F5', 'A1')],
      [disposition('F1', 'A1'), disposition('F2', 'A1'), ...['F3', 'F4', 'F5'].map(id => disposition(id, 'A1', 'still-open'))],
      ['F3', 'F4', 'F5'].map(id => disposition(id, 'A1', 'still-open')))
    expect(convergenceOf(subs, [], null).counts).toEqual([5, 3, 3])
    expect(kinds(subs)).not.toContain('S4')
  })
  test('SG11 a flat count of zero does not fire S4', () => {
    expect(kinds(reviews([], [], []))).not.toContain('S4')
  })
  // @covers: review-convergence › S5 fires on repeated out-of-contract findings › Two reviews push outside the contract
  test('SG12 out-of-contract findings in each of the last two reviews fire S5', () => {
    const subs = reviews([finding('F1', 'A1')], [disposition('F1', 'A1'), finding('F3', null, 'out-of-contract')], [finding('F6', null, 'out-of-contract')])
    expect(signalsOf(subs).find(signal => signal.kind === 'S5')).toEqual({ kind: 'S5', findings: ['F3', 'F6'] })
  })
  // @covers: review-convergence › S5 fires on repeated out-of-contract findings › One review does not fire
  test('SG13 an out-of-contract finding in the newest review alone does not fire S5', () => {
    const subs = reviews([finding('F1', 'A1')], [disposition('F1', 'A1')], [finding('F6', null, 'out-of-contract')])
    expect(kinds(subs)).not.toContain('S5')
  })
  test('SG14 a one-review window fires S1 at most', () => {
    const subs = reviews([finding('F1', 'A2'), finding('F2', null, 'out-of-contract')])
    const window = convergenceWindow(reviewSnapshots(subs, []), null)
    expect(window).toHaveLength(1)
    expect(convergenceSignals(window, foldLedger(subs, [])).every(signal => signal.kind === 'S1')).toBe(true)
  })
  test('SG15 an empty window fires nothing', () => {
    expect(convergenceSignals([], [])).toEqual([])
  })
})

const snap = (id: string, hash: string): ReviewSnapshot => ({ submissionId: id, ledgerSeq: Number(id.slice(1)), contractHash: hash, raised: [], resolved: [], outOfContract: [], reopened: [], openAfter: 0 })
const ids = (window: ReviewSnapshot[]) => window.map(entry => entry.submissionId)

/**
 * Table WN — the window (`convergenceWindow`).
 *
 * | id | contract hashes, oldest → newest | anchor | window |
 * |---|---|---|---|
 * | WN1 | H1 H1 H1 | none | all three |
 * | WN2 | H1 H1 H2 | none | the H2 review |
 * | WN3 | H1 H2 H1 | none | the last H1 review only (a run, not a set) |
 * | WN4 | H1 H1 H1 | the second | the third |
 * | WN5 | H1 H1 H1 | the third | empty |
 * | WN6 | r3#A, then r4#A (renumbered, same hash) | none | both |
 */
describe('table WN — the window', () => {
  test('WN1 one hash and no anchor keeps every review', () => {
    expect(ids(convergenceWindow([snap('s1', 'a'), snap('s2', 'a'), snap('s3', 'a')], null))).toEqual(['s1', 's2', 's3'])
  })
  // @covers: review-convergence › Signals read the counted reviews of the current window › A new contract restarts the window
  test('WN2 a new contract hash restarts the window', () => {
    expect(ids(convergenceWindow([snap('s1', 'a'), snap('s2', 'a'), snap('s3', 'b')], null))).toEqual(['s3'])
    const subs = reviews([finding('F1', 'A1')], [disposition('F1', 'A1', 'still-open')], [disposition('F1', 'A1', 'still-open')])
    subs[2]!.contractIdentity = H2
    expect(convergenceOf(subs, [], null).window.map(entry => entry.submissionId)).toEqual(['sub-3'])
    expect(kinds(subs)).toEqual([])
  })
  test('WN3 the window is the trailing run, not every review under the hash', () => {
    expect(ids(convergenceWindow([snap('s1', 'a'), snap('s2', 'b'), snap('s3', 'a')], null))).toEqual(['s3'])
  })
  // @covers: review-convergence › Signals read the counted reviews of the current window › A closed diagnosis restarts the window
  test('WN4 the window starts after the anchor review', () => {
    expect(ids(convergenceWindow([snap('s1', 'a'), snap('s2', 'a'), snap('s3', 'a')], 's2'))).toEqual(['s3'])
  })
  test('WN5 an anchor on the newest review leaves the window empty', () => {
    expect(convergenceWindow([snap('s1', 'a'), snap('s2', 'a'), snap('s3', 'a')], 's3')).toEqual([])
  })
  // @covers: review-convergence › Signals read the counted reviews of the current window › A rewording keeps the window
  test('WN6 a renumbered identity with the same hash keeps the window', () => {
    const subs = reviews([finding('F1', 'A1')], [disposition('F1', 'A1', 'still-open')])
    subs[0]!.contractIdentity = 'r3#aaaaaaaaaaaa'
    subs[1]!.contractIdentity = 'r4#aaaaaaaaaaaa'
    expect(convergenceWindow(reviewSnapshots(subs, []), null).map(entry => entry.submissionId)).toEqual(['sub-1', 'sub-2'])
  })
})

describe('signal evidence', () => {
  test('signalFindings names each finding once, in number order', () => {
    expect(signalFindings([{ kind: 'S3', findings: ['F10', 'F3'], raised: 2, resolved: 1 }, { kind: 'S1', findings: ['F3'] }, { kind: 'backstop', count: 5, limit: 5 }])).toEqual(['F3', 'F10'])
  })
  test('events up to a review count toward its open count, later ones toward the next', () => {
    const subs = reviews([finding('F1', 'A1'), finding('F2', 'A1')], [disposition('F1', 'A1', 'still-open')])
    subs[1]!.ledgerSeq = 3
    const rejected = { id: 'ev1', findingId: 'F2', ledgerSeq: 2, kind: 'rejected' as const, resultId: null, cardId: 'card-1', decisionId: 'd1', contractIdentity: null, clause: null, text: null, createdAt: '' }
    expect(reviewSnapshots(subs, [rejected]).map(entry => entry.openAfter)).toEqual([2, 1])
  })
})
