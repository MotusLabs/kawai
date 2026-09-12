// E2E (§7): seeded change-worktree creation from a change section. A probe
// change exists only in the main worktree's OpenSpec root (registry-only
// section, no worktree); its [+]-action triggers the server-side seeded
// creation — `git worktree add <main>/.worktrees/<change>` on branch
// `<change>`, artifacts copied from the main worktree and committed there —
// and routes the success into the session form prefilled with the worktree
// root, with the apply auto-start option offered and checked.
import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const SNAPSHOT_TIMEOUT = 20_000
// The seeded creation is synchronous server-side; the snapshot refresh and
// modal routing follow immediately.
const CREATE_TIMEOUT = 30_000

const suffix = `${process.pid}-${Date.now()}`
const changeName = `e2e-seed-${suffix}`

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

test.beforeAll(() => {
  // Registry seed: the change exists only in the main worktree (untracked).
  fs.mkdirSync(mainChangesDir, { recursive: true })
  fs.writeFileSync(path.join(mainChangesDir, 'proposal.md'), '## Why\nprobe\n')
  fs.writeFileSync(path.join(mainChangesDir, 'tasks.md'), '## 1. Group\n\n- [ ] 1.1 Do it\n')
})

test.afterAll(() => {
  // Test artifacts only: the seeded worktree, its branch, and the probe
  // change in the main worktree's OpenSpec root. The worktree contains a
  // commit (the seed), so removal needs --force.
  spawnSync('git', ['worktree', 'remove', '--force', worktreePath])
  spawnSync('git', ['branch', '-D', changeName])
  fs.rmSync(mainChangesDir, { recursive: true, force: true })
})

test('change-section action seeds the worktree and opens the prefilled session form', async ({ page }) => {
  test.setTimeout(CREATE_TIMEOUT + SNAPSHOT_TIMEOUT + 30_000)
  await page.goto('/')

  await expect(page.getByTestId('section-header').first()).toBeVisible({
    timeout: SNAPSHOT_TIMEOUT,
  })

  // The registry-only change section offers seeded creation, not a plain
  // new-session action.
  const section = page.locator(`section[data-section-key$="change::${changeName}"]`)
  await expect(section).toBeVisible({ timeout: SNAPSHOT_TIMEOUT + 30_000 })
  const createButton = section.getByTestId('section-create-change-worktree')
  await expect(createButton).toBeVisible()
  await expect(section.getByTestId('section-new-session')).toHaveCount(0)
  await createButton.click()

  // Success routes into the normal session form, prefilled with the seeded
  // worktree root, with the apply auto-start offered and checked.
  const modal = page.getByRole('dialog', { name: 'New Session' })
  await expect(modal).toBeVisible({ timeout: CREATE_TIMEOUT })
  const pathInput = modal.locator('input.input.text-sm').first()
  await expect(pathInput).toHaveValue(worktreePath)
  await expect(modal.getByTestId('auto-start-apply')).toBeChecked()
  await expect(modal.getByTestId('auto-start-apply')).toBeVisible()

  // The seeded worktree really exists on disk: convention path, branch named
  // after the change, artifacts committed on it.
  const porcelain = run('git', ['worktree', 'list', '--porcelain'])
  expect(porcelain).toContain(`worktree ${worktreePath}`)
  const branch = run('git', ['-C', worktreePath, 'branch', '--show-current']).trim()
  expect(branch).toBe(changeName)
  expect(
    fs.existsSync(path.join(worktreePath, 'openspec', 'changes', changeName, 'proposal.md'))
  ).toBe(true)
  const status = run('git', ['-C', worktreePath, 'status', '--porcelain']).trim()
  expect(status).toBe('')

  // The change's apply command is what the form would send: unchecking is
  // not needed here — cancel instead of creating a real agent session.
  await modal.getByRole('button', { name: 'Cancel' }).click()
  await expect(modal).toBeHidden()
})
