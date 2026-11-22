// Handoff rows (owner-publication-handoff D1, D5, task 2.2): the payload hash
// covers the prepared fields and the notify choice; every transition is
// guarded by `state IN ('open','stale')`, so an ended handoff never changes
// and writes no event (U4); `published_revision` is set only by `published`;
// the association and the prepared-key row are separate reads (D3).
import { beforeEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { schemaCopy } from './schemaDb'
import { handoffPayloadHash, TaskHandoffStore, type NewHandoff } from '../team/taskHandoffStore'
import { HANDOFF_STATES, preparedKey, type HandoffState } from '../../shared/taskHandoffs'

let db: Database
let store: TaskHandoffStore
const actor = { kind: 'human' as const, sessionId: null }
const input = (extra: Partial<NewHandoff> = {}): NewHandoff => ({
  teamId: 't', taskId: 'task-1', baseRevision: 1, baseContractHash: null, direction: 'CSV', acceptance: null, contract: null,
  rationale: 'why', notify: true, baseCommit: null, evidenceRefs: [], requesterSession: 'lead', requesterGroup: 'leads', requestKey: 'k1', ...extra,
})
const revision = (number: number, key: string | null, handoffId: string | null) =>
  db.prepare(`INSERT INTO team_task_revisions (task_id, revision, direction, author_kind, created_at, request_key, handoff_id)
    VALUES ('task-1', ?, 'x', 'human', 'now', ?, ?)`).run(number, key, handoffId)

beforeEach(() => {
  db = schemaCopy()
  store = new TaskHandoffStore(db)
})

test('the payload hash changes with every prepared field and the notify choice, and with nothing else', () => {
  const fields = { direction: 'a', acceptance: 'b', contract: 'c', rationale: 'd', notify: true }
  const base = handoffPayloadHash(fields)
  for (const change of [{ direction: 'x' }, { acceptance: null }, { contract: 'y' }, { rationale: 'z' }, { notify: false }]) {
    expect(handoffPayloadHash({ ...fields, ...change })).not.toBe(base)
  }
  expect(handoffPayloadHash({ ...fields })).toBe(base)
  expect(store.insert(input({ ...fields, requestKey: 'k9' }), 'now').payloadHash).toBe(base)
})

test('every ended state refuses every transition and writes no event (U4)', () => {
  const ended = HANDOFF_STATES.filter(state => state !== 'open' && state !== 'stale')
  for (const [index, from] of ended.entries()) {
    const handoff = store.insert(input({ taskId: `task-${index}`, requestKey: `k${index}` }), 'now')
    db.prepare('UPDATE team_task_handoffs SET state = ? WHERE id = ?').run(from, handoff.id)
    for (const to of HANDOFF_STATES) {
      expect(store.transition(handoff.id, to, { actor, revision: 5 }, 'later')).toBe(false)
    }
    expect(store.get(handoff.id)).toMatchObject({ state: from, publishedRevision: null, updatedAt: 'now' })
    expect(store.events(handoff.id)).toHaveLength(1)
  }
})

test('a pending handoff moves once, with its event; only published records the revision', () => {
  for (const [index, to] of (['stale', 'published', 'declined'] as HandoffState[]).entries()) {
    const handoff = store.insert(input({ taskId: `task-${index}`, requestKey: `k${index}` }), 'now')
    expect(store.transition(handoff.id, to, { actor, revision: 3, reason: 'r' }, 'later')).toBe(true)
    expect(store.get(handoff.id)).toMatchObject({ state: to, stateReason: 'r', publishedRevision: to === 'published' ? 3 : null, updatedAt: 'later' })
    expect(store.events(handoff.id).map(event => [event.from, event.to, event.revision])).toEqual([[null, 'open', null], ['open', to, 3]])
  }
  expect(store.transition('handoff-none', 'published', { actor }, 'later')).toBe(false)
})

test('the association and the prepared-key row are separate facts (R0–R4)', () => {
  const handoff = store.insert(input(), 'now')
  expect([store.associatedRevision('task-1', handoff.id), store.preparedKeyRevision('task-1', handoff.id)]).toEqual([null, null])
  revision(2, preparedKey(handoff.id), null)
  expect([store.associatedRevision('task-1', handoff.id), store.preparedKeyRevision('task-1', handoff.id)]).toEqual([null, { revision: 2, handoffId: null }])
  revision(3, 'ordinary', null)
  store.associate('task-1', 3, handoff.id)
  expect([store.associatedRevision('task-1', handoff.id), store.preparedKeyRevision('task-1', handoff.id)]).toEqual([3, { revision: 2, handoffId: null }])
  expect(store.pendingOf('task-1')!.id).toBe(handoff.id)
  expect(store.pendingForTeam('t').map(row => row.id)).toEqual([handoff.id])
  expect(store.byKey('task-1', 'k1')!.id).toBe(handoff.id)
})
