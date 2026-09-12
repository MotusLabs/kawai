// E2E (§8.4): create a worktree from the branch browser, watch its group
// appear in the navigator, and launch a session at its root through the
// normal session form. The pane's working directory proves the session really
// started inside the new worktree.
import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SNAPSHOT_TIMEOUT = 20_000
// Watches are best-effort; the periodic full reconciliation
// (WORKSPACE_RECONCILE_INTERVAL_MS, 30s) is the correctness mechanism, so a
// branch created outside the app can take up to one reconcile tick to land.
const RECONCILE_TIMEOUT = 45_000

const suffix = `${process.pid}-${Date.now()}`
const branchName = `e2e-create-wt-${suffix}`
// Outside the checkout: a sibling suggestion inside .claude/worktrees would
// collide with real agentboard-managed worktrees.
const destination = path.join(fs.realpathSync(os.tmpdir()), `agentboard-e2e-wt-${suffix}`)

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

test.beforeAll(() => {
  run('git', ['branch', branchName])
})

test.afterAll(() => {
  // Test artifacts only: the throwaway worktree and its branch.
  spawnSync('git', ['worktree', 'remove', '--force', destination])
  spawnSync('git', ['branch', '-D', branchName])
})

test('branch browser creates a worktree and launches a session at its root', async ({ page }) => {
  test.setTimeout(RECONCILE_TIMEOUT + 30_000)
  await page.goto('/')

  // Discovery seeds from this checkout's live session.
  const header = page.getByTestId('worktree-group-header').first()
  await expect(header).toBeVisible({ timeout: SNAPSHOT_TIMEOUT })

  // Open the repository branch browser from the worktree header.
  await page.getByTestId('worktree-branch-browser').first().click()
  const browser = page.getByTestId('branch-browser')
  await expect(browser).toBeVisible()

  // Find the test branch and start creation for it. The branch postdates the
  // server's cached snapshot, so the row appears only after the watcher
  // refresh rebroadcasts — allow the full discovery cadence.
  const filter = browser.getByTestId('branch-filter')
  await filter.fill(branchName)
  const row = browser.getByTestId('branch-row').filter({ hasText: branchName })
  await expect(row).toHaveAttribute('data-assigned', 'false', { timeout: RECONCILE_TIMEOUT })
  await row.getByTestId('branch-create').click()

  // Point the destination at the throwaway path and request a session launch.
  const form = page.getByTestId('create-worktree-form')
  await expect(form).toBeVisible()
  await form.getByTestId('create-worktree-destination').fill(destination)
  await form.getByTestId('create-worktree-launch').check()
  await form.getByTestId('create-worktree-submit').click()

  // Successful creation routes through the normal session form, preselected
  // with the created worktree root.
  const modal = page.getByRole('dialog', { name: 'New Session' })
  await expect(modal).toBeVisible({ timeout: 10_000 })
  const pathInput = modal.locator('input.input.text-sm').first()
  await expect(pathInput).toHaveValue(destination)

  // A stable long-running command keeps the pane alive for cwd assertions.
  await modal.getByRole('radio', { name: 'Custom' }).click()
  await modal.locator('input.font-mono').fill('tail -f /dev/null')
  await modal.getByRole('button', { name: 'Create' }).click()

  // The new worktree appears as its own group in the navigator (the section,
  // not the header, carries the sessions).
  const group = page.locator(`section[data-worktree-id$="${destination}"]`)
  await expect(group).toBeVisible({ timeout: SNAPSHOT_TIMEOUT })

  // The launched session lives inside that group, at the worktree root.
  const card = group.getByTestId('session-card').first()
  await expect(card).toBeVisible({ timeout: SNAPSHOT_TIMEOUT })
  await card.click()
  await expect(page.getByTestId('terminal-panel')).toBeVisible()

  const tmuxSession = process.env.E2E_TMUX_SESSION
  if (!tmuxSession) throw new Error('E2E_TMUX_SESSION is not set')
  // The launched pane must sit at the new worktree root: find it by cwd.
  const windows = run('tmux', [
    'list-windows',
    '-t',
    `=${tmuxSession}`,
    '-F',
    '#{window_id} #{window_name} #{pane_current_command} #{pane_current_path}',
  ])
  const atRoot = windows
    .trim()
    .split('\n')
    .find((line) => line.trim().endsWith(fs.realpathSync(destination)))
  expect(atRoot, `expected a pane at ${destination}; windows:\n${windows}`).toBeDefined()
  expect(atRoot!.split(' ')[2]).toBe('tail')

  // Shrink this spec's footprint immediately: parallel specs assert on the
  // session list, so the extra card shouldn't outlive this test.
  spawnSync('tmux', ['kill-window', '-t', `=${tmuxSession}:${atRoot!.split(' ')[0]}`])
})
