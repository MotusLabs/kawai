// Browser walkthrough of the workspace's URL navigation and pane controls
// (plan-workspace 7.1–7.2) against the SDK-free fixture and an isolated
// durable DB. A plan with two in-review revisions is seeded through the
// agent tool path; the rest runs in the browser:
// 1. the workspace opens on the default displayed version (newest in review);
// 2. a deep link selects the version and the role; a reload restores them;
// 3. a link naming an unknown revision falls back with its notice, keeps the
//    URL, and the notice names what actually stays shown;
// 4. a version pick pushes one history entry; Back re-explains the stale
//    link and Forward restores the pick;
// 5. a full-screen chat visit and the Team button return restore the same
//    plan, version, and role;
// 6. the legacy routes still parse; the divider resizes by keyboard; the
//    conversation column hides; the narrow navigation shows one pane, moves
//    focus with the switch, and Back returns to the map.
// Requires the fixture webServer (AGENTBOARD_CHAT_FIXTURE=1) on its own
// port; never run test:e2e against a live kawai server.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initPlanRepository } from './fixtures/planWalkthrough'

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

/** Create a plan with two in-review revisions, as the lead agent would. */
function seedPlanAsAgent(sessionId: string): string {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
  execFileSync('bun', ['-e', `
    import { initDatabase } from './src/server/db';
    import { PlanStore } from './src/server/plans/planStore';
    import { PlanService } from './src/server/plans/PlanService';
    import { planHandlers } from './src/server/plans/planTools';
    import { StrategyStore } from './src/server/strategy/strategyStore';
    import { retryOnSqliteBusy } from './src/server/__tests__/sqliteBusyRetry';
    const [file, sessionId] = JSON.parse(await Bun.stdin.text());
    const sessions = initDatabase({ path: file });
    sessions.db.exec('PRAGMA busy_timeout = 5000');
    const service = new PlanService(new PlanStore(sessions.db), {
      getSession: id => sessions.getChatSession(id), strategies: new StrategyStore(sessions.db), homeDir: process.env.HOME,
    });
    const tools = planHandlers(service, sessionId);
    const content = () => ({
      goal: 'Navigate the workspace', successCriteria: ['The walkthrough passes'], approach: 'Through the URL',
      changes: [
        { change: 'plan-api', group: 'devs', acceptance: ['Routes answer'] },
        { change: 'plan-web', dependsOn: ['plan-api'], group: 'devs', acceptance: ['Views render'] },
      ],
      roles: [{ group: 'devs', profiles: [] }], reviewGroup: 'devs',
    });
    const planId = (await retryOnSqliteBusy(() => tools.plan_create({ title: 'Navigation Wave' }))).plan.id;
    for (const goal of ['first', 'second']) {
      const stored = await tools.plan_get({ plan_id: planId });
      const draft = stored.drafts?.find(entry => entry.draftId === sessionId) ?? null;
      const saved = await retryOnSqliteBusy(() => tools.plan_save_draft({
        plan_id: planId, content: { ...content(), goal: 'Navigate the workspace (' + goal + ')' },
        expected_draft_hash: draft?.contentHash ?? null,
      }));
      if (saved.ok === false) throw new Error('plan_save_draft: ' + JSON.stringify(saved));
      const submitted = await retryOnSqliteBusy(() => tools.plan_submit_for_review({ plan_id: planId }));
      if (submitted.ok === false) throw new Error('plan_submit_for_review: ' + JSON.stringify(submitted));
    }
    sessions.close();
    console.log(planId);
  `], { cwd: process.cwd(), input: JSON.stringify([dbPath, sessionId]), encoding: 'utf8' }).trim()
}

const teamHash = (root: string, rest: string): string => `#/team/${encodeURIComponent(root)}/${rest}`
const setHash = (page: Page, hash: string) => page.evaluate(value => { window.location.hash = value }, hash)
const hashNow = (page: Page) => page.evaluate(() => window.location.hash)

test('deep links, reload, Back/Forward, the full-screen return, and the pane controls', async ({ page }, info) => {
  const root = mkdtempSync(join(tmpdir(), 'kawai-pw-nav-'))
  initPlanRepository(root, ['plan-api'], {
    leads: '---\nlabel: Leads\ncanCreatePlans: true\n---\nPlan the work',
    devs: '---\nlabel: Developers\n---\nBuild features',
  })
  try {
    await page.goto('/')
    const lead = await createChat(page, root, 'Plan lead', 'leads')
    seedPlanAsAgent(lead)
    // Everything after `#/team/<key>/` in the hash: `plans/<id>[?query]`.
    const plansBase = 'plans'

    // 1. The workspace opens on the newest in-review revision by default.
    await setHash(page, teamHash(root, 'plans'))
    await expect(page.getByTestId('team-workspace')).toBeVisible()
    await page.getByTestId('plan-list').getByRole('button', { name: /Navigation Wave/ }).click()
    await expect(page.getByTestId('plan-workspace')).toBeVisible()
    await expect(page.getByTestId('workspace-displayed-label')).toContainText('revision 2')
    await expect(page.getByTestId('plan-workspace-url-notice')).toHaveCount(0)
    // The selected plan names itself in the URL; take the id from there rather
    // than from the seeder's stdout.
    const planId = decodeURIComponent((await hashNow(page)).split('/').pop()!.split('?')[0]!)

    // 2. A deep link selects the version and the role, in the URL's own words.
    const deepLink = `${plansBase}/${planId}?v=rev%3A1&r=lead`
    await setHash(page, teamHash(root, deepLink))
    await expect(page.getByTestId('workspace-displayed-label')).toContainText('revision 1')
    await expect(page.getByTestId('workspace-version-picker')).toHaveValue('rev:1')
    await expect(page.getByTestId('conversation-role-lead')).toHaveAttribute('aria-selected', 'true')
    // The link already names the selection: the workspace writes no history
    // of its own and raises no notice.
    await expect(page.getByTestId('plan-workspace-url-notice')).toHaveCount(0)
    expect(await hashNow(page)).toBe(teamHash(root, deepLink))

    // 3. A reload restores the same identity.
    await page.reload()
    await expect(page.getByTestId('workspace-displayed-label')).toContainText('revision 1')
    await expect(page.getByTestId('workspace-version-picker')).toHaveValue('rev:1')
    await expect(page.getByTestId('conversation-role-lead')).toHaveAttribute('aria-selected', 'true')
    await page.screenshot({ path: info.outputPath('workspace-deep-link.png') })

    // 4. A link naming an unknown revision falls back with its notice, keeps
    // the URL, and the notice names what actually stays shown (revision 1,
    // retained — never a silently different record).
    await setHash(page, teamHash(root, `${plansBase}/${planId}?v=rev%3A9&c=ghost`))
    const notice = page.getByTestId('plan-workspace-url-notice')
    await expect(notice).toContainText('revision 9')
    await expect(notice).toContainText('ghost')
    await expect(notice).toContainText('showing revision 1')
    await expect(page.getByTestId('workspace-displayed-label')).toContainText('revision 1')
    expect(await hashNow(page)).toContain('rev%3A9')

    // 5. A version pick pushes one entry; Back re-explains the stale link,
    // Forward restores the pick.
    await page.getByTestId('workspace-version-picker').selectOption('rev:1')
    await expect(page.getByTestId('plan-workspace-url-notice')).toHaveCount(0)
    expect(await hashNow(page)).toBe(teamHash(root, `${plansBase}/${planId}?v=rev%3A1&r=lead`))
    await page.goBack()
    await expect(notice).toContainText('revision 9')
    expect(await hashNow(page)).toContain('rev%3A9')
    await page.goForward()
    await expect(page.getByTestId('workspace-displayed-label')).toContainText('revision 1')
    await expect(page.getByTestId('plan-workspace-url-notice')).toHaveCount(0)

    // 6. A full-screen chat visit clears the route; the Team button returns
    // to the same plan, version, and role.
    await page.locator(`[data-session-id="${lead}"]`).first().click()
    await expect(page.getByTestId('chat-view')).toBeVisible()
    await page.getByTestId('chat-team-button').click()
    await expect(page.getByTestId('plan-workspace')).toBeVisible()
    await expect(page.getByTestId('workspace-displayed-label')).toContainText('revision 1')
    await expect(page.getByTestId('workspace-version-picker')).toHaveValue('rev:1')
    await expect(page.getByTestId('conversation-role-lead')).toHaveAttribute('aria-selected', 'true')
    expect(await hashNow(page)).toBe(teamHash(root, deepLink))
    await page.screenshot({ path: info.outputPath('workspace-returned.png') })

    // 7. The legacy routes still parse: the Tasks tab opens by its URL.
    await setHash(page, teamHash(root, 'tasks'))
    await expect(page.getByTestId('team-tasks')).toBeVisible()

    // Back to the workspace by its URL for the pane controls.
    await setHash(page, teamHash(root, deepLink))
    await expect(page.getByTestId('plan-workspace-panes')).toBeVisible()
    await expect(page.getByTestId('plan-workspace-panes')).toHaveAttribute('data-layout', 'desktop')

    // 8. The divider is a keyboard control with a bounded, labelled value.
    const divider = page.getByTestId('workspace-panes-divider')
    await expect(divider).toHaveAttribute('aria-valuenow', '45')
    await divider.focus()
    await page.keyboard.press('ArrowRight')
    await expect(divider).toHaveAttribute('aria-valuenow', '48')
    await page.keyboard.press('End')
    await expect(divider).toHaveAttribute('aria-valuenow', '70')

    // 9. The conversation column hides and comes back.
    await page.getByTestId('workspace-conversation-toggle').click()
    await expect(page.getByTestId('workspace-pane-conversation')).toHaveCount(0)
    await page.getByTestId('workspace-conversation-toggle').click()
    await expect(page.getByTestId('workspace-pane-conversation')).toBeVisible()

    // 10. A narrow host: one pane behind the explicit navigation, focus
    // moves with the switch, and Back returns to the map.
    await page.setViewportSize({ width: 800, height: 900 })
    const panes = page.getByTestId('plan-workspace-panes')
    await expect(panes).toHaveAttribute('data-layout', 'narrow')
    await page.getByTestId('workspace-narrow-documents').click()
    await expect(page.getByTestId('workspace-pane-documents')).toBeVisible()
    await expect(page.getByTestId('workspace-pane-documents')).toBeFocused()
    await expect(page.getByTestId('workspace-narrow-status')).toContainText('Documents pane')
    await expect(page.getByTestId('workspace-pane-map')).toHaveCount(0)
    await page.getByTestId('workspace-narrow-back').click()
    await expect(page.getByTestId('workspace-pane-map')).toBeVisible()
    await expect(page.getByTestId('workspace-pane-documents')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('workspace-narrow.png') })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
