// Browser walkthrough of integration landing and promotion
// (integration-candidates 8.3, L2) against the SDK-free fixture and an
// isolated durable DB. The plan alone is seeded through the stores, with
// `integration-branch` landing; the walkthrough clicks Start, the composed
// executor creates the integration branch on the fixture's bare origin, and
// the change's round lands on it as a candidate through the fixture ref
// adapters (real git, GitHub's ref rules, never forced). The integration
// panel then lists the candidate, Promote's dialog pins the branch head, and
// the promotion runs — branch, pull request on the fixture registry, CI,
// a real merge commit onto master — until its row reads merged and the
// candidate is marked promoted. The implementer's result and the reviewer's
// findings arrive through the agent tool path against the same database.
// Local execution requires the fixture webServer
// (AGENTBOARD_CHAT_FIXTURE=1); CI runs it — never run test:e2e against a
// live kawai server.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initPlanRepository, validateUntilReady } from './fixtures/planWalkthrough'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

const GITHUB_URL = 'https://github.com/acme/integration-walk.git'
const CHANGE = 'int-api'
const BRANCH = 'wave/int-walk'

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
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

/** A bare origin behind a GitHub-shaped remote, so the fixture probe reads a base. */
function initOrigin(root: string, origin: string): void {
  git(['init', '-q', '--bare', '-b', 'master', origin])
  git(['add', '-A'], root)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'base'], root)
  git(['remote', 'add', 'origin', origin], root)
  git(['push', '-q', 'origin', 'master'], root)
  git(['remote', 'set-url', 'origin', GITHUB_URL], root)
  git(['config', `url.${origin}.insteadOf`, GITHUB_URL], root)
}

/** A ref of the bare origin, '' when absent. */
function originRef(origin: string, branch: string): string {
  try { return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], origin).trim() } catch { return '' }
}

/** Seed the approved integration-branch plan (and only the plan) through the stores, as the human. */
function seedPlan(root: string): void {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
  execFileSync('bun', ['-e', `
    import { initDatabase } from './src/server/db';
    import { PlanStore } from './src/server/plans/planStore';
    import { resolveTeam } from './src/server/team/teamIdentity';
    import { normalizePlanContent } from './src/shared/plans';
    const sessions = initDatabase({ path: ${JSON.stringify(dbPath)} });
    sessions.db.exec('PRAGMA busy_timeout = 5000');
    const plans = new PlanStore(sessions.db);
    const teamId = (await resolveTeam(${JSON.stringify(root)})).teamId;
    const planId = plans.insertPlan({ teamId, title: 'Integration walkthrough', creator: { kind: 'human', sessionId: null } });
    const content = normalizePlanContent({
      goal: 'Land on the integration branch, then promote', successCriteria: ['The change reaches master through a promotion'],
      changes: [{ change: ${JSON.stringify(CHANGE)}, dependsOn: [], group: 'devs', acceptance: [], extraChecks: [], guidance: '' }],
      roles: [{ group: 'devs', profiles: [] }, { group: 'reviewers', profiles: [] }], reviewGroup: 'reviewers',
      landing: { mode: 'integration-branch', branch: ${JSON.stringify(BRANCH)} },
    });
    const revision = plans.atomically(() => plans.insertRevision(planId, { content, contentHash: 'int-walk-hash-1', pin: null, author: { kind: 'human', sessionId: null } }));
    plans.setRevisionStatus(planId, revision, 'approved');
    plans.setCurrentApproved(planId, revision);
    sessions.close();
  `], { cwd: process.cwd(), encoding: 'utf8' })
}

/** The implementer's result, then the review claimant's passing findings — the agent tool path. */
function submitRound(root: string, mode: 'result' | 'findings', implementer: string): string {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
  const script = `
    import { join } from 'node:path';
    import { initDatabase } from './src/server/db';
    import { MailboxStore } from './src/server/team/mailboxStore';
    import { AssignmentStore } from './src/server/team/assignmentStore';
    import { TaskStore } from './src/server/team/taskStore';
    import { TaskService } from './src/server/team/TaskService';
    import { TaskResultService } from './src/server/team/TaskResultService';
    import { taskHandlers } from './src/server/team/taskTools';
    import { composeExecutionCore } from './src/server/plans/planComposition';
    import { retryOnSqliteBusy } from './src/server/__tests__/sqliteBusyRetry';
    try {
      const [file, root, mode, implementer, change] = JSON.parse(await Bun.stdin.text());
      const sessions = initDatabase({ path: file });
      sessions.db.exec('PRAGMA busy_timeout = 5000');
      const db = sessions.db;
      const core = composeExecutionCore(db);
      const mail = new MailboxStore(db);
      const taskStore = new TaskStore(db, mail, new AssignmentStore(db, mail));
      const tasks = new TaskService(taskStore, {
        getSession: id => sessions.getChatSession(id), homeDir: process.env.HOME,
        restoreSession: () => undefined, ownership: core.ownership,
      });
      const results = new TaskResultService(tasks, {
        getSession: id => sessions.getChatSession(id), ownership: core.ownership, records: () => [],
      });
      const row = db.prepare('SELECT task_id FROM plan_execution_changes WHERE change = ? AND task_id IS NOT NULL ORDER BY rowid DESC').get(change);
      if (!row) throw new Error('no owned task yet');
      const taskId = row.task_id;
      if (mode === 'result') {
        const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: join(root, '.worktrees', change) }).stdout.toString().trim();
        // The server is a second writer on this database: a BUSY on the
        // result INSERT rolls its transaction back whole, so re-run the
        // submission (planWalkthrough's submitRound, #236). The findings
        // path stays unwrapped: it autocommits three statements.
        await retryOnSqliteBusy(() => taskHandlers(tasks, implementer, results).task_submit_result({ task_id: taskId, summary: 'Implemented ' + change, commit, tests: [{ description: 'unit', outcome: 'pass' }] }));
        console.log('RESULT:' + commit);
      } else {
        let claimant = null;
        for (let attempt = 0; attempt < 60 && claimant === null; attempt++) {
          const row = db.prepare("SELECT claimed_by FROM team_task_assignments WHERE task_id = ? AND handoff_kind = 'review' AND superseded_by IS NULL AND claimed_by IS NOT NULL ORDER BY rowid DESC").get(taskId);
          claimant = row?.claimed_by ?? null;
          if (claimant === null) await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (claimant === null) {
          // Self-diagnosing: a CI timeout names its cause. A stopped change
          // dispatches no review; a dispatched one names its mail state.
          const stopped = db.prepare('SELECT state, step, stop_reason, stop_detail_json FROM plan_execution_changes WHERE change = ? AND task_id = ? ORDER BY rowid DESC').get(change, taskId) ?? {};
          const handoff = db.prepare("SELECT m.state AS mail_state, m.reason AS mail_reason FROM team_task_assignments a LEFT JOIN team_messages m ON m.id = a.message_id WHERE a.task_id = ? AND a.handoff_kind = 'review' AND a.superseded_by IS NULL ORDER BY a.rowid DESC").get(taskId) ?? null;
          const stage = stopped.state === 'stopped'
            ? 'the change stopped (' + (stopped.stop_reason ?? 'unknown') + (stopped.stop_detail_json ? ' — ' + stopped.stop_detail_json : '') + ')'
            : 'the change is ' + (stopped.state ?? 'unknown') + (stopped.step ? ' at step ' + stopped.step : '');
          const dispatch = handoff
            ? 'the review was dispatched, its mail ' + (handoff.mail_state ?? 'unknown') + (handoff.mail_reason ? ' (' + handoff.mail_reason + ')' : '')
            : 'the review was never dispatched';
          throw new Error('the review handoff was never claimed in 60s: ' + stage + '; ' + dispatch);
        }
        const result = db.prepare('SELECT id FROM team_task_results WHERE task_id = ? ORDER BY rowid DESC').get(taskId);
        if (!result) throw new Error('no result yet');
        await taskHandlers(tasks, claimant, results).task_submit_findings({ task_id: taskId, result_id: result.id, kind: 'review', verdict: 'pass', findings: 'Clean.' });
        console.log('FINDINGS:ok:' + claimant);
      }
      sessions.close();
    } catch (error) {
      console.error('ROUND-FAILED:', error instanceof Error ? error.stack : String(error));
      process.exit(1);
    }
  `
  return execFileSync('bun', ['-e', script], {
    cwd: process.cwd(), input: JSON.stringify([dbPath, root, mode, implementer, CHANGE]), encoding: 'utf8',
  }).trim()
}

test('a change lands on the integration branch and Promote merges it into master', async ({ page }, info) => {
  test.setTimeout(150_000)
  const root = mkdtempSync(join(tmpdir(), 'kawai-integration-run-'))
  const origin = `${root}-origin.git`
  initPlanRepository(root, [CHANGE], {
    devs: '---\nlabel: Developers\nmax: 2\napproval: auto\n---\nBuild features',
    reviewers: '---\nlabel: Reviewers\nmax: 2\n---\nReview',
  })
  initOrigin(root, origin)
  try {
    await page.goto('/')
    const implementer = await createChat(page, root, 'Integration implementer', 'devs')
    await createChat(page, root, 'Integration reviewer', 'reviewers')
    seedPlan(root)
    const base = originRef(origin, 'master')

    await page.evaluate(teamKey => { window.location.hash = `#/team/${encodeURIComponent(teamKey)}/plans` }, root)
    await expect(page.getByTestId('team-workspace')).toBeVisible()
    const panel = page.getByTestId('team-plans')
    await panel.getByTestId('plan-list').getByRole('button', { name: /Integration walkthrough/ }).click()
    await expect(panel.getByRole('heading', { name: 'Integration walkthrough' })).toBeFocused()

    await validateUntilReady(panel, 1)
    const section = panel.getByTestId('plan-execution-section')
    await section.getByTestId('plan-execution-start-button').click()
    await expect(section.getByTestId('plan-execution-start-ready')).toBeVisible({ timeout: 20_000 })
    await section.getByTestId('plan-execution-start-confirm').click()
    await expect(section.getByTestId('plan-execution-state')).toContainText('Running', { timeout: 20_000 })

    // The create-integration effect writes the branch at master's head on
    // the bare origin; the change's worktree starts from it.
    await expect.poll(() => originRef(origin, BRANCH), { timeout: 30_000 }).toBe(base)
    const worktree = join(root, '.worktrees', CHANGE)
    await expect.poll(() => existsSync(worktree), { timeout: 30_000 }).toBe(true)

    mkdirSync(join(worktree, 'src'), { recursive: true })
    writeFileSync(join(worktree, 'src', 'int-api.ts'), 'export const integration = 1\n')
    git(['add', '-A'], worktree)
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'implement int-api'], worktree)
    git(['push', '-q', 'origin', `HEAD:refs/heads/${CHANGE}`], worktree)
    const commit = submitRound(root, 'result', implementer).split('RESULT:')[1]!.trim()
    submitRound(root, 'findings', implementer)

    // The round lands as a candidate: the branch fast-forwards to the round's
    // commit, never forced, while master stays where it was.
    await expect.poll(() => originRef(origin, BRANCH), { timeout: 60_000 }).toBe(commit)
    expect(originRef(origin, 'master')).toBe(base)
    await expect(section.getByTestId('plan-execution-state')).toContainText('Finished completed', { timeout: 20_000 })
    const integration = panel.getByTestId('plan-integration-panel')
    await expect(integration.getByTestId('plan-integration-candidate')).toContainText('landed', { timeout: 10_000 })
    await page.screenshot({ path: info.outputPath('integration-landed.png') })

    // Promote: the dialog pins the head and lists the carried change.
    await integration.getByTestId('plan-promote-open').click()
    const dialog = integration.getByTestId('plan-promote-dialog')
    await expect(dialog.getByTestId('plan-promote-head')).toContainText(commit, { timeout: 20_000 })
    await expect(dialog.getByTestId('plan-promote-carried')).toContainText(CHANGE)
    await dialog.getByTestId('plan-promote-confirm').click()

    // The promotion merges with a real merge commit onto master and the
    // landed candidate reads promoted.
    const row = integration.getByTestId('plan-promotion-row')
    await expect(row.getByTestId('plan-promotion-outcome')).toContainText('Merged', { timeout: 60_000 })
    const merged = originRef(origin, 'master')
    expect(git(['rev-list', '--parents', '-n', '1', merged], origin).trim().split(' ').slice(1)).toEqual([base, commit])
    await expect(integration.getByTestId('plan-integration-candidate').filter({ hasText: CHANGE })).toContainText('promoted')
    await expect(integration.getByTestId('plan-promote-open')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('integration-promoted.png') })
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(origin, { recursive: true, force: true }) }
})
