// The affinity task at send (group-mail-task-affinity D1, task 1.3): rows
// R1–R4 and R6 of design.md's "Affinity task at send and owner at route"
// table, send half, through the production `TeamMailbox` composition. Each
// row asserts the stored `affinity_task`, that `task_id` is exactly what the
// sender gave, and that the envelope has a task section only when it did.
// The owner half (R5, R7, and the owner of each row) is resolved at route
// time and lives with the routing tests.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatSessionRecord } from '../db'
import { TeamMailbox } from '../team/TeamMailbox'
import { MailboxStore } from '../team/mailboxStore'
import { mailboxHandlers } from '../team/mailboxTools'
import { TaskStore } from '../team/taskStore'
import { resolveTeam } from '../team/teamIdentity'
import { schemaDb } from './schemaDb'

let dir: string
let db: Database
let store: MailboxStore
let tasks: TaskStore
let mailbox: TeamMailbox
let records: Map<string, ChatSessionRecord>
let taskA: string
let taskB: string

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-mail-affinity-'))
  const project = path.join(dir, 'project')
  fs.mkdirSync(path.join(project, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(project, '.kawai/groups/lead.md'), '---\ndescription: Leads\naffinity: task-owner\n---\nLead.')
  fs.writeFileSync(path.join(project, '.kawai/groups/devs.md'), '---\ndescription: Developers\n---\nBuild.')
  const row = (id: string, groupId: string): ChatSessionRecord => ({
    sessionId: id, projectPath: project, groupId, name: id, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  })
  records = new Map([['lead-a', row('lead-a', 'lead')], ['lead-b', row('lead-b', 'lead')], ['dev', row('dev', 'devs')]])
  db = schemaDb(':memory:')
  store = new MailboxStore(db)
  tasks = new TaskStore(db, store)
  const { teamId } = await resolveTeam(project)
  taskA = tasks.create({ teamId, title: 'A', direction: 'go', creator: { kind: 'agent', sessionId: 'lead-a' } }).id
  taskB = tasks.create({ teamId, title: 'B', direction: 'go', creator: { kind: 'agent', sessionId: 'lead-b' } }).id
  mailbox = new TeamMailbox(store, { getSession: id => records.get(id), homeDir: dir, tasks })
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

interface Row {
  id: string
  taskIdGiven: 'A' | 'B' | null
  senderTask: 'A' | 'B' | null
  group: 'lead' | 'devs'
  affinityTask: 'A' | 'B' | null
}
const ROWS: Row[] = [
  { id: 'R1', taskIdGiven: 'A', senderTask: null, group: 'lead', affinityTask: 'A' },
  { id: 'R1, sender task set', taskIdGiven: 'A', senderTask: 'A', group: 'lead', affinityTask: 'A' },
  { id: 'R2', taskIdGiven: null, senderTask: 'A', group: 'lead', affinityTask: 'A' },
  { id: 'R3', taskIdGiven: null, senderTask: null, group: 'lead', affinityTask: null },
  { id: 'R4, task given', taskIdGiven: 'A', senderTask: 'A', group: 'devs', affinityTask: null },
  { id: 'R4, sender task', taskIdGiven: null, senderTask: 'A', group: 'devs', affinityTask: null },
  { id: 'R6', taskIdGiven: 'B', senderTask: 'A', group: 'lead', affinityTask: 'B' },
]

describe('the affinity task recorded at send (D1, R1–R4, R6)', () => {
  const ids = () => ({ A: taskA, B: taskB })
  for (const row of ROWS) {
    test(`${row.id}: task_id ${row.taskIdGiven ?? 'absent'}, sender's task ${row.senderTask ?? 'absent'}, to ${row.group}`, async () => {
      records.get('dev')!.taskId = row.senderTask ? ids()[row.senderTask] : null
      const sent = await mailboxHandlers(mailbox, 'dev').send_message({
        to_kind: 'group', to_id: row.group, body: 'Done',
        ...(row.taskIdGiven ? { task_id: ids()[row.taskIdGiven] } : {}),
      })
      const stored = db.prepare('SELECT affinity_task, task_id FROM team_messages WHERE id = ?').get(sent.id)
      expect(stored).toEqual({
        affinity_task: row.affinityTask ? ids()[row.affinityTask] : null,
        task_id: row.taskIdGiven ? ids()[row.taskIdGiven] : null,
      })
      // The envelope's task section follows task_id alone.
      expect(store.get(sent.id)!.taskId).toBe(row.taskIdGiven ? ids()[row.taskIdGiven] : null)
    })
  }

  // @covers: agent-mailbox › Group mail records its affinity task › Affinity task from the sender's current task
  test('the sender\'s current task is recorded without giving the message a task', async () => {
    records.get('dev')!.taskId = taskA
    const sent = await mailboxHandlers(mailbox, 'dev').send_message({ to_kind: 'group', to_id: 'lead', body: 'Done' })
    expect(store.get(sent.id)).toMatchObject({ affinityTask: taskA, taskId: null })
  })

  // @covers: agent-mailbox › Group mail records its affinity task › Explicit task wins
  test('an explicit task_id wins over the sender\'s current task', async () => {
    records.get('dev')!.taskId = taskA
    const sent = await mailboxHandlers(mailbox, 'dev').send_message({ to_kind: 'group', to_id: 'lead', body: 'Done', task_id: taskB })
    expect(store.get(sent.id)).toMatchObject({ affinityTask: taskB, taskId: taskB })
  })

  // @covers: agent-mailbox › Group mail records its affinity task › Sender without a task
  test('a sender without a task records none', async () => {
    const sent = await mailboxHandlers(mailbox, 'dev').send_message({ to_kind: 'group', to_id: 'lead', body: 'Done' })
    expect('affinityTask' in store.get(sent.id)!).toBe(false)
  })

  // @covers: agent-mailbox › Group mail records its affinity task › Group without affinity
  test('a group without affinity records none', async () => {
    records.get('lead-a')!.taskId = taskA
    const sent = await mailboxHandlers(mailbox, 'lead-a').send_message({ to_kind: 'group', to_id: 'devs', body: 'Build' })
    expect('affinityTask' in store.get(sent.id)!).toBe(false)
  })

  test('direct mail records none', async () => {
    records.get('dev')!.taskId = taskA
    const sent = await mailboxHandlers(mailbox, 'dev').send_message({ to_kind: 'session', to_id: 'lead-a', body: 'Done' })
    expect('affinityTask' in store.get(sent.id)!).toBe(false)
  })

  test('the human\'s group mail records only an explicit task', async () => {
    const human = { kind: 'human' as const, team: await resolveTeam(records.get('dev')!.projectPath) }
    const bare = await mailbox.send(human, { to_kind: 'group', to_id: 'lead', body: 'Look' })
    expect('affinityTask' in store.get(bare.id)!).toBe(false)
    const given = await mailbox.send(human, { to_kind: 'group', to_id: 'lead', body: 'Look', task_id: taskA })
    expect(store.get(given.id)!.affinityTask).toBe(taskA)
  })
})
