// `worker` on dispatches and task_handoff (dispatch-worker-choice 3.2, design
// D7, task-results spec "Handoffs can name a worker"): a group handoff carries
// the normalized choice on its row and instruction mail; the choice is part of
// the request key's payload identity (compared normalized) and of the agent
// retry's standing-equivalent check; a session target, Kawai, and an invalid
// worker are refused with nothing written.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { taskHandlers, taskSchemas } from '../team/taskTools'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { WORKER_GROUP_TARGET_ONLY } from '../team/workerChoiceCheck'

let root: string
let home: string
let repo: string
let team: TeamIdentity
let db: SessionDatabase
let mail: MailboxStore
let assignmentStore: AssignmentStore
let tasks: TaskService
let results: TaskResultService
let assignments: AssignmentService
let records: Map<string, ChatSessionRecord>
const human = (): TaskCaller => ({ kind: 'human', team })
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const row = (sessionId: string, groupId: string): ChatSessionRecord => ({
  sessionId, groupId, projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-handoff-worker-')))
  // An empty home: the shipped catalog, claude {default, opus, sonnet, haiku} and zai {glm, glm-flash}.
  home = path.join(root, 'home')
  fs.mkdirSync(home)
  repo = path.join(root, 'repo')
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8', env: cleanGitEnv() })
  const commit = spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: repo, encoding: 'utf8', env: cleanGitEnv() })
  if (commit.status !== 0) throw new Error(commit.stderr)
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), 'devs.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'reviewers.md'), '---\nprofiles: [sonnet, glm]\n---\nReview.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  records = new Map([['lead', row('lead', 'leads')], ['dev', row('dev', 'devs')], ['reviewer', row('reviewer', 'reviewers')]])
  db?.close()
  db = initDatabase({ path: path.join(fs.mkdtempSync(path.join(root, 'db-')), 'tasks.db') })
  mail = new MailboxStore(db.db)
  assignmentStore = new AssignmentStore(db.db, mail)
  const store = new TaskStore(db.db, mail, assignmentStore)
  tasks = new TaskService(store, { getSession: id => records.get(id) })
  const worktrees = new TeamWorktrees()
  const staffing = new WorktreeStaffing(db.db, mail, {
    records: () => records.values(), teamOf: () => undefined, caps: new TeamCaps({}), worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  assignments = new AssignmentService(db.db, assignmentStore, store, mail, {
    getSession: id => records.get(id), records: () => records.values(), teamOf: () => undefined, staffing, caps: new TeamCaps({}), worktrees,
    homeDir: home,
  })
  results = new TaskResultService(tasks, { getSession: id => records.get(id), assignments })
})

const review = (resultId: string, extra: Record<string, unknown> = {}) => ({
  kind: 'review' as const, resultId, target: { kind: 'group' as const, id: 'reviewers' }, instructions: 'Review the export',
  expectedResponse: null, requestKey: 'review-1', ...extra,
})

async function submitted() {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, { summary: 'CSV export', commit: 'abc123' })
  return { task, result }
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try { await run() } catch (error) { return error instanceof Error ? error.message : String(error) }
  throw new Error('expected a refusal')
}

const written = (taskId: string) => ({ assignments: tasks.store.assignmentsOf(taskId).length, mail: mail.forTask(taskId).length })

describe('a group handoff carries the worker', () => {
  // @covers: task-results › Handoffs can name a worker › Review on another provider
  test('the normalized choice rides the row and the instruction mail', async () => {
    const { task, result } = await submitted()
    const handed = await results.handoff(human(), task.id, review(result.id, { worker: 'glm' }))
    expect(handed.assignment.workerChoice).toBe('zai/glm')
    expect(mail.get(handed.assignment.messageId!)).toMatchObject({ toKind: 'group', toId: 'reviewers', workerChoice: 'zai/glm' })
  })

  // @covers: task-results › Handoffs can name a worker › Review on another provider
  test('task_handoff passes worker through to the dispatch', async () => {
    const { task, result } = await submitted()
    expect(Object.keys(taskSchemas.task_handoff.shape)).toContain('worker')
    const handed = await taskHandlers(tasks, 'lead', results).task_handoff!({
      task_id: task.id, kind: 'review', result_id: result.id, target: 'reviewers', instructions: 'Review it', worker: 'claude',
    }) as { assignment: { workerChoice?: string; messageId: string } }
    expect(handed.assignment.workerChoice).toBe('claude')
    expect(mail.get(handed.assignment.messageId)!.workerChoice).toBe('claude')
  })

  test('a plain assignment carries a worker too', async () => {
    const { task } = await submitted()
    const out = await assignments.dispatch(human(), { taskId: task.id, target: { kind: 'group', id: 'reviewers' }, instruction: 'Go', requestKey: 'a-1', worker: 'zai' })
    expect(out.assignment.workerChoice).toBe('zai')
    expect(out.message!.workerChoice).toBe('zai')
  })
})

describe('payload identity', () => {
  // @covers: task-results › Handoffs can name a worker › Same key, different worker
  test('the same key with a different worker is refused naming worker; the normalized form replays', async () => {
    const { task, result } = await submitted()
    const first = await results.handoff(human(), task.id, review(result.id, { worker: 'zai/glm' }))
    const before = written(task.id)
    expect(await refusal(() => results.handoff(human(), task.id, review(result.id, { worker: 'claude' }))))
      .toBe('Request key already used with a different worker')
    expect(await refusal(() => results.handoff(human(), task.id, review(result.id))))
      .toBe('Request key already used with a different worker')
    const replay = await results.handoff(human(), task.id, review(result.id, { worker: 'glm' }))
    expect(replay).toMatchObject({ duplicate: true, assignment: { id: first.assignment.id } })
    expect(written(task.id)).toEqual(before)
  })

  test('the store\'s insert-then-read names worker too', async () => {
    const { task } = await submitted()
    const base = { teamId: team.teamId, taskId: task.id, requestKey: 'k', targetKind: 'group' as const, targetId: 'reviewers', role: 'reviewers',
      instruction: 'Go', creator: { kind: 'human' as const, sessionId: null } }
    assignmentStore.insert({ ...base, workerChoice: 'zai' })
    expect(() => assignmentStore.insert({ ...base, workerChoice: 'claude' })).toThrow('Request key already used with a different worker')
    expect(() => assignmentStore.insert(base)).toThrow('Request key already used with a different worker')
    expect(assignmentStore.insert({ ...base, workerChoice: 'zai' }).replay).toBe(true)
  })

  // @covers: task-results › Handoffs can name a worker › Same key, different worker
  test('an agent retry is equivalent only with the same worker; another worker is another handoff', async () => {
    const { task, result } = await submitted()
    const ask = (worker?: string) => results.handoff(agent('dev'), task.id,
      { kind: 'review', resultId: result.id, target: { kind: 'group', id: 'reviewers' }, instructions: 'Review', ...(worker ? { worker } : {}) })
    const first = await ask('glm')
    const retry = await ask('zai/glm')
    expect(retry).toMatchObject({ duplicate: true, assignment: { id: first.assignment.id } })
    const other = await ask('claude')
    expect(other.duplicate).toBe(false)
    expect(other.assignment.workerChoice).toBe('claude')
    expect(tasks.store.assignmentsOf(task.id).find(row => row.id === first.assignment.id)!.supersededBy).toBe(other.assignment.id)
  })
})

describe('refusals write nothing', () => {
  // @covers: task-results › Handoffs can name a worker › Worker on a session target
  test('a session target refuses a worker: a choice applies only to group targets', async () => {
    const { task, result } = await submitted()
    const before = written(task.id)
    const error = await refusal(() => results.handoff(agent('dev'), task.id,
      { kind: 'review', resultId: result.id, target: { kind: 'session', id: 'reviewer' }, instructions: 'Review', worker: 'claude' }))
    expect(error).toBe(WORKER_GROUP_TARGET_ONLY)
    expect(await refusal(() => assignments.dispatch(human(), { taskId: task.id, target: { kind: 'session', id: 'reviewer' }, instruction: 'Go', requestKey: 's-1', worker: 'claude' })))
      .toBe(WORKER_GROUP_TARGET_ONLY)
    expect(written(task.id)).toEqual(before)
  })

  test('an out-of-group or unknown worker is refused naming the reason', async () => {
    const { task, result } = await submitted()
    const before = written(task.id)
    expect(await refusal(() => results.handoff(human(), task.id, review(result.id, { worker: 'claude/opus' }))))
      .toContain('not among group reviewers\'s workers: claude/sonnet, zai/glm')
    expect(await refusal(() => results.handoff(agent('dev'), task.id,
      { kind: 'review', resultId: result.id, target: { kind: 'group', id: 'reviewers' }, instructions: 'Review', worker: 'nobody' })))
      .toContain('names no provider or model')
    expect(written(task.id)).toEqual(before)
  })

  // @covers: task-results › Handoffs can name a worker › Plan-execution handoffs carry no choice
  test('Kawai never carries a worker choice', async () => {
    const { task } = await submitted()
    const system = { kind: 'system' as const, team, origin: { kind: 'execution' as const, executionId: 'exec-1' } }
    expect(() => assignments.workerChoice(system as never, team, { kind: 'group', id: 'reviewers' }, 'claude'))
      .toThrow("Kawai's dispatches carry no worker choice")
    expect(assignments.workerChoice(system as never, team, { kind: 'group', id: 'reviewers' }, undefined)).toBeNull()
    expect(written(task.id)).toEqual({ assignments: 0, mail: 0 })
  })
})
