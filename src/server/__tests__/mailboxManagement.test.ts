// Agent mailbox management (team-mailbox-management D1–D6): sender withdraw,
// manager cancel/discard, scoped listing, attribution, and refusals that
// write nothing. Groups are plain directories so no git is spawned.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { MailboxStore, type EnqueueInput } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { MailboxManagement, LIST_BODY_LIMIT, LIST_ROW_LIMIT } from '../team/mailboxManagement'
import { resolveTeam } from '../team/teamIdentity'
import type { WaitingReason } from '../../shared/team'

let dir: string
let project: string
let outside: string
let sessionDb: SessionDatabase
let db: Database
let store: MailboxStore
let taskStore: TaskStore
let management: MailboxManagement
let records: Map<string, ChatSessionRecord>
let teamId: string
let waiting: Record<string, WaitingReason>

const row = (sessionId: string, groupId: string, projectPath = project): ChatSessionRecord => ({
  sessionId, groupId, projectPath, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})
const group = (id: string, frontmatter = '') => fs.writeFileSync(path.join(project, '.kawai/groups', `${id}.md`), `---\n${frontmatter}\n---\n${id} role`)

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-mail-mgmt-')))
  project = path.join(dir, 'project')
  outside = path.join(dir, 'outside')
  fs.mkdirSync(path.join(project, '.kawai/groups'), { recursive: true })
  fs.mkdirSync(outside)
  group('lead', 'canManageMailbox: true')
  group('devs')
  records = new Map([
    ['lead', row('lead', 'lead')], ['dev', row('dev', 'devs')], ['dev2', row('dev2', 'devs')],
    ['stranger', row('stranger', 'devs', outside)],
  ])
  sessionDb = initDatabase({ path: path.join(dir, 'mail.db') })
  db = sessionDb.db
  store = new MailboxStore(db)
  taskStore = new TaskStore(db, store)
  waiting = {}
  management = new MailboxManagement(store, {
    getSession: id => records.get(id), tasks: new TaskService(taskStore, { getSession: id => records.get(id), homeDir: dir }),
    waitingFor: () => waiting, homeDir: dir,
  })
  teamId = (await resolveTeam(project)).teamId
})
afterEach(() => { sessionDb.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const send = (overrides: Partial<EnqueueInput> = {}) => store.enqueue({
  teamId, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'lead', originPath: project, body: 'Do the thing', ...overrides,
})
const claim = (id: string, by = 'dev') => { store.claim(id, by) }
const deliver = (id: string, by = 'dev') => { claim(id, by); store.markPushed(id); store.markDelivered(id) }
/** The event count and row, to prove a refusal wrote nothing. */
const snapshot = (id: string) => JSON.stringify([store.get(id), store.eventsFor(id)])

describe('sender withdraw', () => {
  test('a sender cancels its own queued, scheduled, and awaiting-request mail', async () => {
    const queued = send()
    const scheduled = send({ deliverAt: '2099-01-01T00:00:00.000Z', toKind: 'session', toId: 'lead' })
    const held = send({ toKind: 'session', toId: 'dev', priority: 'urgent' })
    store.holdForRequest(held.id)
    for (const message of [queued, scheduled, held]) {
      expect(await management.cancel('lead', { message_id: message.id, reason: 'stale' })).toMatchObject({ id: message.id, state: 'cancelled' })
      expect(store.get(message.id)).toMatchObject({ state: 'cancelled', reason: 'cancelled by lead: stale' })
      expect(store.eventsFor(message.id).at(-1)).toMatchObject({ kind: 'cancelled', actor: 'agent', actorSession: 'lead', reason: 'cancelled by lead: stale' })
    }
    expect(store.nextEligible({ teamId, sessionId: 'dev', groupId: 'devs' }, '2100-01-01T00:00:00.000Z')).toBeNull()
  })

  test('claimed, spawning, and delivered mail is refused naming the state, and nothing is written', async () => {
    const claimed = send({ toKind: 'session', toId: 'dev' }); claim(claimed.id)
    const spawning = send(); store.reserveForSpawn(spawning.id)
    const delivered = send(); deliver(delivered.id)
    const expected = [[claimed, 'claimed by dev'], [spawning, 'a member is starting'], [delivered, 'delivered']] as const
    for (const [message, text] of expected) {
      const before = snapshot(message.id)
      await expect(management.cancel('lead', { message_id: message.id, reason: 'x' })).rejects.toThrow(text)
      expect(snapshot(message.id)).toBe(before)
    }
  })

  test('a non-sender without management is refused and the row is untouched', async () => {
    const mine = send({ fromSession: 'dev', fromGroup: 'devs' })
    const before = snapshot(mine.id)
    await expect(management.cancel('dev2', { message_id: mine.id, reason: 'x' })).rejects.toThrow('Only its sender, a group with mailbox management, or the human')
    expect(snapshot(mine.id)).toBe(before)
  })

  test('a plain sender cannot cancel its own parked work', async () => {
    const work = send({ fromSession: 'dev', fromGroup: 'devs', toKind: 'session', toId: 'dev' })
    deliver(work.id)
    store.park(work.id, '2099-01-01T00:00:00.000Z', send({ toKind: 'session', toId: 'dev' }).id)
    const before = snapshot(work.id)
    await expect(management.cancel('dev', { message_id: work.id, reason: 'x' })).rejects.toThrow('Only a group with mailbox management')
    expect(snapshot(work.id)).toBe(before)
  })

  test('an empty or blank reason is refused', async () => {
    const mine = send()
    for (const reason of ['', '   ', undefined]) {
      await expect(management.cancel('lead', { message_id: mine.id, reason })).rejects.toThrow('A reason is required')
    }
    expect(store.get(mine.id)?.state).toBe('queued')
  })

  test('agent text is cut to 300 characters on the row', async () => {
    const mine = send()
    await management.cancel('lead', { message_id: mine.id, reason: 'y'.repeat(900) })
    expect(store.get(mine.id)?.reason).toBe(`cancelled by lead: ${'y'.repeat(300)}`)
  })
})

describe('plain member withdraw', () => {
  test('a dev without management cancels the mail it sent', async () => {
    const mine = send({ fromSession: 'dev', fromGroup: 'devs', toKind: 'group', toId: 'lead' })
    await management.cancel('dev', { message_id: mine.id, reason: 'obsolete' })
    expect(store.get(mine.id)?.state).toBe('cancelled')
    expect(store.eventsFor(mine.id).at(-1)).toMatchObject({ actor: 'agent', actorSession: 'dev' })
  })

  test('a non-manager cannot discard even its own dead letter', async () => {
    const dead = send({ fromSession: 'dev', fromGroup: 'devs' })
    store.deadLetter(dead.id, 'killed-recipient')
    const before = snapshot(dead.id)
    await expect(management.discard('dev', { message_id: dead.id, reason: 'x' })).rejects.toThrow('Only a group with mailbox management')
    expect(snapshot(dead.id)).toBe(before)
  })
})

describe('manager cancel and discard', () => {
  test('a manager cancels mail another agent sent', async () => {
    const theirs = send({ fromSession: 'dev', fromGroup: 'devs', toKind: 'group', toId: 'lead' })
    await management.cancel('lead', { message_id: theirs.id, reason: 'duplicate' })
    expect(store.get(theirs.id)?.state).toBe('cancelled')
  })

  test('the right is read from the current group file on every call', async () => {
    const theirs = send({ fromSession: 'dev', fromGroup: 'devs' })
    group('lead', 'canManageMailbox: false')
    await expect(management.cancel('lead', { message_id: theirs.id, reason: 'x' })).rejects.toThrow('Only its sender')
    group('lead', 'canManageMailbox: true')
    await management.cancel('lead', { message_id: theirs.id, reason: 'x' })
    expect(store.get(theirs.id)?.state).toBe('cancelled')
  })

  test('a manager cancels parked work with its resume mail; the task journal notes it by the manager', async () => {
    const task = taskStore.create({ teamId, title: 'Review', direction: 'Do it', acceptance: null, creator: { kind: 'human', sessionId: null }, parentId: null, worktree: null, openspecChange: null })
    const work = send({ toKind: 'session', toId: 'dev', taskId: task.id })
    deliver(work.id)
    const resume = send({ toKind: 'session', toId: 'dev', fromSession: 'dev', deliverAt: '2099-01-01T00:00:00.000Z' })
    store.park(work.id, '2099-01-01T00:00:00.000Z', resume.id)
    expect(await management.cancel('lead', { message_id: work.id, reason: 'dev is stuck' })).toEqual({ id: work.id, state: 'cancelled', resumeMessage: resume.id })
    expect(store.get(work.id)?.state).toBe('cancelled')
    expect(store.get(resume.id)?.state).toBe('cancelled')
    const journal = taskStore.detail(task.id)!.journal
    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({ author: { kind: 'agent', sessionId: 'lead' } })
    expect(journal[0]!.text).toBe(`Cancelled message ${work.id} to session dev (parked): dev is stuck`)
  })

  test('a parked cancel while the resume turn is in flight is refused naming the holder', async () => {
    const work = send({ toKind: 'session', toId: 'dev' })
    deliver(work.id)
    const resume = send({ toKind: 'session', toId: 'dev', fromSession: 'dev' })
    store.park(work.id, '2099-01-01T00:00:00.000Z', resume.id)
    claim(resume.id)
    const before = snapshot(work.id)
    await expect(management.cancel('lead', { message_id: work.id, reason: 'x' })).rejects.toThrow('dev is resuming this parked work now')
    expect(snapshot(work.id)).toBe(before)
  })

  test('a holder cannot strand its parked work by cancelling its own resume; a manager cannot either', async () => {
    const work = send({ toKind: 'session', toId: 'dev' })
    deliver(work.id)
    const resume = send({ toKind: 'session', toId: 'dev', fromSession: 'dev', fromGroup: 'devs', deliverAt: '2099-01-01T00:00:00.000Z' })
    store.park(work.id, '2099-01-01T00:00:00.000Z', resume.id)
    for (const caller of ['dev', 'lead']) {
      const before = snapshot(resume.id)
      await expect(management.cancel(caller, { message_id: resume.id, reason: 'x' })).rejects.toThrow(`Cancel the parked message ${work.id} instead`)
      expect(snapshot(resume.id)).toBe(before)
    }
    expect(store.get(work.id)?.state).toBe('parked')
  })

  test('a journal failure is logged and does not undo the cancel', async () => {
    const task = taskStore.create({ teamId, title: 'T', direction: 'D', acceptance: null, creator: { kind: 'human', sessionId: null }, parentId: null, worktree: null, openspecChange: null })
    const message = send({ taskId: task.id })
    db.exec(`DELETE FROM team_tasks WHERE id = '${task.id}'`)
    await management.cancel('lead', { message_id: message.id, reason: 'gone task' })
    expect(store.get(message.id)?.state).toBe('cancelled')
  })

  test('discard works for dead and uncertain mail, with the reason on the row and in history', async () => {
    const dead = send(); store.deadLetter(dead.id, 'killed-recipient')
    const uncertain = send({ toKind: 'session', toId: 'dev' }); claim(uncertain.id); store.holdUncertain(uncertain.id, 'torn')
    for (const message of [dead, uncertain]) {
      expect(await management.discard('lead', { message_id: message.id, reason: 'already handled' })).toEqual({ id: message.id, state: 'discarded' })
      expect(store.get(message.id)?.reason).toBe('discarded by lead: already handled')
      expect(store.eventsFor(message.id).at(-1)).toMatchObject({ kind: 'discarded', actor: 'agent', actorSession: 'lead' })
    }
  })

  test('discard of live states and a missing reason is refused without writing', async () => {
    const queued = send()
    const before = snapshot(queued.id)
    await expect(management.discard('lead', { message_id: queued.id, reason: 'x' })).rejects.toThrow('Only dead or uncertain')
    const dead = send(); store.deadLetter(dead.id, 'k')
    await expect(management.discard('lead', { message_id: dead.id, reason: ' ' })).rejects.toThrow('A reason is required')
    expect(snapshot(queued.id)).toBe(before)
    expect(store.get(dead.id)?.state).toBe('dead')
  })

  test('another team’s message reads as not found, for cancel, discard, and a manager', async () => {
    const foreign = store.enqueue({ teamId: '/elsewhere/.git', toKind: 'group', toId: 'devs', fromSession: 'x', fromGroup: null, originPath: '/e', body: 'secret' })
    const before = snapshot(foreign.id)
    await expect(management.cancel('lead', { message_id: foreign.id, reason: 'x' })).rejects.toThrow(`Message not found in this team: ${foreign.id}`)
    await expect(management.discard('lead', { message_id: foreign.id, reason: 'x' })).rejects.toThrow('Message not found in this team')
    await expect(management.cancel('lead', { message_id: 'nope', reason: 'x' })).rejects.toThrow('Message not found in this team: nope')
    expect(snapshot(foreign.id)).toBe(before)
  })

  test('an unknown calling session is refused', async () => {
    await expect(management.cancel('ghost', { message_id: 'x', reason: 'y' })).rejects.toThrow('Unknown calling session')
  })
})

describe('list', () => {
  test('a plain member sees only mail it sent, mail addressed to it, and mail it holds', async () => {
    const sent = send({ fromSession: 'dev', fromGroup: 'devs', toKind: 'group', toId: 'lead' })
    const toMe = send({ toKind: 'session', toId: 'dev' })
    const held = send({ toKind: 'group', toId: 'devs' }); claim(held.id, 'dev')
    send({ fromSession: 'dev2', fromGroup: 'devs', toKind: 'group', toId: 'lead' })
    send({ toKind: 'session', toId: 'dev2' })
    send() // group mail to devs: shared work it has not taken
    const result = await management.list('dev')
    expect(result.scope).toBe('own')
    expect(result.messages.map(message => message.id).sort()).toEqual([sent.id, toMe.id, held.id].sort())
    expect(result.omitted).toBe(0)
  })

  test('a manager sees the whole team and never another team’s mail', async () => {
    const a = send(); const b = send({ fromSession: 'dev', fromGroup: 'devs' })
    store.enqueue({ teamId: '/elsewhere/.git', toKind: 'group', toId: 'devs', fromSession: 'x', fromGroup: null, originPath: '/e', body: 'other team' })
    const result = await management.list('lead')
    expect(result.scope).toBe('team')
    expect(result.messages.map(message => message.id).sort()).toEqual([a.id, b.id].sort())
  })

  test('filters narrow by state, to, from, and task; settled mail is not listed', async () => {
    const task = taskStore.create({ teamId, title: 'T', direction: 'D', acceptance: null, creator: { kind: 'human', sessionId: null }, parentId: null, worktree: null, openspecChange: null })
    const queuedForTask = send({ taskId: task.id })
    const direct = send({ toKind: 'session', toId: 'dev', fromSession: 'dev2', fromGroup: 'devs' })
    const dead = send(); store.deadLetter(dead.id, 'killed')
    const cancelled = send(); store.cancel(cancelled.id, { kind: 'human' })
    const ids = async (filters: Parameters<MailboxManagement['list']>[1]) => (await management.list('lead', filters)).messages.map(message => message.id).sort()
    expect(await ids({})).toEqual([queuedForTask.id, direct.id, dead.id].sort())
    expect(await ids({ state: ['dead'] })).toEqual([dead.id])
    expect(await ids({ to: 'dev' })).toEqual([direct.id])
    expect(await ids({ from: 'dev2' })).toEqual([direct.id])
    expect(await ids({ task_id: task.id })).toEqual([queuedForTask.id])
  })

  test('entries carry the waiting blocker, age, reason, and a cut body; the list is capped with an omitted count', async () => {
    const long = send({ body: 'z'.repeat(LIST_BODY_LIMIT + 50) })
    waiting[long.id] = { blocker: { kind: 'no-eligible-member' }, others: [] }
    const dead = send(); store.deadLetter(dead.id, 'killed-recipient')
    const { messages } = await management.list('lead', { state: ['queued', 'dead'] })
    const entry = messages.find(message => message.id === long.id)!
    expect(entry).toMatchObject({
      state: 'queued', priority: 'normal', from: { kind: 'agent', session: 'lead', group: 'lead' }, to: { kind: 'group', id: 'devs' },
      waiting: { kind: 'no-eligible-member' }, bodyTruncated: true,
    })
    expect(entry.body).toHaveLength(LIST_BODY_LIMIT)
    expect(entry.ageMinutes).toBeGreaterThanOrEqual(0)
    expect(messages.find(message => message.id === dead.id)).toMatchObject({ reason: 'killed-recipient', waiting: null, bodyTruncated: false })
    // One transaction: each send() commits on its own, and 100+ synced commits
    // blow the 5 s per-test timeout when the suite runs under load.
    db.transaction(() => { for (let i = 0; i < LIST_ROW_LIMIT + 5; i++) send() })()
    const capped = await management.list('lead')
    expect(capped.messages).toHaveLength(LIST_ROW_LIMIT)
    expect(capped.omitted).toBe(7)
  })
})
