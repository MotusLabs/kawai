// Worktree occupancy read model (team-waiting-reasons D4): live sessions
// grouped by resolved worktree root — manual and spawned both listed, manual
// never counted as a writer — plus pending reservations, archived exclusion,
// and subdirectory resolution.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatSessionRecord } from '../db'
import { teamRoster, worktreeWriters, type PendingSpawnRow } from '../team/teamRoster'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'

function git(args: string[], cwd?: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

let root: string
let repo: string
let featX: string
let team: TeamIdentity
let other: TeamIdentity

const record = (sessionId: string, extra: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId, name: sessionId, projectPath: repo, sdkSessionId: null, status: 'working', createdAt: '', lastActivityAt: '',
  ...extra,
})
const rosterOf = (records: ChatSessionRecord[], pendingSpawns: PendingSpawnRow[] = [], teamOf = (id: string) => (id.startsWith('other-') ? other : team)) =>
  teamRoster(team.teamId, { records, teamOf, pendingSpawns })

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-roster-')))
  repo = path.join(root, 'repo')
  featX = path.join(root, 'feat-x')
  const otherRepo = path.join(root, 'other')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-x', featX], repo)
  git(['init', '-q', otherRepo])
  clearTeamCache()
  team = await resolveTeam(repo)
  other = await resolveTeam(otherRepo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

test('manual and spawned sessions are listed under their resolved worktree root', () => {
  const roster = rosterOf([
    record('manual', { groupId: 'devs', projectPath: repo }),
    record('spawned-1', { groupId: 'devs', projectPath: featX, spawned: true, taskId: 'task-1', claudeProfileId: 'glm', status: 'waiting' }),
  ])
  expect(roster).toHaveLength(2)
  // Deterministic order: worktree paths sorted, so feat-x precedes repo.
  expect(roster[0]).toMatchObject({ worktree: featX })
  expect(roster[0]!.sessions[0]).toEqual({
    sessionId: 'spawned-1', group: 'devs', profile: 'glm', status: 'waiting', spawned: true, taskId: 'task-1',
  })
  expect(roster[1]).toMatchObject({ worktree: repo })
  expect(roster[1]!.sessions).toEqual([{ sessionId: 'manual', group: 'devs', profile: 'default', status: 'working', spawned: false, taskId: null }])
})

test('a member in a subdirectory resolves to its worktree root', () => {
  fs.mkdirSync(path.join(featX, 'src', 'deep'), { recursive: true })
  const roster = rosterOf([record('deep', { projectPath: path.join(featX, 'src', 'deep') })])
  expect(roster.map(entry => entry.worktree)).toEqual([featX])
})

test('a session whose group definition is missing still lists its recorded group', () => {
  // No group files exist at all in this repo; the roster reports the recorded
  // group id regardless — group resolution is the catalog's job, not the roster's.
  const roster = rosterOf([record('orphan', { groupId: 'gone-group' })])
  expect(roster[0]!.sessions[0]).toMatchObject({ sessionId: 'orphan', group: 'gone-group' })
})

test('archived sessions and other teams are excluded', () => {
  const roster = rosterOf([
    record('archived', { archivedAt: '2026-10-11' }),
    record('other-x', { projectPath: repo, groupId: 'devs' }),
    record('live', { groupId: 'devs' }),
  ])
  expect(roster).toHaveLength(1)
  expect(roster[0]!.sessions.map(session => session.sessionId)).toEqual(['live'])
})

test('pending reservations list with their group and profile and count as writers', () => {
  const roster = rosterOf([], [
    { teamId: team.teamId, groupId: 'devs', worktree: featX, profileId: 'glm' },
    { teamId: 'other-team', groupId: 'devs', worktree: repo, profileId: 'glm' },
  ])
  expect(roster).toEqual([{ worktree: featX, sessions: [], pendingSpawns: [{ group: 'devs', profile: 'glm' }] }])
  expect(worktreeWriters(roster[0])).toEqual({ spawnedIds: [], pending: 1 })
})

test('a manual session never occupies the writer slot; a spawned one does', () => {
  const manual = rosterOf([record('manual', { projectPath: featX })])
  expect(worktreeWriters(manual[0])).toEqual({ spawnedIds: [], pending: 0 })
  const spawned = rosterOf([record('writer', { projectPath: featX, spawned: true })])
  expect(worktreeWriters(spawned[0])).toEqual({ spawnedIds: ['writer'], pending: 0 })
})

test('a team with no sessions serializes an empty list', () => {
  expect(rosterOf([])).toEqual([])
})
