// Handoff dispositions (owner-publication-handoff D4, D6, task 5.1) over a
// real TaskService, store and mailbox: Table H-OTHER (another publication
// makes a pending handoff stale in its own transaction), H-SETTLE (decline
// and withdraw in the order team/id, right, reason, state) and H-CLOSE (a
// close through `setStatus` or `prepareStatus().commit` closes a pending
// handoff), with both orders of a publication and a close. Every refused
// row writes nothing: the snapshot of handoff, event, wakeup, revision and
// mail rows is identical before and after. The Adapt and override paths
// run through their real services in taskHandoffPaths.test.ts.
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
import type { HandoffRequestInput } from '../team/taskHandoffService'
import { HANDOFF_WAKEUP_TAG } from '../team/taskHandoffWakeups'
import { taskHandlers } from '../team/taskTools'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { SYSTEM_ACTOR } from '../../shared/team'
import { HANDOFF_STATES, type HandoffState } from '../../shared/taskHandoffs'

let root: string
let repo: string
let other: string
let db: Database
let records: Map<string, ChatSessionRecord>
let service: TaskService
let team: TeamIdentity
const human = (): TaskCaller => ({ kind: 'human', team })
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const kawai = (): TaskCaller => ({ kind: 'system', team, origin: { kind: 'execution', executionId: '' } })
const row = (sessionId: string, groupId: string | null, projectPath = repo): ChatSessionRecord => ({
  sessionId, groupId, projectPath, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})
const writeGroup = (id: string, content: string) => {
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', `${id}.md`), content)
}
const request = (extra: Partial<HandoffRequestInput> = {}): HandoffRequestInput => ({
  baseRevision: 1, direction: 'CSV with headers', rationale: 'Headers were missing', notify: false, requestKey: 'k1', ...extra,
})
const snapshot = () => Object.fromEntries(['team_task_handoffs', 'team_task_handoff_events', 'team_task_handoff_wakeups', 'team_task_revisions', 'team_messages', 'team_task_status_events']
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
const refusedWithNothing = async (run: () => Promise<unknown>, message: string | RegExp) => {
  const before = snapshot()
  await expect(run()).rejects.toThrow(message)
  expect(snapshot()).toEqual(before)
}
const setState = (id: string, state: HandoffState) => db.prepare('UPDATE team_task_handoffs SET state = ? WHERE id = ?').run(state, id)
const wakeups = (handoffId: string) => db.prepare('SELECT transition, message_id FROM team_task_handoff_wakeups WHERE handoff_id = ? ORDER BY rowid').all(handoffId) as Array<{ transition: string; message_id: string | null }>
const wakeMail = () => db.prepare('SELECT id, to_kind, to_id, task_id, tags, body, from_kind FROM team_messages WHERE tags LIKE ? ORDER BY rowid').all(`%${HANDOFF_WAKEUP_TAG}%`) as Array<Record<string, unknown>>
/** A Kawai task with an open handoff requested by `lead` (a live session of the `leads` group). */
const openHandoff = async () => {
  const task = service.store.create({ teamId: team.teamId, title: 'Export', direction: 'CSV', creator: SYSTEM_ACTOR })
  const { handoff } = await service.handoffs.request(agent('lead'), task.id, request())
  return { task, handoff }
}
/** A task owned by `cl` (change-leads) with an open handoff requested by `lead`. */
const ownedHandoff = async () => {
  const task = await service.create(agent('cl'), { title: 'Owned', direction: 'v1' })
  const { handoff } = await service.handoffs.request(agent('lead'), task.id, request())
  return { task, handoff }
}
const ordinary = (taskId: string, key: string, caller = human()) =>
  service.publish(caller, taskId, { direction: `Other ${key}`, rationale: 'mine first', notify: false, requestKey: key })

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-handoff-dispositions-')))
  repo = path.join(root, 'repo')
  other = path.join(root, 'other')
  for (const dir of [repo, other]) {
    const result = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8', env: cleanGitEnv() })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  clearTeamCache()
  fs.rmSync(path.join(repo, '.kawai'), { recursive: true, force: true })
  writeGroup('leads', '---\ncanCreateTasks: true\n---\nLead.')
  writeGroup('change-leads', '---\ncanCreateTasks: true\n---\nCoordinate.')
  writeGroup('devs', 'Build.')
  records = new Map([
    ['lead', row('lead', 'leads')], ['lead2', row('lead2', 'leads')], ['cl', row('cl', 'change-leads')],
    ['dev', row('dev', 'devs')], ['stranger', row('stranger', 'leads', other)],
  ])
  db?.close()
  db = schemaCopy()
  service = new TaskService(new TaskStore(db, new MailboxStore(db)), { getSession: id => records.get(id), homeDir: path.join(root, 'home') })
})

describe('H-OTHER: a publication not from this handoff', () => {
  // @covers: task-publication-handoffs › Another publication makes a pending handoff stale › The human publishes their own draft first
  test('H20: an ordinary publication turns the open handoff stale naming its revision, with one wakeup, and it cannot be published', async () => {
    for (const publishOther of [
      (taskId: string) => ordinary(taskId, 'mine'),
      (taskId: string) => taskHandlers(service, 'cl').task_amend({ task_id: taskId, direction: 'Owner edit', rationale: 'mine' }),
    ]) {
      const { task, handoff } = await ownedHandoff()
      await publishOther(task.id)
      expect(service.store.get(task.id)!.revision).toBe(2)
      expect(service.handoffs.store.get(handoff.id)).toMatchObject({ state: 'stale', stateReason: 'revision 2 was published', publishedRevision: null })
      expect(service.handoffs.store.events(handoff.id).map(event => [event.from, event.to, event.revision])).toEqual([[null, 'open', null], ['open', 'stale', 2]])
      const [wake] = wakeups(handoff.id)
      expect(wakeups(handoff.id)).toEqual([{ transition: 'stale', message_id: wake.message_id }])
      const mail = wakeMail().filter(message => message.id === wake.message_id)
      expect(mail).toEqual([expect.objectContaining({ to_kind: 'session', to_id: 'lead', task_id: null, from_kind: 'system' })])
      expect(String(mail[0].body)).toContain(handoff.id)
      expect(String(mail[0].body)).toContain('revision 2')
      await refusedWithNothing(() => service.handoffs.publish(human(), task.id, handoff.id, []), 'The publication handoff is stale')
    }
  })

  test('H21: a further publication leaves a stale handoff stale with no second wakeup', async () => {
    const { task, handoff } = await openHandoff()
    await ordinary(task.id, 'one')
    const stale = service.handoffs.store.get(handoff.id)
    const events = service.handoffs.store.events(handoff.id)
    await ordinary(task.id, 'two')
    expect(service.store.get(task.id)!.revision).toBe(3)
    expect(service.handoffs.store.get(handoff.id)).toEqual(stale)
    expect(service.handoffs.store.events(handoff.id)).toEqual(events)
    expect(wakeups(handoff.id).map(wake => wake.transition)).toEqual(['stale'])
    expect(wakeMail()).toHaveLength(1)
  })

  // @covers: task-publication-handoffs › A handoff is published at most once › A padded ordinary key works as before
  test('H39: with no pending handoff an ordinary publication changes no handoff row and stores a padded key trimmed', async () => {
    const { task, handoff } = await openHandoff()
    await service.handoffs.settle(human(), handoff.id, 'decline', 'not now')
    const handoffs = snapshot().team_task_handoffs
    const outcome = await service.publish(human(), task.id, { direction: 'Mine', rationale: 'r', notify: false, requestKey: '  plain-7\t' })
    expect(outcome.revision.revision).toBe(2)
    expect(db.prepare('SELECT request_key, handoff_id FROM team_task_revisions WHERE task_id = ? AND revision = 2').get(task.id)).toEqual({ request_key: 'plain-7', handoff_id: null })
    expect(snapshot().team_task_handoffs).toEqual(handoffs)
    expect(wakeups(handoff.id).map(wake => wake.transition)).toEqual(['declined'])
  })

  test('a prepared publication is exempt from its own stale hook and leaves no other pending handoff behind', async () => {
    const { task, handoff } = await openHandoff()
    await service.handoffs.publish(human(), task.id, handoff.id, [])
    expect(service.handoffs.store.get(handoff.id)).toMatchObject({ state: 'published', publishedRevision: 2 })
    expect(wakeups(handoff.id).map(wake => wake.transition)).toEqual(['published'])
  })

  test('a fault inside the publication rolls the revision, the stale transition, the wakeup and its mail back together', async () => {
    const { task, handoff } = await openHandoff()
    const before = snapshot()
    expect(() => service.store.publish(task.id, { direction: 'x', notify: false, within: () => { throw new Error('fault after the hook') } }, { kind: 'human', sessionId: null }))
      .toThrow('fault after the hook')
    expect(snapshot()).toEqual(before)
    expect(service.handoffs.store.get(handoff.id)!.state).toBe('open')
  })
})

describe('H-SETTLE: decline and withdraw', () => {
  test('team/id first: an unknown or foreign handoff reads as not found, ahead of the right and the reason', async () => {
    const { task, handoff } = await openHandoff()
    await refusedWithNothing(() => service.handoffs.settle(agent('stranger'), handoff.id, 'withdraw', ''), `Publication handoff not found in this team: ${handoff.id}`)
    await refusedWithNothing(() => service.handoffs.settle(agent('dev'), 'handoff-none', 'decline', ''), 'Publication handoff not found in this team: handoff-none')
    await refusedWithNothing(() => service.handoffs.settle(human(), handoff.id, 'decline', 'r', 'task-other'), 'not found')
    expect(service.handoffs.store.get(handoff.id)!.state).toBe('open')
    expect(task.revision).toBe(1)
  })

  test('H23: a missing right is refused before an empty reason and an ended state', async () => {
    const { task, handoff } = await ownedHandoff()
    for (const [caller, action] of [
      [agent('lead'), 'decline'], [agent('dev'), 'decline'], [kawai(), 'decline'],
      [human(), 'withdraw'], [agent('cl'), 'withdraw'], [agent('dev'), 'withdraw'], [kawai(), 'withdraw'],
    ] as Array<[TaskCaller, 'decline' | 'withdraw']>) {
      await refusedWithNothing(() => service.handoffs.settle(caller, handoff.id, action, ''), /Only the|Kawai never declines/)
    }
    setState(handoff.id, 'published')
    await refusedWithNothing(() => service.handoffs.settle(agent('lead'), handoff.id, 'decline', ''), "Only the task's owner or the human can decline")
    expect(task.revision).toBe(1)
  })

  test('H23b: an empty or blank reason is refused before the state', async () => {
    const { handoff } = await ownedHandoff()
    for (const reason of ['', '   ', '\n\t']) {
      await refusedWithNothing(() => service.handoffs.settle(human(), handoff.id, 'decline', reason), 'A decline needs a reason')
      await refusedWithNothing(() => service.handoffs.settle(agent('lead'), handoff.id, 'withdraw', reason), 'A withdraw needs a reason')
    }
    setState(handoff.id, 'declined')
    await refusedWithNothing(() => service.handoffs.settle(agent('cl'), handoff.id, 'decline', ' '), 'A decline needs a reason')
  })

  // @covers: task-publication-handoffs › A handoff is published at most once › A declined handoff cannot be published
  test('H26: a handoff no longer pending is refused naming its state, for both actions', async () => {
    const { handoff } = await ownedHandoff()
    for (const state of HANDOFF_STATES.filter(candidate => candidate !== 'open' && candidate !== 'stale')) {
      setState(handoff.id, state)
      await refusedWithNothing(() => service.handoffs.settle(human(), handoff.id, 'decline', 'r'), `The publication handoff is ${state}; nothing was changed.`)
      await refusedWithNothing(() => service.handoffs.settle(agent('lead2'), handoff.id, 'withdraw', 'r'), `The publication handoff is ${state}; nothing was changed.`)
    }
  })

  // @covers: task-publication-handoffs › A handoff ends only by an explicit disposition › The human declines
  test('H22: the human or the owner declines with a reason and actor; one declined wakeup; the revision is unchanged', async () => {
    for (const [caller, actor] of [[human(), { kind: 'human', sessionId: null }], [agent('cl'), { kind: 'agent', sessionId: 'cl' }]] as const) {
      const { task, handoff } = await ownedHandoff()
      const tools = taskHandlers(service, 'cl')
      const declined = caller.kind === 'human'
        ? await service.handoffs.settle(caller, handoff.id, 'decline', '  scope stays as published ')
        : await tools.task_settle_publication({ handoff_id: handoff.id, action: 'decline', reason: '  scope stays as published ' })
      expect(declined).toMatchObject({ state: 'declined', stateReason: 'scope stays as published', stateActor: actor })
      expect(service.store.get(task.id)!.revision).toBe(1)
      const [wake] = wakeups(handoff.id)
      expect(wakeups(handoff.id)).toEqual([{ transition: 'declined', message_id: wake.message_id }])
      const mail = wakeMail().filter(message => message.id === wake.message_id)
      expect(mail).toEqual([expect.objectContaining({ to_kind: 'session', to_id: 'lead', task_id: null })])
      expect(String(mail[0].body)).toContain('scope stays as published')
      await refusedWithNothing(() => service.handoffs.publish(human(), task.id, handoff.id, []), 'The publication handoff is declined')
    }
  })

  // @covers: task-publication-handoffs › A handoff ends only by an explicit disposition › The requester withdraws
  test('H24: the requester or a session of its group withdraws with a reason; nobody is woken; the task is unchanged', async () => {
    for (const session of ['lead', 'lead2']) {
      const { task, handoff } = await openHandoff()
      const before = snapshot()
      const withdrawn = await taskHandlers(service, session).task_settle_publication({ handoff_id: handoff.id, action: 'withdraw', reason: 'not needed' })
      expect(withdrawn).toMatchObject({ state: 'withdrawn', stateReason: 'not needed', stateActor: { kind: 'agent', sessionId: session } })
      expect(wakeups(handoff.id)).toEqual([])
      expect(snapshot().team_messages).toEqual(before.team_messages)
      expect(snapshot().team_task_revisions).toEqual(before.team_task_revisions)
      expect(service.store.get(task.id)!.revision).toBe(1)
    }
  })
})

describe('H-CLOSE: the task moves to done or cancelled', () => {
  const closers: Array<[string, (taskId: string) => Promise<unknown>]> = [
    ['setStatus cancelled', taskId => service.setStatus(human(), taskId, 'cancelled')],
    ['setStatus done', taskId => service.setStatus(agent('cl'), taskId, 'done')],
    ['prepareStatus().commit', async taskId => (await service.prepareStatus(human(), taskId, 'cancelled', 'Superseded.')).commit()],
  ]

  // @covers: task-publication-handoffs › A handoff ends only by an explicit disposition › Closing the task ends the handoff
  test('H27: an open or stale handoff closes in the status transaction with one closed wakeup and no revision', async () => {
    for (const [name, close] of closers) {
      for (const stale of [false, true]) {
        const { task, handoff } = await ownedHandoff()
        if (stale) await ordinary(task.id, `s-${name}`)
        const revision = service.store.get(task.id)!.revision
        await close(task.id)
        expect([name, service.handoffs.store.get(handoff.id)!.state]).toEqual([name, 'closed'])
        expect(service.handoffs.store.events(handoff.id).at(-1)).toMatchObject({ from: stale ? 'stale' : 'open', to: 'closed' })
        expect(service.store.get(task.id)!.revision).toBe(revision)
        expect(wakeups(handoff.id).map(wake => wake.transition)).toEqual(stale ? ['stale', 'closed'] : ['closed'])
        const closedMail = wakeMail().filter(message => message.id === wakeups(handoff.id).at(-1)!.message_id)
        expect(closedMail).toEqual([expect.objectContaining({ to_kind: 'session', to_id: 'lead', task_id: null })])
      }
    }
  })

  test('H40: a published or ended handoff is unchanged by a close, which writes no wakeup', async () => {
    for (const state of HANDOFF_STATES.filter(candidate => candidate !== 'open' && candidate !== 'stale')) {
      const { task, handoff } = await ownedHandoff()
      setState(handoff.id, state)
      const before = snapshot()
      await service.setStatus(human(), task.id, 'cancelled')
      expect(snapshot().team_task_handoffs).toEqual(before.team_task_handoffs)
      expect(snapshot().team_task_handoff_events).toEqual(before.team_task_handoff_events)
      expect(wakeups(handoff.id)).toEqual([])
    }
  })

  test('a fault at the handoff update, the wakeup insert or the mailbox insert rolls the close back whole', async () => {
    for (const [table, event] of [['team_task_handoffs', 'UPDATE'], ['team_task_handoff_wakeups', 'INSERT'], ['team_messages', 'INSERT']]) {
      const { task, handoff } = await ownedHandoff()
      db.exec(`CREATE TRIGGER fault AFTER ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'fault at ${table}'); END`)
      const before = snapshot()
      const prepared = await service.prepareStatus(human(), task.id, 'cancelled')
      expect(() => prepared.commit()).toThrow(`fault at ${table}`)
      db.exec('DROP TRIGGER fault')
      expect(snapshot()).toEqual(before)
      expect([table, service.store.get(task.id)!.status, service.handoffs.store.get(handoff.id)!.state]).toEqual([table, 'open', 'open'])
    }
  })

  test('traces: publish then close stays published with one wakeup; close then publish reads H15 naming closed', async () => {
    const first = await ownedHandoff()
    await service.handoffs.publish(human(), first.task.id, first.handoff.id, [])
    await service.setStatus(human(), first.task.id, 'done')
    expect(service.handoffs.store.get(first.handoff.id)).toMatchObject({ state: 'published', publishedRevision: 2 })
    expect(wakeups(first.handoff.id).map(wake => wake.transition)).toEqual(['published'])

    const second = await ownedHandoff()
    await service.setStatus(human(), second.task.id, 'cancelled')
    await refusedWithNothing(() => service.handoffs.publish(human(), second.task.id, second.handoff.id, []), 'The publication handoff is closed; nothing was published.')
    expect(wakeups(second.handoff.id).map(wake => wake.transition)).toEqual(['closed'])
    expect(service.store.get(second.task.id)!.revision).toBe(1)
  })
})
