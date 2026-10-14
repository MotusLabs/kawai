// The human's task drafts (task-revision-publication 2.1, design D1): a
// draft changes neither the revision nor `updated_at`, writes no mail, never
// reaches agent paths (`task_get`'s detail, `buildTaskContext`), fires no
// task change, survives a reopen, and rebasing moves only its base.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { buildTaskContext } from '../team/taskContext'
import type { TeamIdentity } from '../team/teamIdentity'

const team = { teamId: '/repo/.git', groupsRoot: '/repo' } as unknown as TeamIdentity
const human = { kind: 'human' as const, team }
const DRAFT_TEXT = 'Ship the CSV export behind a flag'

let dir: string
let session: SessionDatabase
let db: Database
let store: TaskStore
let service: TaskService

const open = () => {
  session = initDatabase({ path: path.join(dir, 'tasks.db') })
  db = session.db
  store = new TaskStore(db, new MailboxStore(db))
  service = new TaskService(store, { getSession: () => undefined })
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-drafts-'))
  open()
})
afterEach(() => { session.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const create = () => store.create({ teamId: team.teamId, title: 'Export', direction: 'Build the export', creator: { kind: 'human', sessionId: null } })
const mailCount = () => (db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n

test('a draft saved at revision 1 publishes nothing: no revision, no updated_at, no mail, no task change', async () => {
  const task = create()
  const changes: string[] = []
  const draftEvents: string[] = []
  store.subscribe(changed => changes.push(changed.id))
  store.drafts.subscribe(taskId => draftEvents.push(taskId))
  const draft = await service.saveDraft(human, task.id, { direction: DRAFT_TEXT, rationale: 'Customer asked' })
  expect(draft).toMatchObject({ taskId: task.id, baseRevision: 1, direction: DRAFT_TEXT, acceptance: null, rationale: 'Customer asked' })
  expect(store.get(task.id)).toMatchObject({ revision: 1, direction: 'Build the export', updatedAt: task.updatedAt })
  expect(store.revisions(task.id)).toHaveLength(1)
  expect(mailCount()).toBe(0)
  // Only the human's view refreshes; nothing that reacts to task changes sees it.
  expect(changes).toEqual([])
  expect(draftEvents).toEqual([task.id])
  expect(store.humanDetail(task.id)?.draft).toMatchObject({ direction: DRAFT_TEXT })
})

test('agent paths never carry the draft: the task_get detail and the delivered task context', async () => {
  const task = create()
  await service.saveDraft(human, task.id, { direction: DRAFT_TEXT })
  const detail = store.detail(task.id)!
  expect('draft' in detail).toBe(false)
  expect(JSON.stringify(detail)).not.toContain(DRAFT_TEXT)
  expect(JSON.stringify(buildTaskContext(store, task.id))).not.toContain(DRAFT_TEXT)
  expect(buildTaskContext(store, task.id)?.direction).toBe('Build the export')
})

test('a draft survives a reopen with its base revision and rationale', async () => {
  const task = create()
  await service.saveDraft(human, task.id, { direction: DRAFT_TEXT, acceptance: 'A file downloads', rationale: 'Customer asked' })
  session.close()
  open()
  expect(store.humanDetail(task.id)?.draft).toMatchObject({
    baseRevision: 1, direction: DRAFT_TEXT, acceptance: 'A file downloads', rationale: 'Customer asked',
  })
})

test('rebase moves only the base revision onto the current one, keeping the text', async () => {
  const task = create()
  const saved = await service.saveDraft(human, task.id, { direction: DRAFT_TEXT, rationale: 'Customer asked' })
  // Another revision is published meanwhile; the draft keeps its old base.
  await service.amend(human, task.id, { direction: 'Build the export, PDF too' })
  expect(store.drafts.get(task.id)?.baseRevision).toBe(1)
  const rebased = await service.rebaseDraft(human, task.id)
  expect(rebased).toMatchObject({ baseRevision: 2, direction: saved.direction, rationale: saved.rationale })
})

test('drafts are the human\'s: an agent caller is refused, and a draft needs a published base and a direction', async () => {
  const task = create()
  await expect(service.saveDraft({ kind: 'agent', sessionId: 'dev' }, task.id, { direction: DRAFT_TEXT })).rejects.toThrow("Drafts are the human's")
  await expect(service.saveDraft(human, task.id, { direction: DRAFT_TEXT, baseRevision: 2 })).rejects.toThrow('published revision')
  await expect(service.saveDraft(human, task.id, { direction: '  ' })).rejects.toThrow('needs a direction')
  expect(store.drafts.get(task.id)).toBeNull()
})
