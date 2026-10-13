// Task participants are derived, never stored (team-tasks design D2), and one
// of the sources is the sender of task mail. A human sender has no session, so
// its row carries a null `from_session` — that must never become a participant
// id. The column is still NOT NULL before the team-messages rebuild, so this
// test opens the nullable shape that migration produces and asserts the
// derivation against that.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import type { TaskActor } from '../../shared/teamTasks'

const TEAM = '/repo/.git'
const human: TaskActor = { kind: 'human', sessionId: null }
const agent = (sessionId: string): TaskActor => ({ kind: 'agent', sessionId })

/** `team_messages` as the rebuild leaves it: nullable sender and recipient. */
function createNullableSenderTable(db: SessionDatabase): void {
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS team_messages (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      to_kind TEXT NOT NULL,
      to_id TEXT,
      from_session TEXT,
      from_group TEXT,
      origin_path TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      tags TEXT NOT NULL DEFAULT '[]',
      thread_id TEXT NOT NULL,
      in_reply_to TEXT,
      hop INTEGER NOT NULL DEFAULT 1,
      body TEXT NOT NULL,
      state TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at TEXT,
      deliver_at TEXT,
      created_at TEXT NOT NULL,
      pushed_at TEXT,
      delivered_at TEXT,
      reason TEXT,
      possible_duplicate INTEGER NOT NULL DEFAULT 0,
      attach_thread INTEGER NOT NULL DEFAULT 0,
      task_id TEXT,
      claim_commit TEXT,
      parked_until TEXT,
      park_count INTEGER NOT NULL DEFAULT 0,
      resume_message_id TEXT,
      handoff TEXT,
      excluded_profile TEXT
    );
  `)
}

describe('task participants with a human sender', () => {
  let dir: string
  let db: SessionDatabase
  let mail: MailboxStore
  let tasks: TaskStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-participants-'))
    db = initDatabase({ path: path.join(dir, 'mail.db') })
    createNullableSenderTable(db)
    mail = new MailboxStore(db.db)
    tasks = new TaskStore(db.db, mail)
  })
  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A task-linked row from a human: the composer's send, no session. */
  function humanSentRow(taskId: string, id: string): void {
    db.db.prepare(`INSERT INTO team_messages
      (id, team_id, to_kind, to_id, from_session, from_group, origin_path, priority, tags,
       thread_id, hop, body, state, created_at, task_id)
      VALUES ($id, $team, 'group', 'devs', NULL, NULL, '/repo', 'normal', '[]',
       $id, 1, 'please take this', 'queued', '2026-10-13T00:00:00.000Z', $taskId)`)
      .run({ $id: id, $team: TEAM, $taskId: taskId })
  }

  test('a human sender never becomes a participant id', () => {
    const task = tasks.create({
      teamId: TEAM, title: 'Add export', direction: 'CSV export of reports', creator: human,
    })
    humanSentRow(task.id, 'human-message')
    mail.claim('human-message', 'chat-claimant')
    tasks.appendJournal(task.id, human, 'Handing this over')
    tasks.appendJournal(task.id, agent('chat-qa'), 'On it')

    const participants = tasks.list(TEAM)[0]!.participants
    expect(new Set(participants)).toEqual(new Set(['chat-claimant', 'chat-qa']))
    // The null sender is dropped, not stringified into an id.
    expect(participants).not.toContain('null')
    expect(participants.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
  })

  test('a human creator with only human mail lists no participants', () => {
    const task = tasks.create({
      teamId: TEAM, title: 'Quiet task', direction: 'Nothing yet', creator: human,
    })
    humanSentRow(task.id, 'human-only')
    expect(tasks.list(TEAM)[0]!.participants).toEqual([])
  })
})
