// Exercise the same schema-stripping handlers registered with the SDK MCP
// transport, without spawning Claude Code or mutating repository git state.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
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
  db = schemaDb(':memory:')
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

test('urgent direct mail to an agent whose profile is cooling is refused; normal mail still queues', async () => {
  records.get('dev')!.claudeProfileId = 'glm'
  const until = '2026-10-12T15:40:00.000Z'
  mailbox = new TeamMailbox(store, { getSession: id => records.get(id), homeDir: dir,
    cooldownUntil: profileId => (profileId === 'glm' ? until : null) })
  handlers = mailboxHandlers(mailbox, 'lead')
  const time = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const error = await handlers.send_message({ to_kind: 'session', to_id: 'dev', body: 'Now!', urgent: true }).then(() => null, e => e as Error)
  expect(error?.message).toContain('profile glm')
  expect(error?.message).toContain(time)
  expect(store.teamsWithQueuedMail()).toEqual([])
  expect(await handlers.send_message({ to_kind: 'session', to_id: 'dev', body: 'Later' })).toMatchObject({ state: 'queued' })
  // An urgent reply to a cooling sender is refused the same way.
  const original = await mailboxHandlers(mailbox, 'dev').send_message({ to_kind: 'session', to_id: 'lead', body: 'Q' })
  store.claim(original.id, 'lead'); store.markPushed(original.id); store.markDelivered(original.id)
  const replyError = await handlers.reply({ message_id: original.id, body: 'A', urgent: true }).then(() => null, e => e as Error)
  expect(replyError?.message).toContain('profile glm')
  // Group mail is never refused for cooldown.
  expect(await handlers.send_message({ ...groupMail, urgent: true })).toMatchObject({ state: 'queued' })
})

// release_member (member-release D6): the tool name is allowed without a
// card, and the handler binds the caller and delegates to MemberRelease.
import { MemberRelease } from '../team/memberRelease'
import { TaskStore } from '../team/taskStore'
import { RELEASE_TOOL_NAMES, TEAM_ALLOWED_TOOLS, releaseHandlers } from '../team/mailboxTools'
import type { GroupDefinition } from '../team/groupFile'

const groupDef = (overrides: Partial<GroupDefinition> = {}): GroupDefinition => ({
  id: 'devs', label: 'devs', description: '', canCreateTasks: false, canCreatePlans: false, canManageMailbox: false,
  releaseOnTaskClose: true, worktreeScoped: true, canReleaseMembers: true,
  max: 1, profiles: [], strategy: 'first-available',
  onLimit: { parkIfResetWithinMs: 3 * 3_600_000, otherwise: 'forward' }, approval: 'manual', warnings: [], prompt: '',
  ...overrides,
})
const makeReleases = (definition: (groupId: string) => Promise<GroupDefinition | undefined>, opts: { idle?: boolean } = {}) => {
  const archived: string[] = []
  const tasks = new TaskStore(db, store)
  const releases = new MemberRelease(db, {
    store, tasks,
    records: () => records.values(),
    getRecord: id => records.get(id),
    teamOf: id => (records.has(id) ? ({ teamId: 'team', groupsRoot: '' } as never) : undefined),
    definition: async (_teamId, groupId) => definition(groupId),
    cachedDefinition: () => undefined,
    recipient: _id => ({ idle: opts.idle ?? true, pendingRequest: false }),
    hasLiveWorkers: () => false,
    hasRunningBackgroundTasks: () => false,
    archive: id => { archived.push(id); records.get(id)!.archivedAt = new Date().toISOString(); return { ok: true } },
    notify: () => {},
  })
  return { releases, archived, tasks }
}

test('release_member is a team tool allowed without approval and archives through MemberRelease', async () => {
  expect(TEAM_ALLOWED_TOOLS).toContain('mcp__kawai-team__release_member')
  expect(RELEASE_TOOL_NAMES).toEqual(['release_member'])
  const task = new TaskStore(db, store).create({ teamId: 'team', title: 't', direction: 'd', creator: { kind: 'human', sessionId: null } })
  records.get('dev')!.spawned = true
  records.get('dev')!.taskId = task.id
  const { releases, archived, tasks } = makeReleases(async () => undefined)
  const result = await releaseHandlers(releases, 'lead').release_member({ session_id: 'dev', reason: 'merged' })
  expect(result).toEqual({ sessionId: 'dev', taskId: task.id })
  expect(archived).toEqual(['dev'])
  // The release is journaled on the member's task, authored by kawai.
  expect(tasks.journal(task.id).at(-1)).toMatchObject({ author: { kind: 'system', sessionId: null }, text: expect.stringContaining('Released dev (dev) at the request of lead (lead): merged.') })
})

test('release_member refusals: not permitted, not spawned, and not ready', async () => {
  records.get('lead')!.groupId = 'leads'
  const { releases } = makeReleases(async groupId =>
    groupId === 'leads' ? groupDef({ id: 'leads', canReleaseMembers: false }) : undefined)
  await expect(releaseHandlers(releases, 'lead').release_member({ session_id: 'dev' })).rejects.toThrow('opted out of releasing members')
  records.get('lead')!.groupId = 'devs'
  records.get('dev')!.spawned = false
  await expect(releaseHandlers(releases, 'lead').release_member({ session_id: 'dev' })).rejects.toThrow('Only spawned members can be released')
  records.get('dev')!.spawned = true
  await expect(releaseHandlers(releases, 'lead').release_member({ session_id: 'dev' })).resolves.toMatchObject({ sessionId: 'dev' })
  await expect(releaseHandlers(releases, 'lead').release_member({ session_id: 'nope' })).rejects.toThrow('archived or unknown')
})

test('management tools bind the caller session, ignore forged ids, and are allowed without cards', async () => {
  const { MailboxManagement } = await import('../team/mailboxManagement')
  const { TaskService } = await import('../team/TaskService')
  const { TaskStore } = await import('../team/taskStore')
  const { managementHandlers, TEAM_ALLOWED_TOOLS } = await import('../team/mailboxTools')
  const management = new MailboxManagement(store, {
    getSession: id => records.get(id), homeDir: dir, tasks: new TaskService(new TaskStore(db, store), { getSession: id => records.get(id), homeDir: dir }),
  })
  const mine = await handlers.send_message(groupMail)
  const theirs = await mailboxHandlers(mailbox, 'dev').send_message({ to_kind: 'session', to_id: 'lead', body: 'Hi' })
  const asDev = managementHandlers(management, 'dev')
  // A forged session argument is stripped: the handler still acts as 'dev'.
  const listed = await asDev.list_mailbox({ session_id: 'lead', sessionId: 'lead' }) as { messages: Array<{ id: string }> }
  expect(listed.messages.map(message => message.id)).toEqual([theirs.id])
  await expect(asDev.cancel_message({ message_id: mine.id, reason: 'forged', sessionId: 'lead' })).rejects.toThrow('Only its sender')
  expect(store.get(mine.id)?.state).toBe('queued')
  await expect(asDev.discard_message({ message_id: mine.id, reason: 'x' })).rejects.toThrow('Only a group with mailbox management')
  expect(await asDev.cancel_message({ message_id: theirs.id, reason: 'oops' })).toMatchObject({ id: theirs.id, state: 'cancelled' })
  for (const name of ['list_mailbox', 'cancel_message', 'discard_message']) {
    expect(TEAM_ALLOWED_TOOLS).toContain(`mcp__kawai-team__${name}`)
  }
  const server = await createMailboxServer(mailbox, 'lead', { management })
  expect(Object.keys((server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort())
    .toEqual(['cancel_message', 'discard_message', 'list_groups', 'list_mailbox', 'reply', 'schedule_message', 'send_message'])
  await server.instance.close()
})
