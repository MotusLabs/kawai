// Handoff wakeups (owner-publication-handoff D6, task 6.1) over a real
// TaskService, store and mailbox: each of `published`, `declined`, `stale`
// and `closed` writes one wakeup row and one system message in its
// transaction — direct to a live requester, else to its group, never to an
// archived, exhausted or missing session, never attached to the task —
// whose body names the task, the handoff, the transition and the revision;
// `superseded` and `withdrawn` wake nobody; the key makes a second write a
// no-op; a fault at the mutation, the wakeup or the mailbox insert rolls all
// three back; a dead-lettered delivery keeps the transition. The closure
// route through a worktree-scoped group in the real composition is DF2's
// row in taskHandoffDefensive.test.ts and CP3's in taskHandoffRecovery.
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
import { HANDOFF_WAKEUP_TAG, writeHandoffWakeup } from '../team/taskHandoffWakeups'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { SYSTEM_ACTOR } from '../../shared/team'
import type { HandoffWakeupTransition } from '../../shared/taskHandoffs'

let root: string
let repo: string
let db: Database
let records: Map<string, ChatSessionRecord>
let service: TaskService
let team: TeamIdentity
const human = (): TaskCaller => ({ kind: 'human', team })
const lead: TaskCaller = { kind: 'agent', sessionId: 'lead' }
const row = (sessionId: string, groupId: string | null): ChatSessionRecord => ({
  sessionId, groupId, projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})
const mailOf = (handoffId: string) => db.prepare('SELECT * FROM team_messages WHERE tags LIKE ? AND body LIKE ? ORDER BY rowid')
  .all(`%${HANDOFF_WAKEUP_TAG}%`, `%${handoffId}%`) as Array<Record<string, unknown>>
const wakeups = (handoffId: string) => db.prepare('SELECT transition, message_id FROM team_task_handoff_wakeups WHERE handoff_id = ? ORDER BY rowid').all(handoffId) as Array<{ transition: string; message_id: string | null }>
const snapshot = () => Object.fromEntries(['team_task_handoffs', 'team_task_handoff_events', 'team_task_handoff_wakeups', 'team_task_revisions', 'team_messages', 'team_tasks']
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))

const open = async () => {
  const task = service.store.create({ teamId: team.teamId, title: 'Export CSV', direction: 'CSV', creator: SYSTEM_ACTOR })
  const { handoff } = await service.handoffs.request(lead, task.id, { baseRevision: 1, direction: 'CSV with headers', rationale: 'why', notify: false, requestKey: 'k1' })
  return { task, handoff }
}
/** Drive one transition; returns the revision the wakeup should name (null for declined and closed). */
const TRANSITIONS: Record<HandoffWakeupTransition, (taskId: string, handoffId: string) => Promise<number | null>> = {
  published: async (taskId, handoffId) => (await service.handoffs.publish(human(), taskId, handoffId, [])).revision.revision,
  declined: async (_taskId, handoffId) => { await service.handoffs.settle(human(), handoffId, 'decline', 'scope stays'); return null },
  stale: async taskId => (await service.publish(human(), taskId, { direction: 'Mine', rationale: 'r', notify: false })).revision.revision,
  closed: async taskId => { await service.setStatus(human(), taskId, 'cancelled'); return null },
}
const WORDS: Record<HandoffWakeupTransition, string> = { published: 'was published', declined: 'was declined', stale: 'is stale', closed: 'closed with its task' }

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-handoff-wakeups-')))
  repo = path.join(root, 'repo')
  const result = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(result.stderr)
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  clearTeamCache()
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  records = new Map([['lead', row('lead', 'leads')], ['lead2', row('lead2', 'leads')]])
  db?.close()
  db = schemaCopy()
  service = new TaskService(new TaskStore(db, new MailboxStore(db)), { getSession: id => records.get(id), homeDir: path.join(root, 'home') })
})

describe('recipients', () => {
  const GONE: Array<[string, () => void]> = [
    ['archived', () => records.set('lead', { ...records.get('lead')!, archivedAt: '2026-11-22T00:00:00Z' })],
    ['context-exhausted', () => records.set('lead', { ...records.get('lead')!, contextExhausted: { at: '2026-11-22T00:00:00Z', reason: 'prompt_too_long' } })],
    ['missing', () => records.delete('lead')],
  ]

  // @covers: task-publication-handoffs › Each disposition wakes the next actor once › The requester learns of the publication
  test('a live requester gets one direct system message per transition, unattached, naming the task, handoff, transition and revision', async () => {
    for (const transition of Object.keys(TRANSITIONS) as HandoffWakeupTransition[]) {
      const { task, handoff } = await open()
      const revision = await TRANSITIONS[transition](task.id, handoff.id)
      const mail = mailOf(handoff.id)
      expect(wakeups(handoff.id)).toEqual([{ transition, message_id: String(mail[0]!.id) }])
      expect(mail).toEqual([expect.objectContaining({ to_kind: 'session', to_id: 'lead', task_id: null, from_kind: 'system', from_session: null })])
      expect(JSON.parse(String(mail[0]!.tags))).toEqual([HANDOFF_WAKEUP_TAG, `handoff-${transition}`])
      const body = String(mail[0]!.body)
      for (const part of ['Export CSV', task.id, handoff.id, WORDS[transition], ...(revision !== null ? [`revision ${revision}`] : [])]) expect([transition, body]).toEqual([transition, expect.stringContaining(part)])
    }
  })

  // @covers: task-publication-handoffs › Each disposition wakes the next actor once › A gone requester's group is woken
  test("a gone requester's group gets the message as group mail, and the session none, for every transition", async () => {
    for (const [gone, make] of GONE) {
      for (const transition of Object.keys(TRANSITIONS) as HandoffWakeupTransition[]) {
        records.set('lead', row('lead', 'leads'))
        const { task, handoff } = await open()
        make()
        await TRANSITIONS[transition](task.id, handoff.id)
        expect([gone, transition, mailOf(handoff.id).map(message => [message.to_kind, message.to_id, message.task_id])])
          .toEqual([gone, transition, [['group', 'leads', null]]])
      }
    }
  })

  test('a gone requester without a group keeps the wakeup row and sends no mail', async () => {
    const { task } = await open()
    const handoff = service.store.atomically(() => {
      db.prepare("UPDATE team_task_handoffs SET state = 'withdrawn' WHERE task_id = ?").run(task.id)
      return service.handoffs.store.insert({ teamId: team.teamId, taskId: task.id, baseRevision: 1, baseContractHash: null, direction: 'x', acceptance: null, contract: null,
        rationale: 'r', notify: false, baseCommit: null, evidenceRefs: [], requesterSession: 'gone', requesterGroup: null, requestKey: 'seeded' }, 'now')
    })
    await TRANSITIONS.closed(task.id, handoff.id)
    expect(wakeups(handoff.id)).toEqual([{ transition: 'closed', message_id: null }])
    expect(mailOf(handoff.id)).toEqual([])
  })

  test('superseded and withdrawn wake nobody', async () => {
    const { task, handoff } = await open()
    const { handoff: newer } = await service.handoffs.request({ kind: 'agent', sessionId: 'lead2' }, task.id, { baseRevision: 1, direction: 'Newer', rationale: 'r', notify: false, requestKey: 'k2' })
    await service.handoffs.settle(lead, newer.id, 'withdraw', 'not needed')
    expect([service.handoffs.store.get(handoff.id)!.state, service.handoffs.store.get(newer.id)!.state]).toEqual(['superseded', 'withdrawn'])
    expect([wakeups(handoff.id), wakeups(newer.id), mailOf(handoff.id), mailOf(newer.id)]).toEqual([[], [], [], []])
  })
})

describe('atomicity and the key', () => {
  test('a second write of a transition is a no-op: no second row and no second message', async () => {
    const { task, handoff } = await open()
    await TRANSITIONS.published(task.id, handoff.id)
    const before = snapshot()
    const again = writeHandoffWakeup(db, service.store.mail, service.handoffs.store.get(handoff.id)!, 'published',
      { taskTitle: 'Export CSV', revision: 2, originPath: repo, live: service.handoffs.live }, 'later')
    expect(again).toBeNull()
    expect(snapshot()).toEqual(before)
  })

  test('a fault at the handoff update, the wakeup insert or the mailbox insert rolls the publication back whole', async () => {
    for (const [table, event] of [['team_task_handoffs', 'UPDATE'], ['team_task_handoff_wakeups', 'INSERT'], ['team_messages', 'INSERT']]) {
      const { task, handoff } = await open()
      db.exec(`CREATE TRIGGER fault AFTER ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'fault at ${table}'); END`)
      const before = snapshot()
      await expect(service.handoffs.publish(human(), task.id, handoff.id, [])).rejects.toThrow(`fault at ${table}`)
      db.exec('DROP TRIGGER fault')
      expect(snapshot()).toEqual(before)
      expect([table, service.store.get(task.id)!.revision, service.handoffs.store.get(handoff.id)!.state]).toEqual([table, 1, 'open'])
    }
  })

  test('a dead-lettered wakeup keeps its transition and is not rewritten', async () => {
    const { task, handoff } = await open()
    await TRANSITIONS.stale(task.id, handoff.id)
    const [wake] = wakeups(handoff.id)
    service.store.mail!.deadLetter(wake!.message_id!, 'killed-recipient')
    expect(service.store.mail!.get(wake!.message_id!)!.state).toBe('dead')
    expect(service.handoffs.store.get(handoff.id)!.state).toBe('stale')
    expect(service.handoffs.reconcile()).toEqual([])
    expect(wakeups(handoff.id)).toEqual([wake])
  })
})
