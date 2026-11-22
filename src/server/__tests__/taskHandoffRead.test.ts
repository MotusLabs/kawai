// Agent reads of publication handoffs (owner-publication-handoff D10, task
// 10.1) over a real TaskService and the real `task_get` handler: bounded
// handoff rows (newest 20, newest first, with the payload hash's first 12
// digits, the disposition, a pending row's next actor and a published row's
// phase), one handoff whole by `handoff_id`, team scoping (another task's or
// another team's handoff is not found), and the delivered task context, which
// names a pending handoff only as pending while the direction stays the
// published revision's.
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
import { AssignmentStore } from '../team/assignmentStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { taskHandlers } from '../team/taskTools'
import { HANDOFF_WINDOW, type AgentHandoffRead } from '../team/taskHandoffRead'
import { buildTaskContext, formatTaskHeader } from '../team/taskContext'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { SYSTEM_ACTOR } from '../../shared/team'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

let root: string
let repo: string
let other: string
let db: Database
let service: TaskService
let team: TeamIdentity
let otherTeam: TeamIdentity
let records: Map<string, ChatSessionRecord>
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const row = (sessionId: string, groupId: string, projectPath: string): ChatSessionRecord => ({
  sessionId, groupId, projectPath, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})
let serial = 0

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-handoff-read-')))
  repo = path.join(root, 'repo')
  other = path.join(root, 'other')
  for (const dir of [repo, other]) {
    git(['init', '-q', dir])
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
    fs.mkdirSync(path.join(dir, '.kawai', 'groups'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
    fs.writeFileSync(path.join(dir, '.kawai', 'groups', 'devs.md'), 'Build.')
  }
  clearTeamCache()
  team = await resolveTeam(repo)
  otherTeam = await resolveTeam(other)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
beforeEach(() => {
  db?.close()
  db = schemaCopy()
  records = new Map([['lead', row('lead', 'leads', repo)], ['dev', row('dev', 'devs', repo)], ['stranger', row('stranger', 'leads', other)]])
  const mail = new MailboxStore(db)
  service = new TaskService(new TaskStore(db, mail, new AssignmentStore(db, mail)), { getSession: id => records.get(id), homeDir: path.join(root, 'home') })
})

const kawaiTask = (teamId = team.teamId) => service.store.create({ teamId, title: 'Export', direction: 'CSV', creator: SYSTEM_ACTOR })
const requestOn = async (taskId: string, requester = 'lead', direction = 'CSV with headers') =>
  (await service.handoffs.request(agent(requester), taskId, { baseRevision: service.store.get(taskId)!.revision, direction, rationale: 'Headers were missing', notify: false, requestKey: `k${++serial}` })).handoff
const get = async (session: string, args: Record<string, unknown>) => (await taskHandlers(service, session).task_get(args)) as unknown as AgentHandoffRead & { task: { direction: string; revision: number } }

describe('task_get handoffs', () => {
  // @covers: task-publication-handoffs › Agents read a task's handoffs › The holder sees a pending correction
  test('the holder reads the open handoff as a row with its base, requester and next actor, and the direction stays the published one', async () => {
    const task = kawaiTask()
    const h = await requestOn(task.id)
    const read = await get('dev', { task_id: task.id })
    expect(read.task.direction).toBe('CSV')
    expect(read.handoffs).toEqual([expect.objectContaining({
      id: h.id, state: 'open', baseRevision: 1, requesterSession: 'lead', requesterGroup: 'leads', payloadHash: h.payloadHash.slice(0, 12),
      publishedRevision: null, publishedAsEdited: null, disposition: null, nextActor: { kind: 'human' },
    })])
    expect(read.handoffBounds).toEqual({ total: 1, returned: 1, truncated: false })
    expect(read.handoff).toBeUndefined()
  })

  test('rows are the newest 20, newest first, with dispositions and the published phase; handoff_id reads one whole with its events', async () => {
    const task = kawaiTask()
    const ids: string[] = []
    for (let index = 0; index < HANDOFF_WINDOW + 2; index++) ids.push((await requestOn(task.id, 'lead', `Prepared ${index}`)).id)
    await service.handoffs.publish({ kind: 'human', team }, task.id, ids.at(-1)!, [])
    const read = await get('dev', { task_id: task.id, handoff_id: ids[0] })
    expect(read.handoffBounds).toEqual({ total: HANDOFF_WINDOW + 2, returned: HANDOFF_WINDOW, truncated: true })
    expect(read.handoffs.map(entry => entry.id)).toEqual([...ids].reverse().slice(0, HANDOFF_WINDOW))
    expect(read.handoffs[0]).toMatchObject({ state: 'published', publishedRevision: 2, publishedAsEdited: false, phase: 'no-holder', disposition: { actor: { kind: 'human' } } })
    expect(read.handoffs[1]).toMatchObject({ state: 'superseded', disposition: { actor: { kind: 'agent', sessionId: 'lead' }, reason: 'superseded by a newer request' } })
    expect(read.handoff).toMatchObject({ id: ids[0], direction: 'Prepared 0', rationale: 'Headers were missing', state: 'superseded' })
    expect(read.handoff!.events.map(event => [event.from, event.to])).toEqual([[null, 'open'], ['open', 'superseded']])
  })

  // @covers: task-publication-handoffs › Agents read a task's handoffs › A handoff of another team is not readable
  test("another team's handoff, or another task's, is not found; another team's task is not readable at all", async () => {
    const mine = kawaiTask()
    const sibling = kawaiTask()
    const theirs = kawaiTask(otherTeam.teamId)
    const foreign = await requestOn(theirs.id, 'stranger')
    const neighbour = await requestOn(sibling.id)
    await expect(get('dev', { task_id: mine.id, handoff_id: foreign.id })).rejects.toThrow(`Publication handoff not found for this task: ${foreign.id}`)
    await expect(get('dev', { task_id: mine.id, handoff_id: neighbour.id })).rejects.toThrow(/not found for this task/)
    await expect(get('dev', { task_id: theirs.id })).rejects.toThrow()
    const read = await get('dev', { task_id: mine.id })
    expect(JSON.stringify(read)).not.toContain(foreign.id)
  })
})

describe('delivered task context', () => {
  // @covers: task-publication-handoffs › A handoff is never a revision › Delivered context keeps the published revision
  test('a pending handoff is named only as pending; the direction is the published revision\'s and its text never appears', async () => {
    const task = kawaiTask()
    const h = await requestOn(task.id, 'lead', 'A prepared direction that must not be delivered')
    const context = buildTaskContext(service.store, task.id)!
    expect(context.direction).toBe('CSV')
    expect(context.pendingHandoff).toEqual({ id: h.id, state: 'open', baseRevision: 1 })
    const header = formatTaskHeader(context)
    expect(header).toContain(`Direction:\nCSV\n`)
    expect(header).toContain(`Pending publication handoff ${h.id} (open) prepared on revision 1 — not published; the direction above is revision 1's.`)
    expect(header).not.toContain('A prepared direction that must not be delivered')
    // Published: no pending line, and the direction is the new revision's.
    await service.handoffs.publish({ kind: 'human', team }, task.id, h.id, [])
    const after = buildTaskContext(service.store, task.id)!
    expect([after.direction, after.pendingHandoff]).toEqual(['A prepared direction that must not be delivered', undefined])
  })

  test('a task without a handoff keeps the old context shape', () => {
    const task = kawaiTask()
    expect(Object.keys(buildTaskContext(service.store, task.id)!)).not.toContain('pendingHandoff')
  })
})
