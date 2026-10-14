// Publication (task-revision-publication 2.2, design D2): one immutable
// revision per command key, the key checked before the base, stale bases
// refused with the draft kept, the unique key as the arbiter of a concurrent
// same-key publish, and exactly one task change per new revision.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import type { TeamIdentity } from '../team/teamIdentity'

const team = { teamId: '/repo/.git', groupsRoot: '/repo' } as unknown as TeamIdentity
const human = { kind: 'human' as const, team }

let dir: string
let session: SessionDatabase
let store: TaskStore
let service: TaskService
let changes: number[]

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-publish-'))
  session = initDatabase({ path: path.join(dir, 'tasks.db') })
  store = new TaskStore(session.db, new MailboxStore(session.db))
  service = new TaskService(store, { getSession: () => undefined })
  changes = []
})
afterEach(() => { session.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const create = () => {
  const task = store.create({ teamId: team.teamId, title: 'Export', direction: 'v1', creator: { kind: 'human', sessionId: null } })
  // Count task changes from here on: creation is not a publication.
  store.subscribe(changed => changes.push(changed.revision))
  return task
}
const publish = (taskId: string, extra: Record<string, unknown> = {}) =>
  service.publish(human, taskId, { direction: 'v2', rationale: 'Scope changed', baseRevision: 1, requestKey: 'publish-1', ...extra })
const revisionRows = (taskId: string) => store.revisions(taskId).length

test('a replay of the same key and payload returns the prior revision and writes nothing', async () => {
  const task = create()
  const first = await publish(task.id)
  const again = await publish(task.id)
  expect(first).toMatchObject({ replay: false, revision: { revision: 2, rationale: 'Scope changed', direction: 'v2' } })
  expect(again).toMatchObject({ replay: true, revision: { revision: 2 } })
  expect(revisionRows(task.id)).toBe(2)
  // One task change, at the new revision — never for the replay.
  expect(changes).toEqual([2])
})

test('a replay of a published key whose base is now stale still returns its revision (key before base)', async () => {
  const task = create()
  await publish(task.id)
  await publish(task.id, { direction: 'v3', baseRevision: 2, requestKey: 'publish-2' })
  // The first command's resend: its base (1) is stale now, but its key already published revision 2.
  const replay = await publish(task.id)
  expect(replay).toMatchObject({ replay: true, revision: { revision: 2, direction: 'v2' } })
  expect(revisionRows(task.id)).toBe(3)
  expect(changes).toEqual([2, 3])
})

test('the same key with a different payload is refused naming the field, and writes nothing', async () => {
  const task = create()
  await publish(task.id)
  await expect(publish(task.id, { direction: 'something else' })).rejects.toThrow('Request key already used with a different direction')
  await expect(publish(task.id, { rationale: 'other reason' })).rejects.toThrow('different rationale')
  await expect(publish(task.id, { acceptance: 'other' })).rejects.toThrow('different acceptance')
  expect(revisionRows(task.id)).toBe(2)
  expect(store.get(task.id)?.revision).toBe(2)
  expect(changes).toEqual([2])
})

test('fromDraft is not payload identity: a same-key replay differing only in it replays, not refused', async () => {
  const task = create()
  await service.saveDraft(human, task.id, { direction: 'v2', rationale: 'Scope changed' })
  const first = await publish(task.id, { fromDraft: true })
  const replay = await publish(task.id, { fromDraft: false })
  expect(first).toMatchObject({ replay: false, revision: { revision: 2 } })
  expect(replay).toMatchObject({ replay: true, revision: { revision: 2 } })
  expect(revisionRows(task.id)).toBe(2)
  expect(changes).toEqual([2])
})

test('a stale base is refused naming the newer revision; nothing is published and the draft remains', async () => {
  const task = create()
  await service.saveDraft(human, task.id, { direction: 'draft text', rationale: 'r' })
  // Another publisher moved the task to revision 2 since the draft's base.
  store.publish(task.id, { direction: 'agent v2', notify: false }, { kind: 'agent', sessionId: 'lead' })
  await expect(publish(task.id, { direction: 'draft text', requestKey: 'publish-stale' })).rejects.toThrow('revision 2 was published since revision 1')
  expect(revisionRows(task.id)).toBe(2)
  expect(store.drafts.get(task.id)).toMatchObject({ direction: 'draft text', baseRevision: 1 })
  expect(changes).toEqual([2])
})

test('two publishes from the same base: exactly one succeeds, the other is stale', async () => {
  const task = create()
  const results = await Promise.allSettled([
    publish(task.id, { direction: 'left', requestKey: 'left' }),
    publish(task.id, { direction: 'right', requestKey: 'right' }),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(String((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason)).toContain('Stale')
  expect(revisionRows(task.id)).toBe(2)
})

test('concurrent same-key publishes: the unique key arbitrates, both return the one revision', async () => {
  const task = create()
  const [left, right] = await Promise.all([publish(task.id), publish(task.id)])
  expect(left.revision.revision).toBe(2)
  expect(right.revision.revision).toBe(2)
  expect(revisionRows(task.id)).toBe(2)
  // Force the race inside one publish: its key lookup misses once, so the
  // other request's committed revision makes the base stale — rolled back and
  // resolved as the replay it is.
  const internals = store as unknown as { resolveKey: (...args: unknown[]) => unknown }
  const resolveKey = internals.resolveKey.bind(store)
  let misses = 1
  internals.resolveKey = (...args: unknown[]) => (misses-- > 0 ? null : resolveKey(...args))
  const human0 = { kind: 'human' as const, sessionId: null }
  const raced = store.publish(task.id, { direction: 'v2', rationale: 'Scope changed', baseRevision: 1, requestKey: 'publish-1', notify: false }, human0)
  expect(raced).toMatchObject({ replay: true, revision: { revision: 2 } })
  expect(revisionRows(task.id)).toBe(2)
  expect(changes).toEqual([2])
})

test('the unique key rejects a second same-key insert, which resolves as the replay', () => {
  const task = create()
  // Another request's revision 2 under the key is committed while this one
  // still read revision 1 (simulated: the row exists, the lookup misses).
  session.db.prepare(`INSERT INTO team_task_revisions (task_id, revision, direction, author_kind, created_at, rationale, request_key, notify)
    VALUES (?, 2, 'v2', 'human', 'now', 'Scope changed', 'publish-1', 0)`).run(task.id)
  const internals = store as unknown as { resolveKey: (...args: unknown[]) => unknown }
  const resolveKey = internals.resolveKey.bind(store)
  let misses = 1
  internals.resolveKey = (...args: unknown[]) => (misses-- > 0 ? null : resolveKey(...args))
  const raced = store.publish(task.id, { direction: 'v2', rationale: 'Scope changed', baseRevision: 1, requestKey: 'publish-1', notify: false },
    { kind: 'human', sessionId: null })
  expect(raced).toMatchObject({ replay: true, revision: { revision: 2, direction: 'v2' } })
  // The rolled-back attempt wrote nothing: no second row, no bump, no change.
  expect(revisionRows(task.id)).toBe(2)
  expect(store.get(task.id)?.revision).toBe(1)
  expect(changes).toEqual([])
})

test('a human publication keeps its rationale and author, and drops the draft only when it came from it', async () => {
  const task = create()
  await service.saveDraft(human, task.id, { direction: 'v2', rationale: 'Scope changed' })
  // Another publish path (not from the draft) leaves the draft alone.
  await publish(task.id, { direction: 'v2 elsewhere', requestKey: 'publish-elsewhere' })
  expect(store.drafts.get(task.id)).toMatchObject({ direction: 'v2' })
  await service.rebaseDraft(human, task.id)
  await publish(task.id, { baseRevision: 2, requestKey: 'publish-from-draft', fromDraft: true })
  expect(store.revisions(task.id)).toMatchObject([
    { revision: 1, direction: 'v1', rationale: null },
    { revision: 2, direction: 'v2 elsewhere' },
    { revision: 3, direction: 'v2', rationale: 'Scope changed', author: { kind: 'human', sessionId: null }, notify: false },
  ])
  expect(store.drafts.get(task.id)).toBeNull()
})

test('without a notice store, publish and notify is refused before anything is written, as notify() is', async () => {
  const task = create()
  await expect(publish(task.id, { notify: true })).rejects.toThrow('Revision notices are not available')
  await expect(service.notify(human, task.id, 1, 'notify-1')).rejects.toThrow('Revision notices are not available')
  expect(revisionRows(task.id)).toBe(1)
  expect(changes).toEqual([])
})

test('publication works with no revision-published subscriber; a subscriber hears each new revision once', async () => {
  const task = create()
  await publish(task.id)
  expect(store.get(task.id)?.revision).toBe(2)
  const heard: number[] = []
  service.onRevisionPublished(event => heard.push(event.revision))
  await publish(task.id)
  await publish(task.id, { direction: 'v3', baseRevision: 2, requestKey: 'publish-2' })
  await service.saveDraft(human, task.id, { direction: 'draft' })
  expect(heard).toEqual([3])
})
