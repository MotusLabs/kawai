// The blind-first seal (independent-verification D6, task 3.2): a session
// holding a task's outstanding review handoff for a result reads the
// submitter's maps withheld — every result of the task, its clause count
// stated, its shape nowhere, check-fact outcomes stripped — until it records
// its own map for that result; then the maps and their differences show.
// Unclaimed group handoffs and superseded or failed ones seal nobody; the
// human always sees everything. Maps are append-only and survive restart.
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
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { TaskResultService, handoffInstruction } from '../team/TaskResultService'
import { taskHandlers } from '../team/taskTools'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { compareCoverageMaps } from '../../shared/coverageMaps'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

let root: string
let repo: string
let dbPath: string
let team: TeamIdentity
let db: SessionDatabase
let mail: MailboxStore
let tasks: TaskService
let results: TaskResultService
let assignments: AssignmentService
let records: Map<string, ChatSessionRecord>
const human = (): TaskCaller => ({ kind: 'human', team })
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const row = (sessionId: string, groupId: string, projectPath = repo): ChatSessionRecord => ({
  sessionId, groupId, projectPath, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-coverage-seal-')))
  repo = path.join(root, 'repo')
  for (const dir of [repo, path.join(root, 'other')]) {
    git(['init', '-q', dir])
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
  }
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), 'Build.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'reviewers.md'), 'Review.')
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  records = new Map([['lead', row('lead', 'leads')], ['dev', row('dev', 'devs')], ['reviewer', row('reviewer', 'reviewers')],
    ['second', row('second', 'reviewers')], ['stranger', row('stranger', 'leads', path.join(root, 'other'))]])
  db?.close()
  dbPath = path.join(fs.mkdtempSync(path.join(root, 'db-')), 'tasks.db')
  db = initDatabase({ path: dbPath })
  mail = new MailboxStore(db.db)
  const assignmentStore = new AssignmentStore(db.db, mail)
  const store = new TaskStore(db.db, mail, assignmentStore)
  tasks = new TaskService(store, { getSession: id => records.get(id) })
  const staffing = new WorktreeStaffing(db.db, mail, {
    records: () => records.values(), teamOf: () => undefined, caps: new TeamCaps({}), worktrees: new TeamWorktrees(),
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  assignments = new AssignmentService(db.db, assignmentStore, store, mail, {
    getSession: id => records.get(id), records: () => records.values(), teamOf: () => undefined, staffing, caps: new TeamCaps({}),
    worktrees: new TeamWorktrees(),
  })
  results = new TaskResultService(tasks, { getSession: id => records.get(id), assignments })
})

const cite = (path: string, title: string) => `\`${path}\` › \`${title}\``
const submitterMap = [
  { clause: 'A clean export downloads', tests: [cite('src/export.test.ts', 'downloads a csv'), cite('src/export.test.ts', 'keeps the header')] },
  { clause: 'Rows keep their order', tests: [cite('src/order.test.ts', 'preserves row order')] },
]
const submitWithMap = (taskId: string, coverage: unknown = submitterMap, summary = 'CSV export') =>
  results.submit(agent('dev'), taskId, { summary, commit: 'abc123', coverage,
    tests: [{ description: 'bun run test', outcome: 'pass' }] })
const reviewOf = (taskId: string, resultId: string, target: { kind: 'group' | 'session'; id: string }) =>
  results.handoff(agent('lead'), taskId, { kind: 'review', resultId, target, instructions: 'Review the export', expectedResponse: null })
/** The detail the named session reads through the task_get handler (the seal applies there). */
const readAs = async (sessionId: string, taskId: string) =>
  (await taskHandlers(tasks, sessionId, results).task_get({ task_id: taskId })).results as
    Array<Record<string, any>>
const readHuman = async (taskId: string) => results.applySeal(human(), taskId, await tasks.get(human(), taskId))
const settledFactsWith = (coverage: unknown) => JSON.stringify({ version: 1, coverage })

// @covers: task-results › Reviewers record their own coverage map first › Map withheld from the reviewer
test('a session-target review handoff withholds every submitter map: clause count only, shape nowhere, facts stripped', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await submitWithMap(task.id)
  // Kawai's check carried citation outcomes before the handoff: they name the map's shape.
  const check = tasks.store.checks.pendingForResult(result.id)!
  expect(tasks.store.checks.settle(check.id, 'done', settledFactsWith([['ran-passed', 'ran-passed'], ['run-unknown']]), null)).toBe(true)
  const handed = await reviewOf(task.id, result.id, { kind: 'session', id: 'reviewer' })
  expect(handed.assignment).toMatchObject({ handoffKind: 'review', targetKind: 'session', targetId: 'reviewer' })
  const rows = await readAs('reviewer', task.id)
  expect(rows).toHaveLength(1)
  expect(rows[0]!.coverage).toEqual({ withheld: true, clauses: 2 })
  // No citation, clause, or outcome text anywhere in the sealed view.
  const sealed = JSON.stringify(rows)
  for (const leak of ['downloads a csv', 'keeps the header', 'Rows keep their order', 'export.test.ts', 'ran-passed']) {
    expect(sealed).not.toContain(leak)
  }
  expect(rows[0]!.checks.newest.facts.coverage).toBeUndefined()
  expect(rows[0]!.reviewerMaps).toEqual([])
  // The human reads the same task whole.
  const humanView = (await readHuman(task.id)).results!
  expect(humanView[0]!.coverage).toEqual(submitterMap)
  expect(humanView[0]!.checks!.newest!.facts!.coverage).toEqual([['ran-passed', 'ran-passed'], ['run-unknown']])
})

// @covers: task-results › Reviewers record their own coverage map first › Map shown after recording
test('recording the reviewer\'s own map unseals the task: both maps and the comparison show', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await submitWithMap(task.id)
  await reviewOf(task.id, result.id, { kind: 'session', id: 'reviewer' })
  const reviewerMap = [
    { clause: 'A Clean  Export Downloads', tests: [cite('src/export.test.ts', 'downloads a csv')] },
    { clause: 'Rows keep their order', tests: [] },
    { clause: 'Only the reviewer checks the header', tests: [cite('src/review.test.ts', 'checks the header')] },
  ]
  const stored = await taskHandlers(tasks, 'reviewer', results)
    .task_submit_coverage!({ task_id: task.id, result_id: result.id, coverage: reviewerMap })
  // The tool returns the result the map now annotates — its submitter is unchanged.
  expect(stored.submittedBy).toEqual({ kind: 'agent', sessionId: 'dev' })
  const rows = await readAs('reviewer', task.id)
  expect(rows[0]!.coverage).toEqual(submitterMap)
  expect(rows[0]!.reviewerMaps).toMatchObject([{ authorSession: 'reviewer', coverage: reviewerMap }])
  // The result-level comparison is the reviewer's own pair; the reviewerMaps
  // entry carries the same diff (C2 pin: every unsealed read keeps it).
  const expected = compareCoverageMaps(submitterMap, reviewerMap)
  expect(expected).toEqual({
    onlySubmitter: [],
    onlyReviewer: ['Only the reviewer checks the header'],
    differingCitations: [
      { clause: 'A clean export downloads', onlySubmitter: ['src/export.test.ts › keeps the header'], onlyReviewer: [] },
      { clause: 'Rows keep their order', onlySubmitter: ['src/order.test.ts › preserves row order'], onlyReviewer: [] },
    ],
    uncoveredDisputes: ['Rows keep their order'],
  })
  expect(rows[0]!.comparison).toEqual(expected)
  expect(rows[0]!.reviewerMaps[0]!.comparison).toEqual(expected)
})

// @covers: task-results › Reviewers record their own coverage map first › A newer result's map is withheld too
test('a newer result\'s map is withheld from the holder of the earlier result\'s review handoff', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const first = await results.submit(agent('dev'), task.id, { summary: 'CSV export', commit: 'abc123', tests: [] })
  await reviewOf(task.id, first.id, { kind: 'session', id: 'reviewer' })
  const newer = [
    { clause: 'The newer clause', tests: [cite('src/newer.test.ts', 'covers newer')] },
  ]
  const second = await submitWithMap(task.id, newer, 'CSV export, v2')
  expect(second.supersedesResultId).toBe(first.id)
  const rows = await readAs('reviewer', task.id)
  expect(rows.map(row => [row.id === second.id, row.coverage])).toEqual([
    [true, { withheld: true, clauses: 1 }],
    // The earlier result has no map of its own: null, never a withheld stub.
    [false, null],
  ])
})

// @covers: task-results › Reviewers record their own coverage map first › Others see the submitter's map
test('the human and sessions without the handoff see the submitter\'s maps', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await submitWithMap(task.id)
  await reviewOf(task.id, result.id, { kind: 'session', id: 'reviewer' })
  // A sealed reviewer for one task is not sealed for another task of the team.
  const other = await tasks.create(agent('lead'), { title: 'Import', direction: 'v1' })
  await submitWithMap(other.id)
  expect((await readAs('second', task.id))[0]!.coverage).toEqual(submitterMap)
  expect((await readAs('reviewer', other.id))[0]!.coverage).toEqual(submitterMap)
  // The submitter reads its own map back, with no comparison of its own yet.
  expect((await readAs('dev', task.id))[0]!.coverage).toEqual(submitterMap)
  expect((await readAs('dev', task.id))[0]!.comparison).toBeNull()
  expect((await readHuman(other.id)).results![0]!.coverage).toEqual(submitterMap)
})

// @covers: task-results › Reviewers record their own coverage map first › Map withheld from the reviewer
test('the claimant of a group-target review handoff is sealed; a fellow group member is not', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await submitWithMap(task.id)
  await reviewOf(task.id, result.id, { kind: 'group', id: 'reviewers' })
  // Unclaimed, the group's members all read the maps (the unclaimed window, D6).
  expect((await readAs('reviewer', task.id))[0]!.coverage).toEqual(submitterMap)
  expect((await readAs('second', task.id))[0]!.coverage).toEqual(submitterMap)
  // The claim is what seals: only the holder of the handoff.
  mail.claim(tasks.store.outstandingAssignment(task.id)!.messageId!, 'reviewer')
  expect((await readAs('reviewer', task.id))[0]!.coverage).toEqual({ withheld: true, clauses: 2 })
  expect((await readAs('second', task.id))[0]!.coverage).toEqual(submitterMap)
})

test('a superseded review handoff seals nobody; a QA handoff and a fix handoff never seal', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const first = await submitWithMap(task.id)
  await reviewOf(task.id, first.id, { kind: 'session', id: 'reviewer' })
  expect((await readAs('reviewer', task.id))[0]!.coverage).toEqual({ withheld: true, clauses: 2 })
  // A new review handoff of the newer result supersedes the reviewer's: the
  // superseded holder seals nobody again, the new holder does.
  const newerMap = [{ clause: 'Newer', tests: [cite('src/n.test.ts', 'new')] }]
  const second = await submitWithMap(task.id, newerMap, 'v2')
  await reviewOf(task.id, second.id, { kind: 'session', id: 'second' })
  expect((await readAs('reviewer', task.id))[0]!.coverage).toEqual(newerMap)
  expect((await readAs('second', task.id))[0]!.coverage).toEqual({ withheld: true, clauses: 1 })
  // A QA handoff supersedes the review: its target reads maps like anyone.
  await results.handoff(agent('lead'), task.id, { kind: 'qa', resultId: second.id, target: { kind: 'session', id: 'second' }, instructions: 'QA it', expectedResponse: null })
  expect((await readAs('second', task.id))[0]!.coverage).toEqual(newerMap)
  // And a fix handoff over it: still no seal, for its target either.
  await results.handoff(agent('lead'), task.id, { kind: 'fix', resultId: second.id, target: { kind: 'session', id: 'dev' }, instructions: 'Fix it', expectedResponse: null })
  expect((await readAs('dev', task.id))[0]!.coverage).toEqual(newerMap)
})

// @covers: task-results › Reviewers record their own coverage map first › Map withheld from the reviewer
test('a sealed reader keeps its own reviewer-map rows (comparisons dropped) and never sees another reviewer\'s', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await submitWithMap(task.id)
  // A second result carries both reviewers' maps; the seal keys on the
  // handoff's result, which neither reviewer has mapped.
  const newer = await submitWithMap(task.id, [{ clause: 'Newer', tests: [cite('src/n.test.ts', 'new')] }], 'v2')
  await taskHandlers(tasks, 'second', results).task_submit_coverage!({ task_id: task.id, result_id: newer.id, coverage: submitterMap })
  const ownMap = [{ clause: 'My own reading', tests: [cite('src/mine.test.ts', 'mine')] }]
  await taskHandlers(tasks, 'reviewer', results).task_submit_coverage!({ task_id: task.id, result_id: newer.id, coverage: ownMap })
  await reviewOf(task.id, result.id, { kind: 'session', id: 'reviewer' })
  const rows = await readAs('reviewer', task.id)
  const newerView = rows.find(row => row.id === newer.id)!
  expect(newerView.reviewerMaps).toMatchObject([{ authorSession: 'reviewer' }])
  expect(newerView.reviewerMaps).toHaveLength(1)
  expect(newerView.reviewerMaps[0]!.comparison).toBeNull()
  // The submitter's map on the newer result is withheld all the same (J3).
  expect(newerView.coverage).toEqual({ withheld: true, clauses: 1 })
  // Sealed and holding no map for the handoff's result: the reviewer records
  // one there and the whole task unseals, other reviewers' maps included.
  await taskHandlers(tasks, 'reviewer', results).task_submit_coverage!({ task_id: task.id, result_id: result.id, coverage: ownMap })
  const unsealed = await readAs('reviewer', task.id)
  expect(unsealed.find(row => row.id === result.id)!.coverage).toEqual(submitterMap)
  expect(unsealed.find(row => row.id === newer.id)!.reviewerMaps).toHaveLength(2)
  expect(unsealed.find(row => row.id === newer.id)!.comparison).toEqual(compareCoverageMaps([{ clause: 'Newer', tests: [cite('src/n.test.ts', 'new')] }], ownMap))
})

test('task_submit_coverage refusals: a malformed map names its clause and writes nothing, like every other wrong target', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await submitWithMap(task.id)
  const other = await tasks.create(agent('lead'), { title: 'Import', direction: 'v1' })
  const otherResult = await submitWithMap(other.id, [])
  const submit = taskHandlers(tasks, 'reviewer', results).task_submit_coverage!
  // The submitter's map rides the result row; the maps table holds reviewers' maps only.
  const maps = () => tasks.store.checks.coverageMapsFor(result.id)
  expect(maps()).toHaveLength(0)
  expect(tasks.store.results.get(result.id)!.coverage).toEqual(submitterMap)
  await expect(submit({ task_id: task.id, result_id: result.id, coverage: [{ clause: 'ok', tests: [] }, { clause: ' ' }] }))
    .rejects.toThrow('coverage clause 2 needs a non-empty clause')
  await expect(submit({ task_id: task.id, result_id: result.id, coverage: 'nope' })).rejects.toThrow('must be a list of clauses')
  await expect(submit({ task_id: other.id, result_id: result.id, coverage: [] })).rejects.toThrow(`is not a result of task ${other.id}`)
  await expect(taskHandlers(tasks, 'stranger', results).task_submit_coverage!({ task_id: other.id, result_id: otherResult.id, coverage: [] }))
    .rejects.toThrow('not found in this team')
  await expect(results.submitCoverage(human(), task.id, { resultId: result.id, coverage: [] })).rejects.toThrow('task_submit_coverage')
  expect(maps()).toHaveLength(0)
  // The tool strips unknown arguments: a forged author never reaches the store.
  await submit({ task_id: task.id, result_id: result.id, coverage: [{ clause: 'Mine', tests: [] }], author_session: 'someone-else' })
  expect(maps().map(entry => entry.authorSession)).toEqual(['reviewer'])
})

// @covers: task-results › Checks and coverage maps are kept and read with their results › Restart keeps checks and maps
test('maps are append-only: the newest map per session counts, each session keeps its own, and restart changes nothing', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await submitWithMap(task.id)
  const submit = taskHandlers(tasks, 'reviewer', results).task_submit_coverage!
  await submit({ task_id: task.id, result_id: result.id, coverage: [{ clause: 'First reading', tests: [] }] })
  await submit({ task_id: task.id, result_id: result.id, coverage: [{ clause: 'Second reading', tests: [cite('src/two.test.ts', 'two')] }] })
  await taskHandlers(tasks, 'second', results).task_submit_coverage!({ task_id: task.id, result_id: result.id, coverage: [{ clause: 'Second reviewer', tests: [] }] })
  const rows = (await readAs('reviewer', task.id))[0]!.reviewerMaps as Array<{ authorSession: string; coverage: unknown }>
  expect(rows.map(entry => [entry.authorSession, entry.coverage])).toEqual([
    ['reviewer', [{ clause: 'Second reading', tests: [cite('src/two.test.ts', 'two')] }]],
    ['second', [{ clause: 'Second reviewer', tests: [] }]],
  ])
  // Restart: the same database reopened reads the same maps, rows and all.
  db.close()
  db = initDatabase({ path: dbPath })
  const reopenedMail = new MailboxStore(db.db)
  const store = new TaskStore(db.db, reopenedMail, new AssignmentStore(db.db, reopenedMail))
  tasks = new TaskService(store, { getSession: id => records.get(id) })
  results = new TaskResultService(tasks, { getSession: id => records.get(id) })
  const after = (await readAs('reviewer', task.id))[0]!
  expect(after.coverage).toEqual(submitterMap)
  expect((after.reviewerMaps as Array<{ authorSession: string; coverage: unknown }>).map(entry => [entry.authorSession, entry.coverage]))
    .toEqual(rows.map(entry => [entry.authorSession, entry.coverage]))
})

// @covers: task-results › Reviewers record their own coverage map first › The handoff carries no map
test('the handoff instruction names the result and its commit and never renders the map (J4)', () => {
  const result = {
    id: 'result-x', taskId: 'task-x', summary: 'CSV export', commit: 'abc123', diff: null, worktree: null,
    tests: [], limitations: null, coverage: submitterMap, taskRevision: 1,
    submittedBy: { kind: 'agent' as const, sessionId: 'dev' }, supersedesResultId: null, supersededBy: null,
    acceptedBy: null, acceptedAt: null, needsReevaluation: false, findings: [], createdAt: 'now',
  }
  const instruction = handoffInstruction('review', result, 'Review the export', null)
  expect(instruction).toContain('result result-x (commit abc123)')
  expect(instruction).not.toContain('downloads a csv')
  expect(instruction).not.toContain('Rows keep their order')
  expect(instruction).not.toContain('export.test.ts')
})

// @covers: task-results › Results carry a coverage map › The map is a claim
test('a declared-uncovered map gates nothing: the result is still handed off, reviewed, and accepted (J7)', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await submitWithMap(task.id, [{ clause: 'Everything', tests: [] }])
  // The handoff dispatches over the mapped result...
  const handed = await reviewOf(task.id, result.id, { kind: 'session', id: 'reviewer' })
  expect(handed.duplicate).toBe(false)
  // ...findings land on it...
  await results.submitFindings(agent('reviewer'), task.id, { resultId: result.id, kind: 'review', verdict: 'pass', findings: 'ok' })
  // ...and the creator accepts and closes, the map's emptiness notwithstanding.
  await results.accept(agent('lead'), task.id, result.id)
  expect(tasks.store.get(task.id)?.status).toBe('done')
  expect(tasks.store.results.get(result.id)!.acceptedAt).not.toBeNull()
})

// @covers: task-results › Results carry a coverage map › The map is a claim
test('a submission\'s malformed map leaves no result and no check behind (J1, at the result boundary)', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  await expect(results.submit(agent('dev'), task.id, { summary: 'x', commit: 'a', coverage: [{ clause: 'ok', tests: [] }, { tests: [] }] }))
    .rejects.toThrow('coverage clause 2 needs a non-empty clause')
  expect(tasks.store.results.listByTask(task.id)).toEqual([])
  expect(tasks.store.checks.pendingForTeam(team.teamId)).toEqual([])
})







