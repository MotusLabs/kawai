// Browser walkthrough of the Execution section of the Plans view
// (plan-execution 17.2, rev 3) against the SDK-free fixture and isolated
// durable DB. The plan alone is seeded through the stores; the execution is
// NOT — the walkthrough clicks Start in the dialog (whose standing comes
// from the server's preview), the composed executor runs behind it, and the
// landing goes through the fixture adapters the composition installs under
// the fixture switch. The implementer's result and the reviewer's findings
// arrive through the agent tool path (task_submit_result /
// task_submit_findings) against the same database; git stays real over a
// local bare origin behind a GitHub-shaped remote. Local execution requires
// the fixture webServer (AGENTBOARD_CHAT_FIXTURE=1); CI runs it — never run
// test:e2e against a live kawai server.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initPlanRepository, validateUntilReady } from './fixtures/planWalkthrough'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

const GITHUB_URL = 'https://github.com/acme/walkthrough.git'

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

/** Seed the approved plan (and only the plan) through the stores, as the human. */
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
    const planId = plans.insertPlan({ teamId, title: 'Execution walkthrough', creator: { kind: 'human', sessionId: null } });
    const content = normalizePlanContent({
      goal: 'Ship the walkthrough', successCriteria: ['The change lands through the execution'],
      changes: [{ change: 'walk-api', dependsOn: [], group: 'devs', acceptance: [], extraChecks: [], guidance: '' }],
      roles: [{ group: 'devs', profiles: [] }, { group: 'reviewers', profiles: [] }], reviewGroup: 'reviewers',
    });
    const revision = plans.atomically(() => plans.insertRevision(planId, { content, contentHash: 'walk-hash-1', pin: null, author: { kind: 'human', sessionId: null } }));
    plans.setRevisionStatus(planId, revision, 'approved');
    plans.setCurrentApproved(planId, revision);
    sessions.close();
  `], { cwd: process.cwd(), encoding: 'utf8' })
}

/**
 * The implementer's result, then the reviewer's passing findings — the agent
 * tool path over the same database. Returns the pushed commit of the result.
 */
function submitRound(root: string, mode: 'result' | 'findings', implementer: string, reviewer: string): string {
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
    try {
      const [file, root, mode, implementer, reviewer] = JSON.parse(await Bun.stdin.text());
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
      const row = db.prepare("SELECT task_id FROM plan_execution_changes WHERE change = 'walk-api' AND task_id IS NOT NULL ORDER BY rowid DESC").get();
      if (!row) throw new Error('no owned task for walk-api yet');
      const taskId = row.task_id;
      if (mode === 'result') {
        const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: join(root, '.worktrees', 'walk-api') }).stdout.toString().trim();
        const asImplementer = taskHandlers(tasks, implementer, results);
        await asImplementer.task_submit_result({ task_id: taskId, summary: 'Implemented walk-api', commit, tests: [{ description: 'unit', outcome: 'pass' }] });
        console.log('RESULT:' + commit);
      } else {
        // The verdict counts only the review handoff's claimant's findings:
        // wait for the dispatched review to be claimed, then answer as that
        // reviewer (the tool path, exactly as the agent would).
        let claimant = null;
        for (let attempt = 0; attempt < 30 && claimant === null; attempt++) {
          const row = db.prepare("SELECT claimed_by FROM team_task_assignments WHERE task_id = ? AND handoff_kind = 'review' AND superseded_by IS NULL AND claimed_by IS NOT NULL ORDER BY rowid DESC").get(taskId);
          claimant = row?.claimed_by ?? null;
          if (claimant === null) await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (claimant === null) throw new Error('the review handoff was never claimed');
        const result = db.prepare('SELECT id FROM team_task_results WHERE task_id = ? ORDER BY rowid DESC').get(taskId);
        if (!result) throw new Error('no result yet');
        const asReviewer = taskHandlers(tasks, claimant, results);
        await asReviewer.task_submit_findings({ task_id: taskId, result_id: result.id, kind: 'review', verdict: 'pass', findings: 'Clean: the walkthrough change is sound.' });
        console.log('FINDINGS:ok:' + claimant);
      }
      sessions.close();
    } catch (error) {
      console.error('ROUND-FAILED:', error instanceof Error ? error.stack : String(error));
      process.exit(1);
    }
  `
  return execFileSync('bun', ['-e', script], {
    cwd: process.cwd(), input: JSON.stringify([dbPath, root, mode, implementer, reviewer]), encoding: 'utf8',
  }).trim()
}

/** Poll the execution's progress until a row reads `until` (e.g. its outcome `completed`). */
async function pollExecution(root: string, until: string): Promise<boolean> {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  const script = `
    import { initDatabase } from './src/server/db';
    import { ExecutionStore } from './src/server/plans/execution/executionStore';
    const sessions = initDatabase({ path: ${JSON.stringify(dbPath)} });
    sessions.db.exec('PRAGMA busy_timeout = 5000');
    const db = sessions.db;
    const store = new ExecutionStore(sessions.db);
    const out = [];
    const execution = db.prepare('SELECT id, state, outcome FROM plan_executions ORDER BY started_at DESC, rowid DESC').get();
    if (execution) {
      out.push({ execution: execution.state, outcome: execution.outcome });
      for (const row of store.changes(execution.id)) {
        out.push({ change: row.change, state: row.state, step: row.step, pr: row.prNumber, taskId: row.taskId !== null });
        const round = store.rounds(execution.id, row.change).at(-1);
        if (round) out.push({ round: round.number, pushed: round.pushedAt !== null, outcome: round.outcome, review: round.reviewAssignmentId !== null, ci: (round.ci ?? []).map(check => check.conclusion) });
        for (const effect of store.effectsOf(execution.id)) out.push({ effect: effect.kind, state: effect.state, error: (effect.error ?? '').slice(0, 120) });
      }
    }
    console.log('POLL ' + JSON.stringify(out));
    sessions.close();
  `
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const stdout = execFileSync('bun', ['-e', script], { cwd: process.cwd(), encoding: 'utf8' })
      const line = stdout.split('\n').find(entry => entry.startsWith('POLL '))
      const rows = line ? JSON.parse(line.slice('POLL '.length)) as Array<Record<string, unknown>> : []
      if (JSON.stringify(rows).includes(JSON.stringify(until))) return true
    } catch {
      // A poll cycle that could not read the state yet tries again.
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  return false
}

test('Start runs the composed executor through to a fixture landing', async ({ page }, info) => {
  test.setTimeout(90_000)
  const root = mkdtempSync(join(tmpdir(), 'kawai-execution-run-'))
  const origin = `${root}-origin.git`
  initPlanRepository(root, ['walk-api'], {
    // The spawned implementer's fixture turn runs a tool call; auto-approve
    // lets it settle idle so the release-before-review step can release it.
    devs: '---\nlabel: Developers\nmax: 2\napproval: auto\n---\nBuild features',
    reviewers: '---\nlabel: Reviewers\nmax: 2\n---\nReview',
  })
  initOrigin(root, origin)
  try {
    await page.goto('/')
    const implementer = await createChat(page, root, 'Walk implementer', 'devs')
    const reviewer = await createChat(page, root, 'Walk reviewer', 'reviewers')
    seedPlan(root)

    await page.evaluate(teamKey => { window.location.hash = `#/team/${encodeURIComponent(teamKey)}/plans` }, root)
    await expect(page.getByTestId('team-workspace')).toBeVisible()
    const panel = page.getByTestId('team-plans')
    await panel.getByTestId('plan-list').getByRole('button', { name: /Execution walkthrough/ }).click()
    await expect(panel.getByRole('heading', { name: 'Execution walkthrough' })).toBeFocused()

    // The Start dialog's standing comes from the server (15.4): the preview
    // answers ready once the revision validates.
    await validateUntilReady(panel, 1)
    const section = panel.getByTestId('plan-execution-section')
    await section.getByTestId('plan-execution-start-button').click()
    await expect(section.getByTestId('plan-execution-start-dialog')).toBeVisible()
    await expect(section.getByTestId('plan-execution-preview-pending')).toBeVisible()
    await expect(section.getByTestId('plan-execution-start-ready')).toBeVisible({ timeout: 20_000 })
    await section.getByTestId('plan-execution-start-confirm').click()

    // The composed executor owns it now: the execution the Start command
    // created runs, provisions the change's worktree, and dispatches.
    await expect(section.getByTestId('plan-execution-state')).toContainText('Running', { timeout: 20_000 })
    await expect(section.getByTestId('plan-execution-change')).toHaveCount(1)
    const worktree = join(root, '.worktrees', 'walk-api')
    await expect.poll(() => existsSync(worktree), { timeout: 30_000 }).toBe(true)

    // The implementer of record works in the provisioned worktree and
    // submits the result through the tool path.
    mkdirSync(join(worktree, 'src'), { recursive: true })
    writeFileSync(join(worktree, 'src', 'walk-api.ts'), 'export const walkthrough = 1\n')
    git(['add', '-A'], worktree)
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'implement walk-api'], worktree)
    git(['push', '-q', 'origin', 'HEAD:refs/heads/walk-api'], worktree)
    submitRound(root, 'result', implementer, reviewer)

    // The reviewer's passing findings decide the round; the fixture landing
    // adapter merges, the fact records, and the plan completes as Kawai's.
    submitRound(root, 'findings', implementer, reviewer)
    const finished = await pollExecution(root, 'completed')
    expect(finished).toBe(true)
    await expect(section.getByTestId('plan-execution-state')).toContainText('Finished completed', { timeout: 10_000 })
    await expect(section.getByTestId('plan-execution-change')).toContainText('Landed')
    await page.screenshot({ path: info.outputPath('execution-landed.png') })
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(origin, { recursive: true, force: true }) }
})

test('a plan without an execution shows the empty state with the Start dialog', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'kawai-execution-empty-'))
  initPlanRepository(root, ['empty-api'], {
    devs: '---\nlabel: Developers\n---\nBuild features',
    reviewers: '---\nlabel: Reviewers\n---\nReview',
  })
  try {
    await page.goto('/')
    await createChat(page, root, 'Empty looker', 'devs')
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
    await expect(section.getByTestId('plan-execution-start-button')).toBeVisible()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
