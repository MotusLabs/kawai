// Browser walkthrough of the Plans view against the SDK-free fixture and
// isolated durable DB (durable-plans 9.1). Only the prerequisites are
// seeded — a plan with two in-review revisions, written through the agent
// tool path (`planHandlers` bound to the lead chat's session, so creation
// rights, structure, and submission run as they do for an agent). The rest
// runs through the UI: open Plans and inspect the floor and the pin, approve
// and see Ready, a second tab's approval left open across that approval and
// refused inline as stale, a linked task created from the form (In
// progress), the task opened from the plan and marked done (the change
// done), and the plan completed. The view is reached through the Team
// page's `#/team/<key>/plans` route and its tab strip (durable-plans D12).
// Local execution requires the fixture webServer (AGENTBOARD_CHAT_FIXTURE=1);
// CI runs it — never run test:e2e against a live kawai server.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

async function createChat(page: Page, root: string, name: string, group: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Project Path').fill(root)
  await expect(dialog.getByLabel('Group').locator('option', { hasText: 'Leads' })).toHaveCount(1)
  await dialog.getByLabel('Group').selectOption(group)
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
  return (await page.locator('[data-session-id^="chat-"]').filter({ hasText: name }).first().getAttribute('data-session-id'))!
}

/** Create a plan and submit two revisions as the lead agent would: through the plan tool handlers, bound to its session. */
function seedPlanAsAgent(sessionId: string) {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
  execFileSync('bun', ['-e', `
    import { initDatabase } from './src/server/db';
    import { PlanStore } from './src/server/plans/planStore';
    import { PlanService } from './src/server/plans/PlanService';
    import { planHandlers } from './src/server/plans/planTools';
    import { StrategyStore } from './src/server/strategy/strategyStore';
    const [file, sessionId] = JSON.parse(await Bun.stdin.text());
    const sessions = initDatabase({ path: file });
    sessions.db.exec('PRAGMA busy_timeout = 5000');
    const service = new PlanService(new PlanStore(sessions.db), {
      getSession: id => sessions.getChatSession(id), strategies: new StrategyStore(sessions.db), homeDir: process.env.HOME,
    });
    const tools = planHandlers(service, sessionId);
    const content = goal => ({
      goal, successCriteria: ['The walkthrough passes'], approach: 'Through the UI',
      changes: [{ change: 'plan-api', group: 'devs', acceptance: ['Routes answer'] }],
      extraChecks: [{ name: 'browser-walkthrough', description: 'The Plans walkthrough is green' }],
      roles: [{ group: 'devs', profiles: [] }, { group: 'reviewers', profiles: [] }], reviewGroup: 'reviewers',
    });
    const planId = (await tools.plan_create({ title: 'Wave C', content: content('Ship durable plans') })).plan.id;
    for (const goal of ['Ship durable plans', 'Ship durable plans, revised']) {
      const stored = await tools.plan_get({ plan_id: planId });
      const draft = stored.drafts?.find(entry => entry.draftId === sessionId) ?? null;
      const saved = await tools.plan_save_draft({ plan_id: planId, content: content(goal), expected_draft_hash: draft?.contentHash ?? null });
      if (saved.ok === false) throw new Error('plan_save_draft: ' + JSON.stringify(saved));
      const submitted = await tools.plan_submit_for_review({ plan_id: planId });
      if (submitted.ok === false) throw new Error('plan_submit_for_review: ' + JSON.stringify(submitted));
    }
    sessions.close();
  `], { cwd: process.cwd(), input: JSON.stringify([dbPath, sessionId]), encoding: 'utf8' })
}

/** Open the team's Plans tab through its URL route, then the plan from the list. */
async function openPlan(page: Page, root: string) {
  await page.evaluate(teamKey => { window.location.hash = `#/team/${encodeURIComponent(teamKey)}/plans` }, root)
  await expect(page.getByTestId('team-workspace')).toBeVisible()
  const panel = page.getByTestId('team-plans')
  await panel.getByTestId('plan-list').getByRole('button', { name: /Wave C/ }).click()
  await expect(panel.getByRole('heading', { name: 'Wave C' })).toBeFocused()
  return panel
}

test('inspect, approve, a stale second-tab approval, a linked task, and completion', async ({ page, context }, info) => {
  const root = mkdtempSync(join(tmpdir(), 'kawai-plans-browser-'))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/leads.md'), '---\nlabel: Leads\ncanCreatePlans: true\n---\nPlan the work')
  writeFileSync(join(root, '.kawai/groups/devs.md'), '---\nlabel: Developers\n---\nBuild features')
  writeFileSync(join(root, '.kawai/groups/reviewers.md'), '---\nlabel: Reviewers\n---\nReview')
  try {
    await page.goto('/')
    const lead = await createChat(page, root, 'Plan lead', 'leads')
    seedPlanAsAgent(lead)

    // 1. Inspect: the floor beside the extra checks, and no strategy pin.
    const panel = await openPlan(page, root)
    await expect(panel.getByTestId('plan-detail-state')).toContainText('Draft')
    await expect(panel.getByTestId('plan-not-approved')).toContainText('Showing revision 2')
    await expect(panel.getByTestId('plan-floor')).toContainText('Mandatory floor')
    await expect(panel.getByTestId('plan-extra-checks')).toContainText('browser-walkthrough')
    await expect(panel.getByTestId('plan-pin')).toHaveText('Alignment unassessed')
    await page.screenshot({ path: info.outputPath('plans-inspect.png') })

    // A second tab opens the approval of revision 2 while nothing is approved.
    const other = await context.newPage()
    await other.goto('/')
    const otherPanel = await openPlan(other, root)
    await otherPanel.getByTestId('plan-approve-2').click()
    await expect(otherPanel.getByTestId('plan-approve-2-dialog')).toContainText('Approve exactly revision 2')

    // 2. Approve revision 1 here: Ready.
    await panel.getByTestId('plan-approve-1').click()
    await panel.getByTestId('plan-approve-1-confirm').click()
    await expect(panel.getByTestId('plan-detail-state')).toContainText('Ready')
    await expect(panel.getByTestId('plan-detail-state')).toContainText('approved revision 1')

    // The other tab's open approval saw no approved revision: refused inline as stale.
    await otherPanel.getByTestId('plan-approve-2-confirm').click()
    await expect(otherPanel.getByTestId('plan-error')).toContainText('changed while this approval was open')
    await other.screenshot({ path: info.outputPath('plans-stale-approval.png') })
    await other.close()
    await expect(panel.getByTestId('plan-revision-list')).toContainText('Revision 2 — In review')

    // 3. A linked task from the task form: In progress.
    await page.getByTestId('team-tab-tasks').click()
    const tasks = page.getByTestId('team-tasks')
    await tasks.locator('summary', { hasText: 'New task' }).click()
    await tasks.getByLabel('Task title').fill('Build the plan API')
    await tasks.getByLabel('Task direction').fill('Store and routes')
    await tasks.getByLabel('Plan', { exact: true }).focus()
    await expect(tasks.getByLabel('Plan', { exact: true }).locator('option', { hasText: 'Wave C (revision 1)' })).toHaveCount(1)
    await tasks.getByLabel('Plan', { exact: true }).selectOption({ label: 'Wave C (revision 1)' })
    await tasks.getByLabel('Plan change').selectOption('plan-api')
    await tasks.getByTestId('task-create-button').click()
    await expect(tasks.getByRole('button', { name: 'Mark done' })).toBeVisible()
    // The Plans tab opens on its list (the URL names no plan).
    await page.getByTestId('team-tab-plans').click()
    const plans = page.getByTestId('team-plans')
    const row = plans.getByTestId('plan-list').getByRole('button', { name: /Wave C/ })
    await expect(row).toContainText('In progress')
    await expect(row).toContainText('1 linked task')
    await row.click()
    await expect(plans.getByTestId('plan-detail-state')).toContainText('In progress')
    await expect(plans.getByTestId('plan-change-plan-api')).toContainText('Build the plan API')
    await page.screenshot({ path: info.outputPath('plans-in-progress.png') })

    // 4. The linked task opens from the plan; mark it done: the change is done.
    await plans.getByTestId('plan-change-plan-api').getByRole('button', { name: 'Build the plan API' }).click()
    await page.getByTestId('team-tasks').getByRole('button', { name: 'Mark done' }).click()
    await expect(page.getByTestId('team-tasks').getByRole('button', { name: 'Reopen' })).toBeVisible()
    await page.getByTestId('team-tab-plans').click()
    await row.click()
    await expect(plans.getByTestId('plan-change-plan-api').getByTestId('plan-change-status')).toHaveText('Done')

    // 5. Complete the plan: every change is done, so no reason is needed.
    await plans.getByTestId('plan-complete').click()
    await expect(plans.getByTestId('plan-complete-dialog')).toContainText('Every change is done')
    await plans.getByTestId('plan-complete-confirm').click()
    await expect(plans.getByTestId('plan-detail-state')).toContainText('Completed')
    await expect(plans.getByTestId('plan-reopen')).toBeVisible()
    await page.screenshot({ path: info.outputPath('plans-completed.png') })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
