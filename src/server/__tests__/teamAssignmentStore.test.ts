// Assignment store (task-assignment 1.1–1.3): the additive migration beside
// pre-existing databases, request-key idempotency on both tables, claim
// copies set and cleared from the instruction mail, supersession chains, and
// the read-time state derivation over every MessageState, exposed as the
// outstanding assignment on summaries and the history on details.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { assignmentState, outstandingOf, AssignmentStore, type AssignmentState } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import type { TaskActor } from '../../shared/teamTasks'
import type { MessageState, TeamMessage } from '../../shared/team'

const TEAM = '/repo/.git'
const OTHER = '/other/.git'
const human: TaskActor = { kind: 'human', sessionId: null }

describe('Assignment migrations', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-assignment-migrate-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('a pre-existing keyless task database gains request_key and assignments untouched', () => {
    const dbPath = path.join(dir, 'legacy.db')
    // A database as the pre-change release left it: tasks without request_key.
    const legacy = new Database(dbPath)
    legacy.exec(`CREATE TABLE team_tasks (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      creator_kind TEXT NOT NULL, creator_session TEXT, parent_id TEXT, worktree TEXT, openspec_change TEXT,
      revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO team_tasks VALUES ('task-old', '${TEAM}', 'Legacy', 'active', 'agent', 'lead', NULL, NULL, NULL, 2, '2026-01-01', '2026-01-02');
      CREATE TABLE team_task_revisions (task_id TEXT NOT NULL, revision INTEGER NOT NULL, direction TEXT NOT NULL,
      acceptance TEXT, author_kind TEXT NOT NULL, author_session TEXT, created_at TEXT NOT NULL, PRIMARY KEY (task_id, revision));
      INSERT INTO team_task_revisions VALUES ('task-old', 1, 'First', NULL, 'agent', 'lead', '2026-01-01');
      INSERT INTO team_task_revisions VALUES ('task-old', 2, 'Second', NULL, 'agent', 'lead', '2026-01-02');
      CREATE TABLE team_task_journal (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author_kind TEXT NOT NULL,
      author_session TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL);`)
    legacy.close()
    const db = initDatabase({ path: dbPath })
    try {
      const mail = new MailboxStore(db.db)
      const assignments = new AssignmentStore(db.db, mail)
      const tasks = new TaskStore(db.db, mail, assignments)
      expect(tasks.get('task-old')).toMatchObject({ id: 'task-old', revision: 2, direction: 'Second' })
      expect(tasks.byRequestKey(TEAM, 'any-key')).toBeNull()
      expect(tasks.list(TEAM)[0]!.assignment).toBeNull()
      expect(tasks.detail('task-old')!.assignments).toEqual([])
      // Keyless tasks read normally and a keyed create beside them works.
      const fresh = tasks.create({ teamId: TEAM, title: 'New', direction: 'go', creator: human, requestKey: 'key-1' })
      expect(tasks.byRequestKey(TEAM, 'key-1')!.id).toBe(fresh.id)
    } finally {
      db.close()
    }
  })
})

describe('AssignmentStore', () => {
  let dir: string
  let dbPath: string
  let db: SessionDatabase
  let mail: MailboxStore
  let assignments: AssignmentStore
  let tasks: TaskStore

  const open = () => {
    db = initDatabase({ path: dbPath })
    mail = new MailboxStore(db.db)
    assignments = new AssignmentStore(db.db, mail)
    tasks = new TaskStore(db.db, mail, assignments)
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-assignments-'))
    dbPath = path.join(dir, 'assignments.db')
    open()
  })
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const reopen = () => { db.close(); open() }

  const createTask = (overrides: Partial<Parameters<TaskStore['create']>[0]> = {}) => tasks.create({
    teamId: TEAM, title: 'Add export', direction: 'CSV', creator: human, ...overrides,
  })

  /** A dispatched assignment with its instruction mail, as the service commits it. */
  const dispatch = (task: { id: string; teamId?: string }, overrides: Partial<Parameters<AssignmentStore['insert']>[0]> = {}) => {
    const teamId = overrides.teamId ?? task.teamId ?? TEAM
    const key = overrides.requestKey ?? `key-${crypto.randomUUID()}`
    const inserted = assignments.insert({
      teamId, taskId: task.id, requestKey: key, targetKind: 'group', targetId: 'devs',
      role: 'devs', instruction: 'Please build it', creator: human, ...overrides,
    })
    const message = mail.enqueue({
      teamId, toKind: inserted.assignment.targetKind, toId: inserted.assignment.targetId,
      fromKind: 'human', fromSession: null, fromGroup: null, originPath: '/repo',
      priority: 'normal', body: inserted.assignment.instruction, taskId: task.id, actor: 'human',
    })
    assignments.setMessage(inserted.assignment.id, message.id)
    return { assignment: assignments.byKey(teamId, key)!, message }
  }

  test('first insert stores the dispatch; a same-payload replay returns the prior row', () => {
    const task = createTask()
    const first = dispatch(task, { requestKey: 'intent-1' })
    expect(first.assignment).toMatchObject({
      taskId: task.id, requestKey: 'intent-1', targetKind: 'group', targetId: 'devs', role: 'devs',
      instruction: 'Please build it', createdBy: human, state: 'queued', claimedBy: null, supersededBy: null,
    })
    const replay = assignments.insert({
      teamId: TEAM, taskId: task.id, requestKey: 'intent-1', targetKind: 'group', targetId: 'devs',
      role: 'devs', instruction: 'Please build it', creator: human,
    })
    expect(replay.replay).toBe(true)
    expect(replay.assignment.id).toBe(first.assignment.id)
    expect(assignments.listByTask(task.id)).toHaveLength(1)
  })

  test('the same key with a different payload is refused naming the field; the original stands', () => {
    const task = createTask()
    dispatch(task, { requestKey: 'intent-1' })
    expect(() => assignments.insert({
      teamId: TEAM, taskId: task.id, requestKey: 'intent-1', targetKind: 'group', targetId: 'devs',
      role: 'devs', instruction: 'A different instruction', creator: human,
    })).toThrow('different instruction')
    expect(() => assignments.insert({
      teamId: TEAM, taskId: task.id, requestKey: 'intent-1', targetKind: 'session', targetId: 'chat-dev',
      role: null, instruction: 'Please build it', creator: human,
    })).toThrow('different target')
    expect(assignments.listByTask(task.id)).toHaveLength(1)
  })

  test('claim copies follow the mail: set on claim, cleared by requeue and release', () => {
    const task = createTask()
    const { assignment, message } = dispatch(task)
    mail.claim(message.id, 'chat-dev', '2026-10-13T10:00:00.000Z')
    expect(assignments.byKey(TEAM, assignment.requestKey)).toMatchObject({ claimedBy: 'chat-dev', claimedAt: '2026-10-13T10:00:00.000Z', state: 'claimed' })
    mail.requeue(message.id)
    expect(assignments.byKey(TEAM, assignment.requestKey)).toMatchObject({ claimedBy: null, claimedAt: null, state: 'queued' })
    mail.claim(message.id, 'chat-dev')
    mail.markPushed(message.id)
    mail.markDelivered(message.id)
    expect(assignments.byKey(TEAM, assignment.requestKey)).toMatchObject({ claimedBy: 'chat-dev', state: 'delivered' })
    mail.release(message.id, 'devs')
    expect(assignments.byKey(TEAM, assignment.requestKey)).toMatchObject({ claimedBy: null, state: 'queued' })
  })

  test('supersession chains keep history; the outstanding assignment is the newest standing row', () => {
    const task = createTask()
    const first = dispatch(task, { requestKey: 'a1' })
    const second = dispatch(task, { requestKey: 'a2' })
    assignments.supersede(first.assignment.id, second.assignment.id)
    const rows = assignments.listByTask(task.id)
    expect(rows.map(row => row.id)).toEqual([first.assignment.id, second.assignment.id])
    expect(rows[0]).toMatchObject({ state: 'superseded', supersededBy: second.assignment.id })
    expect(outstandingOf(rows)!.id).toBe(second.assignment.id)
    // The summary carries the outstanding one; the detail carries the history.
    expect(tasks.list(TEAM)[0]!.assignment!.id).toBe(second.assignment.id)
    expect(tasks.detail(task.id)!.assignments.map(row => row.id)).toEqual(rows.map(row => row.id))
  })

  test('a failed assignment is no longer outstanding, so the task can be reassigned', () => {
    const task = createTask()
    const { assignment, message } = dispatch(task)
    mail.deadLetter(message.id, 'worktree-missing: /gone')
    const rows = assignments.listByTask(task.id)
    expect(rows[0]).toMatchObject({ state: 'failed', reason: 'worktree-missing: /gone' })
    expect(outstandingOf(rows)).toBeNull()
    expect(tasks.list(TEAM)[0]!.assignment).toBeNull()
  })

  test('assignments persist across reopen with their claims and derived states', () => {
    const task = createTask()
    const { assignment, message } = dispatch(task)
    mail.claim(message.id, 'chat-dev')
    mail.markPushed(message.id)
    mail.markDelivered(message.id)
    reopen()
    const restored = assignments.byKey(TEAM, assignment.requestKey)!
    expect(restored).toMatchObject({ claimedBy: 'chat-dev', state: 'delivered', instruction: 'Please build it' })
    expect(tasks.list(TEAM)[0]!.assignment!.id).toBe(restored.id)
  })

  test('an unassigned task shows no assignment; another team is isolated by key', () => {
    const task = createTask()
    expect(tasks.list(TEAM)[0]!.assignment).toBeNull()
    dispatch(task, { requestKey: 'shared' })
    const other = createTask({ teamId: OTHER, title: 'Elsewhere' })
    dispatch(other, { requestKey: 'shared', teamId: OTHER })
    expect(assignments.listByTask(task.id)).toHaveLength(1)
    expect(assignments.listByTask(other.id)).toHaveLength(1)
  })
})

describe('assignmentState', () => {
  const row = (supersededBy: string | null = null) => ({ supersededBy })
  const message = (state: MessageState, reason: string | null = null): TeamMessage =>
    ({ state, reason, claimedBy: null, claimedAt: null, toKind: 'group', toId: 'devs', fromKind: 'human', fromSession: null }) as unknown as TeamMessage

  test('maps every MessageState', () => {
    const cases: Array<[MessageState, AssignmentState]> = [
      ['queued', 'queued'],
      ['spawning', 'queued'],
      ['awaiting-request', 'queued'],
      ['claimed', 'claimed'],
      ['delivered', 'delivered'],
      ['parked', 'parked'],
      ['forwarded', 'forwarded'],
      ['uncertain', 'uncertain'],
    ]
    for (const [mailState, expected] of cases) {
      expect(assignmentState(row(), message(mailState)).state).toBe(expected)
    }
    expect(assignmentState(row(), message('dead', 'hop-limit'))).toEqual({ state: 'failed', reason: 'hop-limit' })
    expect(assignmentState(row(), message('cancelled'))).toMatchObject({ state: 'failed' })
    expect(assignmentState(row(), message('discarded'))).toMatchObject({ state: 'failed' })
    // Supersession wins regardless of the mail.
    expect(assignmentState(row('assignment-next'), message('delivered')).state).toBe('superseded')
    // A committed dispatch always has its mail (D3); a missing one never looks busy.
    expect(assignmentState(row(), null)).toEqual({ state: 'failed', reason: 'instruction-missing' })
  })
})

describe('task request keys', () => {
  let dir: string
  let db: SessionDatabase
  let mail: MailboxStore
  let tasks: TaskStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-keys-'))
    db = initDatabase({ path: path.join(dir, 'tasks.db') })
    mail = new MailboxStore(db.db)
    tasks = new TaskStore(db.db, mail, new AssignmentStore(db.db, mail))
  })
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  test('a same-payload replay returns the prior task; a different payload is refused naming the field', () => {
    const first = tasks.create({ teamId: TEAM, title: 'Export', direction: 'CSV', creator: human, requestKey: 'k1', worktree: '/w', parentId: null, openspecChange: null })
    // Post-create mutations are never payload differences.
    tasks.setStatus(first.id, 'active')
    tasks.amend(first.id, { direction: 'v2' }, human)
    const replay = tasks.create({ teamId: TEAM, title: 'Export', direction: 'CSV', creator: human, requestKey: 'k1', worktree: '/w', parentId: null, openspecChange: null })
    expect(replay.id).toBe(first.id)
    expect(replay.revision).toBe(2)
    expect(() => tasks.create({ teamId: TEAM, title: 'Other', direction: 'CSV', creator: human, requestKey: 'k1' })).toThrow('different title')
    expect(() => tasks.create({ teamId: TEAM, title: 'Export', direction: 'Other', creator: human, requestKey: 'k1' })).toThrow('different direction')
    expect(tasks.list(TEAM)).toHaveLength(1)
  })
})
