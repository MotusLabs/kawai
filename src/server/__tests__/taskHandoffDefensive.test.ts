// Table DF (owner-publication-handoff D7, tasks 4.1 and 7.1): states the
// U-claims call unreachable, seeded directly as an older build or a manual
// edit could leave them. Each fixture is first observed from the database
// and classified by the completeness classifier — excluded, with exactly
// its reason set and no H row — and only then does the command run: the
// startup sweep (DF1–DF5o; precedence association, then closed, then base)
// or the prepared publish (DF6, DF6p). A revision that merely holds
// `handoff:<id>` is never fulfillment. DF2 with an exhausted requester and
// DF5o with an archived one run through the real composition in
// taskHandoffRecovery.integration.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatSessionRecord } from '../db'
import { schemaCopy } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { HANDOFF_WAKEUP_TAG } from '../team/taskHandoffWakeups'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { H_PUB, H_RESTART, classify, observePublish, observeRestart } from './helpers/handoffClassifier'
import { SYSTEM_ACTOR } from '../../shared/team'
import { preparedKey, type HandoffState } from '../../shared/taskHandoffs'

let root: string
let repo: string
let db: Database
let service: TaskService
let team: TeamIdentity
const human = (): TaskCaller => ({ kind: 'human', team })
const row = (sessionId: string, groupId: string | null): ChatSessionRecord => ({
  sessionId, groupId, projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})
const snapshot = () => Object.fromEntries(['team_task_handoffs', 'team_task_handoff_events', 'team_task_handoff_wakeups', 'team_task_revisions', 'team_messages', 'team_tasks']
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
const wakeups = (id: string) => (db.prepare('SELECT transition, message_id FROM team_task_handoff_wakeups WHERE handoff_id = ? ORDER BY rowid').all(id) as Array<{ transition: string; message_id: string | null }>)
const mailOf = (id: string) => db.prepare('SELECT to_kind, to_id, task_id, tags FROM team_messages WHERE tags LIKE ? AND body LIKE ? ORDER BY rowid').all(`%${HANDOFF_WAKEUP_TAG}%`, `%${id}%`) as Array<Record<string, unknown>>

interface Fixture { revisions: number; base: number; associated?: number; orphan?: number; closed?: boolean; state?: HandoffState }
/** Seed a task with `revisions` revisions (no hooks run), a handoff on `base`, and the revision facts. */
function seed(fixture: Fixture) {
  const task = service.store.create({ teamId: team.teamId, title: 'Export CSV', direction: 'CSV', creator: SYSTEM_ACTOR })
  for (let revision = 2; revision <= fixture.revisions; revision++) {
    db.prepare("INSERT INTO team_task_revisions (task_id, revision, direction, author_kind, created_at) VALUES (?, ?, ?, 'human', 'now')").run(task.id, revision, `v${revision}`)
  }
  db.prepare('UPDATE team_tasks SET revision = ?, status = ? WHERE id = ?').run(fixture.revisions, fixture.closed ? 'cancelled' : 'open', task.id)
  const handoff = service.store.atomically(() => service.handoffs.store.insert({
    teamId: team.teamId, taskId: task.id, baseRevision: fixture.base, baseContractHash: null, direction: 'Prepared', acceptance: null, contract: null,
    rationale: 'why', notify: false, baseCommit: null, evidenceRefs: [], requesterSession: 'lead', requesterGroup: 'leads', requestKey: 'k1',
  }, 'seeded'))
  if (fixture.state) db.prepare('UPDATE team_task_handoffs SET state = ? WHERE id = ?').run(fixture.state, handoff.id)
  if (fixture.associated) db.prepare("UPDATE team_task_revisions SET handoff_id = ?, request_key = 'ordinary-edit' WHERE task_id = ? AND revision = ?").run(handoff.id, task.id, fixture.associated)
  if (fixture.orphan) db.prepare('UPDATE team_task_revisions SET request_key = ? WHERE task_id = ? AND revision = ?').run(preparedKey(handoff.id), task.id, fixture.orphan)
  return { task, handoff }
}

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-handoff-defensive-')))
  repo = path.join(root, 'repo')
  const result = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(result.stderr)
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  clearTeamCache()
  db?.close()
  db = schemaCopy()
  const records = new Map([['lead', row('lead', 'leads')]])
  service = new TaskService(new TaskStore(db, new MailboxStore(db)), { getSession: id => records.get(id), homeDir: path.join(root, 'home') })
})

describe('the startup sweep over Table DF', () => {
  test('DF1 {U1}: an associated revision makes the pending handoff published with that revision and its wakeup', () => {
    const { handoff } = seed({ revisions: 2, base: 2, associated: 2 })
    expect(classify(H_RESTART, observeRestart(db, handoff.id))).toEqual({ kind: 'excluded', reasons: ['U1'] })
    expect(service.handoffs.reconcile()).toEqual([handoff.id])
    expect(service.handoffs.store.get(handoff.id)).toMatchObject({ state: 'published', publishedRevision: 2 })
    expect(wakeups(handoff.id).map(wake => wake.transition)).toEqual(['published'])
    expect(mailOf(handoff.id).map(mail => [mail.to_kind, mail.to_id, mail.task_id])).toEqual([['session', 'lead', null]])
  })

  test('DF1 with its published wakeup already written sends nothing more (the wakeup key)', () => {
    const { handoff } = seed({ revisions: 2, base: 2, associated: 2 })
    db.prepare("INSERT INTO team_task_handoff_wakeups (handoff_id, transition, created_at) VALUES (?, 'published', 'seeded')").run(handoff.id)
    service.handoffs.reconcile()
    expect(service.handoffs.store.get(handoff.id)!.state).toBe('published')
    expect(mailOf(handoff.id)).toEqual([])
  })

  test('DF2 {U5}: an open handoff on a closed task closes with one closed wakeup', () => {
    const { handoff } = seed({ revisions: 1, base: 1, closed: true })
    expect(classify(H_RESTART, observeRestart(db, handoff.id))).toEqual({ kind: 'excluded', reasons: ['U5'] })
    service.handoffs.reconcile()
    expect(service.handoffs.store.get(handoff.id)!.state).toBe('closed')
    expect(wakeups(handoff.id).map(wake => wake.transition)).toEqual(['closed'])
  })

  test('DF3 {U3}: an open handoff behind the task turns stale naming the newest revision, with its wakeup', () => {
    const { handoff } = seed({ revisions: 3, base: 1 })
    expect(classify(H_RESTART, observeRestart(db, handoff.id))).toEqual({ kind: 'excluded', reasons: ['U3'] })
    service.handoffs.reconcile()
    expect(service.handoffs.store.get(handoff.id)).toMatchObject({ state: 'stale', stateReason: 'revision 3 was published' })
    expect(service.handoffs.store.events(handoff.id).at(-1)).toMatchObject({ from: 'open', to: 'stale', revision: 3 })
    expect(wakeups(handoff.id).map(wake => wake.transition)).toEqual(['stale'])
  })

  test('DF4a {U6}: an orphan reserved key with a current base is never fulfillment; nothing changes or is sent', () => {
    const { handoff } = seed({ revisions: 2, base: 2, orphan: 2 })
    expect(classify(H_RESTART, observeRestart(db, handoff.id))).toEqual({ kind: 'excluded', reasons: ['U6'] })
    const before = snapshot()
    expect(service.handoffs.reconcile()).toEqual([])
    expect(snapshot()).toEqual(before)
  })

  test('DF4b {U3, U6}: stale only because the task advanced, one wakeup; a second restart reads {U6} and writes nothing', () => {
    const { task, handoff } = seed({ revisions: 2, base: 1, orphan: 2 })
    expect(classify(H_RESTART, observeRestart(db, handoff.id))).toEqual({ kind: 'excluded', reasons: ['U3', 'U6'] })
    service.handoffs.reconcile()
    expect(service.handoffs.store.get(handoff.id)).toMatchObject({ state: 'stale', publishedRevision: null })
    expect(wakeups(handoff.id).map(wake => wake.transition)).toEqual(['stale'])
    expect(classify(H_RESTART, observeRestart(db, handoff.id))).toEqual({ kind: 'excluded', reasons: ['U6'] })
    const before = snapshot()
    expect(service.handoffs.reconcile()).toEqual([])
    expect(snapshot()).toEqual(before)
    expect(db.prepare('SELECT request_key FROM team_task_revisions WHERE task_id = ? AND revision = 2').get(task.id)).toEqual({ request_key: preparedKey(handoff.id) })
  })

  test('DF5 {U1, U3, U5}: the association wins — published once, one published wakeup, no closed or stale', () => {
    const { handoff } = seed({ revisions: 3, base: 1, associated: 2, closed: true })
    expect(classify(H_RESTART, observeRestart(db, handoff.id))).toEqual({ kind: 'excluded', reasons: ['U1', 'U3', 'U5'] })
    service.handoffs.reconcile()
    expect(service.handoffs.store.get(handoff.id)).toMatchObject({ state: 'published', publishedRevision: 2 })
    expect(wakeups(handoff.id).map(wake => wake.transition)).toEqual(['published'])
    expect(service.handoffs.reconcile()).toEqual([])
    expect(mailOf(handoff.id)).toHaveLength(1)
  })

  test('DF5o {U1, U3, U5, U6}: published with the associated revision, never the orphan, which is kept', () => {
    const { task, handoff } = seed({ revisions: 3, base: 1, associated: 2, orphan: 3, closed: true })
    expect(classify(H_RESTART, observeRestart(db, handoff.id))).toEqual({ kind: 'excluded', reasons: ['U1', 'U3', 'U5', 'U6'] })
    service.handoffs.reconcile()
    expect(service.handoffs.store.get(handoff.id)).toMatchObject({ state: 'published', publishedRevision: 2 })
    expect(wakeups(handoff.id).map(wake => wake.transition)).toEqual(['published'])
    expect(mailOf(handoff.id).map(mail => [mail.to_kind, mail.to_id])).toEqual([['session', 'lead']])
    expect(db.prepare('SELECT request_key, handoff_id FROM team_task_revisions WHERE task_id = ? AND revision = 3').get(task.id)).toEqual({ request_key: preparedKey(handoff.id), handoff_id: null })
  })
})

describe('the prepared publish over Table DF', () => {
  test('DF6 {U6}: an orphan reserved-key revision (R1) refuses the publish naming it; the handoff is unchanged', async () => {
    const { task, handoff } = seed({ revisions: 2, base: 2, orphan: 2 })
    expect(classify(H_PUB, observePublish(db, handoff.id, { right: 'ok', extras: 'none' }))).toEqual({ kind: 'excluded', reasons: ['U6'] })
    const before = snapshot()
    await expect(service.handoffs.publish(human(), task.id, handoff.id, [])).rejects.toThrow("Revision 2 holds this handoff's key without its association")
    expect(snapshot()).toEqual(before)
  })

  test('DF6p {U6}: published through its linked revision plus an orphan (R4); the orphan is never returned; nothing written', async () => {
    const { task, handoff } = seed({ revisions: 3, base: 1, associated: 2, orphan: 3, state: 'published' })
    db.prepare('UPDATE team_task_handoffs SET published_revision = 2 WHERE id = ?').run(handoff.id)
    expect(classify(H_PUB, observePublish(db, handoff.id, { right: 'ok', extras: 'none' }))).toEqual({ kind: 'excluded', reasons: ['U6'] })
    const before = snapshot()
    await expect(service.handoffs.publish(human(), task.id, handoff.id, [])).rejects.toThrow("Revision 3 holds this handoff's key without its association")
    expect(snapshot()).toEqual(before)
  })
})
