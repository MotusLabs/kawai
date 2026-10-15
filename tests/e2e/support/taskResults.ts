// Browser helpers for the task-results walkthroughs (task-results-handoffs
// 8.4): an isolated repository with a linked worktree, fixture chats, and a
// result seeded into the isolated database — the SDK-free fixture agents
// cannot call task_submit_result, so the row is written with the server's own
// store and the task view is reopened for its authoritative snapshot.
import { expect, type Page } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanGitEnv } from '../../../src/server/git/gitCommand'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

/** A repository (main checkout = team root) with one linked worktree, `.wt-feat`. */
export function resultsTeam() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-task-results-')))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/leads.md'), '---\nlabel: Team leads\n---\nCoordinate work')
  writeFileSync(join(root, '.kawai/groups/devs.md'), '---\nlabel: Developers\nmax: 3\n---\nBuild features')
  writeFileSync(join(root, '.kawai/groups/reviewers.md'), '---\nlabel: Reviewers\nmax: 3\n---\nReview results')
  git(['init', '-q', root])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], root)
  const worktree = join(root, '.wt-feat')
  git(['worktree', 'add', '-q', '-b', 'feat', worktree], root)
  return { root, worktree }
}

export async function createChat(page: Page, root: string, name: string, group: string) {
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

export async function say(page: Page, session: string, text: string) {
  await page.locator(`[data-session-id="${session}"]`).first().click()
  await page.getByLabel('Message Claude').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

export async function openTasks(page: Page) {
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.getByTestId('team-tasks')).toBeVisible()
}

/** Create a task (optionally in a worktree, assigned to a group) through New task; leaves its detail open. */
export async function createTask(page: Page, input: { title: string; direction: string; acceptance?: string; worktree?: string; parent?: string; assign?: string }) {
  const panel = page.getByTestId('team-tasks')
  const back = panel.getByRole('button', { name: 'All tasks' })
  if (await back.isVisible().catch(() => false)) await back.click()
  await panel.locator('summary', { hasText: 'New task' }).click()
  await panel.getByLabel('Task title').fill(input.title)
  await panel.getByLabel('Task direction').fill(input.direction)
  if (input.acceptance) await panel.getByLabel('Acceptance criteria').fill(input.acceptance)
  if (input.parent) await panel.getByLabel('Parent task').selectOption({ label: input.parent })
  if (input.worktree) await panel.getByLabel('Target worktree').fill(input.worktree)
  if (input.assign) {
    await panel.getByLabel('Assignment target kind').selectOption('group')
    await panel.getByLabel('Assignment group').selectOption(input.assign)
    await panel.getByLabel('Assignment instruction').fill(`Please build ${input.title}`)
    await panel.getByTestId('task-create-assign-button').click()
  } else {
    await panel.getByTestId('task-create-button').click()
  }
  await expect(page.getByTestId('task-detail')).toContainText(input.title, { timeout: 15_000 })
}

/** Reopen the Tasks panel (a fresh list snapshot) and a task's detail, by id (`task-…`) or title. */
export async function reopenTask(page: Page, key: string) {
  const panel = page.getByTestId('team-tasks')
  if (await panel.isVisible().catch(() => false)) await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await openTasks(page)
  const row = key.startsWith('task-') ? panel.locator(`[data-task-id="${key}"]`) : panel.locator('[data-task-id]').filter({ hasText: key })
  await row.first().locator('button').first().click()
  if (key.startsWith('task-')) await expect(page.getByTestId('task-detail')).toHaveAttribute('data-task-id', key)
  else await expect(page.getByTestId('task-detail')).toContainText(key)
}

/** The open task detail's id. */
export async function openTaskId(page: Page) {
  return (await page.getByTestId('task-detail').getAttribute('data-task-id'))!
}

/** Seed a result for the task, submitted by `session` at the task's current revision; returns its id. */
export function seedResult(taskId: string, session: string, worktree: string | null): string {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
  return execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { TaskResultStore } from './src/server/team/taskResultStore';
    const [file, taskId, session, worktree] = JSON.parse(await Bun.stdin.text());
    const db = new Database(file); db.exec('PRAGMA busy_timeout = 5000');
    const task = db.query('SELECT id, team_id, revision FROM team_tasks WHERE id = ?').get(taskId);
    const result = new TaskResultStore(db).insert({ teamId: task.team_id, taskId: task.id, summary: 'CSV export', commit: 'abc1234', diff: null,
      worktree, tests: [{ description: 'bun run test', outcome: 'pass' }], limitations: null, taskRevision: task.revision,
      submittedBy: { kind: 'agent', sessionId: session } });
    console.log(result.id); db.close();
  `], { cwd: process.cwd(), input: JSON.stringify([dbPath, taskId, session, worktree]), encoding: 'utf8' }).trim()
}

/** The live spawned developer's session id in `worktree` (earlier tests' members stay live in the shared database). */
export async function spawnedSession(page: Page, worktree: string) {
  const row = page.locator('[data-session-id^="chat-"]').filter({ has: page.getByTestId('session-spawned-badge') })
    .filter({ has: page.getByTitle(worktree, { exact: true }) }).filter({ hasText: 'Developers' }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  return (await row.getAttribute('data-session-id'))!
}
