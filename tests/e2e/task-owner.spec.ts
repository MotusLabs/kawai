// Browser check for task ownership (group-mail-task-affinity D7): a task whose
// owner differs from its creator names the owner beside "created by" in the
// task detail. The fixture agents cannot call task_transfer_owner, so the
// owner column is written into the isolated database and the detail reopened
// for its authoritative snapshot.
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createChat, createTask, openTaskId, openTasks, reopenTask, resultsTeam } from './support/taskResults'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

function seedOwner(taskId: string, session: string) {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
  execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { retryOnSqliteBusy } from './src/server/__tests__/sqliteBusyRetry';
    const [file, taskId, session] = JSON.parse(await Bun.stdin.text());
    const db = new Database(file); db.exec('PRAGMA busy_timeout = 5000');
    const changed = await retryOnSqliteBusy(() => db.query('UPDATE team_tasks SET owner_session = ? WHERE id = ?').run(session, taskId).changes);
    if (changed !== 1) throw new Error('task not seeded');
    db.close();
  `], { cwd: process.cwd(), input: JSON.stringify([dbPath, taskId, session]), encoding: 'utf8' })
}

test('task detail names the owner once ownership moved away from the creator', async ({ page }, info) => {
  test.setTimeout(90_000)
  const { root } = resultsTeam()
  try {
    await page.goto('/')
    const owner = await createChat(page, root, 'Owner lead', 'leads')
    await openTasks(page, root)
    await createTask(page, { title: 'Owned report', direction: 'Summarize the incident' })
    const detail = page.getByTestId('task-detail')
    // A human-created task has no owner: no "owned by".
    await expect(detail.getByTestId('task-creator')).toBeVisible()
    await expect(detail.getByTestId('task-owner')).toHaveCount(0)

    const taskId = await openTaskId(page)
    seedOwner(taskId, owner)
    await reopenTask(page, taskId)
    await expect(detail.getByTestId('task-owner')).toHaveText('Owner lead')
    await expect(detail).toContainText('· owned by Owner lead')
    await detail.screenshot({ path: info.outputPath('task-owner-detail.png') })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
