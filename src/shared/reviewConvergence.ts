// Review convergence (review-convergence design decisions 1–2): one pure
// module, over the findings ledger, that every reader calls — the executor's
// fix step, the manual-task notice, supervision, and the Plans view — so
// none can disagree (invariant I3).
// - `reviewSnapshots` turns a task's counted reviews into what each raised,
//   resolved, and left open, in ledger order;
// - `convergenceWindow` keeps the trailing run under the newest contract
//   hash, after the anchor review (the newest closed diagnosis's, or a manual
//   task's newest notice's);
// - `convergenceSignals` computes S1–S5 over the window (tables SG and WN).
// A signal never changes a finding (invariant I1); it only names evidence.
import { blocking, foldLedger, type LedgerEvent, type LedgerRow, type LedgerSubmission } from './findingsLedger'

/** What one counted review did, and what it left open. */
export interface ReviewSnapshot {
  submissionId: string
  ledgerSeq: number
  /** The hash part of the review's contract identity; '' when it has none. */
  contractHash: string
  /** Findings it raised that block: new accepted P0/P1 findings and re-raises. */
  raised: Array<{ id: string; clauseId: string | null }>
  /** Findings it gave `resolved`. */
  resolved: Array<{ id: string; clauseId: string | null }>
  /** Findings the gate classed out of contract. */
  outOfContract: string[]
  /** Raised findings that existed before this review: they entered `reopened`. */
  reopened: string[]
  /** The open blocking count of the ledger right after this review. */
  openAfter: number
}

export type ConvergenceSignal =
  | { kind: 'S1'; findings: string[] }
  | { kind: 'S2'; clause: string; findings: string[] }
  | { kind: 'S3'; findings: string[]; raised: number; resolved: number }
  | { kind: 'S4'; counts: number[] }
  | { kind: 'S5'; findings: string[] }

/** A diagnosis's reasons: the signals, or the backstop. */
export type DiagnosisSignal = ConvergenceSignal | { kind: 'backstop'; count: number; limit: number }

export const SIGNAL_LABELS: Record<DiagnosisSignal['kind'], string> = {
  S1: 'S1 oscillation',
  S2: 'S2 moving clause',
  S3: 'S3 churn',
  S4: 'S4 stagnation',
  S5: 'S5 scope pressure',
  backstop: 'backstop',
}

export const contractHashOf = (identity: string | null): string => (identity === null ? '' : identity.slice(identity.indexOf('#') + 1))

const byNumber = (a: string, b: string): number => Number(a.slice(1)) - Number(b.slice(1))
const sortedIds = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(byNumber)

/** One snapshot per counted review, in `ledgerSeq` order. */
export function reviewSnapshots(submissions: readonly LedgerSubmission[], events: readonly LedgerEvent[]): ReviewSnapshot[] {
  const ordered = [...submissions].sort((a, b) => a.ledgerSeq - b.ledgerSeq)
  const snapshots: ReviewSnapshot[] = []
  for (const [index, submission] of ordered.entries()) {
    const before = new Set(foldLedger(ordered.slice(0, index), events.filter(event => event.ledgerSeq < submission.ledgerSeq)).map(row => row.id))
    const after = foldLedger(ordered.slice(0, index + 1), events.filter(event => event.ledgerSeq <= submission.ledgerSeq))
    const raised = submission.items.filter(item => item.itemKind === 'finding' && item.class === 'accepted' && item.level !== 'P2')
    snapshots.push({
      submissionId: submission.id,
      ledgerSeq: submission.ledgerSeq,
      contractHash: contractHashOf(submission.contractIdentity),
      raised: raised.map(item => ({ id: item.findingId, clauseId: item.clauseId })),
      resolved: submission.items.filter(item => item.itemKind === 'disposition' && item.disposition === 'resolved')
        .map(item => ({ id: item.findingId, clauseId: item.clauseId })),
      outOfContract: submission.items.filter(item => item.itemKind === 'finding' && item.class === 'out-of-contract').map(item => item.findingId),
      reopened: raised.filter(item => before.has(item.findingId)).map(item => item.findingId),
      openAfter: blocking(after).length,
    })
  }
  return snapshots
}

/**
 * Table WN: the trailing run under the newest contract hash, strictly after
 * the anchor review and after the newest earlier review that left no
 * blocking finding open (a pass restarts the window, WN7).
 */
export function convergenceWindow(snapshots: readonly ReviewSnapshot[], anchorSubmissionId: string | null): ReviewSnapshot[] {
  const newest = snapshots.at(-1)
  if (!newest) return []
  let start = snapshots.length - 1
  while (start > 0 && snapshots[start - 1]!.contractHash === newest.contractHash && snapshots[start - 1]!.openAfter > 0) start--
  const anchor = anchorSubmissionId === null ? -1 : snapshots.findIndex(snapshot => snapshot.submissionId === anchorSubmissionId)
  return snapshots.slice(Math.max(start, anchor + 1))
}

/** The clauses on which one review both resolved a finding and raised another, with those findings. */
function movingClauses(review: ReviewSnapshot): Map<string, string[]> {
  const moving = new Map<string, string[]>()
  for (const fixed of review.resolved) {
    if (fixed.clauseId === null) continue
    const raised = review.raised.filter(item => item.clauseId === fixed.clauseId && item.id !== fixed.id)
    if (raised.length === 0) continue
    moving.set(fixed.clauseId, [...(moving.get(fixed.clauseId) ?? []), fixed.id, ...raised.map(item => item.id)])
  }
  return moving
}

/** Table SG: the signals over a window, in order S1–S5. `rows` is the ledger's fold now (S1 reads its transitions). */
export function convergenceSignals(window: readonly ReviewSnapshot[], rows: readonly LedgerRow[]): ConvergenceSignal[] {
  const signals: ConvergenceSignal[] = []
  const newest = window.at(-1)
  if (!newest) return signals
  const reopenedTwice = newest.reopened.filter(id => {
    const row = rows.find(entry => entry.id === id)
    return (row?.transitions.filter(t => t.kind === 'reopened' && t.seq <= newest.ledgerSeq).length ?? 0) >= 2
  })
  if (reopenedTwice.length > 0) signals.push({ kind: 'S1', findings: sortedIds(reopenedTwice) })
  if (window.length < 2) return signals
  const [previous, last] = [window.at(-2)!, newest]
  const earlier = movingClauses(previous)
  for (const [clause, ids] of movingClauses(last)) {
    const before = earlier.get(clause)
    if (before) signals.push({ kind: 'S2', clause, findings: sortedIds([...before, ...ids]) })
  }
  const raised = previous.raised.length + last.raised.length
  const resolved = previous.resolved.length + last.resolved.length
  // The newest review itself must raise: one that only keeps findings open is a flat count, S4's to judge.
  if (last.raised.length >= 1 && raised >= resolved) {
    signals.push({ kind: 'S3', findings: sortedIds([...previous.raised, ...last.raised].map(item => item.id)), raised, resolved })
  }
  if (window.length >= 3) {
    const counts = window.slice(-3).map(review => review.openAfter)
    if (counts[1]! >= counts[0]! && counts[2]! >= counts[1]! && counts[2]! > 0) signals.push({ kind: 'S4', counts })
  }
  if (previous.outOfContract.length > 0 && last.outOfContract.length > 0) {
    signals.push({ kind: 'S5', findings: sortedIds([...previous.outOfContract, ...last.outOfContract]) })
  }
  return signals
}

/** The convergence of a task's ledger after an anchor: the window's open counts and its signals. */
export function convergenceOf(submissions: readonly LedgerSubmission[], events: readonly LedgerEvent[], anchorSubmissionId: string | null): { window: ReviewSnapshot[]; counts: number[]; signals: ConvergenceSignal[] } {
  const window = convergenceWindow(reviewSnapshots(submissions, events), anchorSubmissionId)
  return { window, counts: window.map(review => review.openAfter), signals: convergenceSignals(window, foldLedger(submissions, events)) }
}

/** The finding ids a diagnosis's signals name, in order. */
export function signalFindings(signals: readonly DiagnosisSignal[]): string[] {
  return sortedIds(signals.flatMap(signal => ('findings' in signal ? signal.findings : [])))
}

/** One line per signal, for cards, journals, and the Plans view. */
export function signalLine(signal: DiagnosisSignal): string {
  switch (signal.kind) {
    case 'S1': return `${SIGNAL_LABELS.S1}: ${signal.findings.join(', ')} reopened a second time`
    case 'S2': return `${SIGNAL_LABELS.S2}: on ${signal.clause}, fixes keep raising new findings (${signal.findings.join(', ')})`
    case 'S3': return `${SIGNAL_LABELS.S3}: ${signal.raised} raised against ${signal.resolved} resolved over the last two reviews (${signal.findings.join(', ')})`
    case 'S4': return `${SIGNAL_LABELS.S4}: open blocking counts ${signal.counts.join(', ')} did not fall`
    case 'S5': return `${SIGNAL_LABELS.S5}: out-of-contract findings in two reviews (${signal.findings.join(', ')})`
    case 'backstop': return `${SIGNAL_LABELS.backstop}: ${signal.count} failed fix rounds reached the limit of ${signal.limit}`
  }
}
