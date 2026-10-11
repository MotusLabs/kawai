// Exercise the same schema-stripping handlers registered with the SDK MCP
// transport, without spawning Claude Code or mutating repository git state.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatSessionRecord } from '../db'
import { TeamMailbox } from '../team/TeamMailbox'
import { MailboxStore } from '../team/mailboxStore'
import { createMailboxServer, mailboxHandlers } from '../team/mailboxTools'

let dir: string
let db: Database
let store: MailboxStore
let mailbox: TeamMailbox
let records: Map<string, ChatSessionRecord>
let handlers: ReturnType<typeof mailboxHandlers>
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-mail-tools-'))
  const project = path.join(dir, 'project')
  fs.mkdirSync(path.join(project, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(project, '.kawai/groups/devs.md'), '---\ndescription: Developers\nhopLimit: 2\n---\nBuild features')
  fs.mkdirSync(path.join(dir, 'other'))
  const row = (id: string, projectPath = project): ChatSessionRecord => ({
    sessionId: id, projectPath, groupId: 'devs', name: id, sdkSessionId: null,
    status: 'waiting', createdAt: '', lastActivityAt: '',
  })
  records = new Map([['lead', row('lead')], ['dev', row('dev')], ['other', row('other', path.join(dir, 'other'))]])
  db = new Database(':memory:')
  store = new MailboxStore(db)
  mailbox = new TeamMailbox(store, { getSession: id => records.get(id), homeDir: dir,
    restoreSession: id => { records.get(id)!.archivedAt = null } })
  handlers = mailboxHandlers(mailbox, 'lead')
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const groupMail = { to_kind: 'group', to_id: 'devs', body: 'Build it' }
test('group mail binds actual sender and ignores forged fields', async () => {
  const message = await handlers.send_message({ ...groupMail, from_session: 'forged', from_group: 'fake', origin_path: '/fake', sender: 'fake' })
  expect(message).toMatchObject({ fromSession: 'lead', fromGroup: 'devs', originPath: records.get('lead')!.projectPath, toKind: 'group', state: 'queued' })
  expect(store.get(message.id)).toEqual(message)
})
test('direct mail to another member', async () => {
  expect(await handlers.send_message({ to_kind: 'session', to_id: 'dev', body: 'Review' })).toMatchObject({ toKind: 'session', toId: 'dev' })
})
test('direct mail restores an archived recipient instead of queueing forever', async () => {
  records.get('dev')!.archivedAt = '2026-01-01'
  const message = await handlers.send_message({ to_kind: 'session', to_id: 'dev', body: 'Review' })
  expect(message).toMatchObject({ toKind: 'session', toId: 'dev', state: 'queued' })
  expect(records.get('dev')!.archivedAt).toBeNull()
})
test('unknown group and session are refused without enqueueing', async () => {
  await expect(handlers.send_message({ ...groupMail, to_id: 'missing' })).rejects.toThrow('Unknown group')
  await expect(handlers.send_message({ to_kind: 'session', to_id: 'missing', body: 'Hi' })).rejects.toThrow('Unknown recipient')
  expect(store.teamsWithQueuedMail()).toEqual([])
})
test('another team is refused', async () => {
  await expect(handlers.send_message({ to_kind: 'session', to_id: 'other', body: 'Hi' })).rejects.toThrow('another team')
  expect(store.teamsWithQueuedMail()).toEqual([])
})
test('list groups exposes descriptions without role bodies', async () => {
  expect(await handlers.list_groups({})).toEqual([{ id: 'devs', label: 'devs', description: 'Developers' }])
})
test('schedule accepts a due time or delay and rejects invalid times', async () => {
  const scheduled = await handlers.schedule_message({ ...groupMail, deliver_at: '2099-01-01T00:00:00Z' })
  expect(scheduled.deliverAt).toBe('2099-01-01T00:00:00.000Z')
  const start = Date.now()
  const reminder = await handlers.schedule_message({ to_kind: 'session', to_id: 'lead', body: 'Remember', delay_seconds: 60 })
  expect(Date.parse(reminder.deliverAt!)).toBeGreaterThanOrEqual(start + 60000)
  await expect(handlers.schedule_message({ ...groupMail })).rejects.toThrow('exactly one')
  await expect(handlers.schedule_message({ ...groupMail, deliver_at: 'bad' })).rejects.toThrow('Invalid')
  await expect(handlers.schedule_message({ ...groupMail, deliver_at: '2099-01-01', delay_seconds: 1 })).rejects.toThrow('exactly one')
})
test('reply binds the receiver and original thread, restores an archived sender', async () => {
  const original = await handlers.send_message({ to_kind: 'session', to_id: 'dev', body: 'Question' })
  store.claim(original.id, 'dev'); store.markPushed(original.id); store.markDelivered(original.id)
  records.get('lead')!.archivedAt = '2026-01-01'
  const reply = await mailboxHandlers(mailbox, 'dev').reply({ message_id: original.id, body: 'Answer' })
  expect(reply).toMatchObject({ fromSession: 'dev', toId: 'lead', threadId: original.threadId, hop: 2 })
  expect(records.get('lead')!.archivedAt).toBeNull()
  await expect(handlers.reply({ message_id: original.id, body: 'Forge' })).rejects.toThrow('received')
})
test('killed sender reply falls back to stored group with thread attached', async () => {
  const original = await handlers.send_message(groupMail)
  store.claim(original.id, 'dev'); store.markDelivered(original.id)
  records.delete('lead')
  expect(await mailboxHandlers(mailbox, 'dev').reply({ message_id: original.id, body: 'Done' })).toMatchObject({ toKind: 'group', toId: 'devs', attachThread: true })
})
test('SDK server exposes the four mailbox tools', async () => {
  const server = await createMailboxServer(mailbox, 'lead')
  expect(server.type).toBe('sdk')
  expect(server.name).toBe('kawai-team')
  await server.instance.close()
})

test('killed sender without a group leaves reply dead-lettered', async () => {
  records.get('lead')!.groupId = null
  const original = await handlers.send_message({ to_kind: 'session', to_id: 'dev', body: 'Hi' })
  store.claim(original.id, 'dev'); store.markPushed(original.id); store.markDelivered(original.id)
  records.delete('lead')
  expect(await mailboxHandlers(mailbox, 'dev').reply({ message_id: original.id, body: 'Answer' })).toMatchObject({ state: 'dead', reason: 'killed-sender-without-group' })
})
