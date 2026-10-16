// Browser walkthrough of plan validation (plan-validation 12.2) against the
// SDK-free fixture and an isolated durable DB. The server's OpenSpec adapter
// spawns the stub CLI from the e2e stub-bin (playwright.config.ts), whose
// canned deltas this spec rewrites between steps; the plan and its revisions
// are seeded through the agent tool path like chat-plans.spec, and the rest
// runs through the UI:
// 1. a conflicting unordered pair validates as Blocked;
// 2. a resubmission with dependsOn, an answered mandatory question, and an
//    accepted overlap warning validate as Ready;
// 3. an artifact edit turns the standing Out of date, and approval is
//    refused naming that change's artifacts;
// 4. revalidation and approval commit.
// Desktop and mobile screenshots are captured. Local execution requires the
// fixture webServer (AGENTBOARD_CHAT_FIXTURE=1); CI runs it — never run
// test:e2e against a live kawai server.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

/** The canned deltas the stub CLI serves, one file per change: `<change>.json` holds its delta array. */
function serveDeltas(deltas: Record<string, Array<{ capability: string; operation: string; requirement: string }>>) {
  const dir = join(process.env.E2E_TMUX_TMPDIR!, 'openspec-deltas')
  mkdirSync(dir, { recursive: true })
  for (const [change, touches] of Object.entries(deltas)) {
    writeFileSync(
      join(dir, `${change}.json`),
      JSON.stringify(touches.map(touch => ({
        spec: touch.capability, operation: touch.operation,
        requirement: { name: touch.requirement }, description: `${change} ${touch.requirement}`,
      }))),
    )
  }
}

async function createChat(page: Page, root: string, name: string, group: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Project Path').fill(root)
  await dialog.getByLabel('Group').selectOption(group)
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
  return (await page.locator('[data-session-id^="chat-"]').filter({ hasText: name }).first().getAttribute('data-session-id'))!
}

/** Seed the plan, submit the conflicting revision, and ask the mandatory question — as the lead agent would. */
function seedPlanAsAgent(sessionId: string): string {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
  const script = `
    import { initDatabase } from './src/server/db';
    import { MailboxStore } from './src/server/team/mailboxStore';
    import { ImpactStore } from './src/server/strategy/impactStore';
    import { ImpactService } from './src/server/strategy/ImpactService';
    import { composePlanServices } from './src/server/plans/planComposition';
    import { planHandlers } from './src/server/plans/planTools';
    import { validationHandlers } from './src/server/plans/validation/validationTools';
    try {
      const [file, sessionId] = JSON.parse(await Bun.stdin.text());
      const sessions = initDatabase({ path: file });
      sessions.db.exec('PRAGMA busy_timeout = 5000');
      const plans = new (await import('./src/server/plans/planStore')).PlanStore(sessions.db);
      const strategies = new (await import('./src/server/strategy/strategyStore')).StrategyStore(sessions.db);
      const impact = new ImpactService(new ImpactStore(sessions.db), {
        strategies, plans, mail: new MailboxStore(sessions.db), getSession: id => sessions.getChatSession(id), homeDir: process.env.HOME,
      });
      const composed = composePlanServices({
        db: sessions.db, plans, strategies, impact, getSession: id => sessions.getChatSession(id), homeDir: process.env.HOME,
      });
      const tools = planHandlers(composed.plans, sessionId);
      const validation = validationHandlers(composed.validation, sessionId);
      const content = ordered => ({
        goal: 'Ship the walkthrough', successCriteria: ['The walkthrough passes'], approach: 'Through the UI',
        changes: [
          { change: 'conflict-a', dependsOn: [], group: 'devs', acceptance: [], extraChecks: [], guidance: '' },
          { change: 'conflict-b', dependsOn: ordered ? ['conflict-a'] : [], group: 'devs', acceptance: [], extraChecks: [], guidance: '' },
          // Never ordered: the mail overlap warning stays whatever the resubmission does.
          { change: 'overlap-c', dependsOn: [], group: 'devs', acceptance: [], extraChecks: [], guidance: '' },
        ],
        roles: [{ group: 'devs', profiles: [] }, { group: 'reviewers', profiles: [] }], reviewGroup: 'reviewers',
      });
      const created = await tools.plan_create({ title: 'Validated wave', content: content(false) });
      const planId = created.plan.id;
      const submitted = await tools.plan_submit_for_review({ plan_id: planId });
      if (submitted.ok === false) throw new Error('submit: ' + JSON.stringify(submitted));
      const asked = await validation.plan_assess({ plan_id: planId, revision: submitted.revision.revision,
        questions: [{ text: 'Which migration strategy for the schema?', mandatory: true, subject: 'conflict-a' }] });
      if (asked.ok === false) throw new Error('assess: ' + JSON.stringify(asked));
      sessions.close();
      console.log('PLANID:' + planId);
    } catch (error) {
      console.error('SEED-FAILED:', error instanceof Error ? error.stack : String(error));
      process.exit(1);
    }
  `
  try {
    const stdout = execFileSync('bun', ['-e', script], { cwd: process.cwd(), input: JSON.stringify([dbPath, sessionId]), encoding: 'utf8' })
    return /PLANID:(plan-\S+)/.exec(stdout)![1]!
  } catch (error) {
    const detail = error as { stderr?: string | Buffer, message?: string }
    throw new Error(`seed failed: ${detail.message ?? ''} stderr=${String(detail.stderr ?? '')}`)
  }
}

/** Submit the next revision with the dependsOn edge, as the agent would after the conflict. */
function resubmitOrdered(sessionId: string, planId: string) {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  const script = `
    import { initDatabase } from './src/server/db';
    import { MailboxStore } from './src/server/team/mailboxStore';
    import { ImpactStore } from './src/server/strategy/impactStore';
    import { ImpactService } from './src/server/strategy/ImpactService';
    import { composePlanServices } from './src/server/plans/planComposition';
    import { planHandlers } from './src/server/plans/planTools';
    import { validationHandlers } from './src/server/plans/validation/validationTools';
    try {
      const [file, sessionId, planId] = JSON.parse(await Bun.stdin.text());
      const sessions = initDatabase({ path: file });
      sessions.db.exec('PRAGMA busy_timeout = 5000');
      const plans = new (await import('./src/server/plans/planStore')).PlanStore(sessions.db);
      const strategies = new (await import('./src/server/strategy/strategyStore')).StrategyStore(sessions.db);
      const impact = new ImpactService(new ImpactStore(sessions.db), {
        strategies, plans, mail: new MailboxStore(sessions.db), getSession: id => sessions.getChatSession(id), homeDir: process.env.HOME,
      });
      const composed = composePlanServices({
        db: sessions.db, plans, strategies, impact, getSession: id => sessions.getChatSession(id), homeDir: process.env.HOME,
      });
      const tools = planHandlers(composed.plans, sessionId);
      const validation = validationHandlers(composed.validation, sessionId);
      const stored = await tools.plan_get({ plan_id: planId });
      const draft = stored.drafts?.find(entry => entry.draftId === sessionId) ?? null;
      if (!draft) throw new Error('no draft for ' + sessionId);
      const content = draft.content;
      content.changes = content.changes.map(change => change.change === 'conflict-b' ? { ...change, dependsOn: ['conflict-a'] } : change);
      await tools.plan_save_draft({ plan_id: planId, content, expected_draft_hash: draft.contentHash });
      const submitted = await tools.plan_submit_for_review({ plan_id: planId });
      if (submitted.ok === false) throw new Error('resubmit: ' + JSON.stringify(submitted));
      // The question still stands on the resubmitted revision (records bind
      // per revision); the agent asks it again.
      const asked = await validation.plan_assess({ plan_id: planId, revision: submitted.revision.revision,
        questions: [{ text: 'Which migration strategy for the schema?', mandatory: true, subject: 'conflict-a' }] });
      if (asked.ok === false) throw new Error('assess: ' + JSON.stringify(asked));
      sessions.close();
    } catch (error) {
      console.error('RESUBMIT-FAILED:', error instanceof Error ? error.stack : String(error));
      process.exit(1);
    }
  `
  try {
    execFileSync('bun', ['-e', script], { cwd: process.cwd(), input: JSON.stringify([dbPath, sessionId, planId]), encoding: 'utf8' })
  } catch (error) {
    const detail = error as { stderr?: string | Buffer, message?: string }
    throw new Error(`resubmit failed: ${detail.message ?? ''} stderr=${String(detail.stderr ?? '')}`)
  }
}

async function openPlan(page: Page, root: string) {
  await page.evaluate(teamKey => { window.location.hash = `#/team/${encodeURIComponent(teamKey)}/plans` }, root)
  await expect(page.getByTestId('team-workspace')).toBeVisible()
  const panel = page.getByTestId('team-plans')
  await panel.getByTestId('plan-list').getByRole('button', { name: /Validated wave/ }).click()
  await expect(panel.getByRole('heading', { name: 'Validated wave' })).toBeFocused()
  return panel
}

test('blocked by a conflict, ordered and answered to Ready, stale after an edit, then approved', async ({ page }, info) => {
  const root = mkdtempSync(join(tmpdir(), 'kawai-plan-validation-e2e-'))
  try {
    // A git repository with two registered changes, the team's groups, and
    // the stub deltas: an unordered pair sharing chat/Presence (a conflict)
    // and overlapping on mail with different requirements.
    execFileSync('git', ['init', '-q', root])
    for (const change of ['conflict-a', 'conflict-b', 'overlap-c']) {
      mkdirSync(join(root, 'openspec', 'changes', change, 'specs', 'chat'), { recursive: true })
      writeFileSync(join(root, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
      writeFileSync(join(root, 'openspec', 'changes', change, 'specs', 'chat', 'spec.md'), '## MODIFIED Requirements\n### Requirement: Presence\n')
    }
    mkdirSync(join(root, '.kawai', 'groups'), { recursive: true })
    writeFileSync(join(root, '.kawai', 'groups', 'leads.md'), '---\nlabel: Leads\ncanCreatePlans: true\n---\nPlan the work')
    writeFileSync(join(root, '.kawai', 'groups', 'devs.md'), '---\nlabel: Developers\n---\nBuild features')
    writeFileSync(join(root, '.kawai', 'groups', 'reviewers.md'), '---\nlabel: Reviewers\n---\nReview')
    serveDeltas({
      'conflict-a': [
        { capability: 'chat', operation: 'MODIFIED', requirement: 'Presence' },
        { capability: 'mail', operation: 'MODIFIED', requirement: 'Inbox' },
      ],
      'conflict-b': [
        { capability: 'chat', operation: 'MODIFIED', requirement: 'Presence' },
      ],
      'overlap-c': [
        { capability: 'mail', operation: 'MODIFIED', requirement: 'Drafts' },
      ],
    })

    await page.goto('/')
    const lead = await createChat(page, root, 'Validation lead', 'leads')
    const planId = seedPlanAsAgent(lead)
    const panel = await openPlan(page, root)

    // 1. The conflicting unordered pair: Blocked.
    await panel.getByTestId('plan-validate-1').click()
    await expect(panel.getByTestId('plan-validation-1-standing')).toContainText('Blocked')
    await expect(panel.getByTestId('plan-validation-1-standing')).toContainText('unanswered question')
    await expect(panel.getByTestId('plan-validation-1-finding-relations:conflict:conflict-a+conflict-b:chat/Presence')).toContainText('conflict-a and conflict-b')
    await page.screenshot({ path: info.outputPath('validation-blocked.png') })

    // The approve dialog carries the standing and refuses inline.
    await panel.getByTestId('plan-approve-1').click()
    await panel.getByTestId('plan-approve-1-confirm').click()
    await expect(panel.getByTestId('plan-approve-refused-1')).toContainText('not ready')
    await page.screenshot({ path: info.outputPath('validation-refused-approval.png'), fullPage: true })

    // 2. Resubmit with the dependsOn edge, answer the mandatory question,
    //    and accept the overlap warning: Ready.
    resubmitOrdered(lead, planId)
    await page.reload()
    const fresh = await openPlan(page, root)
    await fresh.getByTestId('plan-validate-2').click()
    await expect(fresh.getByTestId('plan-validation-2-standing')).toContainText('Blocked')
    await fresh.locator('[data-testid^="plan-answer-2-pas-"]').first().click()
    await fresh.locator('[data-testid^="plan-answer-2-pas-"][data-testid$="-dialog"]').first().locator('textarea').fill('The documented strategy: expand and migrate.')
    await fresh.locator('[data-testid^="plan-answer-2-pas-"][data-testid$="-confirm"]').first().click()
    await expect(fresh.getByTestId('plan-validation-2-standing')).toContainText('Out of date')
    await fresh.getByTestId('plan-accept-2-relations:overlap:conflict-a+overlap-c:mail').click()
    await fresh.getByTestId('plan-accept-2-relations:overlap:conflict-a+overlap-c:mail-dialog').locator('textarea').fill('The mail changes stay independent.')
    await fresh.getByTestId('plan-accept-2-relations:overlap:conflict-a+overlap-c:mail-confirm').click()
    await fresh.getByTestId('plan-validate-2').click()
    await expect(fresh.getByTestId('plan-validation-2-standing')).toContainText('Ready')
    await page.screenshot({ path: info.outputPath('validation-ready.png'), fullPage: true })

    // 3. An artifact edit: Out of date, and approval refuses naming it.
    appendFileSync(join(root, 'openspec', 'changes', 'conflict-a', 'proposal.md'), 'The scope grew.\n')
    await fresh.getByTestId('plan-approve-2').click()
    await fresh.getByTestId('plan-approve-2-confirm').click()
    await expect(fresh.getByTestId('plan-approve-refused-2')).toContainText("conflict-a's artifacts")
    await page.screenshot({ path: info.outputPath('validation-stale-approval.png'), fullPage: true })

    // 4. Validate again from the refusal, close the refused dialog, approve.
    await fresh.getByTestId('plan-approve-refused-2-validate').click()
    await expect(fresh.getByTestId('plan-validation-2-standing')).toContainText('Ready')
    await fresh.getByTestId('plan-approve-2-dialog').getByRole('button', { name: 'Cancel' }).click()
    await fresh.getByTestId('plan-approve-2').click()
    await fresh.getByTestId('plan-approve-2-confirm').click()
    await expect(fresh.getByTestId('plan-detail-state')).toContainText('approved revision 2')

    // A mobile screenshot of the validated plan.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    const mobile = await openPlan(page, root)
    await mobile.getByTestId('plan-validate-2').click()
    await expect(mobile.getByTestId('plan-validation-2-standing')).toContainText('Ready')
    await page.screenshot({ path: info.outputPath('validation-mobile.png'), fullPage: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
