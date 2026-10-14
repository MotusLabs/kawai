// Revision notices (task-revision-publication 3.1/3.3/4.1, design D3–D5):
// direct normal-priority task mail to the outstanding assignment's claimant,
// written in the publication transaction, never group mail; keyed notify and
// retry that never write a revision; and recipients whose notice state,
// delivered revision, and acknowledged revision stay separate.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { buildTaskContext } from '../team/taskContext'
import type { TeamIdentity } from '../team/teamIdentity'

const team = { teamId: '/repo/.git', groupsRoot: '/repo' } as unknown as TeamIdentity
const human = { kind: 'human' as const, team }

let dir: string
let session: SessionDatabase
let mail: MailboxStore
let assignments: AssignmentStore
let store: TaskStore
let service: TaskService
let records: Map<string, ChatSessionRecord>
let restored: string[]

const record = (sessionId: string, extra: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId, name: sessionId, projectPath: '/repo', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  groupId: 'devs', ...extra,
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-notices-'))
  session = initDatabase({ path: path.join(dir, 'tasks.db') })
  mail = new MailboxStore(session.db)
  assignments = new AssignmentStore(session.db, mail)
  store = new TaskStore(session.db, mail, assignments)
  records = new Map([['dev', record('dev')], ['dev2', record('dev2')]])
  restored = []
  service = new TaskService(store, {
    getSession: id => records.get(id),
    restoreSession: id => { restored.push(id); records.get(id)!.archivedAt = null },
  })
})
afterEach(() => { assignments.close(); session.close(); fs.rmSync(dir, { recursive: true, force: true }) })

/** A task with a group assignment whose instruction mail is queued (task-assignment D3). */
function assignedTask() {
  const task = store.create({ teamId: team.teamId, title: 'Export', direction: 'v1', creator: { kind: 'human', sessionId: null } })
  const { assignment } = assignments.insert({
    teamId: team.teamId, taskId: task.id, requestKey: `assign-${task.id}`, targetKind: 'group', targetId: 'devs', role: 'devs',
    instruction: 'Build it', creator: { kind: 'human', sessionId: null },
  })
  const instruction = mail.enqueue({ teamId: team.teamId, toKind: 'group', toId: 'devs', fromKind: 'human', fromSession: null,
    fromGroup: null, originPath: '/repo', body: 'Build it', taskId: task.id })
  assignments.setMessage(assignment.id, instruction.id)
  return { task, assignmentId: assignment.id, instructionId: instruction.id }
}
/** A dispatch pass hands a message to a session: claim, push with the task revision, deliver. */
function deliver(messageId: string, sessionId: string, revision: number | null, settle = true) {
  mail.claim(messageId, sessionId)
  mail.markPushed(messageId, undefined, revision)
  if (settle) mail.markDelivered(messageId)
}
const noticeRows = (taskId: string) => mail.forTask(taskId).filter(message => message.tags.includes('task-revision'))
const groupRows = (taskId: string) => mail.forTask(taskId).filter(message => message.toKind === 'group')
const publish = (taskId: string, extra: Record<string, unknown> = {}) =>
  service.publish(human, taskId, { direction: 'v2', rationale: 'Scope changed', baseRevision: 1, requestKey: 'publish-1', notify: true, ...extra })
const recipient = (taskId: string, revision = 2) =>
  store.detail(taskId)!.publications!.find(publication => publication.revision === revision)!.recipients

test('publish and notify sends the busy claimant one direct, normal-priority, task-revision notice — never group mail', async () => {
  const { task, assignmentId, instructionId } = assignedTask()
  // The developer claimed the instruction and is mid-turn on it.
  deliver(instructionId, 'dev', 1, false)
  await publish(task.id)
  const notices = noticeRows(task.id)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({
    toKind: 'session', toId: 'dev', priority: 'normal', tags: ['task-revision'], state: 'queued',
    fromKind: 'human', fromSession: null, taskId: task.id,
    revisionNotice: { revision: 2, previousRevision: 1, assignmentId, rationale: 'Scope changed' },
  })
  expect(notices[0]!.body).toBe('Task Export revision 2 published by the human: Scope changed. ' +
    'Read the direction above and call task_acknowledge(task_id, <revision in the header>) when you are working from it.')
  // Only the original instruction is group mail.
  expect(groupRows(task.id).map(row => row.id)).toEqual([instructionId])
  expect(recipient(task.id)).toMatchObject([{ sessionId: 'dev', assignmentId, noticeState: 'queued' }])
})

test('an unclaimed group assignment gets no notice; its instruction carries the latest revision when delivered', async () => {
  const { task, instructionId } = assignedTask()
  await publish(task.id)
  expect(noticeRows(task.id)).toEqual([])
  expect(store.detail(task.id)!.publications![0]!.recipients).toEqual([])
  // The dispatcher builds the context at push: the queued instruction carries revision 2.
  expect(buildTaskContext(store, task.id)?.revision).toBe(2)
  deliver(instructionId, 'dev', buildTaskContext(store, task.id)!.revision)
  expect(mail.get(instructionId)?.taskRevision).toBe(2)
})

test('a replay of a notifying publication under its key with notify off is refused, and sends nothing more', async () => {
  const { task, instructionId } = assignedTask()
  deliver(instructionId, 'dev', 1)
  await publish(task.id)
  await expect(publish(task.id, { notify: false })).rejects.toThrow('different notify')
  expect(noticeRows(task.id)).toHaveLength(1)
  expect(store.revisions(task.id)).toHaveLength(2)
})

test('plain publish sends nothing and its recipients show Not notified', async () => {
  const { task, instructionId } = assignedTask()
  deliver(instructionId, 'dev', 1)
  await publish(task.id, { notify: false })
  expect(noticeRows(task.id)).toEqual([])
  expect(recipient(task.id)).toMatchObject([{ sessionId: 'dev', noticeState: 'not-notified', deliveredRevision: 1, acknowledgedRevision: null }])
})

test('a killed claimant\'s notice is dead-lettered while the revision stands', async () => {
  const { task, instructionId } = assignedTask()
  deliver(instructionId, 'dev', 1)
  records.delete('dev')
  await publish(task.id)
  expect(store.get(task.id)?.revision).toBe(2)
  expect(noticeRows(task.id)).toMatchObject([{ state: 'dead', reason: 'killed-recipient' }])
  expect(recipient(task.id)).toMatchObject([{ noticeState: 'failed', reason: 'killed-recipient' }])
})

test('notices commit or roll back with the publication', async () => {
  const { task, instructionId } = assignedTask()
  deliver(instructionId, 'dev', 1)
  const enqueue = mail.enqueue.bind(mail)
  mail.enqueue = () => { throw new Error('disk full') }
  await expect(publish(task.id)).rejects.toThrow('disk full')
  mail.enqueue = enqueue
  // Neither the revision nor any notice exists: one transaction.
  expect(store.get(task.id)?.revision).toBe(1)
  expect(store.revisions(task.id)).toHaveLength(1)
  expect(noticeRows(task.id)).toEqual([])
  expect((session.db.prepare('SELECT COUNT(*) AS n FROM team_task_notifications').get() as { n: number }).n).toBe(0)
})

test('an archived claimant is restored after its notice commits', async () => {
  const { task, instructionId } = assignedTask()
  deliver(instructionId, 'dev', 1)
  records.get('dev')!.archivedAt = '2026-10-14T00:00:00.000Z'
  await publish(task.id)
  expect(restored).toEqual(['dev'])
  expect(noticeRows(task.id)).toMatchObject([{ toId: 'dev', state: 'queued' }])
})

// Notify and retry (3.3, D4): one keyed command, never a revision.
const notificationRows = () => (session.db.prepare('SELECT COUNT(*) AS n FROM team_task_notifications').get() as { n: number }).n

test('notify later after a plain publish sends one notice; its replay sends none; no revision is written', async () => {
  const { task, instructionId } = assignedTask()
  deliver(instructionId, 'dev', 1)
  await publish(task.id, { notify: false })
  const first = await service.notify(human, task.id, 2, 'notify-1')
  const replay = await service.notify(human, task.id, 2, 'notify-1')
  expect(first).toMatchObject({ replay: false, notices: [{ sessionId: 'dev' }] })
  expect(replay).toMatchObject({ replay: true, notices: first.notices })
  expect(noticeRows(task.id)).toHaveLength(1)
  expect(store.revisions(task.id)).toHaveLength(2)
  expect(store.get(task.id)?.revision).toBe(2)
})

test('retry after a dead-lettered notice sends exactly one new notice; the failed one stays in history', async () => {
  const { task, instructionId } = assignedTask()
  deliver(instructionId, 'dev', 1)
  await publish(task.id)
  const [failed] = noticeRows(task.id)
  mail.deadLetter(failed!.id, 'hop-limit')
  expect(recipient(task.id)).toMatchObject([{ noticeState: 'failed', reason: 'hop-limit', noticeMessageId: failed!.id }])
  await service.notify(human, task.id, 2, 'retry-1')
  await service.notify(human, task.id, 2, 'retry-1')
  const notices = noticeRows(task.id)
  expect(notices.map(row => row.state)).toEqual(['dead', 'queued'])
  expect(notificationRows()).toBe(2)
  // The newest notice decides the state; the revision count never moved.
  expect(recipient(task.id)).toMatchObject([{ noticeState: 'queued', noticeMessageId: notices[1]!.id }])
  expect(store.revisions(task.id)).toHaveLength(2)
})

test('notify skips a holder already delivered the revision, or holding a pending or uncertain notice', async () => {
  const { task, instructionId } = assignedTask()
  deliver(instructionId, 'dev', 1)
  await publish(task.id)
  // Pending: the queued notice already covers it.
  expect((await service.notify(human, task.id, 2, 'notify-pending')).notices).toEqual([])
  // Uncertain: the mailbox's own Retry/Discard resolves it, not a duplicate here.
  const [notice] = noticeRows(task.id)
  deliver(notice!.id, 'dev', 2, false)
  mail.holdUncertain(notice!.id, 'transcript-unreadable')
  expect((await service.notify(human, task.id, 2, 'notify-uncertain')).notices).toEqual([])
  expect(recipient(task.id)).toMatchObject([{ noticeState: 'uncertain', reason: 'transcript-unreadable' }])
  // Delivered: other task mail carrying revision 2 reached the developer.
  mail.discard(notice!.id, { kind: 'human' })
  const other = mail.enqueue({ teamId: team.teamId, toKind: 'session', toId: 'dev', fromKind: 'human', fromSession: null,
    fromGroup: null, originPath: '/repo', body: 'more', taskId: task.id })
  deliver(other.id, 'dev', 2)
  expect((await service.notify(human, task.id, 2, 'notify-delivered')).notices).toEqual([])
  expect(store.revisions(task.id)).toHaveLength(2)
})

test('notify refuses an unpublished revision and a missing key', async () => {
  const { task } = assignedTask()
  await expect(service.notify(human, task.id, 2, 'notify-1')).rejects.toThrow('Revision 2 of this task is not published')
  await expect(service.notify(human, task.id, 1, ' ')).rejects.toThrow('request key')
})

// Delivered and acknowledged (4.1, D5): separate facts, never merged.
test('delivered but not acknowledged, then acknowledged later', async () => {
  const { task, instructionId } = assignedTask()
  deliver(instructionId, 'dev', 1)
  store.acknowledgements.record(task.id, 'dev', 1, null)
  await publish(task.id)
  const [notice] = noticeRows(task.id)
  deliver(notice!.id, 'dev', 2)
  expect(recipient(task.id)).toMatchObject([{ noticeState: 'delivered', deliveredRevision: 2, acknowledgedRevision: 1 }])
  store.acknowledgements.record(task.id, 'dev', 2, null)
  expect(recipient(task.id)).toMatchObject([{ noticeState: 'delivered', deliveredRevision: 2, acknowledgedRevision: 2 }])
})

test('a non-notice task message counts as delivering its revision', async () => {
  const { task, instructionId } = assignedTask()
  deliver(instructionId, 'dev', 1)
  await publish(task.id, { notify: false })
  const note = mail.enqueue({ teamId: team.teamId, toKind: 'session', toId: 'dev', fromKind: 'human', fromSession: null,
    fromGroup: null, originPath: '/repo', body: 'one more thing', taskId: task.id })
  deliver(note.id, 'dev', 2)
  expect(recipient(task.id)).toMatchObject([{ noticeState: 'not-notified', deliveredRevision: 2, acknowledgedRevision: null }])
})

// Replacement claimants (4.3, D6): only the current claimant's acknowledgement shows.
test('a reassigned task starts unacknowledged; the earlier claimant\'s acknowledgement stays in history', async () => {
  const { task, assignmentId, instructionId } = assignedTask()
  deliver(instructionId, 'dev', 1)
  await publish(task.id, { notify: false })
  store.acknowledgements.record(task.id, 'dev', 2, assignmentId)
  const { assignment: next } = assignments.insert({ teamId: team.teamId, taskId: task.id, requestKey: 'assign-2', targetKind: 'session',
    targetId: 'dev2', role: 'devs', instruction: 'Take over', creator: { kind: 'human', sessionId: null } })
  const handover = mail.enqueue({ teamId: team.teamId, toKind: 'session', toId: 'dev2', fromKind: 'human', fromSession: null,
    fromGroup: null, originPath: '/repo', body: 'Take over', taskId: task.id })
  assignments.setMessage(next.id, handover.id)
  assignments.supersede(assignmentId, next.id)
  deliver(handover.id, 'dev2', 2)
  expect(recipient(task.id)).toMatchObject([{ sessionId: 'dev2', assignmentId: next.id, deliveredRevision: 2, acknowledgedRevision: null }])
  expect(store.detail(task.id)!.acknowledgements).toMatchObject([{ sessionId: 'dev', revision: 2, assignmentId }])
  store.acknowledgements.record(task.id, 'dev2', 2, next.id)
  expect(recipient(task.id)).toMatchObject([{ sessionId: 'dev2', acknowledgedRevision: 2 }])
})

test('work requeued to another member starts unacknowledged for the new claimant', async () => {
  const { task, instructionId } = assignedTask()
  mail.claim(instructionId, 'dev')
  store.acknowledgements.record(task.id, 'dev', 1, null)
  await publish(task.id, { notify: false })
  mail.requeue(instructionId)
  expect(recipient(task.id)).toEqual([])
  mail.claim(instructionId, 'dev2')
  expect(recipient(task.id)).toMatchObject([{ sessionId: 'dev2', acknowledgedRevision: null }])
})

test('work forwarded after a provider limit must be re-acknowledged by its new holder', async () => {
  const { task, assignmentId, instructionId } = assignedTask()
  deliver(instructionId, 'dev', 1)
  store.acknowledgements.record(task.id, 'dev', 1, assignmentId)
  await publish(task.id, { notify: false })
  mail.markForwarded(instructionId, 'limit')
  const original = mail.get(instructionId)!
  const successor = mail.enqueue({ teamId: team.teamId, toKind: 'group', toId: 'devs', fromSession: 'dev', fromGroup: 'devs',
    originPath: '/repo', body: 'Build it', inReplyTo: original, attachThread: true, taskId: task.id,
    handoff: { fromSession: 'dev', fromProfile: 'default', claimCommit: null, lastError: 'limit', progress: { toolCalls: 0, tools: [], digest: '' } } as never })
  mail.claim(successor.id, 'dev2')
  expect(recipient(task.id)).toMatchObject([{ sessionId: 'dev2', assignmentId, acknowledgedRevision: null }])
  // A notice for the publication now reaches the forwarded holder.
  await service.notify(human, task.id, 2, 'notify-forwarded')
  expect(noticeRows(task.id)).toMatchObject([{ toId: 'dev2' }])
})

// The revision-published fact (2.3, D8): the revision row is the contract.
test('one revision-published fact per publication: replays, retries, drafts, and acknowledgements add none', async () => {
  const { task, instructionId } = assignedTask()
  deliver(instructionId, 'dev', 1)
  const heard: number[] = []
  service.onRevisionPublished(event => heard.push(event.revision))
  const rows = () => (session.db.prepare('SELECT COUNT(*) AS n FROM team_task_revisions WHERE task_id = ?').get(task.id) as { n: number }).n
  const before = rows()
  await publish(task.id)
  await publish(task.id)
  const [notice] = noticeRows(task.id)
  mail.deadLetter(notice!.id, 'hop-limit')
  await service.notify(human, task.id, 2, 'retry-1')
  await service.notify(human, task.id, 2, 'retry-2')
  await service.saveDraft(human, task.id, { direction: 'next idea' })
  store.acknowledgements.record(task.id, 'dev', 2, null)
  expect(rows()).toBe(before + 1)
  expect(store.get(task.id)?.revision).toBe(2)
  expect(heard).toEqual([2])
})

// Historical rows (5.4, D9): publication, notify, and acknowledgement never rewrite them.
test('a delivered instruction and its thread keep the revision they carried after later publications', async () => {
  const { task, instructionId } = assignedTask()
  deliver(instructionId, 'dev', 1)
  await publish(task.id)
  await service.notify(human, task.id, 2, 'notify-1')
  store.acknowledgements.record(task.id, 'dev', 2, null)
  await publish(task.id, { direction: 'v3', baseRevision: 2, requestKey: 'publish-2', notify: false })
  expect(mail.get(instructionId)?.taskRevision).toBe(1)
  expect(store.get(task.id)?.revision).toBe(3)
})
