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
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChat, git, initOrigin, initPlanRepository, seedPlan, submitRound, validateUntilReady } from './fixtures/planWalkthrough'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')


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
    // Not asserted: the transient "Checking the standing…" line — the server
    // can answer before the dialog is first observed (a flake when it did).
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
      import { retryOnSqliteBusy } from './src/server/__tests__/sqliteBusyRetry';
      const sessions = initDatabase({ path: ${JSON.stringify(dbPath)} });
      sessions.db.exec('PRAGMA busy_timeout = 5000');
      const plans = new PlanStore(sessions.db);
      const teamId = (await resolveTeam(${JSON.stringify(root)})).teamId;
      // Same second-writer shape as seedPlan: one transaction, retried whole.
      await retryOnSqliteBusy(() => plans.atomically(() => {
        const planId = plans.insertPlan({ teamId, title: 'No execution yet', creator: { kind: 'human', sessionId: null } });
        const content = normalizePlanContent({
          goal: 'Nothing runs', successCriteria: ['The empty state shows'],
          changes: [{ change: 'empty-api', dependsOn: [], group: 'devs', acceptance: [], extraChecks: [], guidance: '' }],
          roles: [{ group: 'devs', profiles: [] }],
        });
        const revision = plans.insertRevision(planId, { content, contentHash: 'empty-hash-1', pin: null, author: { kind: 'human', sessionId: null } });
        plans.setRevisionStatus(planId, revision, 'approved');
        plans.setCurrentApproved(planId, revision);
      }));
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
