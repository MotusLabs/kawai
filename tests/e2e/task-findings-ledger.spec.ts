// Browser walkthrough of the findings ledger against the SDK-free fixture
// (review-findings-ledger 6.2, D10): the human creates a manual task; a
// result, a structured review (F1 at P1, accepted; F2 at P2, advisory), and
// the developer's dispute of F1 are written through the production stores
// and services on the isolated DB; the task detail's Findings section shows
// F1 disputed and F2 advisory, the result card shows each item's class, and
// the human rejects F1 with a rationale — after which F1 reads rejected
// with its accepted → disputed → rejected history. Run on its own fixture
// port; never against a live kawai (teardown is scoped to its private tmux
// socket).
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

function isolatedDb(): string {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse touching a non-isolated database')
  return dbPath
}

function teamRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-findings-ledger-')))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/leads.md'), '---\nlabel: Team leads\n---\nCoordinate work')
  return root
}

async function createChat(page: Page, root: string, name: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Project Path').fill(root)
  await expect(dialog.getByLabel('Group').locator('option', { hasText: 'Team leads' })).toHaveCount(1)
  await dialog.getByLabel('Group').selectOption('leads')
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
}

async function openTasks(page: Page) {
  const button = page.getByTestId('chat-team-button')
  if (await button.isVisible().catch(() => false)) await button.click()
  await page.getByTestId('team-tab-tasks').click()
  await expect(page.getByTestId('team-tasks')).toBeVisible()
}

/**
 * R1 by `dev`, a structured review by `rev` (F1 P1 accepted, F2 P2), and dev's
 * dispute of F1 — through the production stores and services. The stores log
 * to stdout too, so the script prints nothing the spec reads. Scripts answer
 * through process.stdout.write: the runner sets FORCE_COLOR.
 */
function seedReview(taskId: string) {
  execFileSync('bun', ['-e', `
    import { initDatabase } from './src/server/db';
    import { AssignmentStore } from './src/server/team/assignmentStore';
    import { MailboxStore } from './src/server/team/mailboxStore';
    import { TaskStore } from './src/server/team/taskStore';
    import { TaskService } from './src/server/team/TaskService';
    import { TaskResultService } from './src/server/team/TaskResultService';
    import { retryOnSqliteBusy } from './src/server/__tests__/sqliteBusyRetry';
    const [file, taskId] = JSON.parse(await Bun.stdin.text());
    const sessions = initDatabase({ path: file });
    sessions.db.exec('PRAGMA busy_timeout = 5000');
    const mail = new MailboxStore(sessions.db);
    const store = new TaskStore(sessions.db, mail, new AssignmentStore(sessions.db, mail));
    const results = new TaskResultService(new TaskService(store, { getSession: () => undefined }), { getSession: () => undefined });
    const task = store.get(taskId);
    // A single INSERT: a re-run on SQLITE_BUSY cannot duplicate it.
    const result = await retryOnSqliteBusy(() => store.results.insert({
      teamId: task.teamId, taskId, summary: 'CSV export', commit: 'abc123', diff: null, worktree: null,
      tests: [], limitations: null, taskRevision: task.revision, submittedBy: { kind: 'agent', sessionId: 'dev' },
    }));
    // The submission and the dispute write in immediate transactions, which wait on the busy handler.
    results.findingsLedger.submit({
      teamId: task.teamId, task, result, author: { kind: 'agent', sessionId: 'rev' }, handoffId: null, counted: true,
      submission: { kind: 'review', dispositions: [], findings: [
        { level: 'P1', clause: task.identity, evidence: 'src/export.ts:12 drops the header row', impact: 'the CSV has no header' },
        { level: 'P2', clause: task.identity, evidence: 'src/export.ts:30 names a variable x', impact: 'naming' },
      ] },
    });
    await results.findingsLedger.disputes.dispute({ teamId: task.teamId, task: store.get(taskId), actor: { kind: 'agent', sessionId: 'dev' },
      disputes: [{ id: 'F1', counterEvidence: 'src/export.ts:8 writes the header before line 12' }] });
    sessions.close();
  `], { cwd: process.cwd(), input: JSON.stringify([isolatedDb(), taskId]), encoding: 'utf8' })
}

test('a structured review, a dispute, and the human\'s decision show in the Findings section and the result card', async ({ page }, info) => {
  test.setTimeout(120_000)
  const root = teamRoot()
  try {
    await page.goto('/')
    await createChat(page, root, 'Findings lead')
    await openTasks(page)
    const panel = page.getByTestId('team-tasks')
    await panel.locator('summary', { hasText: 'New task' }).click()
    await panel.getByLabel('Task title').fill('Export')
    await panel.getByLabel('Task direction').fill('Ship a CSV export')
    await panel.getByTestId('task-create-button').click()
    const detail = page.getByTestId('task-detail')
    await expect(detail).toBeVisible({ timeout: 15_000 })
    const taskId = (await detail.getAttribute('data-task-id'))!
    await expect(detail.getByTestId('task-findings-empty')).toBeVisible()

    seedReview(taskId)
    // Writes from another process push nothing: reopen the task for a fresh detail.
    await page.getByRole('button', { name: 'All tasks' }).click()
    await page.locator(`[data-task-id="${taskId}"] button`).first().click()
    await expect(detail).toHaveAttribute('data-task-id', taskId)

    const f1 = detail.locator('[data-testid="finding-row"][data-finding-id="F1"]')
    const f2 = detail.locator('[data-testid="finding-row"][data-finding-id="F2"]')
    await expect(f1).toHaveAttribute('data-state', 'disputed', { timeout: 15_000 })
    await expect(f2).toHaveAttribute('data-state', 'advisory')
    const card = detail.getByTestId('task-result').first()
    await expect(card.locator('[data-testid="result-finding-item"][data-finding-id="F1"]')).toHaveAttribute('data-class', 'accepted')
    await expect(card.locator('[data-testid="result-finding-item"][data-finding-id="F2"]')).toHaveAttribute('data-class', 'advisory')
    await expect(f2.getByRole('button', { name: 'Reject F2' })).toHaveCount(0)
    await detail.getByTestId('task-findings').screenshot({ path: info.outputPath('disputed.png') })

    // The human rejects F1; the rationale is required.
    await expect(f1.getByRole('button', { name: 'Reject F1' })).toBeDisabled()
    await f1.getByLabel('Rationale for F1').fill('The header is written at line 8')
    await f1.getByRole('button', { name: 'Reject F1' }).click()
    await expect(f1).toHaveAttribute('data-state', 'rejected', { timeout: 15_000 })
    await expect(f1.getByTestId('finding-decision')).toHaveCount(0)
    await f1.getByTestId('finding-history-toggle').click()
    const kinds = f1.getByTestId('finding-transition')
    await expect(kinds).toHaveCount(3)
    expect(await kinds.evaluateAll(rows => rows.map(row => row.getAttribute('data-kind')))).toEqual(['accepted', 'disputed', 'rejected'])
    await expect(kinds.nth(1)).toContainText('src/export.ts:8 writes the header before line 12')
    await expect(kinds.nth(2)).toContainText('The header is written at line 8')
    await detail.getByTestId('task-findings').screenshot({ path: info.outputPath('rejected.png') })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
