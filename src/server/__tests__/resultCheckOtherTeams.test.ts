// The "Other teams" scenario (independent-verification, task-results › Kawai
// checks a result against the base and other open branches › Other teams):
// the branch comparison reads only the checking team's own open tasks and
// listed worktrees, through the production sources wired in
// sessionMailbox.ts — openTasks over TaskStore.list scoped by team, and
// TeamWorktrees.list — so a second team's open branch on its own listed
// worktree is never compared into, or named by, the first team's stored
// check facts. No source is stubbed: two real repositories are two teams of
// one mailbox, each with an open task on a listed worktree.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../db'
import type { ChatSessionDriver } from '../chat/ChatSessionDriver'
import { runGit } from '../git/gitCommand'
import { schemaDb } from './schemaDb'
import { SessionMailbox } from '../team/sessionMailbox'
import { SessionTeams } from '../team/sessionTeams'
import { NULL_OWNERSHIP } from '../plans/execution/executionOwnership'
import type { TaskCaller } from '../team/TaskService'
import type { ResultCheckFacts } from '../../shared/teamTasks'

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e',
}
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })

interface TeamFixture {
  teamId: string
  taskWorktree: string
  comparedWorktree: string
  branch: string
  comparedBranch: string
  sha: string
  comparedHead: string
}

/** One repository as one team: a linked worktree holding the submitted
 * result's commit, and a second linked worktree whose branch is the open
 * branch the team's own check compares. Branch names are per team, so a
 * name in the other team's facts is always a leak. */
function makeTeam(at: string, branch: string, comparedBranch: string): TeamFixture {
  const root = path.join(at, 'repo')
  fs.mkdirSync(root, { recursive: true })
  runGit(['init', '--initial-branch=master', root], { timeoutMs: 10_000 })
  const git = (args: string[], cwd = root) => runGit(args, { cwd, timeoutMs: 10_000, env: COMMIT_ENV })
  // Identical content, authors, and same-second timestamps hash to the same
  // commit shas across repositories, so every fixture commit carries the
  // team's branch name — the two teams must never share a sha to check.
  fs.writeFileSync(path.join(root, 'root.txt'), `${branch}\n`)
  git(['add', '--', 'root.txt'])
  if (!git(['commit', '-q', '-m', 'init']).ok) throw new Error('git init commit failed')
  fs.mkdirSync(path.join(root, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(root, '.kawai/groups/devs.md'), 'Build features.')
  fs.writeFileSync(path.join(root, '.kawai/groups/leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  const commitIn = (worktree: string, file: string): string => {
    fs.writeFileSync(path.join(worktree, file), `${branch} ${file}\n`)
    git(['add', '--', file], worktree)
    git(['commit', '-m', 'fixture'], worktree)
    return git(['rev-parse', 'HEAD'], worktree).stdout.trim()
  }
  const taskWorktree = path.join(at, 'task-wt')
  git(['worktree', 'add', '-b', branch, taskWorktree])
  const sha = commitIn(taskWorktree, 'feature.txt')
  const comparedWorktree = path.join(at, 'compared-wt')
  git(['worktree', 'add', '-b', comparedBranch, comparedWorktree])
  const comparedHead = commitIn(comparedWorktree, 'other.txt')
  return {
    teamId: path.join(root, '.git'), taskWorktree, comparedWorktree,
    branch, comparedBranch, sha, comparedHead,
  }
}

let dir: string
let db: Database
let runtime: SessionMailbox
let teamA: TeamFixture
let teamB: TeamFixture

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-check-other-teams-')))
  teamA = makeTeam(path.join(dir, 'team-a'), 'feat-a', 'feat-a-other')
  teamB = makeTeam(path.join(dir, 'team-b'), 'feat-b', 'feat-b-other')
  db = schemaDb(':memory:')
  const records = new Map<string, ChatSessionRecord>()
  for (const [id, group, team] of [
    ['lead-a', 'leads', teamA], ['dev-a', 'devs', teamA],
    ['lead-b', 'leads', teamB], ['dev-b', 'devs', teamB],
  ] as const) {
    records.set(id, { sessionId: id, groupId: group, projectPath: team.taskWorktree, name: id,
      sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '' } as ChatSessionRecord)
  }
  const teams = new SessionTeams({ homeDir: dir })
  for (const [id, team] of [
    ['lead-a', teamA], ['dev-a', teamA], ['lead-b', teamB], ['dev-b', teamB],
  ] as const) {
    await teams.track(id, team.taskWorktree)
  }
  runtime = new SessionMailbox(db, {
    ownership: NULL_OWNERSHIP, onTaskResultWrite: () => {},
    teams, records: () => records.values(), getRecord: id => records.get(id), available: record => !record.archivedAt,
    getDriver: id => ({ getPendingRequests: () => [], deliver: () => { records.get(id)!.status = 'working' } }) as unknown as ChatSessionDriver,
    prepare: async () => {}, restore: () => {}, watchReceipt: () => {}, archive: () => ({ ok: true }),
    hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false, transcriptFor: () => null,
    homeDir: dir, onError: error => { throw error },
  })
})
afterEach(() => { runtime.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

// @covers: task-results › Kawai checks a result against the base and other open branches › Other teams
test('another team\'s open branch is never compared or named by the stored check facts', async () => {
  const taskA = await runtime.tasks.create(agent('lead-a'), { title: 'Team A work', direction: 'Team A direction', worktree: teamA.taskWorktree })
  const taskA2 = await runtime.tasks.create(agent('lead-a'), { title: 'Team A other branch', direction: 'Team A other', worktree: teamA.comparedWorktree })
  const taskB = await runtime.tasks.create(agent('lead-b'), { title: 'Team B work', direction: 'Team B direction', worktree: teamB.taskWorktree })
  const taskB2 = await runtime.tasks.create(agent('lead-b'), { title: 'Team B other branch', direction: 'Team B other', worktree: teamB.comparedWorktree })
  // Both results settle both teams' checks: each team's own second open
  // task is compared, so an empty comparison can never stand in for scoping.
  const resultA = await runtime.results.submit(agent('dev-a'), taskA.id, { summary: 'Team A result', commit: teamA.sha })
  const resultB = await runtime.results.submit(agent('dev-b'), taskB.id, { summary: 'Team B result', commit: teamB.sha })
  await runtime.resultChecks.quiesce()
  const factsOf = (resultId: string): ResultCheckFacts => {
    const stored = runtime.tasks.store.checks.allForResult(resultId)[0]
    expect(stored?.status).toBe('done')
    expect(stored?.facts).toBeDefined()
    return stored!.facts!
  }
  const factsA = factsOf(resultA.id)
  const factsB = factsOf(resultB.id)
  expect(factsA.branches.compared.map(entry => entry.taskId)).toEqual([taskA2.id])
  expect(factsA.branches.compared[0]?.head).toBe(teamA.comparedHead)
  expect(factsB.branches.compared.map(entry => entry.taskId)).toEqual([taskB2.id])
  expect(factsB.branches.compared[0]?.head).toBe(teamB.comparedHead)
  // No stored fact names the other team's task, branch, worktree, or heads.
  const secretsOf = (otherTasks: string[], team: TeamFixture): string[] => [
    ...otherTasks, team.branch, team.comparedBranch, team.taskWorktree, team.comparedWorktree, team.sha, team.comparedHead,
  ]
  const storedA = JSON.stringify(factsA)
  for (const secret of secretsOf([taskB.id, taskB2.id], teamB)) expect(storedA).not.toContain(secret)
  const storedB = JSON.stringify(factsB)
  for (const secret of secretsOf([taskA.id, taskA2.id], teamA)) expect(storedB).not.toContain(secret)
})
