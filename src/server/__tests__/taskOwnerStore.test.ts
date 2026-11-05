// The task owner on stored tasks (group-mail-task-affinity D7, task 2.1): an
// agent's task starts owned by its creator, a human or Kawai task has none,
// migration 23 backfills existing agent tasks from their creator and leaves
// human and Kawai tasks ownerless, and a store on a database before the
// migration still creates human tasks.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { MIGRATIONS } from '../dbSafety/migrations'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TASK_AFFINITY_MIGRATION_VERSION } from '../team/taskAffinityMigration'
import { SYSTEM_ACTOR } from '../../shared/team'
import { schemaDb } from './schemaDb'

const TEAM = '/repo/.git'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

// @covers: team-tasks › Tasks have an owner › Owner starts as the creator
test('an agent-created task is owned by its creator', () => {
  const db = schemaDb()
  const tasks = new TaskStore(db, new MailboxStore(db))
  const task = tasks.create({ teamId: TEAM, title: 'T', direction: 'go', creator: { kind: 'agent', sessionId: 'lead-a' } })
  expect(task).toMatchObject({ creator: { kind: 'agent', sessionId: 'lead-a' }, ownerSession: 'lead-a' })
  expect(tasks.get(task.id)!.ownerSession).toBe('lead-a')
  db.close()
})

// @covers: team-tasks › Tasks have an owner › Human task has no owner
test('human and Kawai tasks have no owner', () => {
  const db = schemaDb()
  const tasks = new TaskStore(db, new MailboxStore(db))
  expect(tasks.create({ teamId: TEAM, title: 'H', direction: 'go', creator: { kind: 'human', sessionId: null } }).ownerSession).toBeNull()
  expect(tasks.create({ teamId: TEAM, title: 'K', direction: 'go', creator: SYSTEM_ACTOR }).ownerSession).toBeNull()
  db.close()
})

test('migration 23 backfills agent tasks with their creator and leaves human and Kawai tasks ownerless', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-owner-'))
  dirs.push(dir)
  const file = path.join(dir, 'sessions.db')
  const before = MIGRATIONS.filter(migration => migration.version < TASK_AFFINITY_MIGRATION_VERSION)
  const old = initDatabase({ path: file, migrations: before })
  const oldTasks = new TaskStore(old.db, new MailboxStore(old.db))
  const human = oldTasks.create({ teamId: TEAM, title: 'H', direction: 'go', creator: { kind: 'human', sessionId: null } }).id
  const kawai = oldTasks.create({ teamId: TEAM, title: 'K', direction: 'go', creator: SYSTEM_ACTOR }).id
  // A pre-migration build wrote agent tasks without any owner column.
  old.db.prepare(`INSERT INTO team_tasks (id, team_id, title, status, creator_kind, creator_session, revision, created_at, updated_at)
    VALUES ('task-agent', ?, 'A', 'open', 'agent', 'lead-a', 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`).run(TEAM)
  old.db.prepare(`INSERT INTO team_task_revisions (task_id, revision, direction, acceptance, author_kind, author_session, created_at)
    VALUES ('task-agent', 1, 'go', NULL, 'agent', 'lead-a', '2026-11-01T00:00:00.000Z')`).run()
  old.close()

  const upgraded = initDatabase({ path: file })
  const tasks = new TaskStore(upgraded.db, new MailboxStore(upgraded.db))
  expect(tasks.get('task-agent')!.ownerSession).toBe('lead-a')
  expect(tasks.get(human)!.ownerSession).toBeNull()
  expect(tasks.get(kawai)!.ownerSession).toBeNull()
  upgraded.close()
})
