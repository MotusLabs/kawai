// A result records its author's profile (starter-team-setup D5), and a
// review handoff whose worker choice lies wholly within the authors' model
// families is refused at the handoff with nothing written (D7) — through the
// real TaskResultService and AssignmentService over a migrated database.
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
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { recordRecipient } from './helpers/recordRecipient'

let root: string
let home: string
let repo: string
let team: TeamIdentity
let db: SessionDatabase
let mail: MailboxStore
let tasks: TaskService
let results: TaskResultService
let assignments: AssignmentService
let records: Map<string, ChatSessionRecord>
const human = (): TaskCaller => ({ kind: 'human', team })
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const row = (sessionId: string, groupId: string, claudeProfileId?: string): ChatSessionRecord => ({
  sessionId, groupId, projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  ...(claudeProfileId ? { claudeProfileId } : {}),
})

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-result-author-')))
  home = path.join(root, 'home')
  fs.mkdirSync(home)
  repo = path.join(root, 'repo')
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8', env: cleanGitEnv() })
  const commit = spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: repo, encoding: 'utf8', env: cleanGitEnv() })
  if (commit.status !== 0) throw new Error(commit.stderr)
  const groups = path.join(repo, '.kawai', 'groups')
  fs.mkdirSync(groups, { recursive: true })
  fs.writeFileSync(path.join(groups, 'devs.md'), '---\nworkers: { opus: 1, codex-sol: 1 }\nmax: 2\n---\nBuild.')
  fs.writeFileSync(path.join(groups, 'reviewers.md'), '---\nworkers: { codex-sol: 1, opus: 1, openrouter-opus: 1, openrouter-deepseek-flash: 1 }\nmax: 4\ncrossModelReview: true\n---\nReview.')
  fs.writeFileSync(path.join(groups, 'plain.md'), '---\nworkers: { opus: 1 }\n---\nPlain review.')
  fs.writeFileSync(path.join(groups, 'lead.md'), '---\ncanCreateTasks: true\n---\nLead.')
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  records = new Map([
    ['lead', row('lead', 'lead', 'codex-sol')], ['opus-dev', row('opus-dev', 'devs', 'opus')],
    ['sol-dev', row('sol-dev', 'devs', 'codex-sol')], ['legacy-dev', row('legacy-dev', 'devs')],
    ['opus-reviewer', row('opus-reviewer', 'reviewers', 'opus')],
  ])
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
  assignments = new AssignmentService(db.db, assignmentStore, store, mail, {
    getSession: id => records.get(id), records: () => records.values(),
    teamOf: id => records.has(id) ? team : undefined,
    staffing, caps: new TeamCaps({}), worktrees,
    recipient: id => recordRecipient(records.get(id), team.teamId, mail),
    homeDir: home,
  })
  results = new TaskResultService(tasks, { getSession: id => records.get(id), assignments, homeDir: home })
})

async function submittedBy(sessionId: string, taskId?: string) {
  const id = taskId ?? (await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })).id
  const result = await results.submit(agent(sessionId), id, { summary: `work by ${sessionId}`, commit: 'abc123' })
  return { taskId: id, result }
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try { await run() } catch (error) { return error instanceof Error ? error.message : String(error) }
  throw new Error('expected a refusal')
}

const review = (resultId: string, target: string, extra: Record<string, unknown> = {}) => ({
  kind: 'review' as const, resultId, target: { kind: 'group' as const, id: target }, instructions: 'Review it',
  expectedResponse: null, requestKey: `review-${crypto.randomUUID()}`, ...extra,
})

describe('a result records its author profile', () => {
  // @covers: task-results › A result records its author's profile › The profile is recorded at submission
  test('the stored result names the submitting session profile', async () => {
    const { taskId } = await submittedBy('opus-dev')
    expect(tasks.store.results.authorsOf(taskId)).toEqual([{ sessionId: 'opus-dev', profileId: 'opus' }])
  })

  // @covers: task-results › A result records its author's profile › The author profile survives release
  test('the profile stays after the session record is removed', async () => {
    const { taskId } = await submittedBy('sol-dev')
    records.delete('sol-dev')
    expect(tasks.store.results.authorsOf(taskId)).toEqual([{ sessionId: 'sol-dev', profileId: 'codex-sol' }])
  })

  test('a legacy record without a profile id is recorded as default', async () => {
    const { taskId } = await submittedBy('legacy-dev')
    expect(tasks.store.results.authorsOf(taskId)).toEqual([{ sessionId: 'legacy-dev', profileId: 'default' }])
  })

  test('every round author is listed once, in first-submission order', async () => {
    const { taskId } = await submittedBy('opus-dev')
    await submittedBy('sol-dev', taskId)
    await submittedBy('opus-dev', taskId)
    expect(tasks.store.results.authorsOf(taskId)).toEqual([
      { sessionId: 'opus-dev', profileId: 'opus' }, { sessionId: 'sol-dev', profileId: 'codex-sol' },
    ])
  })

  // @covers: task-results › A result records its author's profile › An older result falls back to the session record
  test('a row stored without a profile reads null, and the filter resolves it from the session record', async () => {
    const { taskId } = await submittedBy('sol-dev')
    db.db.prepare('UPDATE team_task_results SET submitted_by_profile = NULL WHERE task_id = ?').run(taskId)
    expect(tasks.store.results.authorsOf(taskId)).toEqual([{ sessionId: 'sol-dev', profileId: null }])
    // An opus choice is allowed for a codex-sol (gpt) author resolved through the record.
    const { result } = { result: tasks.store.results.outstanding(taskId)! }
    const handed = await results.handoff(human(), taskId, review(result.id, 'reviewers', { worker: 'claude/opus' }))
    expect(handed.assignment.workerChoice).toBe('claude/opus')
  })
})

describe('handoff refusal inside the authors families (E8, E9)', () => {
  test("E8: choosing the author's model is refused and nothing is written", async () => {
    const { taskId, result } = await submittedBy('opus-dev')
    const before = { assignments: tasks.store.assignmentsOf(taskId).length, mail: mail.forTask(taskId).length }
    expect(await refusal(() => results.handoff(human(), taskId, review(result.id, 'reviewers', { worker: 'claude/opus' })))).toBe(
      "The handoff is refused: worker choice is within the authors' model family claude; a cross-model review needs a worker of another family. Nothing was dispatched.")
    expect({ assignments: tasks.store.assignmentsOf(taskId).length, mail: mail.forTask(taskId).length }).toEqual(before)
  })

  test('E9: a provider choice keeping another family is accepted', async () => {
    const { taskId, result } = await submittedBy('opus-dev')
    const handed = await results.handoff(human(), taskId, review(result.id, 'reviewers', { worker: 'openrouter' }))
    expect(handed.assignment.workerChoice).toBe('openrouter')
  })

  test('an unflagged group takes the same choice', async () => {
    const { taskId, result } = await submittedBy('opus-dev')
    const handed = await results.handoff(human(), taskId, review(result.id, 'plain', { worker: 'claude/opus' }))
    expect(handed.assignment.workerChoice).toBe('claude/opus')
  })
})

// The reader domains (starter-team-setup D6, as corrected at integration):
// the task-dispatch preview previews a plain task assignment and never
// receives the review filter — a flagged group with result authors still
// previews its author-family member — while the actual review handoff of the
// same result to the same group is refused for the same choice. Through the
// real AssignmentService preview and TaskResultService handoff.
describe('the plain-dispatch preview stays unfiltered where the review handoff filters', () => {
  test('a flagged preview with an existing result author still names the author-family member; the real review handoff refuses', async () => {
    const { taskId, result } = await submittedBy('opus-dev')
    db.db.prepare('UPDATE team_tasks SET worktree = ? WHERE id = ?').run(repo, taskId)
    const plain = await assignments.preview(human(), { taskId, target: { kind: 'group', id: 'reviewers' } })
    // Unfiltered: `opus` runs the author's family `claude`, yet the plain
    // preview names the member and the first allowed spawn profile as usual.
    expect(plain.idleMembers).toContain('opus-reviewer')
    expect(plain.profile).toBe('codex-sol')
    // The same task's actual review handoff with the author-family choice is
    // refused: the filter lives on the review path alone.
    expect(await refusal(() => results.handoff(human(), taskId, review(result.id, 'reviewers', { worker: 'claude/opus' })))).toBe(
      "The handoff is refused: worker choice is within the authors' model family claude; a cross-model review needs a worker of another family. Nothing was dispatched.")
  })
})
