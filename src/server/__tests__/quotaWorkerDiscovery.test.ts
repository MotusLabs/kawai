// Configured workers without surviving sessions (process-quota-history-and-
// incident-advice A1; Sol checkpoint note-c031d34a item 3), through the
// production composition: a bare repository's worktrees share one team id but
// each carries its own group files. The worker one worktree lists stays
// observed after that worktree's last chat is killed while another
// worktree's chat lives on, and after every chat is gone and the server
// restarts — read from git's worktree registrations, never from the bare
// common directory as if it held group files.
import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { teamGroupsRoots } from '../chat/quota/teamRoots'
import { cleanGitEnv } from '../git/gitCommand'
import { advance, CADENCE_MS, quotaComposition, sessionIn, type QuotaComposition } from './helpers/quotaComposition'

let composition: QuotaComposition | undefined

afterEach(async () => {
  await composition?.close()
  composition = undefined
})

function git(cwd: string, ...args: string[]): void {
  const run = spawnSync('git', args, { cwd, env: cleanGitEnv(), encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`)
}

/** A bare repository with worktrees `wt-a` (lists the glm worker) and `wt-b` (an agent-only worker). */
function bareRepository(root: string): { bare: string; a: string; b: string } {
  const seed = path.join(root, 'seed')
  fs.mkdirSync(seed)
  git(seed, 'init', '--quiet')
  git(seed, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '--quiet', '--allow-empty', '-m', 'seed')
  const bare = path.join(root, 'team.git')
  git(root, 'clone', '--quiet', '--bare', seed, bare)
  const a = path.join(root, 'wt-a')
  const b = path.join(root, 'wt-b')
  git(bare, 'worktree', 'add', '--quiet', '-b', 'a', a)
  git(bare, 'worktree', 'add', '--quiet', '-b', 'b', b)
  for (const [tree, workers] of [[a, 'glm'], [b, 'hostonly']] as const) {
    fs.mkdirSync(path.join(tree, '.kawai', 'groups'), { recursive: true })
    fs.writeFileSync(path.join(tree, '.kawai', 'groups', 'devs.md'), `---\nworkers: [${workers}]\n---\nBuild.`)
  }
  return { bare: fs.realpathSync(bare), a: fs.realpathSync(a), b: fs.realpathSync(b) }
}

// @covers: chat-usage-limits › Usage is refreshed when no report has arrived › Eligible alternative without a live chat
test('a bare repository worktree\'s worker stays observed after its last chat is killed and after a restart with no chats', async () => {
  composition = await quotaComposition()
  const { bare, a, b } = bareRepository(composition.root)
  expect(teamGroupsRoots(bare).sort()).toEqual([a, b].sort())
  const sessionA = await sessionIn(composition, a)
  const sessionB = await sessionIn(composition, b)
  expect(composition.manager.teams.teamOf(sessionA)?.teamId).toBe(composition.manager.teams.teamOf(sessionB)?.teamId)
  expect(composition.manager.quota.service.workerKeys()).toHaveLength(1)
  // A's last chat goes while B's lives: A's unchanged group file still lists the worker.
  composition.manager.kill(sessionA)
  await advance(61_000)
  expect(composition.manager.quota.service.workerKeys()).toHaveLength(1)
  const calls = composition.calls.length
  await advance(CADENCE_MS * 1.11)
  expect(composition.calls.length).toBeGreaterThan(calls)
  // Every chat gone, then a restart: the registered worktrees still name it (one startup poll, B1).
  composition.manager.kill(sessionB)
  const before = composition.calls.length
  await composition.restart()
  await advance(1_000)
  expect(composition.manager.quota.service.workerKeys()).toHaveLength(1)
  expect(composition.calls.length).toBe(before + 1)
})

test('a bare common directory is never read as a groups root, and a pruned registration contributes nothing', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'kawai-team-roots-')))
  try {
    const { bare, a } = bareRepository(root)
    fs.mkdirSync(path.join(bare, '.kawai', 'groups'), { recursive: true })
    fs.rmSync(path.join(root, 'wt-b'), { recursive: true, force: true })
    expect(teamGroupsRoots(bare)).toEqual([a])
    expect(teamGroupsRoots(path.join(root, 'seed', '.git'))).toEqual([path.join(root, 'seed')])
    expect(teamGroupsRoots(path.join(root, 'missing'))).toEqual([])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
