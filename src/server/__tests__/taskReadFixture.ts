// Raw-row fixtures for the bounded task sections (bounded-task-reads G/H/P):
// messages, results, assignments, revisions, and acknowledgements inserted
// with exact timestamps (ties included) and exact stored bytes, so ground
// truth is the insertion order and the bytes written. Stored text may hold
// NUL, a BOM, or invalid UTF-8, as historical rows can.
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import type { MailboxStore } from '../team/mailboxStore'
import type { TaskStore } from '../team/taskStore'
import { at } from './taskJournalFixture'

export const bytesOf = (...parts: Array<string | number[]>) =>
  Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part)))

/** One task message at `seconds`, its body stored as exactly `body`'s bytes. */
export function rawMessage(db: Database, mail: MailboxStore, teamId: string, taskId: string, seconds: number, body: string | Uint8Array = `m${seconds}`): string {
  const message = mail.enqueue({ teamId, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null, originPath: '/repo', body: 'placeholder', taskId }, at(seconds))
  db.prepare('UPDATE team_messages SET body = CAST(? AS TEXT) WHERE id = ?').run(typeof body === 'string' ? Buffer.from(body, 'utf8') : body, message.id)
  return message.id
}

/** One result at `seconds` through the store (it supersedes the outstanding one); summary and diff stored as exact bytes. */
export function rawResult(store: TaskStore, teamId: string, taskId: string, seconds: number,
  fields: { summary?: string | Uint8Array; diff?: string | Uint8Array | null; commit?: string | null; revision?: number } = {}): string {
  const result = store.results.insert({
    teamId, taskId, summary: 'placeholder', commit: fields.commit === undefined ? `c${seconds}` : fields.commit, diff: null, worktree: null,
    tests: [{ description: 'bun run test', outcome: 'pass' }], limitations: null, taskRevision: fields.revision ?? 1,
    submittedBy: { kind: 'agent', sessionId: 'dev' },
  }, at(seconds))
  const raw = (value: string | Uint8Array) => typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  store.db.prepare('UPDATE team_task_results SET summary = CAST(? AS TEXT) WHERE id = ?').run(raw(fields.summary ?? `summary ${seconds}`), result.id)
  if (fields.diff !== undefined && fields.diff !== null) {
    store.db.prepare('UPDATE team_task_results SET diff_ref = CAST(? AS TEXT) WHERE id = ?').run(raw(fields.diff), result.id)
  }
  return result.id
}

/** One assignment row at `seconds`; with `messageId` its state derives from that mail. */
export function rawAssignment(db: Database, teamId: string, taskId: string, seconds: number,
  fields: { id?: string; messageId?: string | null; supersededBy?: string | null; instruction?: string } = {}): string {
  const id = fields.id ?? `assignment-${crypto.randomUUID()}`
  db.prepare(`INSERT INTO team_task_assignments (id, team_id, task_id, request_key, target_kind, target_id, role, instruction,
    created_by_kind, created_by_session, message_id, superseded_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'group', 'devs', 'devs', ?, 'agent', 'lead', ?, ?, ?, ?)`)
    .run(id, teamId, taskId, `key-${id}`, fields.instruction ?? `instruction ${seconds}`, fields.messageId ?? null, fields.supersededBy ?? null, at(seconds), at(seconds))
  return id
}

/** The outstanding holder: a claimed instruction mail and its assignment, so publications have one recipient. */
export function rawHolder(db: Database, mail: MailboxStore, teamId: string, taskId: string, seconds: number, session = 'dev', instruction?: string): string {
  const message = mail.enqueue({ teamId, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null, originPath: '/repo', body: 'do it', taskId }, at(seconds))
  mail.claim(message.id, session)
  return rawAssignment(db, teamId, taskId, seconds, { messageId: message.id, ...(instruction ? { instruction } : {}) })
}

/** Revisions `from..to` at `seconds + n`, each with `rationale(n)`; the task's current revision becomes `to`. */
export function rawRevisions(db: Database, taskId: string, from: number, to: number, rationale: (n: number) => string | null = n => `why ${n}`, seconds = (n: number) => n) {
  db.transaction(() => {
    for (let n = from; n <= to; n++) {
      db.prepare(`INSERT INTO team_task_revisions (task_id, revision, direction, acceptance, author_kind, author_session, created_at, rationale, notify)
        VALUES (?, ?, ?, NULL, 'agent', 'lead', ?, ?, 0)`).run(taskId, n, `d${n}`, at(seconds(n)), rationale(n))
    }
    db.prepare('UPDATE team_tasks SET revision = ? WHERE id = ?').run(to, taskId)
  })()
}

/** A sha256 over every stored row of the task tables a read touches (P4: reads write nothing). */
export function storedHash(db: Database): string {
  const hash = createHash('sha256')
  for (const table of ['team_tasks', 'team_task_revisions', 'team_task_journal', 'team_messages', 'team_task_results', 'team_task_assignments',
    'team_task_acknowledgements', 'team_task_notifications', 'team_task_coverage_maps', 'team_task_findings']) {
    // Every column as the hex of its stored bytes, so no decode can hide a change.
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(column => `quote(typeof("${column.name}")) || ':' || hex(CAST("${column.name}" AS BLOB))`).join(` || ',' || `)
    for (const row of db.prepare(`SELECT ${columns} AS v FROM ${table} ORDER BY rowid`).all() as Array<{ v: string }>) hash.update(`${table}:${row.v}\n`)
  }
  return hash.digest('hex')
}

/** `text` padded or cut to exactly `bytes` ASCII bytes. */
export const ascii = (text: string, bytes: number) => text.padEnd(bytes, '.').slice(0, bytes)

/**
 * The deterministic umbrella fixture of design.md's G16/G17 (not a live
 * measurement): 1,993 journal entries, 163 subtasks, 114 messages, 8
 * revisions, 5 results, 70 assignments (one current holder), 70
 * acknowledgements, and 7 publications, at clustered timestamps. Current
 * direction, acceptance, instruction, and each subtask title are 128 ASCII
 * bytes; each journal entry, message, rationale, and summary 32 bytes; each
 * diff 307,200 bytes; one short finding and test per result; no maps or
 * checks. Uses only store APIs older than bounded-task-reads, so the same
 * builder measures the pre-change human detail.
 */
export function umbrellaFixture(db: Database, store: TaskStore, mail: MailboxStore, teamId: string): string {
  const creator = { kind: 'agent' as const, sessionId: 'lead' }
  const task = store.create({ teamId, title: 'Umbrella', direction: ascii('direction', 128), acceptance: ascii('acceptance', 128), creator }, at(0)).id
  db.transaction(() => {
    for (let i = 0; i < 1993; i++) {
      db.prepare(`INSERT INTO team_task_journal (id, task_id, author_kind, author_session, text, created_at) VALUES (?, ?, 'agent', 'writer', ?, ?)`)
        .run(`note-${String(i).padStart(5, '0')}`, task, ascii(`entry ${i}`, 32), at(10 + Math.floor(i / 5)))
    }
  })()
  for (let i = 0; i < 163; i++) store.create({ teamId, title: ascii(`child ${i}`, 128), direction: 'd', creator, parentId: task }, at(500 + Math.floor(i / 3)))
  // 113 messages; the holder's instruction mail below is the 114th.
  for (let i = 0; i < 113; i++) rawMessage(db, mail, teamId, task, 700 + Math.floor(i / 4), ascii(`message ${i}`, 32))
  // Revisions 2–8 (seven publications), each rationale 32 bytes; the current one keeps 128-byte text.
  db.transaction(() => {
    for (let n = 2; n <= 8; n++) {
      db.prepare(`INSERT INTO team_task_revisions (task_id, revision, direction, acceptance, author_kind, author_session, created_at, rationale, notify)
        VALUES (?, ?, ?, ?, 'agent', 'lead', ?, ?, 0)`).run(task, n, ascii(`direction ${n}`, 128), ascii(`acceptance ${n}`, 128), at(800 + n), ascii(`why ${n}`, 32))
    }
    db.prepare('UPDATE team_tasks SET revision = 8 WHERE id = ?').run(task)
  })()
  for (let i = 0; i < 5; i++) {
    const id = rawResult(store, teamId, task, 900 + i, { summary: ascii(`summary ${i}`, 32), diff: ascii(`diff ${i} `, 307200), revision: 8 })
    store.results.insertFindings({ teamId, taskId: task, resultId: id, handoffId: null, kind: 'review', verdict: 'pass', findings: 'ok', author: { kind: 'agent', sessionId: 'reviewer' } }, at(950 + i))
  }
  // 69 superseded assignments, then the one current holder (the publications' one recipient).
  for (let i = 0; i < 69; i++) rawAssignment(db, teamId, task, 1000 + Math.floor(i / 2), { id: `assignment-${String(i).padStart(3, '0')}`, supersededBy: 'assignment-holder', instruction: ascii(`instruction ${i}`, 128) })
  const message = mail.enqueue({ teamId, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null, originPath: '/repo', body: ascii('do it', 32), taskId: task }, at(1100))
  mail.claim(message.id, 'dev')
  rawAssignment(db, teamId, task, 1100, { id: 'assignment-holder', messageId: message.id, instruction: ascii('current instruction', 128) })
  // Nine sessions: eight acknowledge revisions 1–8, the ninth 1–6.
  for (let s = 0; s < 9; s++) {
    for (let revision = 1; revision <= (s === 8 ? 6 : 8); revision++) store.acknowledgements.record(task, `session-${s}`, revision, null, at(1200 + s))
  }
  return task
}

/**
 * A detail's JSON with every random id and wall-clock time replaced by its
 * order of first appearance, so two runs of the fixture compare equal.
 */
export function normalizedJson(value: unknown): string {
  const seen = new Map<string, string>()
  const token = (kind: string, raw: string) => {
    if (!seen.has(raw)) seen.set(raw, `<${kind}${seen.size}>`)
    return seen.get(raw)!
  }
  return JSON.stringify(value)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, raw => token('id', raw))
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, raw => (raw.startsWith('2026-10-01') ? raw : token('now', raw)))
}
