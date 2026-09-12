// E2E (§9.1): external changes reconcile into the live workspace without a
// page reload — external worktree creation, branch/ref changes, OpenSpec task
// progress edits, a transient OpenSpec discovery failure, and its recovery.
// One page instance observes every mutation; reconciliation (watcher misses
// aside, the 30s periodic pass is correctness) is what delivers each update.
import { test, expect, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Watches are best-effort; each external mutation lands by the next periodic
// reconciliation tick at the latest.
const RECONCILE_TIMEOUT = 45_000
const SNAPSHOT_TIMEOUT = 20_000

const suffix = `${process.pid}-${Date.now()}`
const branchName = `e2e-sync-${suffix}`
const worktreePath = path.join(fs.realpathSync(os.tmpdir()), `agentboard-e2e-sync-${suffix}`)
// This spec asserts failure isolation against the checkout the suite runs in;
// pin its canonical path so the group locator is deterministic even when
// parallel specs add their own worktree groups.
const checkoutPath = fs.realpathSync(process.cwd())

// `git branch` / `git worktree add` briefly lock shared refs/worktree state;
// the parallel worktree-create spec mutates the same repository. Retry the
// transient lock contention instead of failing the run.
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

function writeProbeWorktreeFiles(completedTasks: 1 | 2) {
  const changeDir = path.join(worktreePath, 'openspec/changes/probe-change')
  fs.mkdirSync(changeDir, { recursive: true })
  fs.writeFileSync(path.join(changeDir, 'proposal.md'), '## Why\nprobe\n')
  const second = completedTasks === 2 ? 'x' : ' '
  fs.writeFileSync(
    path.join(changeDir, 'tasks.md'),
    `## 1. Group\n\n- [x] 1.1 Done thing\n- [${second}] 1.2 Todo thing\n`
  )
}

// Restore permissions before removal so cleanup succeeds even when the test
// fails partway through the discovery-failure injection below.
function restoreProbePermissions() {
  try {
    fs.chmodSync(path.join(worktreePath, 'openspec/changes'), 0o755)
  } catch {
    // Already removed or never created — nothing to restore.
  }
}

async function waitForReconciled(page: Page, locator: string, state: 'attached' | 'detached') {
  const target = page.locator(locator)
  await expect(target, locator).toHaveCount(state === 'attached' ? 1 : 0, {
    timeout: RECONCILE_TIMEOUT,
  })
}

test.beforeAll(() => {
  runGitMutation(['branch', branchName])
})

test.afterAll(() => {
  // Test artifacts only: the throwaway worktree and its branch.
  restoreProbePermissions()
  spawnSync('git', ['worktree', 'remove', '--force', worktreePath])
  spawnSync('git', ['branch', '-D', branchName])
})

test('external worktree, branch, and OpenSpec changes reconcile without reload', async ({ page }) => {
  // Worst case: every reconciliation-bound assertion waits out a full 30s
  // periodic pass before the update lands.
  test.setTimeout(360_000)
  await page.goto('/')

  // Baseline: the checkout's group (seeded by the suite's tmux window).
  await expect(page.getByTestId('worktree-group-header').first()).toBeVisible({
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

  // External worktree creation: absent before, a new group appears after.
  const group = page.locator(`section[data-worktree-id$="${worktreePath}"]`)
  await expect(group).toHaveCount(0)
  runGitMutation(['worktree', 'add', worktreePath, branchName])
  // Seed the new worktree with a synthetic OpenSpec change before discovery
  // first reads it.
  writeProbeWorktreeFiles(1)
  await expect(group).toBeVisible({ timeout: RECONCILE_TIMEOUT })

  // OpenSpec state discovered inside the new worktree: progress 1/2.
  const change = group.getByTestId('worktree-openspec-change').filter({
    hasText: 'probe-change',
  })
  await expect(change).toBeVisible({ timeout: RECONCILE_TIMEOUT })
  await expect(change.getByTestId('worktree-openspec-progress')).toHaveText('1/2')

  // External task completion: the progress updates to 2/2 without a reload.
  writeProbeWorktreeFiles(2)
  await expect(change.getByTestId('worktree-openspec-progress')).toHaveText('2/2', {
    timeout: RECONCILE_TIMEOUT,
  })

  // Transient OpenSpec discovery failure for exactly this worktree: an
  // unreadable `openspec/changes` makes `openspec list --json` exit 1 with a
  // `list_error` payload (a plain missing root reports `no_openspec_root`,
  // which the server correctly treats as an empty non-error result). Last
  // valid data stays with an unavailable indication, while the checkout's own
  // OpenSpec rows keep rendering.
  const changesDir = path.join(worktreePath, 'openspec/changes')
  fs.chmodSync(changesDir, 0o000)

  await expect(group.getByTestId('worktree-openspec-stale')).toBeVisible({
    timeout: RECONCILE_TIMEOUT,
  })
  // Last valid data is retained alongside the stale indicator.
  await expect(
    group.getByTestId('worktree-openspec-change').filter({ hasText: 'probe-change' })
  ).toBeVisible()
  // Other worktrees are unaffected (failure isolation).
  const checkoutGroup = page.locator(`section[data-worktree-id$="${checkoutPath}"]`)
  await expect(
    checkoutGroup.getByTestId('worktree-openspec-change').first()
  ).toBeVisible()

  // Recovery: making the directory readable again clears the indication.
  fs.chmodSync(changesDir, 0o755)
  await waitForReconciled(
    page,
    `section[data-worktree-id$="${worktreePath}"] [data-testid="worktree-openspec-stale"]`,
    'detached'
  )
  // The worktree also carries the repository's tracked OpenSpec changes, so
  // scope the recovered progress to the synthetic probe change.
  const recoveredProbe = group
    .getByTestId('worktree-openspec-change')
    .filter({ hasText: 'probe-change' })
  await expect(recoveredProbe.getByTestId('worktree-openspec-progress')).toHaveText('2/2')
})
