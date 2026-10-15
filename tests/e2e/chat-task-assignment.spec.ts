// Browser walkthrough of task assignment against the SDK-free fixture
// (task-assignment E01–E03): create-and-assign reaches exactly one idle
// member under a stable request key with the Human sender on its instruction
// row; a refused create keeps every entered field; explicit reassignment
// requires notify or stop; and worktree-targeted subtasks spawn one matching
// member each while an idle main-checkout developer takes neither — with no
// worktree ever created by dispatch. Written for CI; not run locally against
// a live kawai (its teardown would kill it).
import { expect, test, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanGitEnv } from '../../src/server/git/gitCommand'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

/** A throwaway team directory (optionally a git repo with linked worktrees). */
function teamRoot(worktrees: string[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-task-assignment-')))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/leads.md'), '---\nlabel: Team leads\n---\nCoordinate work')
  writeFileSync(join(root, '.kawai/groups/devs.md'), '---\nlabel: Developers\nmax: 3\n---\nBuild features')
  if (worktrees.length > 0) {
    git(['init', '-q', root])
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], root)
    for (const branch of worktrees) git(['worktree', 'add', '-q', '-b', branch, join(root, `.wt-${branch}`)], root)
  }
  return root
}

async function createChat(page: Page, root: string, name: string, group: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Project Path').fill(root)
  await expect(dialog.getByLabel('Group').locator('option', { hasText: 'Developers' })).toHaveCount(1)
  await dialog.getByLabel('Group').selectOption(group)
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
  return (await page.locator('[data-session-id^="chat-"]').filter({ hasText: name }).first().getAttribute('data-session-id'))!
}

/** A fixture turn leaves the session demonstrably idle for dispatch. */
async function makeIdle(page: Page, session: string) {
  await page.locator(`[data-session-id="${session}"]`).click()
  await page.getByLabel('Message Claude').fill('hello')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('chat-status')).toHaveText('waiting', { timeout: 15_000 })
}

/** Open the Tasks view through the Team button or the page's own tab (team-workspace-pages 4.1). */
async function openTasks(page: Page) {
  const button = page.getByTestId('chat-team-button')
  if (await button.isVisible().catch(() => false)) await button.click()
  await page.getByTestId('team-tab-tasks').click()
  await expect(page.getByTestId('team-tasks')).toBeVisible()
}

/** Expand a Mailbox section if it is collapsed (idempotent). */
async function expandSection(page: import('@playwright/test').Page, name: string) {
  const toggle = page.getByTestId(`mailbox-section-toggle-${name}`)
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
}

test('E01/E02: create and assign reaches one member; a refusal keeps the form; a replay cannot duplicate', async ({ page }, info) => {
  const root = teamRoot()
  try {
    await page.goto('/')
    const lead = await createChat(page, root, 'Browser team lead', 'leads')
    const devA = await createChat(page, root, 'Browser developer A', 'devs')
    await createChat(page, root, 'Browser developer B', 'devs')
    await makeIdle(page, devA)
    await page.locator(`[data-session-id="${lead}"]`).click()
    await openTasks(page)
    const panel = page.getByTestId('team-tasks')

    // E02's refusal first: an invalid worktree (typed manual entry) refuses
    // the create and keeps every entered field, including the assignment.
    await panel.locator('summary', { hasText: 'New task' }).click()
    await panel.getByLabel('Task title').fill('Export CSV')
    await panel.getByLabel('Task direction').fill('Ship a CSV export')
    await panel.getByLabel('Target worktree').fill('/nowhere/at/all')
    await panel.getByLabel('Assignment target kind').selectOption('group')
    await panel.getByLabel('Assignment group').selectOption('devs')
    await panel.getByLabel('Assignment instruction').fill('Please build it')
    await panel.getByTestId('task-create-assign-button').click()
    await expect(panel.locator('[role="alert"]')).toContainText('is not a worktree')
    await expect(panel.getByLabel('Task title')).toHaveValue('Export CSV')
    await expect(panel.getByLabel('Assignment instruction')).toHaveValue('Please build it')
    await page.screenshot({ path: info.outputPath('refusal-keeps-form.png') })

    // Fix the field (empty worktree) and dispatch for real: exactly one
    // instruction, taken by one member, from the Human sender. A successful
    // create-and-assign opens the created task's detail (the documented
    // "opens the created task" behavior), so the assignment is asserted on
    // the detail's outstanding line.
    await panel.getByLabel('Target worktree').fill('')
    await panel.getByTestId('task-create-assign-button').click()
    const outstanding = page.getByTestId('task-outstanding-assignment')
    await expect(outstanding).toContainText('group devs', { timeout: 20_000 })
    await page.screenshot({ path: info.outputPath('create-and-assign.png') })
    // The task names its owner once claimed. The browser fixture confirms no
    // receipt, so the assignment settles at `uncertain` — its own name, with
    // the claimant still recorded.
    await expect(outstanding).toContainText(/claimed|delivered|uncertain/, { timeout: 20_000 })
    await expect(outstanding).toContainText('claimed by Browser developer')
    // The instruction row lives in the taker's chat: switch to the member the
    // outstanding line names, then check the Human-sent peer row there.
    const outstandingText = (await outstanding.textContent()) ?? ''
    const taker = /claimed by (.+?) ·/.exec(outstandingText)?.[1] ?? 'Browser developer'
    await page.locator('[data-session-id^="chat-"]').filter({ hasText: taker }).first().click()
    const peer = page.locator('[data-chat-role="peer"]').filter({ hasText: 'Please build it' }).first()
    await expect(peer).toBeVisible({ timeout: 20_000 })
    await expect(peer).toContainText('Human')
    await page.locator(`[data-session-id="${lead}"]`).click()
    // Back on the Team page's list (the button's URL carries no selection,
    // so the list is showing), the row shows the assignment too.
    await openTasks(page)
    await expect(panel.getByTestId('task-assignment').first()).toContainText('Assigned: group devs')

    // E01's replay: after a reload (the reconnect stand-in) the task still
    // has exactly one instruction under it.
    await page.reload()
    await page.locator(`[data-session-id="${lead}"]`).click()
    await openTasks(page)
    await panel.locator('[data-task-id]').first().locator('button').first().click()
    await expect(page.getByTestId('task-outstanding-assignment')).toContainText('group devs')
    await expect(page.getByTestId('message-row')).toHaveCount(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reassignment requires an explicit choice; stop supersedes and keeps history', async ({ page }, info) => {
  const root = teamRoot()
  try {
    await page.goto('/')
    const lead = await createChat(page, root, 'Browser team lead', 'leads')
    const dev = await createChat(page, root, 'Browser developer', 'devs')
    await makeIdle(page, dev)
    await page.locator(`[data-session-id="${lead}"]`).click()
    await openTasks(page)
    const panel = page.getByTestId('team-tasks')
    await panel.locator('summary', { hasText: 'New task' }).click()
    await panel.getByLabel('Task title').fill('Export CSV')
    await panel.getByLabel('Task direction').fill('Ship a CSV export')
    await panel.getByLabel('Assignment target kind').selectOption('group')
    await panel.getByLabel('Assignment group').selectOption('devs')
    await panel.getByLabel('Assignment instruction').fill('First try')
    await panel.getByTestId('task-create-assign-button').click()
    // The created task's detail is open; its outstanding line shows the
    // assignment the dispatch just made.
    await expect(page.getByTestId('task-outstanding-assignment')).toContainText('group devs', { timeout: 20_000 })

    // A new dispatch over the outstanding assignment opens the choice. The
    // detail's assign form starts empty: choose the target, then instruct.
    await page.getByTestId('task-assign-form').getByLabel('Assignment target kind').selectOption('group')
    await page.getByTestId('task-assign-form').getByLabel('Assignment group').selectOption('devs')
    await page.getByTestId('task-assign-form').getByLabel('Assignment instruction').fill('Second try')
    await page.getByTestId('task-assign-send').click()
    const choice = page.getByTestId('task-reassign-choice')
    await expect(choice).toContainText('group devs')
    await page.screenshot({ path: info.outputPath('reassignment-choice.png') })
    await choice.getByRole('radio').nth(1).check()
    await page.getByTestId('task-reassign-confirm').click()
    // The new assignment stands; the old one stays in history, superseded.
    await expect(page.getByTestId('task-outstanding-assignment')).toContainText('group devs')
    await page.getByTestId('task-assignment-history').locator('summary').click()
    await expect(page.getByTestId('task-assignment-history')).toContainText('superseded')
    // The queued first instruction was cancelled on stop; the replacement
    // was dispatched: the task carries both messages.
    await expect(page.getByTestId('message-row')).toHaveCount(2, { timeout: 15_000 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('E03: worktree-targeted subtasks reach only matching members and create no worktree', async ({ page }, info) => {
  const root = teamRoot(['feat-api', 'feat-ui'])
  const apiRoot = join(root, '.wt-feat-api')
  const uiRoot = join(root, '.wt-feat-ui')
  const worktreesBefore = git(['worktree', 'list', '--porcelain'], root)
  try {
    await page.goto('/')
    const lead = await createChat(page, root, 'Browser team lead', 'leads')
    const dev = await createChat(page, root, 'Browser main developer', 'devs')
    await makeIdle(page, dev)
    await page.locator(`[data-session-id="${lead}"]`).click()
    await openTasks(page)
    const panel = page.getByTestId('team-tasks')

    // Every creation — plain or with assignment — opens the created task's
    // detail (the documented behavior), so each subtask round-trips through
    // "All tasks" back to the form.
    const newTaskForm = async () => {
      // A creation leaves the panel on the created task's detail; go back
      // to the list only when one is open.
      const back = panel.getByRole('button', { name: 'All tasks' })
      if (await back.isVisible().catch(() => false)) await back.click()
      await panel.locator('summary', { hasText: 'New task' }).click()
    }
    await newTaskForm()
    await panel.getByLabel('Task title').fill('Reporting revamp')
    await panel.getByLabel('Task direction').fill('Split the work')
    await panel.getByTestId('task-create-button').click()
    await expect(page.getByTestId('task-detail-status')).toHaveText('open', { timeout: 15_000 })

    const subtask = async (title: string, worktree: string) => {
      await newTaskForm()
      await panel.getByLabel('Task title').fill(title)
      await panel.getByLabel('Task direction').fill(`Implement ${title}`)
      await panel.getByLabel('Parent task').selectOption({ label: 'Reporting revamp' })
      // A listed worktree chosen by typing its root: the same server
      // validation the picker's options go through.
      await panel.getByLabel('Target worktree').fill(worktree)
      await panel.getByLabel('Assignment target kind').selectOption('group')
      await panel.getByLabel('Assignment group').selectOption('devs')
      await panel.getByLabel('Assignment instruction').fill(`Build ${title} here`)
      await panel.getByTestId('task-create-assign-button').click()
      // The created subtask's detail shows its assignment (the fixture's
      // unconfirmed receipts may already have settled it to `uncertain`).
      await expect(page.getByTestId('task-outstanding-assignment')).toContainText('group devs', { timeout: 15_000 })
    }
    await subtask('API endpoints', apiRoot)
    await subtask('Report UI', uiRoot)
    await page.screenshot({ path: info.outputPath('worktree-subtasks.png') })

    // Each instruction spawns one member in its own worktree; the idle
    // main-checkout developer takes neither. No worktree is created.
    await expect.poll(async () => page.getByTestId('session-spawned-badge').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
    await expect(page.getByTestId('task-outstanding-assignment')).toContainText(/claimed|delivered|uncertain/, { timeout: 30_000 })
    const devPeers = page.locator('[data-chat-role="peer"]').filter({ hasText: /Build (API endpoints|Report UI) here/ })
    await expect(devPeers).toHaveCount(0)
    expect(git(['worktree', 'list', '--porcelain'], root)).toBe(worktreesBefore)

    // The parent lists both children with their assignments.
    await panel.getByRole('button', { name: 'All tasks' }).click()
    await panel.locator('[data-task-id]').first().locator('button').first().click()
    await expect(page.getByTestId('task-detail')).toContainText('API endpoints')
    await expect(page.getByTestId('task-detail')).toContainText('Report UI')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
