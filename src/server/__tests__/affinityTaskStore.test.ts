// The affinity task on stored group mail (group-mail-task-affinity D1, task
// 1.2): it round-trips through enqueue and the due group queue without
// touching `task_id`; a row without one reads as before (no key, a NULL
// column); a release keeps it; a store on a database before migration 23
// still enqueues ordinary mail and reads no affinity task; and a limit
// forward keeps it, since the forward is the same message about the same task.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../db'
import { initDatabase } from '../db'
import { MIGRATIONS } from '../dbSafety/migrations'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import { MailboxStore } from '../team/mailboxStore'
import type { EnqueueInput } from '../team/enqueueInput'
import { LimitEventStore } from '../team/routing/limitEvents'
import { LimitOutcomes } from '../team/routing/limitOutcomes'
import { TASK_AFFINITY_MIGRATION_VERSION } from '../team/taskAffinityMigration'
import { schemaDb } from './schemaDb'

const TEAM = '/repo/.git'
const T0 = Date.parse('2026-11-05T08:00:00.000Z')

describe('team_messages.affinity_task', () => {
  let db: Database
  let store: MailboxStore
  beforeEach(() => { db = schemaDb(); store = new MailboxStore(db) })
  afterEach(() => db.close())
  const send = (over: Partial<EnqueueInput> = {}) => store.enqueue({
    teamId: TEAM, toKind: 'group', toId: 'lead', fromSession: 'chat-dev', fromGroup: 'devs', originPath: '/repo', body: 'Done', ...over,
  })

  test('an affinity task round-trips through enqueue, get, and the due group queue, leaving task_id unset', () => {
    const sent = send({ affinityTask: 'task-1' })
    expect(sent).toMatchObject({ affinityTask: 'task-1', taskId: null })
    expect(store.get(sent.id)!.affinityTask).toBe('task-1')
    expect(store.dueGroupMail().map(message => message.affinityTask)).toEqual(['task-1'])
    expect(db.prepare('SELECT affinity_task, task_id FROM team_messages WHERE id = ?').get(sent.id))
      .toEqual({ affinity_task: 'task-1', task_id: null })
  })

  test('a worker choice and an affinity task are both written', () => {
    const sent = send({ affinityTask: 'task-1', workerChoice: 'zai' })
    expect(store.get(sent.id)).toMatchObject({ affinityTask: 'task-1', workerChoice: 'zai' })
  })

  test('a message without one reads exactly as before: no key, a NULL column', () => {
    const sent = send()
    expect('affinityTask' in sent).toBe(false)
    expect(db.prepare('SELECT affinity_task FROM team_messages WHERE id = ?').get(sent.id)).toEqual({ affinity_task: null })
  })

  test('a release back to the group queue keeps the affinity task', () => {
    const sent = send({ affinityTask: 'task-1' })
    expect(store.claim(sent.id, 'chat-lead')).toBe(true)
    store.markPushed(sent.id)
    store.markDelivered(sent.id)
    expect(store.release(sent.id, 'lead')).toBe(true)
    expect(store.get(sent.id)).toMatchObject({ state: 'queued', affinityTask: 'task-1' })
  })
})

test('a database before migration 23 opens, enqueues ordinary mail, and reads no affinity task', () => {
  const session = initDatabase({ path: ':memory:', migrations: MIGRATIONS.filter(migration => migration.version < TASK_AFFINITY_MIGRATION_VERSION) })
  const store = new MailboxStore(session.db)
  const sent = store.enqueue({ teamId: TEAM, toKind: 'group', toId: 'lead', fromSession: null, fromGroup: null, originPath: '/repo', body: 'Old build' })
  expect('affinityTask' in store.get(sent.id)!).toBe(false)
  session.close()
})

test('a limit forward keeps the affinity task', async () => {
  const db = schemaDb(':memory:')
  const store = new MailboxStore(db)
  const limits = new LimitEventStore(db, () => T0)
  const parsed = parseGroupFile('lead', '---\nonLimit: forward\n---\nLead.')
  if (!parsed.ok) throw new Error(parsed.error)
  const groups = new Map<string, GroupDefinition>([['lead', parsed.group]])
  const records = new Map<string, ChatSessionRecord>([['lead-a', {
    sessionId: 'lead-a', name: 'Lead A', projectPath: '/repo', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
    groupId: 'lead', claudeProfileId: 'glm',
  }]])
  const outcomes = new LimitOutcomes(db, {
    store, limits, rules: { rule: () => undefined },
    getRecord: id => records.get(id), teamOf: id => (records.has(id) ? TEAM : undefined),
    groupOf: (_sessionId, groupId) => groups.get(groupId), taskTitle: () => null, targetWorktree: () => null,
    restoreSession: () => {}, onError: error => { throw error }, now: () => T0,
  })
  const message = store.enqueue({
    teamId: TEAM, toKind: 'group', toId: 'lead', fromSession: 'chat-dev', fromGroup: 'devs', originPath: '/repo',
    body: 'Done', affinityTask: 'task-1',
  })
  store.claim(message.id, 'lead-a'); store.markPushed(message.id); store.markDelivered(message.id)
  outcomes.delivered('lead-a', store.get(message.id)!)
  outcomes.toolCall('lead-a', 'Edit', { file_path: 'src/a.ts' })
  limits.record({
    profileId: 'glm', sessionId: 'lead-a', groupId: 'lead', kind: 'rate_limit', final: true, status: 429,
    message: 'API Error: 429 quota', resetsAt: new Date(T0 + 6 * 3_600_000).toISOString(), providerId: null, window: null,
  })
  await outcomes.turnEnded('lead-a', true)
  const original = store.get(message.id)!
  expect(original.state).toBe('forwarded')
  const forwardedId = original.reason!.replace('forwarded: ', '')
  expect(store.get(forwardedId)).toMatchObject({ toKind: 'group', toId: 'lead', affinityTask: 'task-1', taskId: null })
  db.close()
})
