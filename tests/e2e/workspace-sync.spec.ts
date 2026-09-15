// E2E (§9.1): external changes reconcile into the live workspace without a
// page reload — registry-seeded change sections, external convention-worktree
// creation flipping the canonical source, worktree-canonical task progress
// edits, a transient OpenSpec discovery failure (last-valid retention and
// isolation), and its recovery. One page instance observes every mutation;
// reconciliation (watcher misses aside, the 30s periodic pass is the
// correctness mechanism) is what delivers each update.
import { test, expect, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Watches are best-effort; each external mutation lands by the next periodic
// reconciliation tick at the latest.
const RECONCILE_TIMEOUT = 45_000
const SNAPSHOT_TIMEOUT = 20_000

const suffix = `${process.pid}-${Date.now()}`
const changeName = `e2e-sync-${suffix}`
const branchName = changeName

// The registry is seeded from the MAIN worktree's OpenSpec root, and the
// canonical copy lives at `<main>/.worktrees/<change-name>` — resolve the
// repository's main worktree from Git rather than assuming cwd (the suite
// itself runs from a linked worktree).
function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

const mainWorktree = run('git', ['worktree', 'list', '--porcelain'])
  .split('\n')[0]!
  .replace(/^worktree /, '')
  .trim()
const mainChangesDir = path.join(mainWorktree, 'openspec', 'changes', changeName)
const worktreePath = path.join(mainWorktree, '.worktrees', changeName)

// `git branch` / `git worktree add` briefly lock shared refs/worktree state;
// parallel specs mutate the same repository. Retry the transient lock
// contention instead of failing the run.
function runGitMutation(args: string[], attempts = 3) {
  let lastStderr = ''
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = spawnSync('git', args, { encoding: 'utf8' })
    if (result.status === 0) return
    lastStderr = result.stderr
    spawnSync('sleep', ['1'])
  }
  throw new Error(`git ${args.join(' ')} failed: ${lastStderr}`)
}

/** Write the probe change's artifacts with the given task completion. */
function writeProbeTasks(targetDir: string, completed: 0 | 1 | 2) {
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(path.join(targetDir, 'proposal.md'), '## Why\nprobe\n')
  const marks = ['- [ ] 1.1 Done thing', '- [ ] 1.2 Todo thing'].map((line, index) =>
    index < completed ? line.replace('[ ]', '[x]') : line
  )
  fs.writeFileSync(path.join(targetDir, 'tasks.md'), `## 1. Group\n\n${marks.join('\n')}\n`)
}

/** The change section for the probe, however its source resolves. */
function probeSection(page: Page) {
  return page.locator(`section[data-section-key$="change::${changeName}"]`)
}

function probeProgress(page: Page) {
  return probeSection(page).getByTestId('change-progress')
}

// Restore permissions before removal so cleanup succeeds even when the test
// fails partway through the discovery-failure injection below.
function restoreProbePermissions() {
  try {
    fs.chmodSync(path.join(worktreePath, 'openspec', 'changes'), 0o755)
  } catch {
    // Already removed or never created — nothing to restore.
  }
}

test.beforeAll(() => {
  // Registry seed: the change exists only in the main worktree (untracked).
  writeProbeTasks(mainChangesDir, 1)
  runGitMutation(['branch', branchName])
})

test.afterAll(() => {
  // Test artifacts only: the throwaway worktree, its branch, and the probe
  // change seeded into the main worktree's OpenSpec root.
  restoreProbePermissions()
  spawnSync('git', ['worktree', 'remove', '--force', worktreePath])
  spawnSync('git', ['branch', '-D', branchName])
  fs.rmSync(mainChangesDir, { recursive: true, force: true })
})

test('registry, worktree, and OpenSpec changes reconcile without reload', async ({ page }) => {
  // Worst case: every reconciliation-bound assertion waits out a full 30s
  // periodic pass before the update lands.
  test.setTimeout(360_000)
  await page.goto('/')

  // Baseline: the sectioned navigator is live (seeded by the suite's tmux
  // window running in this repository).
  await expect(page.getByTestId('section-header').first()).toBeVisible({
    timeout: SNAPSHOT_TIMEOUT,
  })

  // External branch/ref change: the new branch shows up in the repository
  // branch browser as available (unassigned).
  await page.getByTestId('worktree-branch-browser').first().click()
  const browser = page.getByTestId('branch-browser')
  await expect(browser).toBeVisible()
  await browser.getByTestId('branch-filter').fill(branchName)
  const branchRow = browser.getByTestId('branch-row').filter({ hasText: branchName })
  await expect(branchRow).toHaveAttribute('data-assigned', 'false', {
    timeout: RECONCILE_TIMEOUT,
  })
  await browser.getByRole('button', { name: 'Close' }).click()

  // Registry-only change section: the probe is listed in the main worktree's
  // OpenSpec root, so its section exists with no worktree and no sessions.
  const section = probeSection(page)
  await expect(section).toBeVisible({ timeout: RECONCILE_TIMEOUT })
  await expect(section.getByTestId('change-name')).toHaveText(changeName)
  // Registry progress from the main worktree's copy: 1/2.
  await expect(probeProgress(page)).toHaveText('1/2', { timeout: RECONCILE_TIMEOUT })

  // External convention-worktree creation: `<main>/.worktrees/<change>` on
  // the change's existing branch. The worktree copy becomes the canonical
  // source, so seeding it with fresher artifacts moves the displayed progress.
  runGitMutation(['worktree', 'add', worktreePath, branchName])
  writeProbeTasks(path.join(worktreePath, 'openspec', 'changes', changeName), 2)
  await expect(probeProgress(page)).toHaveText('2/2', { timeout: RECONCILE_TIMEOUT })

  // Transient OpenSpec discovery failure for exactly this worktree: an
  // unreadable `openspec/changes` makes `openspec list --json` exit 1 (a
  // plain missing root reports `no_openspec_root`, which the server correctly
  // treats as an empty non-error result). Last valid data is retained.
  const changesDir = path.join(worktreePath, 'openspec', 'changes')
  fs.chmodSync(changesDir, 0o000)

  // While the worktree's discovery fails, the main worktree stays readable:
  // moving ITS copy to 0/2 must not move the display — the canonical source
  // is the worktree's retained last-valid value.
  writeProbeTasks(mainChangesDir, 0)
  await expect(probeProgress(page)).toHaveText('2/2', { timeout: RECONCILE_TIMEOUT })
  // The section still exists (nothing removed by the failure) and other
  // sections keep rendering (failure isolation).
  await expect(section.getByTestId('change-name')).toBeVisible()
  await expect(page.getByTestId('section-header').first()).toBeVisible()

  // Recovery: readable again, and a new external edit to the canonical copy
  // updates the display without a reload.
  fs.chmodSync(changesDir, 0o755)
  writeProbeTasks(path.join(worktreePath, 'openspec', 'changes', changeName), 1)
  await expect(probeProgress(page)).toHaveText('1/2', { timeout: RECONCILE_TIMEOUT })
})
