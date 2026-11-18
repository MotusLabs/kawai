// Browser walkthrough of revision control (revision-control 9.5) against the
// SDK-free fixture and isolated durable DB, over the same real executor
// plan-execution.spec.ts drives: the owner holds the running change in the
// Plans view's Holds section, pauses it from the execution section (the
// target reads Pausing with its cause), the holder records a checkpoint
// through `task_checkpoint` (the agent tool path against the same database;
// Kawai's `push-checkpoint` effect pushes it), the target turns Paused once
// the push settles and the holder is idle, and the owner's Continue decides
// it; the hold is then released. Local execution requires the fixture
// webServer (AGENTBOARD_CHAT_FIXTURE=1); CI runs it — never run test:e2e
// against a live kawai server.
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pollDelay } from 'node:timers/promises'
import { createChat, git, initOrigin, initPlanRepository, seedPlan, validateUntilReady } from './fixtures/planWalkthrough'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

const isolatedDb = (): string => {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse touching a non-isolated database')
  return dbPath
}

/**
 * The spawned dev holding the walk-api task, once it has claimed the
 * instruction — a pause withdraws an unclaimed one instead of asking its
 * holder (D6). The fixture writes no CLI transcript, so a pushed instruction
 * settles `uncertain` rather than `delivered`; either is claimed. Scoped to
 * this spec's own team: CI's one-server run shares the database across
 * walkthrough teams.
 */
async function claimedHolder(root: string, deadline: number): Promise<{ holder: string; taskId: string }> {
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
    console.log('HOLDER:' + JSON.stringify({ taskId, holder: row?.holder ?? null, state: row?.state ?? null }));
    sessions.close();
  `
  let observed: unknown = null
  for (;;) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the claimed walk-api holder: ${JSON.stringify(observed)}`)
    let stdout: string
    try {
      stdout = execFileSync('bun', ['-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 })
    } catch (error) {
      throw new Error(`claimedHolder failed; last isolated state: ${JSON.stringify(observed)}`, { cause: error })
    }
    const line = stdout.split('\n').find(entry => entry.startsWith('HOLDER:'))
    if (!line) throw new Error(`claimedHolder printed no result: ${stdout}`)
    const state = JSON.parse(line.slice('HOLDER:'.length)) as { taskId: string | null; holder: string | null; state: string | null }
    observed = state
    if (state.taskId && state.holder && (state.state === 'delivered' || state.state === 'uncertain')) return { holder: state.holder, taskId: state.taskId }
    await pollDelay(200)
  }
}

/**
 * The pause mail's receipt, standing in for the CLI transcript the fixture
 * never writes: once the mail was pushed and settled `uncertain` (receipt
 * unconfirmed), mark it delivered — the same late-receipt transition the
 * server makes when the transcript shows the message (`markDelivered` takes
 * `claimed` or `uncertain`). Without it the target stays Pausing on
 * `awaiting-delivery`, as it would for a holder that never received the mail.
 */
function settlePauseReceipt(root: string): string {
  const script = `
    import { initDatabase } from './src/server/db';
    import { resolveTeam } from './src/server/team/teamIdentity';
    import { MailboxStore } from './src/server/team/mailboxStore';
    const sessions = initDatabase({ path: ${JSON.stringify(isolatedDb())} });
    sessions.db.exec('PRAGMA busy_timeout = 5000');
    const teamId = (await resolveTeam(${JSON.stringify(root)})).teamId;
    const mail = new MailboxStore(sessions.db);
    const deadline = Date.now() + 30_000;
    let state = null;
    for (;;) {
      const row = sessions.db.prepare("SELECT t.message_id AS id, m.state FROM plan_pause_targets t JOIN plan_pauses p ON p.id = t.pause_id JOIN team_messages m ON m.id = t.message_id WHERE p.team_id = ? AND t.change = 'walk-api' ORDER BY p.rowid DESC LIMIT 1").get(teamId);
      state = row?.state ?? null;
      if (state === 'delivered') break;
      if (state === 'uncertain') { mail.markDelivered(row.id); state = 'delivered'; break; }
      if (Date.now() >= deadline) break;
      await Bun.sleep(200);
    }
    console.log('RECEIPT:' + JSON.stringify(state));
    sessions.close();
  `
  const stdout = execFileSync('bun', ['-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 })
  const line = stdout.split('\n').find(entry => entry.startsWith('RECEIPT:'))
  if (!line) throw new Error(`settlePauseReceipt printed no result: ${stdout}`)
  return JSON.parse(line.slice('RECEIPT:'.length)) as string
}

/** `task_checkpoint` as the holder: the tool's handler over the stores of the server's database. */
function recordCheckpoint(sessionId: string, input: Record<string, unknown>): Record<string, unknown> {
  const script = `
    import { initDatabase } from './src/server/db';
    import { ExecutionStore } from './src/server/plans/execution/executionStore';
    import { PauseStore } from './src/server/plans/revisionControl/pauseStore';
    import { CheckpointStore } from './src/server/plans/revisionControl/checkpointStore';
    import { CheckpointTool, checkpointHandlers } from './src/server/plans/revisionControl/checkpointTool';
    import { retryOnSqliteBusy } from './src/server/__tests__/sqliteBusyRetry';
    try {
      const [file, sessionId, input] = JSON.parse(await Bun.stdin.text());
      const sessions = initDatabase({ path: file });
      sessions.db.exec('PRAGMA busy_timeout = 5000');
      const db = sessions.db;
      const tool = new CheckpointTool({ executions: new ExecutionStore(db), pauses: new PauseStore(db), checkpoints: new CheckpointStore(db) });
      const outcome = await retryOnSqliteBusy(() => checkpointHandlers(tool, sessionId).task_checkpoint(input));
      console.log('CHECKPOINT:' + JSON.stringify(outcome));
      sessions.close();
    } catch (error) {
      console.error('CHECKPOINT-FAILED:', error instanceof Error ? error.stack : String(error));
      process.exit(1);
    }
  `
  const stdout = execFileSync('bun', ['-e', script], { cwd: process.cwd(), input: JSON.stringify([isolatedDb(), sessionId, input]), encoding: 'utf8' })
  const line = stdout.split('\n').find(entry => entry.startsWith('CHECKPOINT:'))
  if (!line) throw new Error(`task_checkpoint printed no result: ${stdout}`)
  return JSON.parse(line.slice('CHECKPOINT:'.length)) as Record<string, unknown>
}

// @covers: plan-pause › Holders record checkpoints through task_checkpoint › A clean checkpoint
// @covers: plan-pause › Paused is recorded only when work is safe and the holder has stopped › Checkpoint pushed, holder still busy
// @covers: plan-pause › The owner chooses how paused work goes on › Continue
test('revision-control walkthrough: hold, pause, checkpoint, Pausing to Paused, Continue', async ({ page }, info) => {
  test.setTimeout(300_000)
  const root = mkdtempSync(join(tmpdir(), 'kawai-revision-control-run-'))
  const origin = `${root}-origin.git`
  initPlanRepository(root, ['walk-api'], {
    // The spawned implementer's fixture turns run a tool call; auto-approve
    // lets each settle idle, so the holder reads ready for Paused.
    devs: '---\nlabel: Developers\nmax: 2\napproval: auto\n---\nBuild features',
    leads: '---\nlabel: Leads\nmax: 1\n---\nDecide plan work',
    reviewers: '---\nlabel: Reviewers\nmax: 2\n---\nReview',
  })
  // Its own repository: the fixture PR registry is repo-scoped.
  initOrigin(root, origin, 'https://github.com/acme/revision-control-walk.git')
  try {
    await page.goto('/')
    // Names unique across the fixture suite: specs share one server and pick
    // their sessions with hasText, a case-insensitive substring match, so no
    // other spec's name may be part of these, nor these of theirs
    // (chat-task-revision's 'Revision lead', plan-execution's 'Walk implementer').
    await createChat(page, root, 'Pausecase developer', 'devs')
    await createChat(page, root, 'Pausecase coordinator', 'leads')
    seedPlan(root, {
      title: 'Revision control walkthrough', goal: 'Show holds and pauses', leadGroup: 'leads',
      roles: [{ group: 'devs', profiles: [] }, { group: 'leads', profiles: [] }, { group: 'reviewers', profiles: [] }],
    })

    await page.evaluate(teamKey => { window.location.hash = `#/team/${encodeURIComponent(teamKey)}/plans` }, root)
    await expect(page.getByTestId('team-workspace')).toBeVisible()
    const panel = page.getByTestId('team-plans')
    await panel.getByTestId('plan-list').getByRole('button', { name: /Revision control walkthrough/ }).click()
    await expect(panel.getByRole('heading', { name: 'Revision control walkthrough' })).toBeFocused()
    const section = panel.getByTestId('plan-execution-section')
    await validateUntilReady(panel, 1)
    await section.getByTestId('plan-execution-start-button').click()
    await expect(section.getByTestId('plan-execution-start-ready')).toBeVisible({ timeout: 20_000 })
    await section.getByTestId('plan-execution-start-confirm').click()
    await expect(section.getByTestId('plan-execution-state')).toContainText('Running', { timeout: 20_000 })
    const worktree = join(root, '.worktrees', 'walk-api')
    await expect.poll(() => existsSync(worktree), { timeout: 30_000 }).toBe(true)
    const { holder, taskId } = await claimedHolder(root, Date.now() + 60_000)

    // Hold walk-api from the plan detail's Holds section.
    const holds = panel.getByTestId('plan-holds-section')
    await holds.getByTestId('plan-hold-place').click()
    const holdDialog = holds.getByTestId('plan-hold-place-dialog')
    await holdDialog.getByLabel('Some changes').check()
    await holdDialog.getByLabel('Hold walk-api').check()
    await holdDialog.getByLabel('Hold rationale').fill('The API shape is under review.')
    await holdDialog.getByTestId('plan-hold-place-confirm').click()
    await expect(holdDialog).toHaveCount(0, { timeout: 20_000 })
    await expect(holds).toContainText('on walk-api')
    await expect(holds).toContainText('The API shape is under review.')

    // Pause it from the execution section: the target reads Pausing with its cause.
    await section.getByTestId('plan-pause-open').click()
    await section.getByLabel('Pause note').fill('Checkpoint the API work.')
    await section.getByTestId('plan-pause-open-confirm').click()
    const state = section.getByTestId('plan-pause-state-walk-api')
    await expect(state).toContainText('Pausing', { timeout: 20_000 })
    await expect(state).not.toContainText('Paused')
    expect(settlePauseReceipt(root)).toBe('delivered')

    // The holder commits its work (never pushing it) and records the checkpoint.
    mkdirSync(join(worktree, 'src'), { recursive: true })
    writeFileSync(join(worktree, 'src', 'walk-api.ts'), 'export const walkthrough = 1\n')
    git(['add', '-A'], worktree)
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'walk-api: first half'], worktree)
    const commit = git(['rev-parse', 'HEAD'], worktree).trim()
    const recorded = recordCheckpoint(holder, {
      task_id: taskId, commit, summary: 'The first half of walk-api.', unfinished: 'The second endpoint.', next_steps: 'Add the second endpoint.',
    })
    expect(recorded.ok).toBe(true)

    // Kawai pushes the checkpoint; with the holder idle the target turns Paused.
    await expect(state).toContainText('Paused since', { timeout: 60_000 })
    const target = section.getByTestId('plan-pause-target-walk-api')
    await expect(target).toContainText('The first half of walk-api.')
    await expect(target).toContainText(commit)
    expect(git(['ls-remote', origin, 'refs/heads/walk-api'])).toContain(commit)
    await page.screenshot({ path: info.outputPath('revision-control-paused.png') })

    // Continue: the holder resumes from its checkpoint.
    await target.getByTestId('plan-checkpoint-decide-walk-api').click()
    const decide = target.getByTestId('plan-checkpoint-decide-walk-api-dialog')
    await expect(decide.getByTestId('plan-checkpoint-decide-walk-api-stop')).toBeVisible()
    await decide.getByLabel('continue', { exact: true }).check()
    await decide.getByTestId('plan-checkpoint-decide-walk-api-confirm').click()
    await expect(state).toContainText('Decided: continue', { timeout: 20_000 })

    // The hold still stands until the owner releases it.
    const holdRow = holds.locator('[data-testid^="plan-hold-hold-"]')
    await holdRow.locator('[data-testid^="plan-hold-release-"]').first().click()
    await holds.getByLabel('Release reason').fill('The API shape is settled.')
    await holds.locator('[data-testid$="-confirm"]').click()
    await expect(holds).toContainText('No active hold.', { timeout: 20_000 })
    await expect(holds).toContainText('The API shape is settled.')
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(origin, { recursive: true, force: true }) }
})
