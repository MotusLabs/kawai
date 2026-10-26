// `worker` on send_message and schedule_message (dispatch-worker-choice 3.1,
// agent-mailbox spec "Group mail can name a worker" and "Invalid worker
// choices are refused"): group mail stores the canonical selector; direct
// mail, mail to the human, an unknown, ambiguous, or out-of-group worker, and
// a `worker` on `reply` are refused naming the reason, with nothing queued.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { schemaDb } from './schemaDb'
import type { ChatSessionRecord } from '../db'
import { TeamMailbox } from '../team/TeamMailbox'
import { MailboxStore } from '../team/mailboxStore'
import { mailboxHandlers, mailboxSchemas, teamToolTable } from '../team/mailboxTools'
import { resolveTeam } from '../team/teamIdentity'

let dir: string
let project: string
let db: Database
let store: MailboxStore
let mailbox: TeamMailbox
let records: Map<string, ChatSessionRecord>
let lead: ReturnType<typeof mailboxHandlers>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-mail-worker-'))
  project = path.join(dir, 'project')
  fs.mkdirSync(path.join(project, '.kawai/groups'), { recursive: true })
  // The shipped catalog: claude {default, opus, sonnet, haiku}, zai {glm, glm-flash}.
  fs.writeFileSync(path.join(project, '.kawai/groups/devs.md'), '---\ndescription: Developers\nprofiles: [sonnet, glm, glm-flash]\n---\nBuild')
  fs.writeFileSync(path.join(project, '.kawai/groups/leads.md'), '---\ndescription: Leads\n---\nLead')
  // The user-level catalog replaces the shipped one whole, so it is the shipped
  // providers plus a provider `glm`: the bare `glm` (also zai's model) is ambiguous.
  fs.mkdirSync(path.join(dir, '.kawai'), { recursive: true })
  const shipped = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../../../config/providers.default.json'), 'utf8'))
  fs.writeFileSync(path.join(dir, '.kawai/providers.json'), JSON.stringify({
    ...shipped, glm: { label: 'GLM direct', models: { 'glm-direct': { label: 'GLM direct', model: 'sonnet' } } },
  }))
  const row = (id: string, groupId: string): ChatSessionRecord => ({
    sessionId: id, projectPath: project, groupId, name: id, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  })
  records = new Map([['lead', row('lead', 'leads')], ['dev', row('dev', 'devs')]])
  db = schemaDb(':memory:')
  store = new MailboxStore(db)
  mailbox = new TeamMailbox(store, { getSession: id => records.get(id), homeDir: dir })
  lead = mailboxHandlers(mailbox, 'lead')
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const group = { to_kind: 'group', to_id: 'devs', body: 'Build it' }
const queued = () => store.teamsWithQueuedMail()

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try { await run() } catch (error) { return error instanceof Error ? error.message : String(error) }
  throw new Error('expected a refusal')
}

describe('group mail names a worker', () => {
  // @covers: agent-mailbox › Group mail can name a worker › Provider choice
  test('a provider is stored as the provider and routed by it', async () => {
    const sent = await lead.send_message({ ...group, worker: 'zai' })
    expect(store.get(sent.id)).toMatchObject({ toKind: 'group', state: 'queued', workerChoice: 'zai' })
  })

  // @covers: agent-mailbox › Group mail can name a worker › Exact model
  test('a bare model key is stored as provider/model; provider/model is kept', async () => {
    expect((await lead.send_message({ ...group, worker: 'glm-flash' })).workerChoice).toBe('zai/glm-flash')
    expect((await lead.send_message({ ...group, worker: 'claude/sonnet' })).workerChoice).toBe('claude/sonnet')
  })

  // @covers: agent-mailbox › Group mail can name a worker › Scheduled mail keeps its choice
  test('schedule_message stores the choice on the scheduled row', async () => {
    const scheduled = await lead.schedule_message({ ...group, worker: 'claude', delay_seconds: 60 })
    expect(store.get(scheduled.id)).toMatchObject({ workerChoice: 'claude', deliverAt: scheduled.deliverAt })
  })

  test('a group listing no workers takes the default profile\'s: claude/default', async () => {
    const leads = { to_kind: 'group', to_id: 'leads', body: 'Plan it' }
    expect((await lead.send_message({ ...leads, worker: 'claude' })).workerChoice).toBe('claude')
    expect((await lead.send_message({ ...leads, worker: 'default' })).workerChoice).toBe('claude/default')
    const before = queued()
    expect(await refusal(() => lead.send_message({ ...leads, worker: 'zai' }))).toContain('not among group leads\'s workers: claude/default')
    expect(queued()).toEqual(before)
  })

  test('without a worker the row carries no choice', async () => {
    expect('workerChoice' in (await lead.send_message(group))).toBe(false)
  })
})

describe('invalid worker choices are refused with nothing queued', () => {
  // @covers: agent-mailbox › Invalid worker choices are refused › Not among the group's workers
  test('a worker the group does not list is refused naming the group\'s workers', async () => {
    const error = await refusal(() => lead.send_message({ ...group, worker: 'claude/opus' }))
    expect(error).toContain('not among group devs\'s workers: claude/sonnet, zai/glm, zai/glm-flash')
    expect(queued()).toEqual([])
  })

  // @covers: agent-mailbox › Invalid worker choices are refused › Unknown worker
  test('an unknown worker is refused naming the catalog', async () => {
    expect(await refusal(() => lead.send_message({ ...group, worker: 'nobody' }))).toContain('names no provider or model')
    expect(await refusal(() => lead.schedule_message({ ...group, worker: 'zai/opus', delay_seconds: 5 }))).toContain('names no model opus of provider zai')
    expect(queued()).toEqual([])
  })

  // @covers: agent-mailbox › Invalid worker choices are refused › Ambiguous bare id
  test('an ambiguous bare id asks for the provider/model form', async () => {
    expect(await refusal(() => lead.send_message({ ...group, worker: 'glm' }))).toContain('use the provider/model form (zai/glm)')
    expect(queued()).toEqual([])
  })

  // @covers: agent-mailbox › Invalid worker choices are refused › Direct mail
  // @covers: agent-mailbox › Invalid worker choices are refused › Mail to the human
  test('direct mail and mail to the human are refused: a choice applies only to group mail', async () => {
    const direct = await refusal(() => lead.send_message({ to_kind: 'session', to_id: 'dev', body: 'Go', worker: 'zai' }))
    expect(direct).toContain('applies only to group mail')
    const human = await refusal(() => lead.send_message({ to_kind: 'human', body: 'Hi', worker: 'zai' }))
    expect(human).toContain('applies only to group mail')
    const scheduled = await refusal(() => lead.schedule_message({ to_kind: 'session', to_id: 'dev', body: 'Later', worker: 'zai', delay_seconds: 5 }))
    expect(scheduled).toContain('applies only to group mail')
    // The human composer's send meets the same check.
    const team = await resolveTeam(project)
    expect(await refusal(() => mailbox.send({ kind: 'human', team }, { to_kind: 'session', to_id: 'dev', body: 'Go', worker: 'zai' })))
      .toContain('applies only to group mail')
    expect(queued()).toEqual([])
  })

  // @covers: agent-mailbox › Invalid worker choices are refused › Reply does not take a choice
  test('a worker given on reply is refused naming the reason', async () => {
    const asked = await mailboxHandlers(mailbox, 'dev').send_message({ to_kind: 'session', to_id: 'lead', body: 'Question' })
    store.claim(asked.id, 'lead'); store.markPushed(asked.id); store.markDelivered(asked.id)
    const before = db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }
    expect(await refusal(() => lead.reply({ message_id: asked.id, body: 'Answer', worker: 'zai' }))).toContain('A reply takes no worker choice')
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_messages').get()).toEqual(before)
  })
})

describe('tool schemas', () => {
  test('send_message and schedule_message take worker; reply only names it to refuse it', () => {
    expect(Object.keys(mailboxSchemas.send_message.shape)).toContain('worker')
    expect(Object.keys(mailboxSchemas.schedule_message.shape)).toContain('worker')
    const table = teamToolTable(mailbox, 'lead')
    const describe = (name: string) => table.find(spec => spec.name === name)!.description
    expect(describe('send_message')).toContain('worker')
    expect(describe('schedule_message')).toContain('worker')
  })
})
