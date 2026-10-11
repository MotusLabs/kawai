import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { DEFAULT_MAX_SPAWNED_SESSIONS, TeamCaps, teamCapsFile } from '../team/teamCaps'
import { clearTeamCache } from '../team/teamIdentity'

// cleanGitEnv: under the pre-commit hook git exports GIT_DIR/GIT_INDEX_FILE,
// and a raw spawn would run these commands against the hook's repository.
function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

describe('TeamCaps', () => {
  let root: string
  let home: string
  let repo: string
  let feature: string
  let other: string
  let teamId: string

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-caps-')))
    repo = path.join(root, 'repo')
    feature = path.join(root, 'repo-feature')
    other = path.join(root, 'other')
    git(['init', '-q', repo])
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
    git(['worktree', 'add', '-q', '-b', 'feature', feature], repo)
    git(['init', '-q', other])
    teamId = path.join(repo, '.git')
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  beforeEach(() => {
    clearTeamCache()
    home = fs.mkdtempSync(path.join(root, 'home-'))
  })

  const writeCaps = (content: unknown) => {
    fs.mkdirSync(path.dirname(teamCapsFile(home)), { recursive: true })
    fs.writeFileSync(teamCapsFile(home), typeof content === 'string' ? content : JSON.stringify(content))
  }

  test('an absent file gives every team the default cap of 5', async () => {
    const errors: string[][] = []
    const caps = new TeamCaps({ homeDir: home, onErrors: e => errors.push(e) })
    expect(DEFAULT_MAX_SPAWNED_SESSIONS).toBe(5)
    expect(await caps.maxSpawnedSessions(teamId)).toBe(5)
    expect(errors).toEqual([])
  })

  test('a global value and a per-repository override', async () => {
    writeCaps({ maxSpawnedSessions: 3, teams: { [repo]: { maxSpawnedSessions: 8 } } })
    const caps = new TeamCaps({ homeDir: home })
    expect(await caps.maxSpawnedSessions(teamId)).toBe(8)
    expect(await caps.maxSpawnedSessions(path.join(other, '.git'))).toBe(3)
  })

  test('an override keyed by a linked worktree applies to its repository team', async () => {
    writeCaps({ teams: { [feature]: { maxSpawnedSessions: 2 } } })
    expect(await new TeamCaps({ homeDir: home }).maxSpawnedSessions(teamId)).toBe(2)
  })

  test('malformed JSON is reported and the default applies', async () => {
    writeCaps('{ not json')
    const errors: string[][] = []
    const caps = new TeamCaps({ homeDir: home, onErrors: e => errors.push(e) })
    expect(await caps.maxSpawnedSessions(teamId)).toBe(5)
    expect(errors.flat().some(e => e.includes(teamCapsFile(home)))).toBe(true)
  })

  test('malformed settings are reported; valid ones still apply', async () => {
    writeCaps({ maxSpawnedSessions: 0, teams: { [repo]: { maxSpawnedSessions: 'many' }, relative: { maxSpawnedSessions: 2 }, [other]: { maxSpawnedSessions: 4 } } })
    const errors: string[] = []
    const caps = new TeamCaps({ homeDir: home, onErrors: e => errors.push(...e) })
    expect(await caps.maxSpawnedSessions(teamId)).toBe(5)
    expect(await caps.maxSpawnedSessions(path.join(other, '.git'))).toBe(4)
    expect(errors).toHaveLength(3)
    expect(errors.some(e => e.includes('maxSpawnedSessions must be a positive integer'))).toBe(true)
    expect(errors.some(e => e.includes('"relative" must be an absolute path'))).toBe(true)
  })

  test('a file change is picked up on the next read', async () => {
    const caps = new TeamCaps({ homeDir: home })
    expect(await caps.maxSpawnedSessions(teamId)).toBe(5)
    writeCaps({ maxSpawnedSessions: 7 })
    expect(await caps.maxSpawnedSessions(teamId)).toBe(7)
    fs.rmSync(teamCapsFile(home))
    expect(await caps.maxSpawnedSessions(teamId)).toBe(5)
  })

  test('a project-level teams.json can never raise the cap', async () => {
    fs.mkdirSync(path.join(repo, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.kawai', 'teams.json'), JSON.stringify({ maxSpawnedSessions: 50 }))
    expect(await new TeamCaps({ homeDir: home }).maxSpawnedSessions(teamId)).toBe(5)
    // Even a project rooted where the home's .kawai is not: only HOME is read.
    expect(teamCapsFile(home)).toBe(path.join(home, '.kawai', 'teams.json'))
    fs.rmSync(path.join(repo, '.kawai'), { recursive: true, force: true })
  })
})
