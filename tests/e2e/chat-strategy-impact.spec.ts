// Browser walkthrough of the strategy impact review against the SDK-free
// fixture and isolated durable DB (strategy-revision-impact 7.1). Only the
// prerequisites are seeded, through the store and tool paths: a `lead` group,
// strategy revision 1 approved, a plan created and submitted by the lead chat
// through the plan tool handlers and approved by the human under revision 1,
// and strategy revision 2 in review. The rest runs through the UI: approve
// revision 2 (the review needs decisions, the plan is affected), open the
// review from the Plans badge link, record `continue` (Reviewed), a second
// tab's decision left open across an `adapt` and refused inline as stale, the
// superseded `continue` in the history, and an assessment request to `lead`
// shown in the Messages view.
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
  await expect(dialog.getByLabel('Group').locator('option', { hasText: 'Lead' })).toHaveCount(1)
  await dialog.getByLabel('Group').selectOption(group)
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
  return (await page.locator('[data-session-id^="chat-"]').filter({ hasText: name }).first().getAttribute('data-session-id'))!
}

/**
 * Seed the prerequisites as the human and the lead agent would: strategy
 * revision 1 approved through the strategy store, a plan created and submitted
 * through the plan tool handlers bound to the lead's session and approved by
 * the human under revision 1, then strategy revision 2 submitted for review.
 */
function seedImpactPrerequisites(root: string, sessionId: string) {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
  execFileSync('bun', ['-e', `
    import { initDatabase } from './src/server/db';
    import { PlanStore } from './src/server/plans/planStore';
    import { PlanService } from './src/server/plans/PlanService';
    import { planHandlers } from './src/server/plans/planTools';
    import { StrategyStore } from './src/server/strategy/strategyStore';
    import { hashStrategyContent } from './src/server/strategy/strategyHash';
    import { normalizeStrategyContent } from './src/shared/productStrategy';
    import { resolveTeam } from './src/server/team/teamIdentity';
    import { TeamWorktrees } from './src/server/team/worktreeRoots';
    const [file, root, sessionId] = JSON.parse(await Bun.stdin.text());
    const sessions = initDatabase({ path: file });
    sessions.db.exec('PRAGMA busy_timeout = 5000');
    const human = { kind: 'human', sessionId: null };
    const strategies = new StrategyStore(sessions.db);
    const team = await resolveTeam(root);
    const strategy = strategies.create({
      productId: 'impact-browser', title: 'Kawai', owner: human, teamId: team.teamId, worktrees: await new TeamWorktrees().list(team.teamId),
    });
    const submit = purpose => {
      const submitted = strategies.submitRevision(strategy.id, { author: human, content: { purpose } });
      if (!submitted.ok) throw new Error('submitRevision: ' + submitted.message);
      return submitted.revision.revision;
    };
    const first = submit('Agents ship reviewed changes');
    const approved = strategies.approve(strategy.id, {
      revision: first, contentHash: hashStrategyContent(normalizeStrategyContent({ purpose: 'Agents ship reviewed changes' })),
      commandId: 'seed-strategy-1', expectedCurrentRevision: null, actor: human,
    });
    if (!approved.ok) throw new Error('approve strategy: ' + approved.message);
    const service = new PlanService(new PlanStore(sessions.db), {
      getSession: id => sessions.getChatSession(id), strategies, homeDir: process.env.HOME,
    });
    const tools = planHandlers(service, sessionId);
    const content = {
      goal: 'Ship the impact review', successCriteria: ['The walkthrough passes'], approach: 'Through the UI',
      changes: [{ change: 'impact-api', group: 'lead', acceptance: ['Routes answer'] }],
      roles: [{ group: 'lead', profiles: [] }], reviewGroup: 'lead',
    };
    const planId = (await tools.plan_create({ title: 'Wave C', content })).plan.id;
    const submitted = await tools.plan_submit_for_review({ plan_id: planId });
    if (submitted.ok === false) throw new Error('plan_submit_for_review: ' + JSON.stringify(submitted));
    const plan = await service.approve({ kind: 'human', team }, {
      planId, revision: submitted.revision.revision, contentHash: submitted.revision.contentHash,
      expectedApprovedRevision: null, commandId: 'seed-plan-1',
    });
    if (!plan.ok) throw new Error('approve plan: ' + JSON.stringify(plan));
    submit('Agents ship reviewed changes the owner can steer');
    sessions.close();
  `], { cwd: process.cwd(), input: JSON.stringify([dbPath, root, sessionId]), encoding: 'utf8' })
}

/** Open the team's Strategy tab through its URL route, optionally on a sub-view. */
async function openStrategy(page: Page, root: string, sub = '') {
  await page.evaluate(([teamKey, subView]) => {
    window.location.hash = `#/team/${encodeURIComponent(teamKey)}/strategy${subView ? `/${subView}` : ''}`
  }, [root, sub] as const)
  const view = page.getByTestId('product-strategy')
  await expect(view).toBeVisible()
  return view
}

/** Decide one disposition for the plan with a rationale, from an open impact review. */
async function decide(view: ReturnType<Page['getByTestId']>, disposition: string, rationale: string, confirm = true) {
  await view.locator('[data-testid^="impact-decide-open-"]').first().click()
  const dialog = view.getByTestId('impact-decide-dialog')
  await dialog.getByTestId(`impact-disposition-${disposition}`).check()
  await dialog.getByTestId('impact-rationale').fill(rationale)
  if (confirm) await dialog.getByTestId('impact-decide-confirm').click()
  return dialog
}

test('approve a revision, open the review from Plans, decide twice, a stale second tab, and ask lead to assess', async ({ page, context }, info) => {
  const root = mkdtempSync(join(tmpdir(), 'kawai-impact-browser-'))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/lead.md'), '---\nlabel: Lead\ncanCreatePlans: true\n---\nPlan the work')
  try {
    await page.goto('/')
    const lead = await createChat(page, root, 'Impact lead', 'lead')
    seedImpactPrerequisites(root, lead)

    // 1. Approve strategy revision 2: the review needs decisions, the plan is affected.
    const strategy = await openStrategy(page, root)
    await strategy.getByTestId('strategy-sub-review-2').click()
    await strategy.getByTestId('strategy-review-2').getByTestId('approve-2').click()
    await strategy.getByTestId('strategy-sub-overview').click()
    await expect(strategy.getByTestId('strategy-status')).toContainText('Approved revision 2')
    await strategy.getByTestId('strategy-sub-impact').click()
    await expect(strategy.getByTestId('impact-review-state')).toContainText('Needs decisions')
    const affected = strategy.getByTestId('impact-group-affected')
    await expect(affected).toContainText('Wave C')
    await expect(affected).toContainText('Decision required')
    await page.screenshot({ path: info.outputPath('impact-needs-decisions.png') })

    // 2. The Plans badge marks the plan and its link opens the review.
    await page.getByTestId('team-tab-plans').click()
    const plans = page.getByTestId('team-plans')
    await expect(plans.getByTestId('plan-list')).toContainText('Strategy impact: Decision required')
    await plans.getByRole('button', { name: 'Open review: impact review of strategy revision 2' }).click()
    const review = page.getByTestId('product-strategy')
    await expect(review.getByTestId('impact-review-tab-2')).toHaveAttribute('aria-current', 'true')
    expect(page.url()).toContain('/strategy/impact/2')

    // 3. Record continue with a rationale: Reviewed.
    await decide(review, 'continue', 'Revision 2 only sharpens the purpose')
    await expect(review.getByTestId('impact-decide-dialog')).toHaveCount(0)
    await expect(review.getByTestId('impact-review-state')).toContainText('Reviewed')
    await expect(review.getByTestId('impact-effective-decision')).toContainText('Continue — Revision 2 only sharpens the purpose')

    // A second tab opens its decision over that continue and leaves it open.
    const other = await context.newPage()
    await other.goto('/')
    const otherReview = await openStrategy(other, root, 'impact/2')
    const otherDialog = await decide(otherReview, 'reconsider', 'Second tab', false)
    await expect(otherDialog.getByTestId('impact-decide-replaces')).toContainText('Continue')

    // 4. Record adapt here: the superseded continue stays in the history.
    await decide(review, 'adapt', 'Steering needs a new revision')
    await expect(review.getByTestId('impact-effective-decision')).toContainText('Adapt — Steering needs a new revision')
    await review.getByTestId('impact-history-toggle').click()
    const history = review.getByTestId('impact-decision-history')
    await expect(history).toContainText('Continue — Revision 2 only sharpens the purpose')
    await expect(history).toContainText('Adapt — Steering needs a new revision')
    await page.screenshot({ path: info.outputPath('impact-adapt-history.png') })

    // The other tab's decision replaced continue, no longer effective: refused inline as stale.
    await otherDialog.getByTestId('impact-decide-confirm').click()
    await expect(otherDialog.getByTestId('impact-decide-error')).toContainText('Another decision was recorded meanwhile: adapt')
    await other.screenshot({ path: info.outputPath('impact-stale-decision.png') })
    await other.close()
    await expect(review.getByTestId('impact-effective-decision')).toContainText('Adapt')

    // 5. Ask the lead group to assess: the request shows in the Messages view.
    await review.getByTestId('impact-ask-open').click()
    const ask = review.getByTestId('impact-ask-dialog')
    await expect(ask.getByTestId('impact-ask-group')).toHaveValue('lead')
    await ask.getByTestId('impact-ask-confirm').click()
    await expect(review.getByTestId('impact-notice')).toContainText('Assessment request sent')
    await page.getByTestId('team-tab-messages').click()
    await expect(page.getByTestId('team-messages')).toContainText('Please assess the strategy impact review for Kawai')
    await page.screenshot({ path: info.outputPath('impact-assessment-request.png') })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
