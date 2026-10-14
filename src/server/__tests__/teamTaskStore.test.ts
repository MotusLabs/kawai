// Durable team tasks (team-tasks D1): migrations for task references on
// mail and chat rows, the task/revision/journal tables, derived
// participants, and persistence across reopening the database.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import type { TaskActor } from '../../shared/teamTasks'

const TEAM = '/repo/.git'
const OTHER = '/other/.git'
const human: TaskActor = { kind: 'human', sessionId: null }
const agent = (sessionId: string): TaskActor => ({ kind: 'agent', sessionId })

const chatRow = (sessionId: string, extra: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId, name: sessionId, projectPath: '/repo', sdkSessionId: null,
  status: 'waiting', createdAt: '2026-10-11T00:00:00.000Z', lastActivityAt: '2026-10-11T00:00:00.000Z', ...extra,
})

describe('TaskStore', () => {
  let dir: string
  let dbPath: string
  let db: SessionDatabase
  let mail: MailboxStore
  let tasks: TaskStore

  const open = () => {
    db = initDatabase({ path: dbPath })
    mail = new MailboxStore(db.db)
    tasks = new TaskStore(db.db, mail)
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-tasks-'))
    dbPath = path.join(dir, 'tasks.db')
    open()
  })
  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const reopen = () => { db.close(); open() }

  const create = (overrides: Partial<Parameters<TaskStore['create']>[0]> = {}) => tasks.create({
    teamId: TEAM, title: 'Add export', direction: 'CSV export of reports', creator: agent('chat-lead'), ...overrides,
  })

  test('create starts at revision 1, status open, with the creator and optional links', () => {
    const task = create({ acceptance: 'Downloads a file', worktree: '/repo-feature', openspecChange: 'add-export' })
    expect(task).toMatchObject({
      teamId: TEAM, title: 'Add export', status: 'open', revision: 1, creator: agent('chat-lead'),
      direction: 'CSV export of reports', acceptance: 'Downloads a file', parentId: null,
      worktree: '/repo-feature', openspecChange: 'add-export',
    })
    expect(task.id.startsWith('task-')).toBe(true)
    expect(tasks.revisions(task.id)).toEqual([
      { revision: 1, direction: 'CSV export of reports', acceptance: 'Downloads a file', author: agent('chat-lead'), createdAt: task.createdAt, rationale: null, notify: null },
    ])
  })

  test('a human creator has no session; missing optional links read as null', () => {
    const task = create({ creator: human })
    expect(task).toMatchObject({ creator: human, acceptance: null, worktree: null, openspecChange: null })
    expect(tasks.list(TEAM)[0]!.participants).toEqual([])
  })

  test('lists are team scoped and detail lists subtasks', () => {
    const parent = create()
    const child = create({ title: 'Export button', parentId: parent.id })
    create({ teamId: OTHER, title: 'Elsewhere' })
    expect(tasks.list(TEAM).map(task => task.title)).toEqual(['Add export', 'Export button'])
    expect(tasks.list(OTHER).map(task => task.title)).toEqual(['Elsewhere'])
    expect(tasks.detail(parent.id)!.subtasks.map(task => task.id)).toEqual([child.id])
    expect(tasks.get(child.id)!.parentId).toBe(parent.id)
    expect(tasks.detail('task-missing')).toBeNull()
  })

  test('participants come from the creator, associated sessions, task mail, and journal authors', () => {
    const task = create()
    db.insertChatSession(chatRow('chat-spawned', { taskId: task.id, spawned: true }))
    const message = mail.enqueue({ teamId: TEAM, toKind: 'group', toId: 'devs', fromSession: 'chat-sender', fromGroup: null, originPath: '/repo', body: 'go', taskId: task.id })
    mail.claim(message.id, 'chat-claimant')
    tasks.appendJournal(task.id, agent('chat-qa'), 'Tested')
    tasks.appendJournal(task.id, human, 'Looks right')
    expect(new Set(tasks.list(TEAM)[0]!.participants)).toEqual(new Set(['chat-lead', 'chat-spawned', 'chat-sender', 'chat-claimant', 'chat-qa']))
    expect(tasks.detail(task.id)!.messages.map(row => row.id)).toEqual([message.id])
  })

  test('amendments create numbered revisions and keep the earlier ones', () => {
    const task = create({ acceptance: 'v1 criteria' })
    tasks.amend(task.id, { direction: 'JSON export too' }, agent('chat-lead'))
    const amended = tasks.amend(task.id, { acceptance: null }, human)!
    expect(amended).toMatchObject({ revision: 3, direction: 'JSON export too', acceptance: null })
    expect(tasks.revisions(task.id).map(({ revision, direction, acceptance, author }) => ({ revision, direction, acceptance, author }))).toEqual([
      { revision: 1, direction: 'CSV export of reports', acceptance: 'v1 criteria', author: agent('chat-lead') },
      { revision: 2, direction: 'JSON export too', acceptance: 'v1 criteria', author: agent('chat-lead') },
      { revision: 3, direction: 'JSON export too', acceptance: null, author: human },
    ])
    expect(tasks.amend('task-missing', { direction: 'x' }, human)).toBeNull()
  })

  test('competing amendments each get their own revision number', async () => {
    const task = create()
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      Promise.resolve().then(() => tasks.amend(task.id, { direction: `take ${index}` }, agent(`chat-${index}`)))))
    const numbers = tasks.revisions(task.id).map(revision => revision.revision)
    expect(numbers).toEqual(Array.from({ length: 11 }, (_, index) => index + 1))
    expect(tasks.get(task.id)!.revision).toBe(11)
  })

  test('a second store on the same file cannot lose a revision', () => {
    const task = create()
    const otherConnection = new Database(dbPath)
    const second = new TaskStore(otherConnection)
    second.amend(task.id, { direction: 'from connection two' }, human)
    tasks.amend(task.id, { direction: 'from connection one' }, human)
    otherConnection.close()
    expect(tasks.revisions(task.id).map(revision => revision.direction)).toEqual([
      'CSV export of reports', 'from connection two', 'from connection one',
    ])
  })

  test('the journal appends author, time, and text in order; limit keeps the latest', () => {
    const task = create()
    for (let index = 1; index <= 7; index += 1) {
      tasks.appendJournal(task.id, agent('chat-dev'), `note ${index}`, `2026-10-11T00:00:0${index}.000Z`)
    }
    expect(tasks.journal(task.id).map(entry => entry.text)).toEqual(['note 1', 'note 2', 'note 3', 'note 4', 'note 5', 'note 6', 'note 7'])
    expect(tasks.journal(task.id, 5).map(entry => entry.text)).toEqual(['note 3', 'note 4', 'note 5', 'note 6', 'note 7'])
    expect(tasks.journal(task.id)[0]).toMatchObject({ author: agent('chat-dev'), createdAt: '2026-10-11T00:00:01.000Z' })
    expect(tasks.appendJournal('task-missing', human, 'lost')).toBeNull()
  })

  test('system journal entries round-trip and never count as participants (member-release D4)', () => {
    const task = create()
    const entry = tasks.appendJournal(task.id, { kind: 'system', sessionId: null }, 'Released Dev (chat-dev-1): task done by human.')
    expect(entry).toMatchObject({ author: { kind: 'system', sessionId: null } })
    reopen()
    expect(tasks.journal(task.id)).toEqual([expect.objectContaining({ id: entry!.id })])
    // A system entry has no session, so it adds no participant id.
    expect(tasks.list(TEAM)[0].participants).toEqual(['chat-lead'])
  })

  test('status updates are recorded; listeners see every committed change', () => {
    const task = create()
    const seen: string[] = []
    tasks.subscribe(changed => seen.push(`${changed.status}@${changed.revision}`))
    tasks.setStatus(task.id, 'active')
    tasks.amend(task.id, { direction: 'more' }, human)
    tasks.appendJournal(task.id, human, 'note')
    tasks.setStatus(task.id, 'done')
    expect(seen).toEqual(['active@1', 'active@2', 'active@2', 'done@2'])
    expect(tasks.setStatus('task-missing', 'done')).toBeNull()
  })

  test('tasks, revisions, and journal persist across reopening and outlive their sessions', () => {
    const task = create({ parentId: null, worktree: '/repo-feature', openspecChange: 'add-export' })
    db.insertChatSession(chatRow('chat-lead', { taskId: task.id }))
    tasks.amend(task.id, { direction: 'v2' }, agent('chat-lead'))
    tasks.appendJournal(task.id, agent('chat-lead'), 'decided')
    tasks.setStatus(task.id, 'blocked')
    db.updateChatSession('chat-lead', { archivedAt: '2026-10-11T01:00:00.000Z' })
    db.deleteChatSession('chat-lead')
    reopen()
    expect(tasks.get(task.id)).toMatchObject({ status: 'blocked', revision: 2, direction: 'v2', creator: agent('chat-lead'), worktree: '/repo-feature', openspecChange: 'add-export' })
    expect(tasks.journal(task.id).map(entry => entry.text)).toEqual(['decided'])
    expect(tasks.list(TEAM)[0]!.participants).toEqual(['chat-lead'])
  })
})

describe('task reference migrations', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-migrate-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('legacy chat sessions and mail gain nullable task references without losing rows', () => {
    const dbPath = path.join(dir, 'legacy.db')
    const legacy = new Database(dbPath)
    legacy.exec(`CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL, sdk_session_id TEXT, profile_id TEXT NOT NULL DEFAULT 'default', status TEXT NOT NULL, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, archived_at TEXT, group_id TEXT);
      INSERT INTO chat_sessions VALUES ('legacy', 'old', '/repo', 'sdk-old', 'default', 'waiting', '2026-01-01', '2026-01-01', NULL, 'devs');
      CREATE TABLE team_messages (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, to_kind TEXT NOT NULL, to_id TEXT NOT NULL, from_session TEXT NOT NULL, from_group TEXT, origin_path TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', tags TEXT NOT NULL DEFAULT '[]', thread_id TEXT NOT NULL, in_reply_to TEXT, hop INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL, state TEXT NOT NULL, claimed_by TEXT, claimed_at TEXT, deliver_at TEXT, created_at TEXT NOT NULL, pushed_at TEXT, delivered_at TEXT, reason TEXT, possible_duplicate INTEGER NOT NULL DEFAULT 0, attach_thread INTEGER NOT NULL DEFAULT 0);
      INSERT INTO team_messages (id, team_id, to_kind, to_id, from_session, origin_path, thread_id, body, state, created_at) VALUES ('m1', '${TEAM}', 'group', 'devs', 'legacy', '/repo', 'm1', 'hi', 'queued', '2026-01-01');`)
    legacy.close()
    const db = initDatabase({ path: dbPath })
    try {
      const mail = new MailboxStore(db.db)
      expect(db.getChatSession('legacy')).toMatchObject({ groupId: 'devs', taskId: null, spawned: false, sdkSessionId: 'sdk-old' })
      expect(mail.get('m1')).toMatchObject({ body: 'hi', state: 'queued', taskId: null })
      const tasks = new TaskStore(db.db, mail)
      const task = tasks.create({ teamId: TEAM, title: 't', direction: 'd', creator: human })
      const sent = mail.enqueue({ teamId: TEAM, toKind: 'group', toId: 'devs', fromSession: 'legacy', fromGroup: 'devs', originPath: '/repo', body: 'task mail', taskId: task.id })
      expect(mail.get(sent.id)!.taskId).toBe(task.id)
      db.updateChatSession('legacy', { taskId: task.id })
      expect(db.getChatSession('legacy')!.taskId).toBe(task.id)
    } finally {
      db.close()
    }
  })

  test('a fresh session row round-trips its task and spawned flag', () => {
    const db = initDatabase({ path: path.join(dir, 'fresh.db') })
    try {
      db.insertChatSession(chatRow('spawned', { taskId: 'task-1', spawned: true }))
      db.insertChatSession(chatRow('manual'))
      expect(db.getChatSession('spawned')).toMatchObject({ taskId: 'task-1', spawned: true })
      expect(db.getChatSession('manual')).toMatchObject({ taskId: null, spawned: false })
    } finally {
      db.close()
    }
  })
})
