// Restart reconciliation (owner-publication-handoff D7, task 7.1): Table
// H-RESTART's healthy tuples and paired witnesses, each classified from the
// database before a real restart through `SessionMailbox.start()`, and the
// model-based property P4 — seeded command sequences in the healthy domain
// with a crash at one transaction boundary (a fault inside the transaction,
// or a throw right after its commit, before any post-commit work), then the
// database reopened from its file and the production mailbox started; every
// stored state equals the reference model's and P1's counts hold. The
// sequences include ordinary publications, plain and from a draft, under the
// handoff's derived key (the collision traces): refused, and after restart
// an open handoff with a current base is still open. CP3 through the full
// chat-session composition is taskHandoffRecovery.integration.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatAgentDriver } from '../chat/provider/driver'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { cleanGitEnv } from '../git/gitCommand'
import { NULL_OWNERSHIP } from '../plans/execution/executionOwnership'
import { SessionMailbox } from '../team/sessionMailbox'
import { SessionTeams } from '../team/sessionTeams'
import { resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { H_RESTART, classify, observeRestart } from './helpers/handoffClassifier'
import { propertyCases } from './helpers/propertyCases'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { SYSTEM_ACTOR } from '../../shared/team'

let root: string
let repo: string
let template: string
let team: TeamIdentity
let sequence = 0
const records = new Map<string, ChatSessionRecord>()
const row = (sessionId: string, groupId: string): ChatSessionRecord => ({
  sessionId, groupId, projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})

/** One process lifetime: the database file opened, the production mailbox over it; `start` boots it as ChatSessionManager does. */
async function open(file: string, start = true): Promise<{ sdb: SessionDatabase; runtime: SessionMailbox; close: () => void }> {
  const sdb = initDatabase({ path: file })
  const teams = new SessionTeams({ homeDir: path.join(root, 'home') })
  for (const id of records.keys()) await teams.track(id, repo)
  const runtime = new SessionMailbox(sdb.db, {
    ownership: NULL_OWNERSHIP, onTaskResultWrite: () => {},
    teams, records: () => records.values(), getRecord: id => records.get(id), available: record => !record.archivedAt,
    getDriver: () => ({ getPendingRequests: () => [], deliver: () => {} }) as unknown as ChatAgentDriver,
    prepare: async () => {}, restore: () => {}, watchReceipt: () => {}, archive: () => ({ ok: true }), hasLiveWorkers: () => false,
    hasRunningBackgroundTasks: () => false, transcriptFor: () => null, homeDir: path.join(root, 'home'), onError: () => {},
  })
  if (start) runtime.start()
  return { sdb, runtime, close: () => { runtime.close(); sdb.close() } }
}
const freshFile = () => {
  const file = path.join(root, `db-${++sequence}.db`)
  fs.copyFileSync(template, file)
  return file
}

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-handoff-restart-')))
  repo = path.join(root, 'repo')
  const result = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(result.stderr)
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  team = await resolveTeam(repo)
  records.set('lead', row('lead', 'leads'))
  records.set('lead2', row('lead2', 'leads'))
  template = path.join(root, 'template.db')
  initDatabase({ path: template }).close()
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('H-RESTART through SessionMailbox.start()', () => {
  // @covers: task-publication-handoffs › Handoffs survive restart and reconcile once › A restart changes nothing settled
  test('H29: open with a current base and stale (behind, and the tolerated current) are unchanged with no mail; witnesses (1) and (2) classified first', async () => {
    const file = freshFile()
    const first = await open(file, false)
    const tasks = first.runtime.tasks
    const seed = async (title: string) => {
      const task = tasks.store.create({ teamId: team.teamId, title, direction: 'v1', creator: SYSTEM_ACTOR })
      const { handoff } = await tasks.handoffs.request({ kind: 'agent', sessionId: 'lead' }, task.id, { baseRevision: 1, direction: 'Prepared', rationale: 'why', notify: false, requestKey: 'k1' })
      return { task, handoff }
    }
    const witness1 = await seed('witness 1')
    const witness2 = await seed('witness 2')
    first.sdb.db.prepare('INSERT INTO team_task_revisions (task_id, revision, direction, author_kind, created_at, request_key) VALUES (?, 2, ?, \'human\', \'now\', ?)')
      .run(witness2.task.id, 'orphan', `handoff:${witness2.handoff.id}`)
    first.sdb.db.prepare('UPDATE team_task_handoffs SET base_revision = 2 WHERE id = ?').run(witness2.handoff.id)
    first.sdb.db.prepare('UPDATE team_tasks SET revision = 2 WHERE id = ?').run(witness2.task.id)
    const behind = await seed('stale behind')
    await tasks.publish({ kind: 'human', team }, behind.task.id, { direction: 'Mine', rationale: 'r', notify: false })
    const tolerated = await seed('stale current')
    first.sdb.db.prepare("UPDATE team_task_handoffs SET state = 'stale' WHERE id = ?").run(tolerated.handoff.id)
    const ids = [witness1, witness2, behind, tolerated].map(entry => entry.handoff.id)
    const classes = ids.map(id => classify(H_RESTART, observeRestart(first.sdb.db, id)))
    expect(classes).toEqual([
      { kind: 'healthy', row: 'H29' }, { kind: 'excluded', reasons: ['U6'] }, { kind: 'healthy', row: 'H29' }, { kind: 'healthy', row: 'H29', tolerated: true },
    ])
    const dump = (db: SessionDatabase['db']) => ['team_task_handoffs', 'team_task_handoff_events', 'team_task_handoff_wakeups', 'team_task_revisions', 'team_messages']
      .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    const before = dump(first.sdb.db)
    first.close()
    const second = await open(file)
    try {
      expect(dump(second.sdb.db)).toEqual(before)
    } finally {
      second.close()
    }
  })
})

type Kind = 'request' | 'request-behind' | 'rerequest' | 'publish' | 'other' | 'reserved' | 'reserved-draft' | 'decline' | 'withdraw' | 'close'
const KINDS: Kind[] = ['request', 'request', 'request-behind', 'rerequest', 'publish', 'publish', 'other', 'reserved', 'reserved-draft', 'decline', 'withdraw', 'close']
/** The table each command writes first: a fault there rolls the whole transaction back. */
const BOUNDARY: Record<Kind, [string, 'INSERT' | 'UPDATE']> = {
  request: ['team_task_handoffs', 'INSERT'], 'request-behind': ['team_task_handoffs', 'INSERT'], rerequest: ['team_task_handoffs', 'INSERT'],
  publish: ['team_task_revisions', 'INSERT'], other: ['team_task_revisions', 'INSERT'], reserved: ['team_task_revisions', 'INSERT'], 'reserved-draft': ['team_task_revisions', 'INSERT'],
  decline: ['team_task_handoffs', 'UPDATE'], withdraw: ['team_task_handoffs', 'UPDATE'], close: ['team_task_status_events', 'INSERT'],
}

interface Model { states: string[]; revision: number; closed: boolean }
const pendingIndex = (model: Model) => model.states.findIndex(state => state === 'open' || state === 'stale')

/** H's reference result for one command in the healthy domain. */
function apply(model: Model, kind: Kind): void {
  const pending = pendingIndex(model)
  switch (kind) {
    case 'request': case 'rerequest':
      if (model.closed) return
      if (pending >= 0) model.states[pending] = 'superseded'
      model.states.push('open')
      return
    case 'request-behind': return
    case 'publish':
      if (pending >= 0 && model.states[pending] === 'open') { model.states[pending] = 'published'; model.revision++ }
      return
    case 'other':
      if (model.closed) return
      model.revision++
      if (pending >= 0 && model.states[pending] === 'open') model.states[pending] = 'stale'
      return
    case 'reserved': case 'reserved-draft': return
    case 'decline': case 'withdraw':
      if (pending >= 0) model.states[pending] = kind === 'decline' ? 'declined' : 'withdrawn'
      return
    case 'close':
      if (model.closed) return
      if (pending >= 0) model.states[pending] = 'closed'
      model.closed = true
  }
}

class CrashAfterCommit extends Error {}

async function command(runtime: SessionMailbox, taskId: string, kind: Kind, n: number): Promise<void> {
  const tasks = runtime.tasks
  const human = { kind: 'human' as const, team }
  const pending = tasks.handoffs.store.pendingOf(taskId)
  const revision = tasks.store.get(taskId)!.revision
  const latest = tasks.store.db.prepare('SELECT id FROM team_task_handoffs WHERE task_id = ? ORDER BY rowid DESC').get(taskId) as { id: string } | null
  const target = pending?.id ?? latest?.id ?? 'handoff-none'
  const request = (session: string, base: number) => tasks.handoffs.request({ kind: 'agent', sessionId: session }, taskId, { baseRevision: base, direction: `Prepared ${n}`, rationale: 'why', notify: false, requestKey: `k${n}` })
  switch (kind) {
    case 'request': await request('lead', revision); return
    case 'request-behind': await request('lead', revision - 1); return
    case 'rerequest': await request('lead2', revision); return
    case 'publish': await tasks.handoffs.publish(human, taskId, target, []); return
    case 'other': await tasks.publish(human, taskId, { direction: `Other ${n}`, rationale: 'mine', notify: false, requestKey: `o${n}` }); return
    case 'reserved': case 'reserved-draft':
      // A real rationale: only the reserved-prefix check can refuse the collision trace.
      await tasks.publish(human, taskId, { direction: `Reserved ${n}`, rationale: 'collision', notify: false, requestKey: ` handoff:${target}`, requireRationale: true, ...(kind === 'reserved-draft' ? { fromDraft: true } : {}) })
      return
    case 'decline': await tasks.handoffs.settle(human, target, 'decline', 'no'); return
    case 'withdraw': await tasks.handoffs.settle({ kind: 'agent', sessionId: 'lead' }, target, 'withdraw', 'not needed'); return
    case 'close': await tasks.setStatus(human, taskId, 'cancelled')
  }
}

function stored(runtime: SessionMailbox, taskId: string): Model {
  const db = runtime.tasks.store.db
  const states = (db.prepare('SELECT state FROM team_task_handoffs WHERE task_id = ? ORDER BY rowid').all(taskId) as Array<{ state: string }>).map(entry => entry.state)
  const task = runtime.tasks.store.get(taskId)!
  return { states, revision: task.revision, closed: task.status === 'cancelled' }
}

function counts(runtime: SessionMailbox, taskId: string): string[] {
  const db = runtime.tasks.store.db
  const problems: string[] = []
  for (const { id, state } of db.prepare('SELECT id, state FROM team_task_handoffs WHERE task_id = ?').all(taskId) as Array<{ id: string; state: string }>) {
    const associated = (db.prepare('SELECT COUNT(*) AS n FROM team_task_revisions WHERE handoff_id = ?').get(id) as { n: number }).n
    if (associated > 1 || (state === 'published') !== (associated === 1)) problems.push(`${id} ${state} associated ${associated}`)
    const mail = db.prepare('SELECT tags, COUNT(*) AS n FROM team_messages WHERE body LIKE ? GROUP BY tags HAVING n > 1').all(`%${id}%`)
    if (mail.length) problems.push(`${id} duplicate wakeups ${JSON.stringify(mail)}`)
  }
  const strays = db.prepare("SELECT revision FROM team_task_revisions WHERE task_id = ? AND request_key LIKE 'handoff:%' AND (handoff_id IS NULL OR request_key != 'handoff:' || handoff_id)").all(taskId)
  if (strays.length) problems.push(`stray reserved keys ${JSON.stringify(strays)}`)
  return problems
}

describe('P4: crash recovery', () => {
  const CASES = 200
  test('P4: seed 0x0A11CE04, 200 cases — a crash at any transaction boundary, then SessionMailbox.start(), leaves exactly the model state', async () => {
    const random = mulberry32(0x0A11CE04)
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
    let crashes = 0
    const effective = { rollback: 0, 'after-commit': 0 }
    for (let index = 0; index < propertyCases(CASES); index++) {
      const file = freshFile()
      let life = await open(file)
      const task = life.runtime.tasks.store.create({ teamId: team.teamId, title: `P4 ${index}`, direction: 'v1', creator: SYSTEM_ACTOR })
      const model: Model = { states: [], revision: 1, closed: false }
      const kinds = Array.from({ length: 2 + Math.floor(random() * 7) }, () => pick(KINDS))
      const crashAt = Math.floor(random() * kinds.length)
      const crashKind = random() < 0.5 ? 'rollback' : 'after-commit'
      try {
        for (const [position, kind] of kinds.entries()) {
          const label = [index, kinds, position, crashAt === position ? crashKind : 'none']
          if (model.closed && kind === 'other') continue
          const n = ++sequence
          const crash = position === crashAt
          let unsubscribe = () => {}
          if (crash && crashKind === 'rollback') {
            const [table, event] = BOUNDARY[kind]
            life.sdb.db.exec(`CREATE TRIGGER crash AFTER ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'crash'); END`)
          }
          if (crash && crashKind === 'after-commit') {
            const store = life.runtime.tasks.store
            // Only the announcement of the command's own committed write crashes
            // (a preparation may announce the task earlier, before anything committed).
            const armed = JSON.stringify(stored(life.runtime, task.id))
            unsubscribe = store.subscribe(() => {
              if (JSON.stringify(stored(life.runtime, task.id)) === armed) return
              unsubscribe()
              throw new CrashAfterCommit('crash after commit')
            })
          }
          try {
            await command(life.runtime, task.id, kind, n)
          } catch (error) {
            // A refusal, the injected fault, or the throw right after a commit.
            if (!(error instanceof Error)) throw error
          } finally {
            unsubscribe()
          }
          // The reference model: a refused command changes nothing; a fault
          // inside the transaction rolls it back; one after its commit keeps it.
          const changed = structuredClone(model)
          apply(changed, kind)
          if (crash && JSON.stringify(changed) !== JSON.stringify(model)) effective[crashKind]++
          if (!(crash && crashKind === 'rollback')) Object.assign(model, changed)
          if (crash) {
            crashes++
            if (crashKind === 'rollback') life.sdb.db.exec('DROP TRIGGER IF EXISTS crash')
            life.close()
            life = await open(file)
          }
          expect([...label, stored(life.runtime, task.id), counts(life.runtime, task.id)]).toEqual([...label, model, []])
        }
        life.close()
        life = await open(file)
        expect([index, kinds, 'final restart', stored(life.runtime, task.id), counts(life.runtime, task.id)]).toEqual([index, kinds, 'final restart', model, []])
      } finally {
        life.close()
      }
    }
    expect(crashes).toBeGreaterThan(0)
    // Both crash kinds hit commands that write (not only refusals).
    expect(effective.rollback * effective['after-commit']).toBeGreaterThan(0)
  }, 600_000)
})
