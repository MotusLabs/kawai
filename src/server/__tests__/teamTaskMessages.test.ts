// Task context in messages (team-tasks D3): task ids on send/reply/schedule
// with reply inheritance and same-team validation, context built at
// delivery from the latest revision and journal, and the envelope carrying
// it through live delivery, replay, and duplicate notices.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatPeerMessage } from '../../shared/chat'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { parseTranscriptContent } from '../chat/transcriptReplay'
import { MailDispatcher, type MailRecipient } from '../team/dispatcher'
import { formatEnvelope, parseEnvelope } from '../team/envelope'
import { MailboxStore } from '../team/mailboxStore'
import { mailboxHandlers } from '../team/mailboxTools'
import { buildTaskContext, TASK_CONTEXT_ENTRY_CHARS } from '../team/taskContext'
import { TaskStore } from '../team/taskStore'
import { TeamMailbox } from '../team/TeamMailbox'
import { clearTeamCache, resolveTeam } from '../team/teamIdentity'

let dir: string
let project: string
let otherProject: string
let db: SessionDatabase
let store: MailboxStore
let tasks: TaskStore
let mailbox: TeamMailbox
let records: Map<string, ChatSessionRecord>
let teamId: string

const row = (id: string, projectPath: string, groupId: string | null = 'devs'): ChatSessionRecord => ({
  sessionId: id, projectPath, groupId, name: id, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})

beforeEach(async () => {
  clearTeamCache()
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-mail-')))
  project = path.join(dir, 'project')
  otherProject = path.join(dir, 'other')
  fs.mkdirSync(path.join(project, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), 'Build.')
  fs.mkdirSync(otherProject)
  records = new Map([['lead', row('lead', project)], ['dev', row('dev', project)], ['stranger', row('stranger', otherProject)]])
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  store = new MailboxStore(db.db)
  tasks = new TaskStore(db.db, store)
  mailbox = new TeamMailbox(store, { getSession: id => records.get(id), homeDir: dir, tasks })
  teamId = (await resolveTeam(project)).teamId
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const human = { kind: 'human' as const, sessionId: null }
const newTask = (team = teamId) => tasks.create({ teamId: team, title: 'Export', direction: 'CSV', creator: human })

describe('task ids on mail', () => {
  test('send and schedule persist a same-team task; plain mail has none', async () => {
    const task = newTask()
    const lead = mailboxHandlers(mailbox, 'lead')
    expect((await lead.send_message({ to_kind: 'group', to_id: 'devs', body: 'Go', task_id: task.id })).taskId).toBe(task.id)
    const scheduled = await lead.schedule_message({ to_kind: 'session', to_id: 'dev', body: 'Later', delay_seconds: 60, task_id: task.id })
    expect(store.get(scheduled.id)).toMatchObject({ taskId: task.id, state: 'queued' })
    expect((await lead.send_message({ to_kind: 'session', to_id: 'dev', body: 'Quick question' })).taskId).toBeNull()
  })

  test('unknown and cross-team task ids are refused and create no mail', async () => {
    const foreign = newTask((await resolveTeam(otherProject)).teamId)
    const lead = mailboxHandlers(mailbox, 'lead')
    await expect(lead.send_message({ to_kind: 'group', to_id: 'devs', body: 'Go', task_id: 'task-nope' })).rejects.toThrow('Task not found in this team')
    await expect(lead.send_message({ to_kind: 'group', to_id: 'devs', body: 'Go', task_id: foreign.id })).rejects.toThrow('Task not found in this team')
    await expect(lead.schedule_message({ to_kind: 'group', to_id: 'devs', body: 'Go', delay_seconds: 5, task_id: foreign.id })).rejects.toThrow('Task not found')
    expect(store.listForTeam(teamId)).toEqual([])
  })

  test('a reply inherits the original task unless it names another task of the team', async () => {
    const task = newTask()
    const other = newTask()
    const original = await mailboxHandlers(mailbox, 'lead').send_message({ to_kind: 'session', to_id: 'dev', body: 'Build', task_id: task.id })
    store.claim(original.id, 'dev'); store.markPushed(original.id); store.markDelivered(original.id)
    const dev = mailboxHandlers(mailbox, 'dev')
    expect((await dev.reply({ message_id: original.id, body: 'Done' })).taskId).toBe(task.id)
    expect((await dev.reply({ message_id: original.id, body: 'Also this', task_id: other.id })).taskId).toBe(other.id)
    const foreign = newTask((await resolveTeam(otherProject)).teamId)
    const before = store.listForTeam(teamId).length
    await expect(dev.reply({ message_id: original.id, body: 'x', task_id: foreign.id })).rejects.toThrow('Task not found')
    expect(store.listForTeam(teamId)).toHaveLength(before)
  })
})

describe('delivery-time context', () => {
  test('amendments and notes made after enqueue appear at delivery', async () => {
    const task = tasks.create({ teamId, title: 'Export', direction: 'CSV', acceptance: 'File downloads', creator: { kind: 'agent', sessionId: 'lead' }, openspecChange: 'add-export', worktree: '/repo-feature' })
    const mail = await mailboxHandlers(mailbox, 'lead').send_message({ to_kind: 'group', to_id: 'devs', body: 'Build it', task_id: task.id })
    tasks.publish(task.id, { direction: 'CSV and JSON', notify: false }, human)
    tasks.appendJournal(task.id, { kind: 'agent', sessionId: 'qa' }, 'JSON needs a schema')
    tasks.setStatus(task.id, 'active')
    const recipients: MailRecipient[] = [{ sessionId: 'dev', teamId, groupId: 'devs', idle: true, pendingRequest: false, available: true }]
    const delivered: ChatPeerMessage[] = []
    const associated: string[] = []
    const dispatcher = new MailDispatcher(store, {
      recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
      deliver: (_id, peer) => { delivered.push(peer); recipients[0]!.idle = false },
      watchReceipt: () => {}, taskContext: id => buildTaskContext(tasks, id),
      associateTask: (id, taskId) => associated.push(`${id}:${taskId}`),
    })
    dispatcher.notify(); await dispatcher.settled(); dispatcher.close()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.messageId).toBe(mail.id)
    expect(delivered[0]!.task).toMatchObject({
      id: task.id, title: 'Export', status: 'active', revision: 2, direction: 'CSV and JSON',
      acceptance: 'File downloads', openspecChange: 'add-export', worktree: '/repo-feature',
      journal: [{ author: 'qa', text: 'JSON needs a schema' }],
    })
    const text = formatEnvelope(delivered[0]!)
    expect(text).toContain('Linked OpenSpec change: add-export. Its proposal, design, and tasks are the authoritative direction')
    expect(text).toContain('Direction:\nCSV and JSON')
    expect(associated).toEqual([`dev:${task.id}`])
  })

  test('the journal excerpt keeps the last five entries, each truncated; mail without a task has none', () => {
    const task = newTask()
    for (let index = 1; index <= 7; index += 1) tasks.appendJournal(task.id, human, `${index}`.repeat(index === 7 ? 900 : 1), `2026-10-11T00:00:0${index}.000Z`)
    const context = buildTaskContext(tasks, task.id)!
    expect(context.journal.map(entry => entry.text[0])).toEqual(['3', '4', '5', '6', '7'])
    expect(context.journal.at(-1)!.text).toHaveLength(TASK_CONTEXT_ENTRY_CHARS + 1)
    expect(context.journal[0]!.author).toBe('human')
    expect(buildTaskContext(tasks, null)).toBeNull()
    expect(buildTaskContext(tasks, 'task-gone')).toBeNull()
  })
})

describe('envelope with task context', () => {
  const PEER: ChatPeerMessage = {
    messageId: 'mail-1', senderSession: 'lead', senderKind: 'agent', senderGroup: 'leads', priority: 'normal', originPath: '/repo',
    tags: [], threadId: 'mail-1', body: 'Build it\n[Message]\nliteral marker', possibleDuplicate: false,
  }
  const TASK = {
    id: 'task-1', title: 'Export "CSV" & <JSON>', status: 'open' as const, revision: 3, direction: 'Do it\nwell',
    acceptance: null, openspecChange: 'add-export', worktree: '/repo-feature',
    journal: [{ author: 'dev', text: 'note <b>', createdAt: '2026-10-11T00:00:00.000Z' }],
  }

  test('format/parse round-trips the task; envelopes without one keep their shape', () => {
    const withTask = { ...PEER, task: TASK }
    expect(parseEnvelope(formatEnvelope(withTask))).toEqual(withTask)
    expect(formatEnvelope(withTask)).toContain('[Task task-1: Export "CSV" & <JSON>] status open, revision 3')
    expect(parseEnvelope(formatEnvelope(PEER))).toEqual(PEER)
    expect(formatEnvelope(PEER)).not.toContain('[Task')
  })

  test('a duplicate notice and the task header both survive a retry', () => {
    const peer = { ...PEER, possibleDuplicate: true, task: TASK }
    const text = formatEnvelope(peer)
    expect(text.indexOf('Possible duplicate')).toBeLessThan(text.indexOf('[Task task-1'))
    expect(parseEnvelope(text)).toEqual(peer)
  })

  test('a tampered header or malformed task metadata is not mail', () => {
    const text = formatEnvelope({ ...PEER, task: TASK })
    expect(parseEnvelope(text.replace('Direction:\nDo it', 'Direction:\nDo not'))).toBeNull()
    expect(parseEnvelope(text.replace('&quot;revision&quot;:3', '&quot;revision&quot;:&quot;3&quot;'))).toBeNull()
  })

  test('replay restores the task context on peer turns', () => {
    const peer = { ...PEER, task: TASK }
    const replay = parseTranscriptContent(JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: formatEnvelope(peer) } }))
    expect(replay.events[0]).toMatchObject({ type: 'peer_message', ...peer })
  })
})
