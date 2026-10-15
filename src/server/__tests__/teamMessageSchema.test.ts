// The guarded `team_messages` rebuild (team-message-threads D4): a legacy
// table with NOT NULL `from_session`/`to_id` is rebuilt once into the shape
// that allows human senders and recipients, a fresh database never rebuilds,
// and every rebuilt row — plus a human row's mapped shape — is asserted, not
// only that rows survived.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { applyBaselineSchema } from '../dbSafety/baseline'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMessageTable, CREATE_TABLE_SQL, type MessageSchemaResult } from '../team/messageSchema'
import { mapRow } from '../team/messageRow'
import { MailboxStore } from '../team/mailboxStore'

/** The shape `team_messages` shipped with before human senders existed. */
const LEGACY_TABLE = `
CREATE TABLE team_messages (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  from_session TEXT NOT NULL,
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
  attach_thread INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX team_messages_queue ON team_messages (team_id, state);
CREATE INDEX team_messages_thread ON team_messages (thread_id);
CREATE INDEX team_messages_recipient ON team_messages (to_id, state);
CREATE INDEX team_messages_claimant ON team_messages (claimed_by, state);
`

const INDEXES = [
  'team_messages_queue', 'team_messages_thread', 'team_messages_recipient',
  'team_messages_claimant', 'team_messages_task', 'team_messages_resume',
]

describe('team_messages schema migration', () => {
  let dir: string
  let db: Database

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-schema-'))
    db = new Database(path.join(dir, 'mail.db'))
  })
  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const indexNames = () => (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'team_messages'"
  ).all() as Array<{ name: string }>).map(row => row.name)
    .filter(name => !name.startsWith('sqlite_')).sort()
  const column = (name: string) => (db.prepare('PRAGMA table_info(team_messages)').all() as Array<{ name: string; notnull: number }>)
    .find(row => row.name === name)!
  const reopen = (): MessageSchemaResult => {
    db.close()
    db = new Database(path.join(dir, 'mail.db'))
    return createMessageTable(db)
  }

  test('a fresh database creates the final shape and never rebuilds', () => {
    expect(createMessageTable(db)).toEqual({ rebuilt: false })
    expect(column('from_session').notnull).toBe(0)
    expect(column('to_id').notnull).toBe(0)
    expect(column('from_kind').notnull).toBe(1)
    expect(column('task_revision').notnull).toBe(0)
    expect(indexNames()).toEqual([...INDEXES].sort())
    // Opening again must not rebuild a table that is already relaxed.
    expect(reopen()).toEqual({ rebuilt: false })
    expect(indexNames()).toEqual([...INDEXES].sort())
  })

  test('a constrained table is rebuilt exactly once, keeping its rows', () => {
    db.exec(LEGACY_TABLE)
    db.exec(`INSERT INTO team_messages
      (id, team_id, to_kind, to_id, from_session, from_group, origin_path, thread_id, body, state, created_at)
      VALUES
      ('legacy-1', '/repo/.git', 'group', 'devs', 'lead', 'leads', '/repo', 'legacy-1', 'Build it', 'delivered', '2026-01-01T00:00:00.000Z'),
      ('legacy-2', '/repo/.git', 'session', 'dev', 'lead', NULL, '/repo', 'legacy-1', 'Reply', 'queued', '2026-01-02T00:00:00.000Z')`)

    expect(createMessageTable(db)).toEqual({ rebuilt: true })
    expect(column('from_session').notnull).toBe(0)
    expect(column('to_id').notnull).toBe(0)
    expect(indexNames()).toEqual([...INDEXES].sort())

    // Every row round-trips through the mapper with an agent sender.
    const rows = (db.prepare('SELECT * FROM team_messages ORDER BY created_at').all() as Record<string, unknown>[])
      .map(mapRow)
    expect(rows.map(row => row.id)).toEqual(['legacy-1', 'legacy-2'])
    expect(rows[0]).toMatchObject({
      id: 'legacy-1', toKind: 'group', toId: 'devs', fromKind: 'agent', fromSession: 'lead',
      fromGroup: 'leads', body: 'Build it', state: 'delivered', taskRevision: null,
    })
    expect(rows[1]).toMatchObject({
      id: 'legacy-2', toKind: 'session', toId: 'dev', fromKind: 'agent', fromSession: 'lead',
      fromGroup: null, body: 'Reply', state: 'queued', taskRevision: null,
    })

    // The second open sees a relaxed table and leaves it alone.
    expect(reopen()).toEqual({ rebuilt: false })
    expect((db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n).toBe(2)
    expect(indexNames()).toEqual([...INDEXES].sort())
  })

  test('a human row maps to nulls and the human kinds, never stringified nulls', () => {
    createMessageTable(db)
    db.exec(`INSERT INTO team_messages
      (id, team_id, to_kind, to_id, from_kind, from_session, from_group, origin_path, thread_id, body, state, created_at)
      VALUES ('human-1', '/repo/.git', 'human', NULL, 'human', NULL, NULL, '/repo', 'human-1', 'From the composer', 'delivered', '2026-01-03T00:00:00.000Z')`)
    const row = mapRow(db.prepare('SELECT * FROM team_messages WHERE id = ?').get('human-1') as Record<string, unknown>)
    expect(row).toMatchObject({
      id: 'human-1', toKind: 'human', toId: null, fromKind: 'human', fromSession: null,
      fromGroup: null, body: 'From the composer', state: 'delivered', taskRevision: null,
    })
    expect(row.toId).toBeNull()
    expect(row.fromSession).toBeNull()
  })

  test('a rebuilt table accepts human rows and the store reads them back', () => {
    db.exec(LEGACY_TABLE)
    db.exec(`INSERT INTO team_messages (id, team_id, to_kind, to_id, from_session, origin_path, thread_id, body, state, created_at)
      VALUES ('legacy', '/repo/.git', 'group', 'devs', 'lead', '/repo', 'legacy', 'hi', 'delivered', '2026-01-01T00:00:00.000Z')`)
    applyBaselineSchema(db)
    const store = new MailboxStore(db)
    expect(store.get('legacy')).toMatchObject({ fromKind: 'agent', fromSession: 'lead', toId: 'devs', taskRevision: null })

    const human = store.enqueue({
      teamId: '/repo/.git', toKind: 'human', toId: null, fromKind: 'human', fromSession: null,
      fromGroup: null, originPath: '/repo', body: 'From the composer',
    })
    expect(human).toMatchObject({ toKind: 'human', toId: null, fromKind: 'human', fromSession: null, taskRevision: null })
    expect(store.get(human.id)).toMatchObject({ toKind: 'human', toId: null, fromKind: 'human', fromSession: null })
  })

  test('the task revision a delivery carried is recorded at push and on send', () => {
    applyBaselineSchema(db)
    const store = new MailboxStore(db)
    const pushed = store.enqueue({
      teamId: '/repo/.git', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null,
      originPath: '/repo', body: 'work', taskId: 'task-1',
    })
    store.claim(pushed.id, 'dev')
    expect(store.markPushed(pushed.id, 'T1', 3)).toBe(true)
    expect(store.get(pushed.id)?.taskRevision).toBe(3)

    const toHuman = store.enqueue({
      teamId: '/repo/.git', toKind: 'human', toId: null, fromSession: 'dev', fromGroup: 'devs',
      originPath: '/repo', body: 'reply', inReplyTo: store.get(pushed.id)!, taskId: 'task-1',
    })
    expect(store.deliverOnSend(toHuman.id, 4)).toBe(true)
    expect(store.get(toHuman.id)).toMatchObject({ state: 'delivered', taskRevision: 4, claimedBy: null, pushedAt: null })
    // A taskless delivery records none.
    const bare = store.enqueue({
      teamId: '/repo/.git', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null,
      originPath: '/repo', body: 'bare',
    })
    store.claim(bare.id, 'dev')
    store.markPushed(bare.id)
    expect(store.get(bare.id)?.taskRevision).toBeNull()
  })

  test('the task index is created after migration, not by the DDL block', () => {
    // A legacy table has no `task_id` yet, so the DDL block must not name it.
    db.exec(LEGACY_TABLE)
    db.exec(CREATE_TABLE_SQL)
    expect(indexNames()).toEqual(INDEXES.filter(name => name !== 'team_messages_task' && name !== 'team_messages_resume').sort())
    createMessageTable(db)
    expect(indexNames()).toEqual([...INDEXES].sort())
  })
})
