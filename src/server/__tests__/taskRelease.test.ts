// Release worktree and hand off (task-results-handoffs 6.1, design D7):
// team-member-release's readiness for every live spawned member first — one
// not-ready member refuses the whole release, naming it and why, with nothing
// archived or dispatched — then archive (never kill) with kawai's journal
// entry, then one review handoff; a failed dispatch after the archive is not
// re-archived on retry; manual sessions in the worktree are shown, never
// archived; a resend under the same key replays the handoff.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { MemberRelease } from '../team/memberRelease'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

let root: string
let repo: string
let feature: string
let team: TeamIdentity
let db: SessionDatabase
let mail: MailboxStore
let tasks: TaskService
let results: TaskResultService
let records: Map<string, ChatSessionRecord>
let busy: Set<string>
let asking: Set<string>
let workers: Set<string>
let archived: string[]
const human = (): TaskCaller => ({ kind: 'human', team })
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const row = (sessionId: string, extra: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId, groupId: 'devs', projectPath: feature, name: `Dev ${sessionId}`, sdkSessionId: null, status: 'waiting',
  createdAt: '', lastActivityAt: '', ...extra,
})

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-release-')))
  repo = path.join(root, 'repo')
  feature = path.join(root, 'repo-feature')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feature', feature], repo)
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), 'Build.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'reviewers.md'), 'Review.')
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  records = new Map()
  busy = new Set(); asking = new Set(); workers = new Set(); archived = []
  db?.close()
  db = initDatabase({ path: path.join(fs.mkdtempSync(path.join(root, 'db-')), 'tasks.db') })
  mail = new MailboxStore(db.db)
  const assignmentStore = new AssignmentStore(db.db, mail)
  const store = new TaskStore(db.db, mail, assignmentStore)
  tasks = new TaskService(store, { getSession: id => records.get(id) })
  const worktrees = new TeamWorktrees()
  const staffing = new WorktreeStaffing(db.db, mail, {
    records: () => records.values(), teamOf: () => undefined, caps: new TeamCaps({}), worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  const assignments = new AssignmentService(db.db, assignmentStore, store, mail, {
    getSession: id => records.get(id), records: () => records.values(), teamOf: () => undefined, staffing, caps: new TeamCaps({}), worktrees,
  })
  const releases = new MemberRelease(db.db, {
    store: mail, tasks: store, records: () => records.values(), getRecord: id => records.get(id), teamOf: () => team,
    definition: async () => undefined, cachedDefinition: () => undefined,
    recipient: id => ({ idle: !busy.has(id), pendingRequest: asking.has(id) }),
    hasLiveWorkers: id => workers.has(id), hasRunningBackgroundTasks: () => false,
    archive: id => { archived.push(id); records.get(id)!.archivedAt = new Date().toISOString(); return { ok: true } },
    notify: () => {},
  })
  results = new TaskResultService(tasks, { getSession: id => records.get(id), assignments, releases, records: () => records.values() })
})

const request = { target: 'reviewers', instructions: 'Review the export', requestKey: 'release-1' }
/** A task in the feature worktree, its spawned developer, and a submitted result. */
async function developed() {
  const task = await tasks.create(human(), { title: 'Export', direction: 'v1', worktree: feature })
  records.set('dev', row('dev', { spawned: true, taskId: task.id }))
  const result = await results.submit(agent('dev'), task.id, { summary: 'CSV export', commit: 'abc123' })
  return { task, result }
}
const reviewMail = (taskId: string) => mail.forTask(taskId).filter(message => message.toId === 'reviewers')

test('a busy, asking, or worker-holding developer refuses the release with the reason; nothing is archived or dispatched', async () => {
  const { task } = await developed()
  for (const [hold, reason] of [[busy, 'it is busy'], [asking, 'it is awaiting an approval or answer'],
    [workers, 'a background worker it started is still running']] as const) {
    hold.add('dev')
    await expect(results.release!.release(human(), task.id, request)).rejects.toThrow(`Dev dev (dev): ${reason}`)
    hold.delete('dev')
    expect(archived).toEqual([])
    expect(reviewMail(task.id)).toEqual([])
    expect(tasks.store.assignmentsOf(task.id)).toEqual([])
  }
  expect(results.release!.preview(task.id).members).toEqual([{ sessionId: 'dev', name: 'Dev dev', ready: true, reason: null }])
})

test('after the turn ends: exactly one release and one review handoff; the result and kawai\'s journal entry stay', async () => {
  const { task, result } = await developed()
  busy.add('dev')
  await expect(results.release!.release(human(), task.id, request)).rejects.toThrow('it is busy')
  busy.delete('dev')
  const outcome = await results.release!.release(human(), task.id, request)
  expect(outcome).toMatchObject({ released: ['dev'], handoff: { duplicate: false, assignment: { handoffKind: 'review', resultId: result.id } } })
  expect(archived).toEqual(['dev'])
  expect(reviewMail(task.id)).toHaveLength(1)
  expect(tasks.store.results.outstanding(task.id)?.id).toBe(result.id)
  expect(tasks.store.journal(task.id).map(entry => [entry.author.kind, entry.text])).toContainEqual(
    ['system', "Released Dev dev (dev): worktree released for review at the human's request."])
  // A resend under the same key replays the handoff: no second release, no second instruction.
  const resend = await results.release!.release(human(), task.id, request)
  expect(resend).toMatchObject({ released: [], handoff: { duplicate: true, assignment: { id: outcome.handoff.assignment.id } } })
  expect(archived).toEqual(['dev'])
  expect(reviewMail(task.id)).toHaveLength(1)
})

test('a dispatch failure after the archive is surfaced; Request review dispatches without archiving again', async () => {
  const { task, result } = await developed()
  const handoff = results.handoff.bind(results)
  results.handoff = async () => { throw new Error('dispatch exploded') }
  await expect(results.release!.release(human(), task.id, request)).rejects.toThrow('The worktree was released (dev), but the review dispatch failed: dispatch exploded')
  results.handoff = handoff
  expect(archived).toEqual(['dev'])
  // A second release finds nobody to release and says so.
  await expect(results.release!.release(human(), task.id, { ...request, requestKey: 'release-2' })).rejects.toThrow('No live spawned member holds the worktree')
  await results.handoff(human(), task.id, { kind: 'review', resultId: result.id, target: { kind: 'group', id: 'reviewers' }, instructions: 'Review', requestKey: 'review-1' })
  expect(archived).toEqual(['dev'])
  expect(reviewMail(task.id)).toHaveLength(1)
})

test('manual sessions in the worktree are shown and never archived; refusals before anything is touched', async () => {
  const { task } = await developed()
  records.set('manual', row('manual', { name: 'Human-made session', spawned: false }))
  records.set('elsewhere', row('elsewhere', { projectPath: repo, spawned: false }))
  expect(results.release!.preview(task.id)).toMatchObject({ others: [{ sessionId: 'manual', name: 'Human-made session' }], unavailable: null })
  await expect(results.release!.release(human(), task.id, { ...request, target: 'nobody' })).rejects.toThrow('Unknown group: nobody')
  await expect(results.release!.release(human(), task.id, { ...request, instructions: ' ' })).rejects.toThrow('needs instructions')
  await expect(results.release!.release(agent('dev'), task.id, request)).rejects.toThrow("is the human's")
  expect(archived).toEqual([])
  await results.release!.release(human(), task.id, request)
  expect(archived).toEqual(['dev'])
  expect(records.get('manual')!.archivedAt).toBeUndefined()
})

test('no result, or no worktree, refuses with the reason the preview gives', async () => {
  const bare = await tasks.create(human(), { title: 'Bare', direction: 'v1' })
  expect(results.release!.preview(bare.id).unavailable).toBe('The task has no worktree.')
  await expect(results.release!.release(human(), bare.id, request)).rejects.toThrow('no worktree')
  const unsubmitted = await tasks.create(human(), { title: 'Unsubmitted', direction: 'v1', worktree: feature })
  expect(results.release!.preview(unsubmitted.id).unavailable).toBe('No result has been submitted yet.')
  await expect(results.release!.release(human(), unsubmitted.id, request)).rejects.toThrow('No result has been submitted yet')
})

test('a review already queued behind the occupied worktree is not doubled: the release frees its slot', async () => {
  const { task, result } = await developed()
  const queued = await results.handoff(human(), task.id, { kind: 'review', resultId: result.id, target: { kind: 'group', id: 'reviewers' },
    instructions: 'Review', requestKey: 'review-early' })
  const outcome = await results.release!.release(human(), task.id, request)
  expect(outcome).toMatchObject({ released: ['dev'], handoff: { duplicate: true, assignment: { id: queued.assignment.id } } })
  expect(outcome.handoff.notice).toContain('proceeds in the freed worktree')
  expect(reviewMail(task.id)).toHaveLength(1)
})
