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
// 6. a second plan never sees the first's expansion; returning restores it
//    (retained state isolates by plan);
// 7. the legacy routes still parse; the divider resizes by keyboard; the
//    conversation column hides; the narrow navigation shows one pane, moves
//    focus with the switch, and Back returns to the map.
// 8. the panes are the real scroll owners: each bounded pane overflows on
//    long content, the wheel moves the pane (never only the plans column),
//    and a scrolled position survives a narrow switch, the desktop expand
//    and restore, and the full-screen chat return;
// 9. an in-place plan switch (the list never shows) reads each plan's own
//    map record and document state, and plan A's come back on return;
// 10. an in-place team switch over two retained plans keeps the panes
//     mounted (the tagged element survives) and restores each team's own
//     position and document state, and the conversation pane never scrolls
//     itself — the bound chat's transcript is the scroller, with the
//     composer reachable.
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
  // The fixture gate is NODE_ENV=development plus AGENTBOARD_CHAT_FIXTURE=1
  // (mirroring the CI fixture step); with it satisfied, creation is
  // deterministic and needs only the default expectation.
  await expect(page.getByTestId('chat-view')).toContainText(name)
  return (await page.locator('[data-session-id^="chat-"]').filter({ hasText: name }).first().getAttribute('data-session-id'))!
}

/** Create a plan with two in-review revisions, as the lead agent would.
 * Twelve changes make the workspace map long enough to overflow its pane. */
function seedPlanAsAgent(sessionId: string, title = 'Navigation Wave'): string {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
  const stdout = execFileSync('bun', ['-e', `
    import { initDatabase } from './src/server/db';
    import { PlanStore } from './src/server/plans/planStore';
    import { PlanService } from './src/server/plans/PlanService';
    import { planHandlers } from './src/server/plans/planTools';
    import { StrategyStore } from './src/server/strategy/strategyStore';
    import { retryOnSqliteBusy } from './src/server/__tests__/sqliteBusyRetry';
    const [file, sessionId, title] = JSON.parse(await Bun.stdin.text());
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
        ...Array.from({ length: 10 }, (_, i) => ({ change: 'plan-fill-' + (i + 1), group: 'devs', acceptance: ['Fills the map'] })),
      ],
      roles: [{ group: 'devs', profiles: [] }], reviewGroup: 'devs',
    });
    const planId = (await retryOnSqliteBusy(() => tools.plan_create({ title }))).plan.id;
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
    console.log('PLAN:' + planId);
  `], { cwd: process.cwd(), input: JSON.stringify([dbPath, sessionId, title]), encoding: 'utf8' })
  // The seed's initDatabase start logs its backup line to stdout too; the
  // marked line is the only trustworthy carrier of the id.
  const line = stdout.split('\n').find(entry => entry.startsWith('PLAN:'))
  if (!line) throw new Error(`seedPlanAsAgent printed no plan id: ${stdout.slice(0, 400)}`)
  return line.slice('PLAN:'.length)
}

const teamHash = (root: string, rest: string): string => `#/team/${encodeURIComponent(root)}/${rest}`
const setHash = (page: Page, hash: string) => page.evaluate(value => { window.location.hash = value }, hash)
const hashNow = (page: Page) => page.evaluate(() => window.location.hash)

/** The seeded proposal is long enough to overflow the documents pane's reader. */
const LONG_PROPOSAL = '# plan-api\n\n' + Array.from({ length: 120 }, (_, i) =>
  `Line ${i + 1}: seeded reader content, long enough to overflow a bounded pane.`).join('\n') + '\n'

/** A pane body's scroll facts, read from the live element. */
const scrollState = (locator: ReturnType<Page['getByTestId']>) =>
  locator.evaluate((el: HTMLElement) => ({ top: el.scrollTop, client: el.clientHeight, scroll: el.scrollHeight }))

/** A pane's scrollTop, in a pollable shape. */
const topOf = (locator: ReturnType<Page['getByTestId']>) => async () => (await scrollState(locator)).top

/** Wheel over the pane itself: the browser offers the event to the topmost
 * scrollable element under the pointer, so a bounded pane scrolls and an
 * unbounded one lets the plans column take it — the assertion decides. The
 * input pipeline applies the scroll asynchronously (hit-test, then the
 * compositor, over several frames), so the pane's response is polled, never
 * assumed instant — and the poll waits for the position to settle before
 * returning: a later step may switch identities and restore an absolute
 * position, and an in-flight wheel scroll would override that restore. */
async function wheelPane(page: Page, locator: ReturnType<Page['getByTestId']>, deltaY: number) {
  await locator.scrollIntoViewIfNeeded()
  await locator.hover()
  await page.mouse.wheel(0, deltaY)
  const read = async () => (await scrollState(locator)).top
  await expect.poll(read, 'the wheel must scroll the pane itself').toBeGreaterThan(0)
  let previous = -1
  await expect.poll(async () => {
    const current = await read()
    const settled = current === previous
    previous = current
    return settled
  }, 'the wheel scroll must settle before the next step reads or restores').toBe(true)
}

/** Mark the map pane's element so a later read proves it stayed mounted. */
const tagMapPane = (page: Page) => page.evaluate(() => {
  const el = document.querySelector('[data-testid="workspace-pane-map"]')
  if (el !== null) el.setAttribute('data-probe', 'mounted')
  return el !== null
})
const mapPaneProbe = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-testid="workspace-pane-map"]')?.getAttribute('data-probe') ?? null)

test('deep links, reload, Back/Forward, the full-screen return, and the pane controls', async ({ page }, info) => {
  // The scroll-owner and in-place identity steps add seeded second-team and
  // conversation work to the navigation walkthrough; every scroll position is
  // asserted through a real wheel-and-poll, which is intentionally patient on
  // a shared runner.
  test.setTimeout(420_000)
  const root = mkdtempSync(join(tmpdir(), 'kawai-pw-nav-'))
  const groups = {
    leads: '---\nlabel: Leads\ncanCreatePlans: true\n---\nPlan the work',
    devs: '---\nlabel: Developers\n---\nBuild features',
  }
  initPlanRepository(root, ['plan-api'], groups, {
    'openspec/changes/plan-api/proposal.md': LONG_PROPOSAL,
  })
  const root2 = mkdtempSync(join(tmpdir(), 'kawai-pw-nav2-'))
  initPlanRepository(root2, ['plan-api'], groups)
  try {
    await page.goto('/')
    const lead = await createChat(page, root, 'Plan lead', 'leads')
    seedPlanAsAgent(lead)
    // The twin exists before the list is ever subscribed: a direct database
    // write does not re-push the plans snapshot, so seeding it mid-visit
    // would never reach the open list.
    const twinPlanId = seedPlanAsAgent(lead, 'Retention Twin')
    // The second team: a chat on another repository discovers it, and its
    // plan is seeded before that team's list is ever subscribed.
    const lead2 = await createChat(page, root2, 'Team two lead', 'leads')
    const team2PlanId = seedPlanAsAgent(lead2, 'Team Two Plan')
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

    // 7. Retained state isolates by plan: expand A's checklist, visit the
    // second plan (whose own rows start collapsed), and return to A — its
    // expansion is still shown.
    await page.getByTestId('wbs-expand-plan-api').click()
    await expect(page.getByTestId('wbs-expand-plan-api')).toHaveAttribute('aria-expanded', 'true')
    await setHash(page, teamHash(root, plansBase))
    await expect(page.getByTestId('plan-list')).toBeVisible()
    await page.getByTestId('plan-list').getByRole('button', { name: /Retention Twin/ }).click()
    await expect(page.getByTestId('plan-workspace')).toBeVisible()
    await expect(page.getByTestId('wbs-row-plan-api')).toBeVisible()
    await expect(page.getByTestId('wbs-expand-plan-api')).toHaveAttribute('aria-expanded', 'false')
    await setHash(page, teamHash(root, plansBase))
    await expect(page.getByTestId('plan-list')).toBeVisible()
    await page.getByTestId('plan-list').getByRole('button', { name: /Navigation Wave/ }).click()
    await expect(page.getByTestId('plan-workspace')).toBeVisible()
    await expect(page.getByTestId('wbs-row-plan-api')).toBeVisible()
    await expect(page.getByTestId('wbs-expand-plan-api')).toHaveAttribute('aria-expanded', 'true')
    await page.screenshot({ path: info.outputPath('workspace-retention.png') })

    // 8. The legacy routes still parse: the Tasks tab opens by its URL.
    await setHash(page, teamHash(root, 'tasks'))
    await expect(page.getByTestId('team-tasks')).toBeVisible()

    // Back to the workspace by its URL for the pane controls.
    await setHash(page, teamHash(root, deepLink))
    await expect(page.getByTestId('plan-workspace-panes')).toBeVisible()
    await expect(page.getByTestId('plan-workspace-panes')).toHaveAttribute('data-layout', 'desktop')

    // 9. The divider is a keyboard control with a bounded, labelled value.
    const divider = page.getByTestId('workspace-panes-divider')
    await expect(divider).toHaveAttribute('aria-valuenow', '45')
    await divider.focus()
    await page.keyboard.press('ArrowRight')
    await expect(divider).toHaveAttribute('aria-valuenow', '48')
    await page.keyboard.press('End')
    await expect(divider).toHaveAttribute('aria-valuenow', '70')

    // 10. The conversation column hides and comes back.
    await page.getByTestId('workspace-conversation-toggle').click()
    await expect(page.getByTestId('workspace-pane-conversation')).toHaveCount(0)
    await page.getByTestId('workspace-conversation-toggle').click()
    await expect(page.getByTestId('workspace-pane-conversation')).toBeVisible()

    // 12. The map pane is a real bounded scroll owner: the seeded map
    // overflows it, and the wheel moves the pane — not only the plans
    // column — leaving a position that sticks.
    const mapPane = page.getByTestId('workspace-pane-map')
    await expect(mapPane).toBeVisible()
    const mapMetrics = await scrollState(mapPane)
    expect(mapMetrics.scroll, 'the seeded map must overflow its bounded pane').toBeGreaterThan(mapMetrics.client)
    await wheelPane(page, mapPane, 220)
    const mapTop = (await scrollState(mapPane)).top
    await page.waitForTimeout(150)
    expect((await scrollState(mapPane)).top, 'the pane position must stick').toBeCloseTo(mapTop, 6)

    // 13. The desktop expand and restore keeps the map's position.
    const expand = page.getByTestId('workspace-expand-documents')
    await expand.scrollIntoViewIfNeeded()
    await expand.click()
    await expect(page.getByTestId('workspace-pane-map')).toHaveCount(0)
    await expand.click()
    await expect(mapPane).toBeVisible()
    await expect.poll(topOf(mapPane)).toBeCloseTo(mapTop, 6)

    // 14. The full-screen chat return keeps the map's position too.
    await page.locator(`[data-session-id="${lead}"]`).first().click()
    await expect(page.getByTestId('chat-view')).toBeVisible()
    await page.getByTestId('chat-team-button').click()
    await expect(mapPane).toBeVisible()
    await expect.poll(topOf(mapPane)).toBeCloseTo(mapTop, 6)

    // 15. Select plan-api and open its long proposal, so the documents pane
    // has reader content for the identity steps below. The first enumeration
    // in a fresh server spawns the OpenSpec CLI probe and listing, which a
    // busy runner can stretch past the default wait.
    await page.getByTestId('wbs-select-plan-api').scrollIntoViewIfNeeded()
    await page.getByTestId('wbs-select-plan-api').click()
    const proposal = page.getByTestId('plan-workspace-artifact-proposal')
    await expect(proposal).toBeVisible({ timeout: 20_000 })
    await proposal.scrollIntoViewIfNeeded()
    await proposal.click()
    await expect(page.getByTestId('reader-document-body')).toBeVisible()

    // 16. An in-place plan switch — the list never shows — and each plan
    // reads its own record: the twin's map is its own (empty), and plan A's
    // position and document come back. The plan switch trades the pane for
    // the loading branch by design (a foreign detail must not flash), so
    // mount-restore carries these; the team switch below is where the panes
    // stay mounted and the identity restore is the thing on trial.
    await wheelPane(page, mapPane, 160)
    const planATop = (await scrollState(mapPane)).top
    await setHash(page, teamHash(root, `plans/${twinPlanId}`))
    await expect(page.getByTestId('plan-workspace')).toBeVisible()
    await expect.poll(topOf(mapPane), 'the twin map reads its own (never-scrolled) record').toBe(0)
    await expect(page.getByTestId('reader-document-body')).toHaveCount(0)
    await wheelPane(page, mapPane, 120)
    await setHash(page, teamHash(root, `plans/${planId}`))
    await expect(page.getByTestId('plan-workspace')).toBeVisible()
    await expect.poll(topOf(mapPane)).toBeCloseTo(planATop, 6)
    await expect(page.getByTestId('reader-document-body')).toBeVisible()

    // 17. The conversation pane never scrolls itself: the bound chat's
    // transcript is the scroller, and the composer stays reachable. The
    // picker's options are valued by session id and labelled "name — id",
    // so the test's own chat is picked by value; the active role here is
    // the Lead (r=lead since step 2), so its binding line is the one that
    // appears.
    await page.getByTestId('conversation-bind-picker').selectOption(lead)
    await expect(page.getByTestId('conversation-binding-lead')).toBeVisible()
    const conversationPane = page.getByTestId('workspace-pane-conversation')
    const composer = conversationPane.getByLabel('Message Claude')
    for (let i = 0; i < 12; i++) {
      await composer.fill(`Sizing message ${i + 1}`)
      await composer.press('Enter')
    }
    await expect(conversationPane.getByText('Sizing message 12')).toBeVisible()
    await expect(conversationPane.getByText('Fixture response').first()).toBeVisible()
    const conversationMetrics = await scrollState(conversationPane)
    expect(conversationMetrics.scroll, 'the conversation pane must not scroll itself — chat owns the transcript').toBe(conversationMetrics.client)
    const transcriptBox = conversationPane.locator('div.overflow-y-auto.p-4').first()
    // The transcript's tail-follow runs on the browser side, so the position
    // is polled too.
    await expect.poll(topOf(transcriptBox), 'the transcript sits scrolled into the live tail').toBeGreaterThan(0)
    const transcriptMetrics = await scrollState(transcriptBox)
    expect(transcriptMetrics.scroll, 'the long transcript must overflow the chat transcript scroller').toBeGreaterThan(transcriptMetrics.client)
    const composerBox = await composer.boundingBox()
    expect(composerBox, 'the composer renders inside the pane').not.toBeNull()
    // The pane must not clip the composer: it lies fully within the pane's
    // own box — the bounded body passes its whole height down.
    const paneBox = await conversationPane.boundingBox()
    expect(composerBox!.y).toBeGreaterThanOrEqual(paneBox!.y)
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(paneBox!.y + paneBox!.height)
    // And it is reachable: the scroll a user would make leaves it wholly on
    // screen (fill only guarantees the top edge enters the viewport).
    await composer.scrollIntoViewIfNeeded()
    const scrolledComposer = await composer.boundingBox()
    expect(scrolledComposer!.y).toBeGreaterThanOrEqual(0)
    expect(scrolledComposer!.y + scrolledComposer!.height).toBeLessThanOrEqual(720)

    // 18. An in-place team switch over two retained plans: both teams'
    // details are already held, so the plans view never trades the section
    // for its loading branch — the tagged element survives the switch, and
    // the identity restore (not a remount) is what applies each team's own
    // map record and document state.
    await setHash(page, teamHash(root2, `plans/${team2PlanId}`))
    await expect(page.getByTestId('plan-workspace')).toBeVisible()
    await expect(page.getByTestId('plan-workspace-loading')).toHaveCount(0)
    await setHash(page, teamHash(root, `plans/${planId}`))
    await expect(mapPane).toBeVisible()
    await wheelPane(page, mapPane, 140)
    const team1Top = (await scrollState(mapPane)).top
    expect(await tagMapPane(page)).toBe(true)
    await setHash(page, teamHash(root2, `plans/${team2PlanId}`))
    await expect(page.getByTestId('plan-workspace')).toBeVisible()
    expect(await mapPaneProbe(page), 'the panes stayed mounted across the in-place team switch').toBe('mounted')
    await expect.poll(topOf(mapPane), "team two's map reads its own (never-scrolled) record").toBe(0)
    await wheelPane(page, mapPane, 130)
    await setHash(page, teamHash(root, `plans/${planId}`))
    await expect(mapPane).toBeVisible()
    expect(await mapPaneProbe(page)).toBe('mounted')
    await expect.poll(topOf(mapPane)).toBeCloseTo(team1Top, 6)
    await expect(page.getByTestId('reader-document-body')).toBeVisible()

    // 11. A narrow host: one pane behind the explicit navigation, focus
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
    // The narrow panes are real scrollers with remembered positions: the
    // map's and the documents' records never cross.
    await wheelPane(page, page.getByTestId('workspace-pane-map'), 200)
    const narrowMapTop = (await scrollState(page.getByTestId('workspace-pane-map'))).top
    await page.getByTestId('workspace-narrow-documents').click()
    const documentsPane = page.getByTestId('workspace-pane-documents')
    await expect(documentsPane).toBeVisible()
    const documentsMetrics = await scrollState(documentsPane)
    expect(documentsMetrics.scroll, 'the open long proposal overflows the documents pane').toBeGreaterThan(documentsMetrics.client)
    await wheelPane(page, documentsPane, 120)
    const narrowDocumentsTop = (await scrollState(documentsPane)).top
    await page.getByTestId('workspace-narrow-back').click()
    await expect(page.getByTestId('workspace-pane-map')).toBeVisible()
    await expect.poll(topOf(page.getByTestId('workspace-pane-map')), 'the map position survives the narrow switch').toBeCloseTo(narrowMapTop, 6)
    await page.getByTestId('workspace-narrow-documents').click()
    await expect(documentsPane).toBeVisible()
    await expect.poll(topOf(documentsPane), 'the documents position survives the switch too').toBeCloseTo(narrowDocumentsTop, 6)
    await page.screenshot({ path: info.outputPath('workspace-narrow.png') })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(root2, { recursive: true, force: true })
  }
})
