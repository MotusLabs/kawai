// The findings ledger (review-findings-ledger D2, D5): one pure fold over a
// task's counted submissions and its events, ordered by `ledgerSeq`, that
// every reader calls — the tools, execution, the task summary, and the
// client — so none can disagree (invariant I2). Also the derived verdicts
// (`deriveVerdict`, `roundReview`) and `planSubmission`, which turns one
// structured submission into stored items under tables VD and RO.
import type { CitationContext, Disposition, FindingClass, FindingLevel, FindingState, ScopeView } from './reviewFindings'
import { FINDING_LIMITS, classifyFinding, contractHas, isBlocking, parseLocus, resolveCitation } from './reviewFindings'
import { clauseIdentity, type ImplementationContract } from './implementationContract'

/** One stored item of a submission: a new or re-raised finding, or a disposition. */
export interface LedgerItem {
  findingId: string
  itemKind: 'finding' | 'disposition'
  level: FindingLevel
  clause: string | null
  clauseId: string | null
  evidence: string | null
  impact: string | null
  reproduction: string | null
  locus: string
  class: FindingClass | null
  reason: string | null
  disposition: Disposition | null
  regressed: boolean
}

export interface LedgerSubmission {
  id: string
  resultId: string
  ledgerSeq: number
  contractIdentity: string | null
  createdAt: string
  items: LedgerItem[]
}

export type LedgerEventKind = 'disputed' | 'upheld' | 'rejected' | 'remapped' | 'superseded' | 'ignored'

export interface LedgerEvent {
  id: string
  findingId: string
  ledgerSeq: number
  kind: LedgerEventKind
  resultId: string | null
  cardId: string | null
  decisionId: string | null
  contractIdentity: string | null
  clause: string | null
  text: string | null
  createdAt: string
}

export interface LedgerTransition {
  seq: number
  /** The state the finding entered, or `ignored`/`remapped` for transitions that keep it. */
  kind: FindingState | 'upheld' | 'ignored' | 'remapped'
  source: 'submission' | 'event'
  sourceId: string
  resultId: string | null
  cardId: string | null
  contractIdentity: string | null
  note: string | null
  at: string
}

export interface LedgerRow {
  id: string
  level: FindingLevel
  clause: string | null
  clauseId: string | null
  locus: string
  state: FindingState
  regressed: boolean
  /** The state before the open (or last) dispute; what upholding restores. */
  preDispute: FindingState | null
  /** The newest dispute event, and whether the state entry it disputed is still current. */
  disputeEventId: string | null
  disputedThisEntry: boolean
  /** The `ledgerSeq` at which the finding last read resolved. */
  resolvedSeq: number | null
  transitions: LedgerTransition[]
}

const findingNumber = (id: string): number => Number(id.slice(1))

/** Fold counted submissions and events, by `ledgerSeq`, into one row per finding id. */
export function foldLedger(submissions: readonly LedgerSubmission[], events: readonly LedgerEvent[]): LedgerRow[] {
  type Step = { seq: number; submission?: LedgerSubmission; event?: LedgerEvent }
  const steps: Step[] = [
    ...submissions.map(submission => ({ seq: submission.ledgerSeq, submission })),
    ...events.map(event => ({ seq: event.ledgerSeq, event })),
  ].sort((a, b) => a.seq - b.seq)
  const rows = new Map<string, LedgerRow>()
  for (const step of steps) {
    if (step.submission) applySubmission(rows, step.submission)
    else if (step.event) applyEvent(rows, step.event)
  }
  return [...rows.values()].sort((a, b) => findingNumber(a.id) - findingNumber(b.id))
}

function applySubmission(rows: Map<string, LedgerRow>, submission: LedgerSubmission): void {
  for (const item of submission.items) {
    const existing = rows.get(item.findingId)
    const transition = (kind: LedgerTransition['kind'], note: string | null): LedgerTransition => ({
      seq: submission.ledgerSeq, kind, source: 'submission', sourceId: submission.id, resultId: submission.resultId,
      cardId: null, contractIdentity: submission.contractIdentity, note, at: submission.createdAt,
    })
    if (item.itemKind === 'disposition') {
      if (!existing) continue
      existing.state = item.disposition === 'resolved' ? 'resolved' : 'still-open'
      existing.regressed = item.disposition === 'regressed'
      existing.disputedThisEntry = false
      if (existing.state === 'resolved') existing.resolvedSeq = submission.ledgerSeq
      existing.transitions.push(transition(existing.state, item.disposition === 'regressed' ? 'regressed' : item.evidence))
      continue
    }
    const cls = item.class ?? 'unsupported'
    if (existing) {
      // A re-raise (table RO): the id is reused and re-gated.
      existing.level = item.level
      existing.clause = item.clause
      existing.clauseId = item.clauseId
      existing.locus = item.locus
      existing.state = cls === 'accepted' ? 'reopened' : cls
      existing.regressed = false
      existing.disputedThisEntry = false
      existing.transitions.push(transition(existing.state, `re-raised: ${item.reason ?? cls}`))
      continue
    }
    rows.set(item.findingId, {
      id: item.findingId, level: item.level, clause: item.clause, clauseId: item.clauseId, locus: item.locus,
      state: cls, regressed: false, preDispute: null, disputeEventId: null, disputedThisEntry: false, resolvedSeq: null,
      transitions: [transition(cls, item.reason)],
    })
  }
}

function applyEvent(rows: Map<string, LedgerRow>, event: LedgerEvent): void {
  const row = rows.get(event.findingId)
  if (!row) return
  const push = (kind: LedgerTransition['kind']): void => { row.transitions.push({
    seq: event.ledgerSeq, kind, source: 'event', sourceId: event.id, resultId: event.resultId, cardId: event.cardId,
    contractIdentity: event.contractIdentity, note: event.text, at: event.createdAt,
  }) }
  switch (event.kind) {
    case 'disputed':
      row.preDispute = row.state
      row.state = 'disputed'
      row.disputeEventId = event.id
      row.disputedThisEntry = true
      return push('disputed')
    case 'upheld':
      row.state = row.preDispute ?? 'accepted'
      return push('upheld')
    case 'rejected':
      row.state = 'rejected'
      return push('rejected')
    case 'remapped':
      row.clause = event.clause
      return push('remapped')
    case 'superseded':
      row.state = 'superseded'
      return push('superseded')
    case 'ignored':
      return push('ignored')
  }
}

export const blocking = (rows: readonly LedgerRow[]): LedgerRow[] => rows.filter(row => isBlocking(row.level, row.state))
export const pendingDisputes = (rows: readonly LedgerRow[]): LedgerRow[] => rows.filter(row => row.state === 'disputed')
export const deriveVerdict = (rows: readonly LedgerRow[]): 'pass' | 'fail' => (blocking(rows).length > 0 ? 'fail' : 'pass')

/** The fields of a findings row the effective verdict reads. */
export interface VerdictRow { structured: boolean; counted: boolean; replacedBy: string | null; verdict: 'pass' | 'fail' }

/**
 * The effective review verdict of a result's findings rows (D5), for every
 * reader: the newest row the ledger stands on — a text row, or a counted
 * structured row not replaced — decides; a text row by its stored verdict,
 * a structured one by the ledger's fold now, so a later dispute decision or
 * re-map reaches every reader. Null when no row counts.
 */
export function effectiveVerdict(rows: readonly VerdictRow[], ledger: () => readonly LedgerRow[]): 'pass' | 'fail' | null {
  const last = rows.filter(row => !row.structured || (row.counted && row.replacedBy === null)).at(-1)
  if (!last) return null
  return last.structured ? deriveVerdict(ledger()) : last.verdict
}

/** Table RD's review part: a pending dispute holds a round nothing else fails. */
export function roundReview(rows: readonly LedgerRow[]): 'fail' | 'pending-dispute' | 'pass' {
  if (blocking(rows).length > 0) return 'fail'
  return pendingDisputes(rows).length > 0 ? 'pending-dispute' : 'pass'
}

/**
 * D6: whether a decision on the card of dispute `disputeEventId` applies —
 * every transition since that dispute came from the same card (its earlier
 * decisions). A re-map, a later disposition, or a newer dispute makes it
 * `ignored` (DD5, DD7).
 */
export function decisionApplies(row: LedgerRow, disputeEventId: string, cardId: string): boolean {
  const index = row.transitions.findIndex(t => t.source === 'event' && t.sourceId === disputeEventId)
  // A re-map (remapped or superseded) after the dispute is an event of no card, so it fails the test below (DD5).
  if (index < 0) return false
  return row.transitions.slice(index + 1).every(t => t.source === 'event' && t.cardId === cardId && (t.kind === 'upheld' || t.kind === 'rejected' || t.kind === 'ignored'))
}

/** DS1–DS4: whether a finding can be disputed now, else why not. */
export function disputeRefusal(row: LedgerRow | undefined, id: string): string | null {
  if (!row) return `${id} is not a finding of this task`
  if (row.state === 'disputed') return `${id} is already disputed`
  if (!isBlocking(row.level, row.state)) return `${id} is not blocking (${row.state}); only blocking findings can be disputed`
  if (row.disputedThisEntry) return `${id} was already disputed in its current state; it can be disputed again after a later review re-raises it`
  return null
}

const clauseKey = (row: { clauseId: string | null; clause: string | null }): string | null =>
  row.clauseId ?? (row.clause !== null ? '#revision' : null)

/** Table RO: the resolved finding a new item re-raises — most recently resolved, then lowest id. */
export function reopenMatch(rows: readonly LedgerRow[], key: string | null, locus: string): LedgerRow | null {
  if (key === null) return null
  const matches = rows.filter(row => row.state === 'resolved' && clauseKey(row) === key && row.locus === locus)
  matches.sort((a, b) => (b.resolvedSeq ?? 0) - (a.resolvedSeq ?? 0) || findingNumber(a.id) - findingNumber(b.id))
  return matches[0] ?? null
}

export interface SubmittedFinding { id?: string; level: FindingLevel; clause?: string | null; evidence?: string | null; impact?: string | null; reproduction?: string | null }
export interface SubmittedDisposition { id: string; disposition: Disposition; evidence?: string | null }

export type SubmissionPlan =
  | { ok: true; items: LedgerItem[]; verdict: 'pass' | 'fail'; after: LedgerRow[]; nextNumber: number }
  | { ok: false; problems: string[] }

const tooLong = (value: string | null | undefined, max: number): boolean => (value?.length ?? 0) > max

/**
 * Plan one structured submission against the prior ledger (D4 steps 1, 3–5):
 * bounds, dispositions (VD), re-raises and duplicates (RO), the gate, id
 * allocation from `nextNumber`, and the derived verdict. Problems refuse the
 * whole submission; nothing is half-planned (invariant I3).
 */
export function planSubmission(input: {
  prior: readonly LedgerRow[]
  findings: readonly SubmittedFinding[]
  dispositions: readonly SubmittedDisposition[]
  citation: CitationContext
  scope: ScopeView | null
  nextNumber: number
  submission: Omit<LedgerSubmission, 'items'>
  priorSubmissions: readonly LedgerSubmission[]
  events: readonly LedgerEvent[]
}): SubmissionPlan {
  const problems: string[] = []
  const L = FINDING_LIMITS
  if (input.findings.length > L.newFindings) problems.push(`a submission holds at most ${L.newFindings} new findings`)
  if (input.dispositions.length > L.dispositions) problems.push(`a submission holds at most ${L.dispositions} dispositions`)
  for (const [index, finding] of input.findings.entries()) {
    const name = finding.id ?? `finding ${index + 1}`
    if (tooLong(finding.evidence, L.evidenceChars)) problems.push(`${name}: evidence is over ${L.evidenceChars} characters`)
    if (tooLong(finding.reproduction, L.reproductionChars)) problems.push(`${name}: reproduction is over ${L.reproductionChars} characters`)
    if (tooLong(finding.impact, L.impactChars)) problems.push(`${name}: impact is over ${L.impactChars} characters`)
    if (tooLong(finding.clause, L.citationChars)) problems.push(`${name}: the clause citation is over ${L.citationChars} characters`)
  }
  for (const disposition of input.dispositions) {
    if (tooLong(disposition.evidence, L.evidenceChars)) problems.push(`${disposition.id}: evidence is over ${L.evidenceChars} characters`)
  }
  if (problems.length > 0) return { ok: false, problems }

  const byId = new Map(input.prior.map(row => [row.id, row]))
  const open = blocking(input.prior)
  const disposed = new Set<string>()
  const items: LedgerItem[] = []
  for (const disposition of input.dispositions) {
    const row = byId.get(disposition.id)
    if (disposed.has(disposition.id)) { problems.push(`${disposition.id} has two dispositions`); continue }
    disposed.add(disposition.id)
    if (!row || !isBlocking(row.level, row.state)) { problems.push(`${disposition.id} is not blocking; only blocking findings take a disposition`); continue }
    if (disposition.disposition !== 'resolved' && (disposition.evidence?.trim() ?? '') === '') {
      problems.push(`${disposition.id}: ${disposition.disposition} needs evidence`)
      continue
    }
    items.push({
      findingId: row.id, itemKind: 'disposition', level: row.level, clause: row.clause, clauseId: row.clauseId,
      evidence: disposition.evidence?.trim() || null, impact: null, reproduction: null, locus: row.locus,
      class: null, reason: null, disposition: disposition.disposition, regressed: disposition.disposition === 'regressed',
    })
  }
  const missing = open.filter(row => !disposed.has(row.id)).map(row => row.id)
  if (missing.length > 0) problems.push(`every blocking finding needs a disposition; missing ${missing.join(', ')}`)

  let next = input.nextNumber
  const raised = new Set<string>()
  for (const finding of input.findings) {
    const gate = classifyFinding(finding, input.citation, input.scope)
    const locus = parseLocus(finding.evidence)
    const resolved = resolveCitation(finding.clause, input.citation)
    const key = resolved.kind === 'clause' ? resolved.clauseId : resolved.kind === 'revision' ? '#revision' : null
    let id: string
    if (finding.id !== undefined) {
      const row = byId.get(finding.id)
      if (!row) { problems.push(`${finding.id} is not a finding of this task`); continue }
      if (isBlocking(row.level, row.state)) { problems.push(`${finding.id} is blocking; give it a disposition instead of raising it again`); continue }
      if (row.state === 'disputed') { problems.push(`${finding.id} is disputed; it awaits its decision`); continue }
      id = row.id
    } else {
      const duplicate = key === null ? undefined : open.find(row => clauseKey(row) === key && row.locus === locus)
      if (duplicate) { problems.push(`a new finding duplicates ${duplicate.id} (same clause, same locus); give ${duplicate.id} a disposition instead`); continue }
      id = reopenMatch(input.prior, key, locus)?.id ?? `F${next++}`
    }
    if (raised.has(id)) { problems.push(`${id} is raised twice`); continue }
    raised.add(id)
    items.push({
      findingId: id, itemKind: 'finding', level: finding.level, clause: gate.clause, clauseId: gate.clauseId,
      evidence: finding.evidence?.trim() || null, impact: finding.impact?.trim() || null,
      reproduction: finding.reproduction?.trim() || null, locus: gate.locus, class: gate.class, reason: gate.reason,
      disposition: null, regressed: false,
    })
  }
  if (problems.length > 0) return { ok: false, problems }
  const after = foldLedger([...input.priorSubmissions, { ...input.submission, items }], input.events)
  if (blocking(after).length > L.blocking) {
    return { ok: false, problems: [`a task holds at most ${L.blocking} blocking findings; this submission would leave ${blocking(after).length}`] }
  }
  return { ok: true, items, verdict: deriveVerdict(after), after, nextNumber: next }
}

export interface RemapEvent { findingId: string; kind: 'remapped' | 'superseded'; clause: string | null }

/** The hash part of `r<N>#<hash12>`: the revision number moves on every publication, the hash only when the text or contract does. */
const identityHash = (identity: string): string => identity.slice(identity.indexOf('#') + 1)

/**
 * Table RM (D9): the events a publication writes. Nothing when the identity's
 * hash is unchanged (RM6) or for a finding neither blocking nor disputed
 * (RM7). A clause citation moves by its clause id, never by its text, to a
 * contract that still has that id (RM1, RM2, RM5); a revision citation moves
 * only to a revision without a contract (RM3, RM4).
 */
export function remapOnPublication(rows: readonly LedgerRow[], previousIdentity: string, next: { identity: string; contract: ImplementationContract | null }): RemapEvent[] {
  if (identityHash(previousIdentity) === identityHash(next.identity)) return []
  const events: RemapEvent[] = []
  for (const row of rows) {
    if (!isBlocking(row.level, row.state) && row.state !== 'disputed') continue
    if (row.clauseId !== null) {
      events.push(next.contract !== null && contractHas(next.contract, row.clauseId)
        ? { findingId: row.id, kind: 'remapped', clause: clauseIdentity(next.identity, row.clauseId) }
        : { findingId: row.id, kind: 'superseded', clause: null })
    } else {
      events.push(row.clause !== null && next.contract === null
        ? { findingId: row.id, kind: 'remapped', clause: next.identity }
        : { findingId: row.id, kind: 'superseded', clause: null })
    }
  }
  return events
}
