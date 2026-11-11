// workspaceOpenspecComposition.integration.test.ts - PC1 from
// bounded-openspec-discovery design.md (hazard M1): the production
// composition (`WorkspaceCoordinator` with `defaultDiscoveryApi`, the
// server-wide pool, the real fingerprint and cache) over a real Git
// repository with 12 worktrees and a stub `openspec` first on PATH that logs
// each run's start and end. Overlap is read from that log, never from the
// pool's own counters.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkspaceSnapshot } from '../../shared/workspace'
import { cleanGitEnv } from '../git/gitCommand'
import { WorkspaceCoordinator, type OpenSpecPassLog } from '../workspace/workspaceCoordinator'

const WORKTREES = 12
const STUB = `#!/bin/sh
echo "s $$ $(date +%s%N)" >> "$OPENSPEC_STUB_LOG"
sleep 0.3
done=$(grep -c '^- \\[x\\]' openspec/changes/alpha/tasks.md 2>/dev/null); done=\${done:-0}
total=$(grep -c '^- \\[' openspec/changes/alpha/tasks.md 2>/dev/null); total=\${total:-0}
printf '{"changes":[{"name":"alpha","completedTasks":%s,"totalTasks":%s}],"root":{"path":"%s"}}\\n' "$done" "$total" "$PWD"
echo "e $$ $(date +%s%N)" >> "$OPENSPEC_STUB_LOG"
`

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: cleanGitEnv(), stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
}

let root = ''
let mainPath = ''
let logPath = ''
let savedPath: string | undefined
let savedLog: string | undefined

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-pc1-')))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'openspec'), STUB, { mode: 0o755 })
  logPath = path.join(root, 'stub.log')
  fs.writeFileSync(logPath, '')
  savedPath = process.env.PATH
  savedLog = process.env.OPENSPEC_STUB_LOG
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`
  process.env.OPENSPEC_STUB_LOG = logPath

  mainPath = path.join(root, 'main')
  const tasks = path.join(mainPath, 'openspec', 'changes', 'alpha', 'tasks.md')
  fs.mkdirSync(path.dirname(tasks), { recursive: true })
  fs.writeFileSync(path.join(mainPath, 'openspec', 'config.yaml'), 'schema: spec-driven\n')
  fs.writeFileSync(tasks, '- [ ] 1.1 one\n- [ ] 1.2 two\n')
  git(mainPath, 'init', '-q', '-b', 'main')
  git(mainPath, 'add', '.')
  git(mainPath, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init')
  for (let index = 1; index < WORKTREES; index += 1) {
    git(mainPath, 'worktree', 'add', '-q', '--detach', path.join(root, `wt-${index}`))
  }
})

afterAll(() => {
  process.env.PATH = savedPath
  if (savedLog === undefined) delete process.env.OPENSPEC_STUB_LOG
  else process.env.OPENSPEC_STUB_LOG = savedLog
  fs.rmSync(root, { recursive: true, force: true })
})

/** Runs logged since the last call, and their peak overlap. */
let consumedLines = 0
function takeRuns(): { runs: number; peak: number } {
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
  const fresh = lines.slice(consumedLines)
  consumedLines = lines.length
  const events = fresh
    .map((line) => {
      const [kind, , time] = line.split(' ')
      return { kind, time: BigInt(time) }
    })
    // An end sorts before a start at the same instant.
    .sort((a, b) => (a.time === b.time ? (a.kind === 'e' ? -1 : 1) : a.time < b.time ? -1 : 1))
  let active = 0
  let peak = 0
  for (const event of events) {
    active += event.kind === 's' ? 1 : -1
    peak = Math.max(peak, active)
  }
  return { runs: fresh.filter((line) => line.startsWith('s ')).length, peak }
}

describe('workspace OpenSpec discovery, production composition (PC1)', () => {
  // @covers: openspec-visibility › Bound concurrent OpenSpec discovery › A full reconciliation
  test('PC1: 12 runs at most 3 at once, then none while unchanged, one after an edit, and all 12 after ten minutes', async () => {
    let now = 1_800_000_000_000
    const logs: OpenSpecPassLog[] = []
    let snapshot: WorkspaceSnapshot | null = null
    const coordinator = new WorkspaceCoordinator({
      getSeeds: () => [mainPath],
      broadcast: (next) => {
        snapshot = next
      },
      now: () => now,
      logOpenSpecPass: (fields) => logs.push(fields),
    })

    // Step 1: a cold reconciliation runs every worktree through the pool.
    await coordinator.reconcile()
    const worktreeCount = (coordinator.getSnapshot()?.repositories ?? []).flatMap((repository) => repository.worktrees).length
    expect(worktreeCount).toBe(WORKTREES)
    const step1 = takeRuns()
    expect(step1.runs).toBe(WORKTREES)
    expect(step1.peak).toBeLessThanOrEqual(3)

    // Step 2: nothing changed, so nothing runs.
    now += 60_000
    await coordinator.reconcile()
    expect(takeRuns().runs).toBe(0)
    expect(logs.at(-1)).toMatchObject({ runs: 0, reused: WORKTREES })

    // Step 3: one worktree's tasks.md changes; only it runs, with new progress.
    const edited = path.join(root, 'wt-5')
    fs.writeFileSync(path.join(edited, 'openspec', 'changes', 'alpha', 'tasks.md'), '- [x] 1.1 one\n- [ ] 1.2 two\n')
    now += 60_000
    await coordinator.reconcile()
    expect(takeRuns().runs).toBe(1)
    const worktrees = (coordinator.getSnapshot()?.repositories ?? []).flatMap((repository) => repository.worktrees)
    const editedState = worktrees.find((worktree) => worktree.path === edited)?.openspec
    expect(editedState?.changes).toEqual([{ name: 'alpha', completedTasks: 1, totalTasks: 2 }])
    expect(snapshot).not.toBeNull()

    // Step 4: ten minutes on, every worktree is rediscovered.
    now += 600_000
    await coordinator.reconcile()
    const step4 = takeRuns()
    expect(step4.runs).toBe(WORKTREES)
    expect(step4.peak).toBeLessThanOrEqual(3)
  }, 60_000)
})
