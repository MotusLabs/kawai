// Handoff commands (owner-publication-handoff D2, D3, D10) over a real
// TaskService and store: Table H-REQ's rows in check order (rights before the
// key, the key before status, base and payload, the pending check last), the
// combined rulings, H-PUB's rights, override, replay and state rows over the
// revision facts R0–R4, and the ordinary entry's reserved-key refusal ahead of
// every other check (H33 with its mixed errors). Every refused row writes
// nothing: the snapshot of handoff, event, wakeup, revision and mail rows is
// identical before and after.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatSessionRecord } from '../db'
import { schemaCopy } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { RESERVED_KEY_REFUSAL, type HandoffRequestInput } from '../team/taskHandoffService'
import { HANDOFF_FIELD_LIMIT } from '../team/taskHandoffValidation'
import { taskHandlers } from '../team/taskTools'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { SYSTEM_ACTOR } from '../../shared/team'
import type { HandoffState } from '../../shared/taskHandoffs'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

let root: string
let repo: string
let other: string
let head: string
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
const kawaiTask = () => service.store.create({ teamId: team.teamId, title: 'Export', direction: 'CSV', creator: SYSTEM_ACTOR })
const request = (_taskId: string, extra: Partial<HandoffRequestInput> = {}): HandoffRequestInput => ({
  baseRevision: 1, direction: 'CSV with headers', rationale: 'Headers were missing', notify: true, requestKey: 'k1', ...extra,
})
const snapshot = () => Object.fromEntries(['team_task_handoffs', 'team_task_handoff_events', 'team_task_handoff_wakeups', 'team_task_revisions', 'team_messages', 'team_task_notifications']
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
const refusedWithNothing = async (run: () => Promise<unknown>, message: string | RegExp) => {
  const before = snapshot()
  await expect(run()).rejects.toThrow(message)
  expect(snapshot()).toEqual(before)
}
const setState = (id: string, state: HandoffState) => db.prepare('UPDATE team_task_handoffs SET state = ? WHERE id = ?').run(state, id)

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-handoff-commands-')))
  repo = path.join(root, 'repo')
  other = path.join(root, 'other')
  for (const dir of [repo, other]) {
    git(['init', '-q', dir])
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
  }
  head = git(['rev-parse', 'HEAD'], repo)
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

describe('H-REQ: task_request_publication', () => {
  // @covers: task-publication-handoffs › Task authors may request an owner publication › A Lead prepares a correction for a Kawai task
  test('H1: an eligible requester records one open handoff and the task is unchanged', async () => {
    const task = kawaiTask()
    const { handoff, replay } = await service.handoffs.request(agent('lead'), task.id, request(task.id, { baseCommit: head, evidenceRefs: ['docs/a.md', 'note-1'] }))
    expect(replay).toBe(false)
    expect(handoff).toMatchObject({ state: 'open', baseRevision: 1, requesterSession: 'lead', requesterGroup: 'leads', baseCommit: head, evidenceRefs: ['docs/a.md', 'note-1'] })
    expect(service.store.get(task.id)!.revision).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_messages').get()).toEqual({ n: 0 })
    expect(service.handoffs.store.events(handoff.id).map(event => [event.from, event.to])).toEqual([[null, 'open']])
  })

  // @covers: task-publication-handoffs › Task authors may request an owner publication › The owner is told to amend
  test('H6: the live owner is pointed to task_amend, also when its group cannot create tasks', async () => {
    const owned = await service.create(agent('lead'), { title: 'Mine', direction: 'x' })
    await refusedWithNothing(() => service.handoffs.request(agent('lead'), owned.id, request(owned.id)), /task_amend/)
    writeGroup('leads', 'Lead.')
    await refusedWithNothing(() => service.handoffs.request(agent('lead'), owned.id, request(owned.id)), /task_amend/)
  })

  // @covers: task-publication-handoffs › Task authors may request an owner publication › A developer cannot request
  test('H5: a group that cannot create tasks is refused suggesting task_note, even on a closed task', async () => {
    const task = kawaiTask()
    await refusedWithNothing(() => service.handoffs.request(agent('dev'), task.id, request(task.id)), /task_note/)
    service.store.setStatus(task.id, 'cancelled')
    await refusedWithNothing(() => service.handoffs.request(agent('dev'), task.id, request(task.id)), /task_note/)
  })

  // @covers: task-publication-handoffs › A request is validated before it is recorded › A foreign task is refused without disclosure
  test('H4: a task of another team reads like an unknown id', async () => {
    const task = kawaiTask()
    await refusedWithNothing(() => service.handoffs.request(agent('stranger'), task.id, request(task.id)), `Task not found in this team: ${task.id}`)
    await refusedWithNothing(() => service.handoffs.request(agent('lead'), 'task-none', request('task-none')), 'Task not found in this team: task-none')
  })

  // @covers: task-publication-handoffs › Requests are idempotent under a request key › A resent request returns the same handoff
  // @covers: task-publication-handoffs › Requests are idempotent under a request key › A replay after the task moved on returns the handoff
  test('H10: the requester side replays its key with the current state, even after the task closed', async () => {
    const task = kawaiTask()
    const first = await service.handoffs.request(agent('lead'), task.id, request(task.id))
    const before = snapshot()
    expect(await service.handoffs.request(agent('lead2'), task.id, request(task.id))).toEqual({ handoff: first.handoff, replay: true, superseded: null })
    expect(snapshot()).toEqual(before)
    // The close moves the handoff to closed (H27); the replay returns it as it is now and writes nothing.
    service.store.setStatus(task.id, 'cancelled')
    const closed = snapshot()
    expect(await service.handoffs.request(agent('lead'), task.id, request(task.id))).toMatchObject({ replay: true, handoff: { id: first.handoff.id, state: 'closed' } })
    expect(snapshot()).toEqual(closed)
  })

  // @covers: task-publication-handoffs › Requests are idempotent under a request key › A reused key with another payload is refused
  test('H11: the same key with another payload names the first differing field in order', async () => {
    const task = kawaiTask()
    await service.handoffs.request(agent('lead'), task.id, request(task.id, { baseCommit: head }))
    for (const [change, field] of [
      [{ direction: 'Other', rationale: 'Other' }, 'direction'], [{ acceptance: 'A' }, 'acceptance'], [{ rationale: 'Why not' }, 'rationale'],
      [{ notify: false }, 'notify'], [{ baseRevision: 2 }, 'base revision'], [{ baseCommit: null }, 'base commit'], [{ evidenceRefs: ['x'] }, 'evidence'],
    ] as Array<[Partial<HandoffRequestInput>, string]>) {
      await refusedWithNothing(() => service.handoffs.request(agent('lead'), task.id, request(task.id, { baseCommit: head, ...change })), `Request key already used with a different ${field}`)
    }
  })

  // @covers: task-publication-handoffs › Requests are idempotent under a request key › Another requester side cannot use the key
  test('H11s: another requester side using the key is refused without the handoff, even with the identical payload on a closed task', async () => {
    const task = kawaiTask()
    const { handoff } = await service.handoffs.request(agent('lead'), task.id, request(task.id))
    service.store.setStatus(task.id, 'cancelled')
    const before = snapshot()
    const error = await service.handoffs.request(agent('cl'), task.id, request(task.id)).catch((caught: Error) => caught)
    expect((error as Error).message).toContain('different requester')
    expect((error as Error).message).not.toContain(handoff.id)
    expect(snapshot()).toEqual(before)
  })

  // @covers: task-publication-handoffs › Requests are idempotent under a request key › A replay after losing the right is refused
  test('a replay after losing the right is refused by the right check (H5), not returned', async () => {
    const task = kawaiTask()
    await service.handoffs.request(agent('lead'), task.id, request(task.id))
    writeGroup('leads', 'Lead.')
    await refusedWithNothing(() => service.handoffs.request(agent('lead'), task.id, request(task.id)), /task_note/)
  })

  // @covers: task-publication-handoffs › A request is validated before it is recorded › A closed task is refused
  test('H3: a closed task is refused naming its status, before a behind base', async () => {
    const task = kawaiTask()
    await service.amend(human(), task.id, { direction: 'v2' })
    service.store.setStatus(task.id, 'done')
    await refusedWithNothing(() => service.handoffs.request(agent('lead'), task.id, request(task.id)), 'The task is done')
  })

  // @covers: task-publication-handoffs › A request is validated before it is recorded › A stale base is refused
  test('H2: a base behind the current revision is refused naming it', async () => {
    const task = kawaiTask()
    await service.amend(human(), task.id, { direction: 'v2' })
    await refusedWithNothing(() => service.handoffs.request(agent('lead'), task.id, request(task.id)), /current revision is 2/)
  })

  // @covers: task-publication-handoffs › A request is validated before it is recorded › An oversized field is named before a contract problem
  // @covers: task-publication-handoffs › A request is validated before it is recorded › A malformed contract is refused
  // @covers: task-publication-handoffs › A request is validated before it is recorded › A request without content is refused
  // @covers: task-publication-handoffs › A handoff records its exact provenance › An unknown base commit is refused
  test('H7: the first payload problem in field order is named', async () => {
    const task = kawaiTask()
    const big = 'x'.repeat(HANDOFF_FIELD_LIMIT + 1)
    for (const [change, message] of [
      [{ rationale: big, contract: 'not a contract' }, /rationale exceeds its size limit/],
      [{ evidenceRefs: Array.from({ length: 21 }, (_, index) => `e${index}`) }, /At most 20 evidence references/],
      [{ direction: ' ', acceptance: null, contract: null }, /needs a direction, acceptance criteria, or a contract/],
      [{ contract: 'not a contract' }, /contract/i],
      [{ rationale: '  ' }, /needs a rationale/],
      [{ evidenceRefs: ['/etc/passwd'] }, /repository-relative path/],
      [{ evidenceRefs: ['a/../b'] }, /repository-relative path/],
      [{ baseCommit: 'abc' }, /full 40-hex commit id/],
      [{ baseCommit: 'f'.repeat(40) }, /does not resolve/],
    ] as Array<[Partial<HandoffRequestInput>, RegExp]>) {
      await refusedWithNothing(() => service.handoffs.request(agent('lead'), task.id, request(task.id, change)), message)
    }
  })

  // @covers: task-publication-handoffs › A task has at most one pending handoff › Another group cannot replace it
  test('H9: a pending handoff of another group refuses the request naming it', async () => {
    const task = kawaiTask()
    const { handoff } = await service.handoffs.request(agent('lead'), task.id, request(task.id))
    await refusedWithNothing(() => service.handoffs.request(agent('cl'), task.id, request(task.id, { requestKey: 'k2' })), new RegExp(`${handoff.id}.*requested by lead`))
  })

  // @covers: task-publication-handoffs › A task has at most one pending handoff › The requester re-prepares
  test('H8: the requester side re-prepares, superseding its pending handoff in one transaction with no wakeup', async () => {
    const task = kawaiTask()
    const first = await service.handoffs.request(agent('lead'), task.id, request(task.id))
    const second = await service.handoffs.request(agent('lead2'), task.id, request(task.id, { requestKey: 'k2', direction: 'Better' }))
    expect(second).toMatchObject({ replay: false, superseded: first.handoff.id, handoff: { state: 'open', direction: 'Better' } })
    expect(service.handoffs.store.get(first.handoff.id)).toMatchObject({ state: 'superseded', supersededBy: second.handoff.id })
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_task_handoff_wakeups').get()).toEqual({ n: 0 })
  })
})

describe('H-PUB: publish prepared revision', () => {
  const openHandoff = async () => {
    const task = kawaiTask()
    const { handoff } = await service.handoffs.request(agent('lead'), task.id, request(task.id, { notify: false }))
    return { task, handoff }
  }

  // @covers: task-publication-handoffs › The publisher publishes a handoff with one action › No other party can publish it
  test('H13: an unrelated agent and Kawai are refused, for an open and for a published handoff', async () => {
    const { task, handoff } = await openHandoff()
    for (const caller of [agent('lead'), agent('dev'), kawai()]) {
      await refusedWithNothing(() => service.handoffs.publish(caller, task.id, handoff.id, []), /Kawai never publishes|Only the task's owner or the human/)
    }
    await service.handoffs.publish(human(), task.id, handoff.id, [])
    for (const caller of [agent('lead'), kawai()]) {
      await refusedWithNothing(() => service.handoffs.publish(caller, task.id, handoff.id, []), /Kawai never publishes|Only the task's owner or the human/)
    }
  })

  // @covers: task-publication-handoffs › The publisher publishes a handoff with one action › A live owner publishes with task_amend
  // @covers: task-publication-handoffs › The publisher publishes a handoff with one action › A former owner's resend returns nothing
  // @covers: task-publication-handoffs › The publisher publishes a handoff with one action › A resend with fields beside the handoff is refused
  test('H12/H14/H35/H13: the owner publishes with task_amend, extras are refused, and a former owner gets nothing', async () => {
    const task = await service.create(agent('cl'), { title: 'Owned', direction: 'v1' })
    const { handoff } = await service.handoffs.request(agent('lead'), task.id, request(task.id, { notify: false }))
    const tools = taskHandlers(service, 'cl')
    const published = await tools.task_amend({ task_id: task.id, handoff_id: handoff.id })
    expect(published.revision).toBe(2)
    expect(service.store.revisions(task.id).at(-1)).toMatchObject({ direction: 'CSV with headers', author: { kind: 'agent', sessionId: 'cl' } })
    expect(service.handoffs.store.get(handoff.id)).toMatchObject({ state: 'published', publishedRevision: 2 })
    const before = snapshot()
    expect((await tools.task_amend({ task_id: task.id, handoff_id: handoff.id })).revision).toBe(2)
    expect((await service.handoffs.publish(human(), task.id, handoff.id, [])).replay).toBe(true)
    expect(snapshot()).toEqual(before)
    await refusedWithNothing(() => tools.task_amend({ task_id: task.id, handoff_id: handoff.id, rationale: 'again' }), /rationale cannot override/)
    records.set('cl2', row('cl2', 'change-leads'))
    await service.ownership.transfer(agent('cl'), { task_id: task.id, to_session: 'cl2' })
    await refusedWithNothing(() => tools.task_amend({ task_id: task.id, handoff_id: handoff.id }), /Only the task's owner or the human/)
  })

  test('H35: every prepared-payload field beside the handoff id is refused, before replay or state', async () => {
    const { task, handoff } = await openHandoff()
    for (const field of ['direction', 'acceptance', 'contract', 'rationale', 'notify']) {
      await refusedWithNothing(() => service.handoffs.publish(human(), task.id, handoff.id, [field]), new RegExp(`${field} cannot override`))
    }
  })

  // @covers: task-publication-handoffs › A handoff is published at most once › A declined handoff cannot be published
  test('H15: a handoff in any other non-published state is refused naming it', async () => {
    for (const state of ['stale', 'declined', 'withdrawn', 'superseded', 'closed'] as const) {
      const { task, handoff } = await openHandoff()
      setState(handoff.id, state)
      await refusedWithNothing(() => service.handoffs.publish(human(), task.id, handoff.id, []), `The publication handoff is ${state}`)
    }
  })

  test('H16b (R3): published through a linked revision under an ordinary key is refused naming it; R4 and R1 orphans are refused', async () => {
    const { task, handoff } = await openHandoff()
    const linked = await service.publish(human(), task.id, { direction: 'Edited', rationale: 'edit', requestKey: 'ordinary', baseRevision: 1 })
    service.handoffs.store.associate(task.id, linked.revision.revision, handoff.id)
    setState(handoff.id, 'published')
    await refusedWithNothing(() => service.handoffs.publish(human(), task.id, handoff.id, []), 'published as revision 2 through its linked draft')
    // R4: plus an orphan prepared-key row, which is never returned as the publication.
    db.prepare("UPDATE team_task_revisions SET request_key = ? WHERE task_id = ? AND revision = 1").run(`handoff:${handoff.id}`, task.id)
    await refusedWithNothing(() => service.handoffs.publish(human(), task.id, handoff.id, []), /without its association/)
    // R1 (DF6): an open handoff with only the orphan.
    const fresh = await openHandoff()
    db.prepare("UPDATE team_task_revisions SET request_key = ? WHERE task_id = ? AND revision = 1").run(`handoff:${fresh.handoff.id}`, fresh.task.id)
    await refusedWithNothing(() => service.handoffs.publish(human(), fresh.task.id, fresh.handoff.id, []), /without its association/)
  })

  test('H16/H4: an unknown handoff, or one of another task, is not found', async () => {
    const { task, handoff } = await openHandoff()
    const otherTask = kawaiTask()
    await refusedWithNothing(() => service.handoffs.publish(human(), task.id, 'handoff-none', []), 'Publication handoff not found for this task: handoff-none')
    await refusedWithNothing(() => service.handoffs.publish(human(), otherTask.id, handoff.id, []), `Publication handoff not found for this task: ${handoff.id}`)
  })
})

describe('H33: the ordinary entry refuses a reserved key first', () => {
  // @covers: task-publication-handoffs › A handoff is published at most once › Surrounding whitespace does not hide a handoff key
  test('bare or padded, with a blank rationale, an unknown task, a stale base, or no right, the refusal is the reserved key', async () => {
    const { handoff } = await service.handoffs.request(agent('lead'), kawaiTask().id, request(''))
    const task = service.store.get(handoff.taskId)!
    for (const key of [`handoff:${handoff.id}`, ` handoff:${handoff.id}`, `\thandoff:${handoff.id}\n`, `handoff:${handoff.id}  `, 'handoff:anything']) {
      for (const [caller, taskId, extra] of [
        [human(), task.id, { rationale: ' ' }], [human(), 'task-none', {}], [human(), task.id, { baseRevision: 7 }], [agent('dev'), task.id, {}], [kawai(), task.id, {}],
      ] as Array<[TaskCaller, string, object]>) {
        await refusedWithNothing(() => service.publish(caller, taskId, { direction: 'x', rationale: 'r', requestKey: key, baseRevision: 1, ...extra }), RESERVED_KEY_REFUSAL)
      }
    }
    expect(service.handoffs.store.get(handoff.id)!.state).toBe('open')
  })

  // @covers: task-publication-handoffs › A handoff is published at most once › A padded ordinary key works as before
  test('H39: a padded ordinary key is stored trimmed and a differently padded resend replays', async () => {
    const task = kawaiTask()
    const first = await service.publish(human(), task.id, { direction: 'v2', rationale: 'r', requestKey: '  plain  ', baseRevision: 1 })
    const again = await service.publish(human(), task.id, { direction: 'v2', rationale: 'r', requestKey: '\tplain', baseRevision: 1 })
    expect([first.replay, again.replay, again.revision.revision]).toEqual([false, true, 2])
    expect(db.prepare('SELECT request_key FROM team_task_revisions WHERE revision = 2').get()).toEqual({ request_key: 'plain' })
  })
})
