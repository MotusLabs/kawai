// Browser walkthrough of Apply (plan-revision-apply 3.3, design D6, A8)
// against the SDK-free fixture and isolated durable DB, over the same real
// executor plan-execution.spec.ts drives: the owner starts revision 1, a
// developer takes walk-api, revision 2 rewording its guidance is approved
// (seeded through the stores as the human, as `seedPlan` seeds revision 1),
// and the owner applies it from the execution section: the dialog shows
// walk-api changed in its guidance and asks its one choice, the owner picks
// adapt and writes the rationale, and the execution then holds revision 2
// with its history — the seq-2 row carrying the rationale and walk-api's
// published task revision. Local execution requires the fixture webServer
// (AGENTBOARD_CHAT_FIXTURE=1); CI runs it — never run test:e2e against a
// live kawai server.
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pollDelay } from 'node:timers/promises'
import { createChat, initOrigin, initPlanRepository, seedPlan, validateUntilReady } from './fixtures/planWalkthrough'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

const isolatedDb = (): string => {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse touching a non-isolated database')
  return dbPath
}

/** Run a `bun -e` script over the isolated database and parse its `<tag>:` line. */
function runScript<T>(tag: string, script: string, timeout = 30_000): T {
  const stdout = execFileSync('bun', ['-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout })
  const line = stdout.split('\n').find(entry => entry.startsWith(`${tag}:`))
  if (!line) throw new Error(`${tag} printed no result: ${stdout}`)
  return JSON.parse(line.slice(tag.length + 1)) as T
}

/** walk-api's task, once the executor provisioned it and a developer claimed its instruction (scoped to this spec's team). */
async function claimedTask(root: string, deadline: number): Promise<string> {
  const script = `
    import { initDatabase } from './src/server/db';
    import { resolveTeam } from './src/server/team/teamIdentity';
    const sessions = initDatabase({ path: ${JSON.stringify(isolatedDb())} });
    sessions.db.exec('PRAGMA busy_timeout = 5000');
    const teamId = (await resolveTeam(${JSON.stringify(root)})).teamId;
    const taskId = sessions.db.prepare("SELECT task_id FROM plan_execution_changes WHERE team_id = ? AND change = 'walk-api' AND task_id IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(teamId)?.task_id ?? null;
    const row = taskId
      ? sessions.db.prepare("SELECT m.claimed_by AS holder, m.state FROM team_task_assignments a JOIN team_messages m ON m.id = a.message_id WHERE a.team_id = ? AND a.task_id = ? ORDER BY a.rowid DESC LIMIT 1").get(teamId, taskId)
      : null;
    console.log('CLAIMED:' + JSON.stringify({ taskId, holder: row?.holder ?? null, state: row?.state ?? null }));
    sessions.close();
  `
  let observed: unknown = null
  for (;;) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for walk-api's claimed task: ${JSON.stringify(observed)}`)
    const state = runScript<{ taskId: string | null; holder: string | null; state: string | null }>('CLAIMED', script)
    observed = state
    if (state.taskId && state.holder && (state.state === 'delivered' || state.state === 'uncertain')) return state.taskId
    await pollDelay(200)
  }
}

/** Approve revision 2 as the human through the stores: walk-api's guidance reworded, revision 1 superseded. */
function approveRewordedRevision(planId: string): number {
  const script = `
    import { initDatabase } from './src/server/db';
    import { PlanStore } from './src/server/plans/planStore';
    import { retryOnSqliteBusy } from './src/server/__tests__/sqliteBusyRetry';
    const sessions = initDatabase({ path: ${JSON.stringify(isolatedDb())} });
    sessions.db.exec('PRAGMA busy_timeout = 5000');
    const plans = new PlanStore(sessions.db);
    const planId = ${JSON.stringify(planId)};
    await retryOnSqliteBusy(() => plans.atomically(() => {
      const current = plans.revision(planId, 1);
      const content = { ...current.content, changes: current.content.changes.map(entry => ({ ...entry, guidance: 'Serve the API under /v2.' })) };
      const revision = plans.insertRevision(planId, { content, contentHash: 'seed-hash-2-' + planId, pin: null, author: { kind: 'human', sessionId: null } });
      plans.setRevisionStatus(planId, revision, 'approved');
      plans.setRevisionStatus(planId, 1, 'superseded');
      plans.setCurrentApproved(planId, revision);
      console.log('REVISION:' + JSON.stringify(revision));
    }));
    sessions.close();
  `
  return runScript<number>('REVISION', script)
}

/** The execution's history rows and walk-api's task revision, read from the isolated database. */
function appliedState(planId: string, taskId: string): { history: Array<{ seq: number; revision: number; rationale: string | null }>; taskRevision: number; published: string | null } {
  const script = `
    import { initDatabase } from './src/server/db';
    const sessions = initDatabase({ path: ${JSON.stringify(isolatedDb())} });
    sessions.db.exec('PRAGMA busy_timeout = 5000');
    const execution = sessions.db.prepare('SELECT id FROM plan_executions WHERE plan_id = ? ORDER BY rowid DESC LIMIT 1').get(${JSON.stringify(planId)});
    const history = sessions.db.prepare('SELECT seq, revision, rationale FROM plan_execution_revisions WHERE execution_id = ? ORDER BY seq').all(execution.id);
    const taskRevision = sessions.db.prepare('SELECT revision FROM team_tasks WHERE id = ?').get(${JSON.stringify(taskId)}).revision;
    const published = sessions.db.prepare("SELECT choice FROM plan_execution_publication_changes WHERE execution_id = ? AND seq = 2 AND change = 'walk-api'").get(execution.id)?.choice ?? null;
    console.log('APPLIED:' + JSON.stringify({ history, taskRevision, published }));
    sessions.close();
  `
  return runScript('APPLIED', script)
}

// @covers: plan-revision-apply › Kawai classifies every change against the running revision › The preview shows the delta
test('revision-apply walkthrough: start revision 1, approve revision 2, apply it with walk-api adapted, see the history', async ({ page }, info) => {
  test.setTimeout(300_000)
  const root = mkdtempSync(join(tmpdir(), 'kawai-revision-apply-run-'))
  const origin = `${root}-origin.git`
  initPlanRepository(root, ['walk-api'], {
    devs: '---\nlabel: Developers\nmax: 2\napproval: auto\n---\nBuild features',
    reviewers: '---\nlabel: Reviewers\nmax: 2\n---\nReview',
  })
  // Its own repository: the fixture PR registry is repo-scoped.
  initOrigin(root, origin, 'https://github.com/acme/revision-apply-walk.git')
  try {
    await page.goto('/')
    // A name unique across the fixture suite: specs share one server and pick sessions with hasText.
    await createChat(page, root, 'Applycase developer', 'devs')
    const planId = seedPlan(root, { title: 'Revision apply walkthrough', goal: 'Show Apply' })

    const openPlan = async () => {
      await page.evaluate(teamKey => { window.location.hash = `#/team/${encodeURIComponent(teamKey)}/plans` }, root)
      await expect(page.getByTestId('team-workspace')).toBeVisible()
      const panel = page.getByTestId('team-plans')
      await panel.getByTestId('plan-list').getByRole('button', { name: /Revision apply walkthrough/ }).click()
      await expect(panel.getByRole('heading', { name: 'Revision apply walkthrough' })).toBeFocused()
      return panel
    }
    let panel = await openPlan()
    let section = panel.getByTestId('plan-execution-section')
    await validateUntilReady(panel, 1)
    await section.getByTestId('plan-execution-start-button').click()
    await expect(section.getByTestId('plan-execution-start-ready')).toBeVisible({ timeout: 20_000 })
    await section.getByTestId('plan-execution-start-confirm').click()
    await expect(section.getByTestId('plan-execution-state')).toContainText('Running', { timeout: 20_000 })
    await expect.poll(() => existsSync(join(root, '.worktrees', 'walk-api')), { timeout: 30_000 }).toBe(true)
    const taskId = await claimedTask(root, Date.now() + 60_000)

    // Revision 2 is approved outside this page: reload so the detail reads it, then validate it.
    expect(approveRewordedRevision(planId)).toBe(2)
    await page.reload()
    panel = await openPlan()
    section = panel.getByTestId('plan-execution-section')
    await validateUntilReady(panel, 2)

    // The dialog: walk-api changed in its guidance, one choice asked.
    await section.getByTestId('plan-apply-revision').click()
    const dialog = section.getByTestId('plan-apply-revision-dialog')
    await expect(dialog.getByTestId('plan-apply-change-walk-api')).toContainText('walk-api: changed (guidance)', { timeout: 20_000 })
    await dialog.getByLabel('adapt walk-api').check()
    await expect(dialog.getByTestId('plan-apply-adaptation-walk-api')).toBeVisible()
    await dialog.getByLabel('Apply rationale').fill('The API moves under /v2.')
    await page.screenshot({ path: info.outputPath('revision-apply-dialog.png') })
    await dialog.getByTestId('plan-apply-revision-confirm').click()
    await expect(dialog).toHaveCount(0, { timeout: 20_000 })

    // The execution holds revision 2, with its history.
    await expect(section.getByTestId('plan-execution-state')).toContainText('revision 2', { timeout: 20_000 })
    const state = appliedState(planId, taskId)
    expect(state.history).toEqual([{ seq: 1, revision: 1, rationale: null }, { seq: 2, revision: 2, rationale: 'The API moves under /v2.' }])
    expect(state.taskRevision).toBe(2)
    expect(state.published).toBe('adapt')
    await page.screenshot({ path: info.outputPath('revision-apply-applied.png') })
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(origin, { recursive: true, force: true }) }
})
