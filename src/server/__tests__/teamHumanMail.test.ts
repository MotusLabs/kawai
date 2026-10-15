// The human as a mail participant (team-message-threads D5): they send and
// reply through the service bound to their team identity, agents may only
// answer a human-sent message (settled on send, never claimed or pushed), and
// starting new mail to the human is refused. Human-directed rows are invisible
// to every dispatcher query.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatSessionRecord } from '../db'
import { TeamMailbox, type MailCaller, type MailInput } from '../team/TeamMailbox'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { mailboxHandlers } from '../team/mailboxTools'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'

let dir: string
let project: string
let other: string
let db: Database
let store: MailboxStore
let tasks: TaskStore
let mailbox: TeamMailbox
let records: Map<string, ChatSessionRecord>
let team: TeamIdentity
const human = (): MailCaller => ({ kind: 'human', team })

beforeEach(async () => {
  clearTeamCache()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-human-mail-'))
  project = path.join(dir, 'project')
  other = path.join(dir, 'other')
  fs.mkdirSync(path.join(project, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(project, '.kawai/groups/devs.md'), '---\ndescription: Developers\n---\nBuild features')
  fs.mkdirSync(other, { recursive: true })
  const row = (id: string, projectPath = project): ChatSessionRecord => ({
    sessionId: id, projectPath, groupId: 'devs', name: id, sdkSessionId: null,
    status: 'waiting', createdAt: '', lastActivityAt: '',
  })
  records = new Map([['dev', row('dev')], ['other', row('other', other)]])
  db = new Database(':memory:')
  store = new MailboxStore(db)
  tasks = new TaskStore(db)
  mailbox = new TeamMailbox(store, { getSession: id => records.get(id), homeDir: dir, tasks })
  team = await resolveTeam(project)
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

/** Extra tool-argument keys must never become identity (D5). */
const forged = (input: Record<string, unknown>) => input as unknown as MailInput

const task = (teamId = team.teamId) => tasks.create({
  teamId, title: 'Export', direction: 'CSV', creator: { kind: 'human', sessionId: null },
})

test('a human sends to a group and to a session, stamped human', async () => {
  const group = await mailbox.send(human(), { to_kind: 'group', to_id: 'devs', body: 'Build it' })
  expect(group).toMatchObject({
    fromKind: 'human', fromSession: null, fromGroup: null, originPath: team.groupsRoot,
    toKind: 'group', toId: 'devs', state: 'queued', priority: 'normal',
  })
  const direct = await mailbox.send(human(), { to_kind: 'session', to_id: 'dev', body: 'Review' })
  expect(direct).toMatchObject({ fromKind: 'human', fromSession: null, toKind: 'session', toId: 'dev' })
  expect(store.get(group.id)).toEqual(group)
})

test('forged identity fields are ignored; the caller is the human', async () => {
  const message = await mailbox.send(human(), forged({
    to_kind: 'group', to_id: 'devs', body: 'Build it',
    from_session: 'dev', from_kind: 'agent', from_group: 'devs', origin_path: '/fake', sender: 'dev',
  }))
  expect(message).toMatchObject({ fromKind: 'human', fromSession: null, fromGroup: null, originPath: team.groupsRoot })
})

test('unknown recipients, another team, and an invalid task refuse with nothing queued', async () => {
  await expect(mailbox.send(human(), { to_kind: 'group', to_id: 'missing', body: 'Hi' })).rejects.toThrow('Unknown group')
  await expect(mailbox.send(human(), { to_kind: 'session', to_id: 'missing', body: 'Hi' })).rejects.toThrow('Unknown recipient')
  await expect(mailbox.send(human(), { to_kind: 'session', to_id: 'other', body: 'Hi' })).rejects.toThrow('another team')
  await expect(mailbox.send(human(), { to_kind: 'group', to_id: 'devs', body: 'Hi', task_id: 'task-missing' })).rejects.toThrow('Task not found')
  const foreign = task(path.join(dir, 'foreign-team'))
  await expect(mailbox.send(human(), { to_kind: 'group', to_id: 'devs', body: 'Hi', task_id: foreign.id })).rejects.toThrow('Task not found')
  expect(store.teamsWithQueuedMail()).toEqual([])
})

test('urgent flags and task ids ride the human send', async () => {
  const created = task()
  const message = await mailbox.send(human(), { to_kind: 'group', to_id: 'devs', body: 'Now', urgent: true, tags: ['ops'], task_id: created.id })
  expect(message).toMatchObject({ priority: 'urgent', tags: ['ops'], taskId: created.id, taskRevision: null })
})

test('a reply inherits the original task unless an explicit id overrides it', async () => {
  const created = task()
  const original = await mailbox.send(human(), { to_kind: 'session', to_id: 'dev', body: 'Question', task_id: created.id })
  store.claim(original.id, 'dev'); store.markPushed(original.id); store.markDelivered(original.id)
  const inherited = await mailboxHandlers(mailbox, 'dev').reply({ message_id: original.id, body: 'Answer' })
  expect(inherited).toMatchObject({ taskId: created.id, toKind: 'human', toId: null })
  const other = task()
  const overridden = await mailboxHandlers(mailbox, 'dev').reply({ message_id: original.id, body: 'Also', task_id: other.id })
  expect(overridden).toMatchObject({ taskId: other.id, toKind: 'human' })
  // A human answer to an agent message keeps the agent's task the same way,
  // and is addressed to the agent that sent it.
  const fromAgent = await mailboxHandlers(mailbox, 'dev').send_message({ to_kind: 'group', to_id: 'devs', body: 'Update', task_id: created.id })
  const humanReply = await mailbox.reply(human(), { message_id: fromAgent.id, body: 'Noted' })
  expect(humanReply).toMatchObject({ taskId: created.id, fromKind: 'human', toKind: 'session', toId: 'dev', state: 'queued' })
})

test('an agent reply to a human-sent message is delivered to the human on send', async () => {
  const created = task()
  const original = await mailbox.send(human(), { to_kind: 'session', to_id: 'dev', body: 'Tasked', task_id: created.id })
  store.claim(original.id, 'dev'); store.markPushed(original.id); store.markDelivered(original.id)
  const reply = await mailboxHandlers(mailbox, 'dev').reply({ message_id: original.id, body: 'Done' })
  expect(reply).toMatchObject({
    fromKind: 'agent', fromSession: 'dev', toKind: 'human', toId: null,
    state: 'delivered', claimedBy: null, pushedAt: null, taskRevision: created.revision,
  })
  expect(reply.deliveredAt).not.toBeNull()
  // No claim or push ever happened on the human-directed row.
  expect(store.eventsFor(reply.id).map(event => event.kind)).toEqual(['sent', 'delivered'])
})

test('an agent reply to a human-sent message without a task is delivered with a null revision', async () => {
  const original = await mailbox.send(human(), { to_kind: 'session', to_id: 'dev', body: 'Quick question' })
  store.claim(original.id, 'dev'); store.markDelivered(original.id)
  const reply = await mailboxHandlers(mailbox, 'dev').reply({ message_id: original.id, body: 'Yes' })
  expect(reply).toMatchObject({ state: 'delivered', toKind: 'human', taskId: null, taskRevision: null, claimedBy: null, pushedAt: null })
})

test('neither agents nor the human start new mail to the human', async () => {
  const handlers = mailboxHandlers(mailbox, 'dev')
  await expect(handlers.send_message({ to_kind: 'human', body: 'Hi' })).rejects.toThrow('Reply to a message they sent instead')
  await expect(handlers.schedule_message({ to_kind: 'human', body: 'Hi', delay_seconds: 1 })).rejects.toThrow('Reply to a message they sent instead')
  await expect(mailbox.send(human(), { to_kind: 'human', body: 'Hi' })).rejects.toThrow('Reply to a message they sent instead')
  await expect(mailbox.schedule(human(), { to_kind: 'human', body: 'Hi', delay_seconds: 1 })).rejects.toThrow('Reply to a message they sent instead')
  expect(store.teamsWithQueuedMail()).toEqual([])
})

test('human-directed rows never reach the dispatcher queries', async () => {
  // A settled reply: not queued at all.
  const original = await mailbox.send(human(), { to_kind: 'session', to_id: 'dev', body: 'Q' })
  store.claim(original.id, 'dev'); store.markDelivered(original.id)
  const reply = await mailboxHandlers(mailbox, 'dev').reply({ message_id: original.id, body: 'A' })
  expect(reply.state).toBe('delivered')
  expect(store.teamsWithQueuedMail()).not.toContain(team.teamId)
  // Even a still-queued human-directed row is structurally invisible — every
  // selection query filters on the routing `to_kind`, not on state alone.
  const targeted = tasks.create({
    teamId: team.teamId, title: 'WT', direction: 'go', creator: { kind: 'human', sessionId: null },
    worktree: project,
  })
  const stranded = store.enqueue({
    teamId: team.teamId, toKind: 'human', toId: null, fromKind: 'agent', fromSession: 'dev',
    fromGroup: 'devs', originPath: project, body: 'Stranded', taskId: targeted.id,
  })
  expect(store.get(stranded.id)?.state).toBe('queued')
  expect(store.dueGroupMail().map(message => message.id)).toEqual([])
  expect(store.nextEligible({ teamId: team.teamId, sessionId: 'dev', groupId: 'devs' })).toBeNull()
  expect(store.nextEligible({ teamId: team.teamId, sessionId: 'dev', groupId: null })).toBeNull()
  expect(store.urgentDirectFor('dev')).toEqual([])
  expect(store.worktreeTaskMail().map(entry => entry.message.id)).toEqual([])
})

test('the human answers any message of their team, never an unknown one', async () => {
  const original = await mailboxHandlers(mailbox, 'dev').send_message({ to_kind: 'group', to_id: 'devs', body: 'Update' })
  store.claim(original.id, 'dev'); store.markDelivered(original.id)
  // A reply is addressed to the original sender, not to its destination.
  expect(await mailbox.reply(human(), { message_id: original.id, body: 'Noted' })).toMatchObject({ toKind: 'session', toId: 'dev' })
  await expect(mailbox.reply(human(), { message_id: 'missing', body: 'Hi' })).rejects.toThrow('this team')
})
