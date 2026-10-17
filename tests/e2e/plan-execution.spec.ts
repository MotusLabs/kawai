// Browser walkthrough of the Execution section of the Plans view
// (plan-execution 17.2) against the SDK-free fixture and isolated durable
// DB. Only the rows are seeded — an approved plan with two changes and a
// running execution over them, written through the stores the server composes
// — the rest runs through the UI: the Execution section renders the
// execution's state, per-change rows with the waiting reason explained, the
// task and PR facts, and Stop listing what it cancels and keeps. The view is
// reached through the Team page's `#/team/<key>/plans` route, like the
// durable-plans walkthrough beside it. Local execution requires the fixture
// webServer (AGENTBOARD_CHAT_FIXTURE=1); CI runs it — never run test:e2e
// against a live kawai server.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initPlanRepository } from './fixtures/planWalkthrough'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

async function createChat(page: Page, root: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Project Path').fill(root)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toBeVisible()
}

/** Seed the plan and its running execution directly through the stores. */
function seedExecution(root: string) {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
  execFileSync('bun', ['-e', `
    import { initDatabase } from './src/server/db';
    import { PlanStore } from './src/server/plans/planStore';
    import { ExecutionStore } from './src/server/plans/execution/executionStore';
    import { resolveTeam } from './src/server/team/teamIdentity';
    import { normalizePlanContent } from './src/shared/plans';
    const sessions = initDatabase({ path: ${JSON.stringify(dbPath)} });
    sessions.db.exec('PRAGMA busy_timeout = 5000');
    const plans = new PlanStore(sessions.db);
    const executions = new ExecutionStore(sessions.db);
    const teamId = (await resolveTeam(${JSON.stringify(root)})).teamId;
    const planId = plans.insertPlan({ teamId, title: 'Execution walkthrough', creator: { kind: 'human', sessionId: null } });
    const content = normalizePlanContent({
      goal: 'Ship the walkthrough', successCriteria: ['The Execution section renders'],
      changes: [
        { change: 'walk-api', dependsOn: [], group: 'devs', acceptance: [], extraChecks: [], guidance: '' },
        { change: 'walk-ui', dependsOn: ['walk-api'], group: 'devs', acceptance: [], extraChecks: [], guidance: '' },
      ],
      roles: [{ group: 'devs', profiles: [] }], reviewGroup: 'reviewers',
    });
    const revision = plans.atomically(() => plans.insertRevision(planId, { content, contentHash: 'walk-hash-1', pin: null, author: { kind: 'human', sessionId: null } }));
    plans.setRevisionStatus(planId, revision, 'approved');
    plans.setCurrentApproved(planId, revision);
    const execution = executions.insertExecution({
      teamId, planId, revision, contentHash: 'walk-hash-1', reportId: 'rep-walk', inputHash: 'in-walk',
      landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc123', floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } },
      maxParallel: 2, mergeMethod: 'merge',
      changes: [{ change: 'walk-api', landed: false }, { change: 'walk-ui', landed: false }],
    });
    const api = executions.change(execution.id, 'walk-api')!;
    executions.transition(execution.id, 'walk-api', api, { state: 'provisioning' });
    executions.transition(execution.id, 'walk-api', executions.change(execution.id, 'walk-api')!, { state: 'implementing', taskId: 'task-walk-1', worktree: ${JSON.stringify(join(root, '.worktrees', 'walk-api'))}, branch: 'walk-api', baselineCommit: 'abc123' });
    const round = executions.insertRound({ executionId: execution.id, change: 'walk-api', attemptId: 'attempt-walk-1', resultId: 'res-walk-1', commitSha: 'def456', fixRound: false });
    executions.markRoundPushed(round.id, new Date().toISOString());
    const row = executions.change(execution.id, 'walk-api')!;
    executions.transition(execution.id, 'walk-api', row, { prNumber: 9, prUrl: 'https://example.internal/pr/9', prOpenedByKawai: true });
    sessions.close();
  `], { cwd: process.cwd(), encoding: 'utf8' })
}

test('the Execution section renders a running execution and its changes', async ({ page }, info) => {
  const root = mkdtempSync(join(tmpdir(), 'kawai-execution-browser-'))
  initPlanRepository(root, ['walk-api', 'walk-ui'], {
    leads: '---\nlabel: Leads\ncanCreatePlans: true\n---\nPlan the work',
    devs: '---\nlabel: Developers\n---\nBuild features',
    reviewers: '---\nlabel: Reviewers\n---\nReview',
  })
  try {
    await page.goto('/')
    await createChat(page, root)
    seedExecution(root)

    await page.evaluate(teamKey => { window.location.hash = `#/team/${encodeURIComponent(teamKey)}/plans` }, root)
    await expect(page.getByTestId('team-workspace')).toBeVisible()
    const panel = page.getByTestId('team-plans')
    await panel.getByTestId('plan-list').getByRole('button', { name: /Execution walkthrough/ }).click()
    await expect(panel.getByRole('heading', { name: 'Execution walkthrough' })).toBeFocused()

    // The section: the execution's state, one row per change.
    const section = panel.getByTestId('plan-execution-section')
    await expect(section).toBeVisible()
    await expect(section.getByTestId('plan-execution-state')).toContainText('Running')
    await expect(section.getByTestId('plan-execution-state')).toContainText('revision 1')
    const rows = section.getByTestId('plan-execution-change')
    await expect(rows).toHaveCount(2)

    // walk-api (first in content order): gating on its pushed round.
    const api = rows.nth(0)
    await expect(api).toContainText('walk-api')
    await expect(api).toContainText('Gating')
    await expect(api.getByTestId('plan-execution-round')).toContainText('round 1')

    // walk-ui (second): waiting is explained — its dependency has not landed.
    const ui = rows.nth(1)
    await expect(ui).toContainText('walk-ui')
    await expect(ui).toContainText('Waiting')
    await expect(ui.getByTestId('plan-execution-waiting')).toContainText('walk-api')

    // Stop states what it cancels (both unlanded changes) and keeps (nothing yet).
    await expect(section.getByTestId('stop-cancels')).toContainText('walk-api')
    await expect(section.getByTestId('stop-cancels')).toContainText('walk-ui')
    await page.screenshot({ path: info.outputPath('execution-running.png') })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a plan without an execution shows the empty state with the Start hint', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'kawai-execution-empty-'))
  initPlanRepository(root, ['empty-api'], {
    leads: '---\nlabel: Leads\ncanCreatePlans: true\n---\nPlan the work',
    devs: '---\nlabel: Developers\n---\nBuild features',
    reviewers: '---\nlabel: Reviewers\n---\nReview',
  })
  try {
    await page.goto('/')
    await createChat(page, root)
    // Approve a revision with no execution seeded.
    const dbPath = process.env.AGENTBOARD_DB_PATH!
    execFileSync('bun', ['-e', `
      import { initDatabase } from './src/server/db';
      import { PlanStore } from './src/server/plans/planStore';
      import { resolveTeam } from './src/server/team/teamIdentity';
      import { normalizePlanContent } from './src/shared/plans';
      const sessions = initDatabase({ path: ${JSON.stringify(dbPath)} });
      sessions.db.exec('PRAGMA busy_timeout = 5000');
      const plans = new PlanStore(sessions.db);
      const teamId = (await resolveTeam(${JSON.stringify(root)})).teamId;
      const planId = plans.insertPlan({ teamId, title: 'No execution yet', creator: { kind: 'human', sessionId: null } });
      const content = normalizePlanContent({
        goal: 'Nothing runs', successCriteria: ['The empty state shows'],
        changes: [{ change: 'empty-api', dependsOn: [], group: 'devs', acceptance: [], extraChecks: [], guidance: '' }],
        roles: [{ group: 'devs', profiles: [] }],
      });
      const revision = plans.atomically(() => plans.insertRevision(planId, { content, contentHash: 'empty-hash-1', pin: null, author: { kind: 'human', sessionId: null } }));
      plans.setRevisionStatus(planId, revision, 'approved');
      plans.setCurrentApproved(planId, revision);
      sessions.close();
    `], { cwd: process.cwd(), encoding: 'utf8' })

    await page.evaluate(teamKey => { window.location.hash = `#/team/${encodeURIComponent(teamKey)}/plans` }, root)
    await expect(page.getByTestId('team-workspace')).toBeVisible()
    const panel = page.getByTestId('team-plans')
    await panel.getByTestId('plan-list').getByRole('button', { name: /No execution yet/ }).click()
    const section = panel.getByTestId('plan-execution-section')
    await expect(section).toContainText('No execution has run')
    await expect(section).toContainText('Start runs the approved revision')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
