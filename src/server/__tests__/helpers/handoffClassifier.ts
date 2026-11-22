// The H completeness classifier (owner-publication-handoff design, "Table
// H", "Completeness claim", task 7.3): each partition declares its axes,
// the U-claims it evaluates — each computed only from its declared
// observations — and its rows as independent predicates in check order. A
// tuple whose reason set is empty must match exactly one row; a tuple with
// a nonempty set matches none and is one excluded classification keeping
// every reason. The DF fixtures are observed from a database snapshot into
// the same tuples (`observeRestart`, `observePublish`), so a seeded state is
// classified exactly as the enumeration classifies it.
import type { Database } from 'bun:sqlite'
import { HANDOFF_STATES, preparedKey } from '../../../shared/taskHandoffs'

export type Tuple = Record<string, string>
export type Reason = 'U1' | 'U3' | 'U5' | 'U6'
export interface Row { id: string; match: (tuple: Tuple) => boolean }
export interface Claim { id: Reason; reads: readonly string[]; holds: (tuple: Tuple) => boolean }
export interface Partition { name: string; axes: Record<string, readonly string[]>; claims: Claim[]; rows: Row[] }
export type Classification =
  | { kind: 'healthy'; row: string; tolerated?: true }
  | { kind: 'excluded'; reasons: Reason[] }
  | { kind: 'gap' }
  | { kind: 'overlap'; rows: string[]; reasons: Reason[] }

const STATES = HANDOFF_STATES as readonly string[]
const PENDING = ['open', 'stale']
const ENDED = STATES.filter(state => !PENDING.includes(state))

export const H_REQ: Partition = {
  name: 'H-REQ',
  axes: {
    right: ['ok', 'owner', 'cannot-create'], key: ['new', 'replay-same', 'replay-different', 'other-side'],
    status: ['open', 'closed'], base: ['current', 'behind'], payload: ['valid', 'invalid'], pending: ['none', 'requester-side', 'other-group'],
  },
  claims: [],
  rows: [
    { id: 'H6', match: t => t.right === 'owner' },
    { id: 'H5', match: t => t.right === 'cannot-create' },
    { id: 'H11s', match: t => t.right === 'ok' && t.key === 'other-side' },
    { id: 'H10', match: t => t.right === 'ok' && t.key === 'replay-same' },
    { id: 'H11', match: t => t.right === 'ok' && t.key === 'replay-different' },
    { id: 'H3', match: t => t.right === 'ok' && t.key === 'new' && t.status === 'closed' },
    { id: 'H2', match: t => t.right === 'ok' && t.key === 'new' && t.status === 'open' && t.base === 'behind' },
    { id: 'H7', match: t => t.right === 'ok' && t.key === 'new' && t.status === 'open' && t.base === 'current' && t.payload === 'invalid' },
    { id: 'H9', match: t => t.right === 'ok' && t.key === 'new' && t.status === 'open' && t.base === 'current' && t.payload === 'valid' && t.pending === 'other-group' },
    { id: 'H8', match: t => t.right === 'ok' && t.key === 'new' && t.status === 'open' && t.base === 'current' && t.payload === 'valid' && t.pending === 'requester-side' },
    { id: 'H1', match: t => t.right === 'ok' && t.key === 'new' && t.status === 'open' && t.base === 'current' && t.payload === 'valid' && t.pending === 'none' },
  ],
}

/** H-PUB's revision facts: R0 none; R1 orphan only; R2 associated under the prepared key; R3 associated under another key; R4 R3 plus an orphan. */
export const associationOf = (r: string) => r === 'R2' || r === 'R3' || r === 'R4'
export const orphanOf = (r: string) => r === 'R1' || r === 'R4'
/** The revision-fact and state pairs a legal history produces (the 8 pairs the H-PUB rows are defined over). */
const legalPair = (t: Tuple) => (t.revisionFacts === 'R0' && t.state !== 'published') || ((t.revisionFacts === 'R2' || t.revisionFacts === 'R3') && t.state === 'published')

export const H_PUB: Partition = {
  name: 'H-PUB',
  axes: { revisionFacts: ['R0', 'R1', 'R2', 'R3', 'R4'], right: ['ok', 'other'], extras: ['none', 'some'], state: STATES },
  claims: [
    { id: 'U1', reads: ['revisionFacts', 'state'], holds: t => (t.state === 'published') !== associationOf(t.revisionFacts!) },
    { id: 'U6', reads: ['revisionFacts'], holds: t => orphanOf(t.revisionFacts!) },
  ],
  rows: [
    { id: 'H13', match: t => legalPair(t) && t.right === 'other' },
    { id: 'H35', match: t => legalPair(t) && t.right === 'ok' && t.extras === 'some' },
    { id: 'H14', match: t => t.right === 'ok' && t.extras === 'none' && t.revisionFacts === 'R2' && t.state === 'published' },
    { id: 'H15', match: t => t.right === 'ok' && t.extras === 'none' && t.revisionFacts === 'R0' && ['stale', 'declined', 'withdrawn', 'superseded', 'closed'].includes(t.state!) },
    { id: 'H16b', match: t => t.right === 'ok' && t.extras === 'none' && t.revisionFacts === 'R3' && t.state === 'published' },
    { id: 'H12', match: t => t.right === 'ok' && t.extras === 'none' && t.revisionFacts === 'R0' && t.state === 'open' },
  ],
}

export const H_OTHER: Partition = {
  name: 'H-OTHER',
  axes: { key: ['ordinary', 'reserved'], raw: ['bare', 'padded'], pending: ['none', 'open', 'stale'] },
  claims: [],
  rows: [
    { id: 'H33', match: t => t.key === 'reserved' },
    { id: 'H20', match: t => t.key === 'ordinary' && t.pending === 'open' },
    { id: 'H21', match: t => t.key === 'ordinary' && t.pending === 'stale' },
    { id: 'H39', match: t => t.key === 'ordinary' && t.pending === 'none' },
  ],
}

export const H_SETTLE: Partition = {
  name: 'H-SETTLE',
  axes: { action: ['decline', 'withdraw'], right: ['ok', 'missing'], reason: ['given', 'empty'], state: STATES },
  claims: [],
  rows: [
    { id: 'H23', match: t => t.right === 'missing' },
    { id: 'H23b', match: t => t.right === 'ok' && t.reason === 'empty' },
    { id: 'H26', match: t => t.right === 'ok' && t.reason === 'given' && ENDED.includes(t.state!) },
    { id: 'H22', match: t => t.right === 'ok' && t.reason === 'given' && PENDING.includes(t.state!) && t.action === 'decline' },
    { id: 'H24', match: t => t.right === 'ok' && t.reason === 'given' && PENDING.includes(t.state!) && t.action === 'withdraw' },
  ],
}

export const H_CLOSE: Partition = {
  name: 'H-CLOSE',
  axes: { path: ['setStatus', 'prepareStatus', 'override'], state: STATES },
  claims: [],
  rows: [
    { id: 'H27', match: t => PENDING.includes(t.state!) },
    { id: 'H40', match: t => ENDED.includes(t.state!) },
  ],
}

export const NEUTRAL_EVENTS = ['answer', 'own-call', 'override-elsewhere', 'override-closing', 'note', 'mail', 'time', 'archival', 'exhaustion', 'notice-retry', 'acknowledgement'] as const
export const H_NEUTRAL: Partition = {
  name: 'H-NEUTRAL',
  axes: { event: NEUTRAL_EVENTS, state: STATES },
  claims: [],
  rows: [
    { id: 'H28', match: t => t.event !== 'override-closing' },
    { id: 'H28b', match: t => t.event === 'override-closing' },
  ],
}

export const H_RESTART: Partition = {
  name: 'H-RESTART',
  axes: { associationPresent: ['true', 'false'], unassociatedReservedKeyPresent: ['true', 'false'], status: ['open', 'closed'], base: ['current', 'behind'], state: PENDING },
  claims: [
    // A pending handoff is never `published`, so an association is U1 by itself.
    { id: 'U1', reads: ['associationPresent', 'state'], holds: t => t.associationPresent === 'true' && t.state !== 'published' },
    { id: 'U3', reads: ['state', 'base'], holds: t => t.state === 'open' && t.base === 'behind' },
    { id: 'U5', reads: ['state', 'status'], holds: t => PENDING.includes(t.state!) && t.status === 'closed' },
    { id: 'U6', reads: ['unassociatedReservedKeyPresent'], holds: t => t.unassociatedReservedKeyPresent === 'true' },
  ],
  rows: [
    { id: 'H29', match: t => t.associationPresent === 'false' && t.unassociatedReservedKeyPresent === 'false' && t.status === 'open' && ((t.state === 'open' && t.base === 'current') || t.state === 'stale') },
  ],
}

export const PARTITIONS = [H_REQ, H_PUB, H_OTHER, H_SETTLE, H_CLOSE, H_NEUTRAL, H_RESTART]

export function product(partition: Partition): Tuple[] {
  return Object.entries(partition.axes).reduce<Tuple[]>(
    (tuples, [axis, values]) => tuples.flatMap(tuple => values.map(value => ({ ...tuple, [axis]: value }))), [{}])
}

/** Every reason a tuple satisfies (the whole set, never the first). */
export function reasonsOf(partition: Partition, tuple: Tuple): Reason[] {
  return partition.claims.filter(claim => claim.holds(tuple)).map(claim => claim.id)
}

export function classify(partition: Partition, tuple: Tuple): Classification {
  const reasons = reasonsOf(partition, tuple)
  const rows = partition.rows.filter(row => row.match(tuple)).map(row => row.id)
  if (reasons.length) return rows.length ? { kind: 'overlap', rows, reasons } : { kind: 'excluded', reasons }
  if (rows.length === 0) return { kind: 'gap' }
  if (rows.length > 1) return { kind: 'overlap', rows, reasons }
  // H29's (stale, current): no legal history produces it; a no-op reported apart.
  const tolerated = partition.name === 'H-RESTART' && tuple.state === 'stale' && tuple.base === 'current'
  return { kind: 'healthy', row: rows[0]!, ...(tolerated ? { tolerated: true as const } : {}) }
}

/** H-RESTART's five observations of a pending handoff, read from one snapshot before any repair. */
export function observeRestart(db: Database, handoffId: string): Tuple {
  return db.transaction(() => {
    const handoff = db.prepare('SELECT task_id, base_revision, state FROM team_task_handoffs WHERE id = ?').get(handoffId) as { task_id: string; base_revision: number; state: string }
    const task = db.prepare('SELECT status, revision FROM team_tasks WHERE id = ?').get(handoff.task_id) as { status: string; revision: number }
    const associated = db.prepare('SELECT 1 FROM team_task_revisions WHERE task_id = ? AND handoff_id = ?').get(handoff.task_id, handoffId)
    const orphan = db.prepare('SELECT 1 FROM team_task_revisions WHERE task_id = ? AND request_key = ? AND (handoff_id IS NULL OR handoff_id != ?)')
      .get(handoff.task_id, preparedKey(handoffId), handoffId)
    return {
      associationPresent: String(!!associated), unassociatedReservedKeyPresent: String(!!orphan),
      status: task.status === 'done' || task.status === 'cancelled' ? 'closed' : 'open',
      base: task.revision > handoff.base_revision ? 'behind' : 'current', state: handoff.state,
    }
  })()
}

/** H-PUB's revision facts and state for a handoff, plus the caller axes the command supplies. */
export function observePublish(db: Database, handoffId: string, caller: { right: 'ok' | 'other'; extras: 'none' | 'some' }): Tuple {
  const handoff = db.prepare('SELECT task_id, state FROM team_task_handoffs WHERE id = ?').get(handoffId) as { task_id: string; state: string }
  const associated = db.prepare('SELECT request_key FROM team_task_revisions WHERE task_id = ? AND handoff_id = ?').get(handoff.task_id, handoffId) as { request_key: string | null } | null
  const orphan = !!db.prepare('SELECT 1 FROM team_task_revisions WHERE task_id = ? AND request_key = ? AND (handoff_id IS NULL OR handoff_id != ?)')
    .get(handoff.task_id, preparedKey(handoffId), handoffId)
  const facts = !associated ? (orphan ? 'R1' : 'R0') : associated.request_key === preparedKey(handoffId) ? 'R2' : orphan ? 'R4' : 'R3'
  return { revisionFacts: facts, ...caller, state: handoff.state }
}
