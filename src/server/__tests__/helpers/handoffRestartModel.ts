// P4's commands and reference model (owner-publication-handoff design
// "Properties", P4; Table H as the reference). The healthy domain only:
// requests on the current base (and one behind, refused), prepared
// publications, ordinary ones, the linked-draft history through the human's
// own commands (load, the linked publish), the reserved-key collisions —
// plain, draft-shaped without a link, and from a genuinely linked draft —
// settlements, a close, and a restart. The model is independent of the
// source: each handoff's state history (its events), the revisions by key
// kind and association, the durable wakeup rows with their mail, and the
// stored linked draft.
import { loadHandoffDraft } from '../../team/taskHandoffDrafts'
import type { SessionMailbox } from '../../team/sessionMailbox'
import { HANDOFF_WAKEUP_TAG } from '../../team/taskHandoffWakeups'
import type { TeamIdentity } from '../../team/teamIdentity'

export type Kind =
  | 'request' | 'request-behind' | 'rerequest' | 'publish' | 'other' | 'load' | 'linked-publish'
  | 'reserved' | 'reserved-draft' | 'reserved-linked' | 'decline' | 'withdraw' | 'close' | 'restart'
export const KINDS: Kind[] = [
  'request', 'request', 'request-behind', 'rerequest', 'publish', 'publish', 'other', 'load', 'load', 'linked-publish', 'linked-publish',
  'reserved', 'reserved-draft', 'reserved-linked', 'decline', 'withdraw', 'close', 'restart',
]
/** The named boundary each command writes first: a fault there rolls its whole transaction back. The sweep's is the restart. */
export const BOUNDARY: Record<Exclude<Kind, 'restart'>, [string, 'INSERT' | 'UPDATE']> = {
  request: ['team_task_handoffs', 'INSERT'], 'request-behind': ['team_task_handoffs', 'INSERT'], rerequest: ['team_task_handoffs', 'INSERT'],
  publish: ['team_task_revisions', 'INSERT'], other: ['team_task_revisions', 'INSERT'], 'linked-publish': ['team_task_revisions', 'INSERT'],
  load: ['team_task_drafts', 'INSERT'],
  reserved: ['team_task_revisions', 'INSERT'], 'reserved-draft': ['team_task_revisions', 'INSERT'], 'reserved-linked': ['team_task_revisions', 'INSERT'],
  decline: ['team_task_handoffs', 'UPDATE'], withdraw: ['team_task_handoffs', 'UPDATE'], close: ['team_task_status_events', 'INSERT'],
}
/** The sweep's writes: a healthy sweep makes none, so a fault armed on all of them never fires. */
export const SWEEP_WRITES: Array<[string, 'INSERT' | 'UPDATE']> = [
  ['team_task_handoffs', 'UPDATE'], ['team_task_handoff_events', 'INSERT'], ['team_task_handoff_wakeups', 'INSERT'], ['team_messages', 'INSERT'],
]

export interface Model {
  /** Each handoff's states in order (its events' `to_state`), its base and its requester. */
  handoffs: Array<{ history: string[]; base: number; requester: string }>
  revision: number
  closed: boolean
  /** Revisions after the first: the key kind and the associated handoff's index. */
  revisions: Array<{ key: 'prepared' | 'draft' | 'ordinary'; handoff: number | null }>
  /** Wakeup rows in order (`<index>:<transition>`), each with its one mail to the live requester. */
  wakeups: string[]
  /** The stored linked draft: its handoff and base. */
  draft: { handoff: number; base: number } | null
}
export const emptyModel = (): Model => ({ handoffs: [], revision: 1, closed: false, revisions: [], wakeups: [], draft: null })

const stateOf = (model: Model, index: number) => model.handoffs[index]!.history.at(-1)!
const pendingIndex = (model: Model) => model.handoffs.findIndex((_, index) => ['open', 'stale'].includes(stateOf(model, index)))
function move(model: Model, index: number, to: string): void {
  model.handoffs[index]!.history.push(to)
  if (['published', 'declined', 'stale', 'closed'].includes(to)) model.wakeups.push(`${index}:${to}`)
}
/** A revision past an open handoff that does not fulfil it makes it stale (D4). */
function advance(model: Model, key: 'prepared' | 'draft' | 'ordinary', fulfils: number | null): void {
  model.revision++
  model.revisions.push({ key, handoff: fulfils })
  const pending = pendingIndex(model)
  if (pending >= 0 && pending !== fulfils && stateOf(model, pending) === 'open') move(model, pending, 'stale')
}

/** H's reference result for one command in the healthy domain. */
export function apply(model: Model, kind: Kind, requester = 'lead'): void {
  const pending = pendingIndex(model)
  switch (kind) {
    case 'request': case 'rerequest':
      if (model.closed) return
      if (pending >= 0) move(model, pending, 'superseded')
      model.handoffs.push({ history: ['open'], base: model.revision, requester })
      return
    case 'publish':
      if (pending >= 0 && stateOf(model, pending) === 'open') { move(model, pending, 'published'); advance(model, 'prepared', pending) }
      return
    case 'other':
      advance(model, 'ordinary', null)
      return
    case 'load':
      if (pending >= 0 && stateOf(model, pending) === 'open') model.draft = { handoff: pending, base: model.handoffs[pending]!.base }
      return
    case 'linked-publish': {
      const draft = model.draft
      if (!draft || draft.base !== model.revision) return
      model.draft = null
      if (stateOf(model, draft.handoff) === 'open') { move(model, draft.handoff, 'published'); advance(model, 'draft', draft.handoff) } else advance(model, 'draft', null)
      return
    }
    case 'decline': case 'withdraw':
      if (pending >= 0) move(model, pending, kind === 'decline' ? 'declined' : 'withdrawn')
      return
    case 'close':
      if (model.closed) return
      if (pending >= 0) move(model, pending, 'closed')
      model.closed = true
      return
    case 'request-behind': case 'reserved': case 'reserved-draft': case 'reserved-linked': case 'restart':
  }
}

export async function command(runtime: SessionMailbox, team: TeamIdentity, taskId: string, kind: Kind, n: number): Promise<void> {
  const tasks = runtime.tasks
  const human = { kind: 'human' as const, team }
  const pending = tasks.handoffs.store.pendingOf(taskId)
  const revision = tasks.store.get(taskId)!.revision
  const latest = tasks.store.db.prepare('SELECT id FROM team_task_handoffs WHERE task_id = ? ORDER BY rowid DESC').get(taskId) as { id: string } | null
  const target = pending?.id ?? latest?.id ?? 'handoff-none'
  const draft = tasks.store.drafts.get(taskId)
  const request = (session: string, base: number) => tasks.handoffs.request({ kind: 'agent', sessionId: session }, taskId, { baseRevision: base, direction: `Prepared ${n}`, rationale: 'why', notify: false, requestKey: `k${n}` })
  // A real rationale everywhere: only the reserved-prefix check can refuse the collision traces.
  const fromForm = (requestKey: string) => draft ? {
    requireRationale: true, direction: draft.direction, acceptance: draft.acceptance, rationale: draft.rationale ?? 'edited',
    baseRevision: draft.baseRevision, requestKey, notify: false, fromDraft: true, observedDraft: draft.lineageId,
  } : null
  switch (kind) {
    case 'request': await request('lead', revision); return
    case 'request-behind': await request('lead', revision - 1); return
    case 'rerequest': await request('lead2', revision); return
    case 'publish': await tasks.handoffs.publish(human, taskId, target, []); return
    case 'other': await tasks.publish(human, taskId, { direction: `Other ${n}`, rationale: 'mine', notify: false, requestKey: `o${n}` }); return
    case 'load': await loadHandoffDraft(tasks, human, taskId, target, true); return
    case 'linked-publish': { const input = fromForm(`d${n}`); if (input) await tasks.publish(human, taskId, input); return }
    case 'reserved': case 'reserved-draft':
      await tasks.publish(human, taskId, { direction: `Reserved ${n}`, rationale: 'collision', notify: false, requestKey: ` handoff:${target}`, requireRationale: true, ...(kind === 'reserved-draft' ? { fromDraft: true } : {}) })
      return
    case 'reserved-linked': { const input = fromForm(` handoff:${draft?.handoffId ?? target}`); if (input) await tasks.publish(human, taskId, input); return }
    case 'decline': await tasks.handoffs.settle(human, target, 'decline', 'no'); return
    case 'withdraw': await tasks.handoffs.settle({ kind: 'agent', sessionId: pending?.requesterSession ?? 'lead' }, target, 'withdraw', 'not needed'); return
    case 'close': await tasks.setStatus(human, taskId, 'cancelled'); return
    case 'restart':
  }
}

/** The stored facts the model predicts, read from the rows by their own queries. */
export function stored(runtime: SessionMailbox, taskId: string): Model {
  const db = runtime.tasks.store.db
  const rows = db.prepare('SELECT id, base_revision, requester_session FROM team_task_handoffs WHERE task_id = ? ORDER BY rowid').all(taskId) as Array<{ id: string; base_revision: number; requester_session: string }>
  const index = new Map(rows.map((row, at) => [row.id, at]))
  const handoffs = rows.map(row => ({
    history: (db.prepare('SELECT to_state FROM team_task_handoff_events WHERE handoff_id = ? ORDER BY seq').all(row.id) as Array<{ to_state: string }>).map(entry => entry.to_state),
    base: Number(row.base_revision), requester: row.requester_session,
  }))
  const revisions = (db.prepare('SELECT request_key, handoff_id FROM team_task_revisions WHERE task_id = ? AND revision > 1 ORDER BY revision').all(taskId) as Array<{ request_key: string | null; handoff_id: string | null }>)
    .map(row => ({
      key: row.handoff_id !== null && row.request_key === `handoff:${row.handoff_id}` ? 'prepared' as const : row.request_key?.startsWith('d') ? 'draft' as const : 'ordinary' as const,
      handoff: row.handoff_id === null ? null : index.get(row.handoff_id) ?? -1,
    }))
  const wakeups = (db.prepare(`SELECT w.handoff_id, w.transition, m.to_kind, m.to_id, m.tags FROM team_task_handoff_wakeups w
    JOIN team_task_handoffs h ON h.id = w.handoff_id LEFT JOIN team_messages m ON m.id = w.message_id WHERE h.task_id = ? ORDER BY w.rowid`).all(taskId) as Array<Record<string, string | null>>)
    .map(row => {
      const at = index.get(row.handoff_id!)!
      // Each wakeup's one mail goes to the live requester, tagged with its transition.
      const mailed = row.to_kind === 'session' && row.to_id === rows[at]!.requester_session && String(row.tags).includes(`"handoff-${row.transition}"`)
      return `${at}:${row.transition}${mailed ? '' : ' (no mail to the requester)'}`
    })
  const task = runtime.tasks.store.get(taskId)!
  const draft = db.prepare('SELECT handoff_id, base_revision FROM team_task_drafts WHERE task_id = ? AND handoff_id IS NOT NULL').get(taskId) as { handoff_id: string; base_revision: number } | null
  return {
    handoffs, revision: task.revision, closed: task.status === 'cancelled', revisions, wakeups,
    draft: draft === null ? null : { handoff: index.get(draft.handoff_id) ?? -1, base: Number(draft.base_revision) },
  }
}

/** Handoff mail beyond the wakeups' own (a duplicate or an unlinked one); P4 expects none. */
export function strayMail(runtime: SessionMailbox, taskId: string): number {
  const db = runtime.tasks.store.db
  const ids = (db.prepare('SELECT id FROM team_task_handoffs WHERE task_id = ?').all(taskId) as Array<{ id: string }>).map(row => row.id)
  return ids.reduce((count, id) => count + (db.prepare(`SELECT COUNT(*) AS n FROM team_messages WHERE tags LIKE ? AND body LIKE ?
    AND id NOT IN (SELECT message_id FROM team_task_handoff_wakeups WHERE message_id IS NOT NULL)`).get(`%${HANDOFF_WAKEUP_TAG}%`, `%${id}%`) as { n: number }).n, 0)
}
