// Browser walkthrough of plan supervision (plan-supervision §11.1) against
// the SDK-free fixture and isolated durable DB, over the same real executor
// plan-execution.spec.ts drives: the implementer asks a decision card
// through `decision_ask`, the Lead answers through `decision_record` (the
// agent tool path against the same database), the human overrides it in the
// Plans view — creating the fix task and its attention item — and two
// consecutive failing reviews stall the change as a repeating failure in
// the report with its plan-stall attention item. Local execution requires
// the fixture webServer (AGENTBOARD_CHAT_FIXTURE=1); CI runs it — never run
// test:e2e against a live kawai server.
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChat, git, initOrigin, initPlanRepository, seedPlan, submitRound, validateUntilReady } from './fixtures/planWalkthrough'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

/**
 * One decision tool call as a session — the agent tool path
 * (decisionHandlers over the wired DecisionService) against the same
 * database the server runs on. Returns the handler's outcome.
 */
function decisionTool(root: string, sessionId: string, tool: 'ask' | 'record', input: Record<string, unknown>): Record<string, unknown> {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
  const script = `
    import { initDatabase } from './src/server/db';
    import { PlanStore } from './src/server/plans/planStore';
    import { MailboxStore } from './src/server/team/mailboxStore';
    import { AssignmentStore } from './src/server/team/assignmentStore';
    import { TaskStore } from './src/server/team/taskStore';
    import { TaskService } from './src/server/team/TaskService';
    import { TeamMailbox } from './src/server/team/TeamMailbox';
    import { DecisionStore } from './src/server/plans/decisions/decisionStore';
    import { DecisionService } from './src/server/plans/decisions/DecisionService';
    import { decisionReplyGuard } from './src/server/plans/decisions/decisionReplyGuard';
    import { decisionHandlers } from './src/server/plans/decisions/decisionTools';
    import { retryOnSqliteBusy } from './src/server/__tests__/sqliteBusyRetry';
    try {
      const [file, sessionId, tool, input] = JSON.parse(await Bun.stdin.text());
      const sessions = initDatabase({ path: file });
      sessions.db.exec('PRAGMA busy_timeout = 5000');
      const db = sessions.db;
      const mail = new MailboxStore(db);
      const taskStore = new TaskStore(db, mail, new AssignmentStore(db, mail));
      const tasks = new TaskService(taskStore, { getSession: id => sessions.getChatSession(id), homeDir: process.env.HOME });
      const plans = new PlanStore(db);
      const decisions = new DecisionStore(db);
      // The production mailbox carries the decision reply guard (D9).
      const mailbox = new TeamMailbox(mail, { getSession: id => sessions.getChatSession(id), homeDir: process.env.HOME, tasks: taskStore, replyGuard: decisionReplyGuard(decisions) });
      const decide = new DecisionService({ db, decisions, plans, planService: {}, tasks, taskStore, assignments: {}, mailbox, getSession: id => sessions.getChatSession(id), homeDir: process.env.HOME });
      const handler = decisionHandlers(decide, sessionId)[tool === 'ask' ? 'decision_ask' : 'decision_record'];
      // Same second-writer shape as the plan seed: a BUSY on the deferred
      // read→write upgrade bypasses busy_timeout, so re-run the whole call
      // (its transaction rolls back whole).
      const outcome = await retryOnSqliteBusy(() => handler(input));
      console.log('DECISION:' + JSON.stringify(outcome));
      sessions.close();
    } catch (error) {
      console.error('DECISION-FAILED:', error instanceof Error ? error.stack : String(error));
      process.exit(1);
    }
  `
  const stdout = execFileSync('bun', ['-e', script], { cwd: process.cwd(), input: JSON.stringify([dbPath, sessionId, tool, input]), encoding: 'utf8' })
  const line = stdout.split('\n').find(entry => entry.startsWith('DECISION:'))
  if (!line) throw new Error(`decision ${tool} printed no result: ${stdout}`)
  return JSON.parse(line.slice('DECISION:'.length)) as Record<string, unknown>
}

/**
 * The session the executor's task mail landed on: the spawned dev holding
 * the walk-api task. Worktree-scoped routing skips a chat rooted above the
 * worktree, and the reviewer's handoff mail pins the same task, so the group
 * narrows the pick to the implementer. decisionScope resolves a card from
 * `session.taskId`, so the ask must come from this session.
 */
function taskHolder(root: string): string {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse reading a non-isolated database')
  const script = `
    import { initDatabase } from './src/server/db';
    import { resolveTeam } from './src/server/team/teamIdentity';
    const sessions = initDatabase({ path: ${JSON.stringify(dbPath)} });
    sessions.db.exec('PRAGMA busy_timeout = 5000');
    // CI's one-server fixture run shares one database across walkthrough
    // teams, and two name their change walk-api: scope to this spec's own
    // team (one execution per team owns the change), so another team's
    // row can never answer between provisioning and task creation.
    const teamId = (await resolveTeam(${JSON.stringify(root)})).teamId;
    const taskId = sessions.db.prepare("SELECT task_id FROM plan_execution_changes WHERE team_id = ? AND change = 'walk-api' AND task_id IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(teamId)?.task_id;
    const row = taskId
      ? sessions.db.prepare("SELECT session_id FROM chat_sessions WHERE task_id = ? AND group_id = 'devs' ORDER BY rowid DESC LIMIT 1").get(taskId)
      : null;
    console.log('HOLDER:' + JSON.stringify({ taskId: taskId ?? null, holder: row?.session_id ?? null }));
    sessions.close();
  `
  const stdout = execFileSync('bun', ['-e', script], { cwd: process.cwd(), encoding: 'utf8' })
  const line = stdout.split('\n').find(entry => entry.startsWith('HOLDER:'))
  if (!line) throw new Error(`taskHolder printed no result: ${stdout}`)
  const { taskId, holder } = JSON.parse(line.slice('HOLDER:'.length)) as { taskId: string | null; holder: string | null }
  if (!holder) throw new Error(`no devs session holds the walk-api task ${taskId ?? '(none)'}: the executor's task mail has not been delivered`)
  return holder
}

test('supervision walkthrough: a Lead-answered card, the owner override, and a repeating-failure stall', async ({ page }, info) => {
  test.setTimeout(300_000)
  const root = mkdtempSync(join(tmpdir(), 'kawai-supervision-run-'))
  const origin = `${root}-origin.git`
  initPlanRepository(root, ['walk-api'], {
    // The spawned implementer's fixture turn runs a tool call; auto-approve
    // lets it settle idle (plan-execution's shape). The Lead role group
    // takes the card's question and the fix task.
    devs: '---\nlabel: Developers\nmax: 2\napproval: auto\n---\nBuild features',
    leads: '---\nlabel: Leads\nmax: 1\n---\nDecide plan work',
    reviewers: '---\nlabel: Reviewers\nmax: 2\n---\nReview',
  })
  // The supervision walkthrough's own repository: the fixture PR registry is
  // repo-scoped, so sharing plan-execution's acme/walkthrough would let one
  // spec's open walk-api PR refuse the other's.
  initOrigin(root, origin, 'https://github.com/acme/supervision-walk.git')
  try {
    await page.goto('/')
    const implementer = await createChat(page, root, 'Supervision implementer', 'devs')
    const lead = await createChat(page, root, 'Supervision lead', 'leads')
    const reviewer = await createChat(page, root, 'Supervision reviewer', 'reviewers')
    const planId = seedPlan(root, {
      title: 'Supervision walkthrough', goal: 'Show plan supervision', leadGroup: 'leads',
      roles: [{ group: 'devs', profiles: [] }, { group: 'leads', profiles: [] }, { group: 'reviewers', profiles: [] }],
    })

    await page.evaluate(teamKey => { window.location.hash = `#/team/${encodeURIComponent(teamKey)}/plans` }, root)
    await expect(page.getByTestId('team-workspace')).toBeVisible()
    const panel = page.getByTestId('team-plans')
    await panel.getByTestId('plan-list').getByRole('button', { name: /Supervision walkthrough/ }).click()
    await expect(panel.getByRole('heading', { name: 'Supervision walkthrough' })).toBeFocused()
    const section = panel.getByTestId('plan-execution-section')
    await validateUntilReady(panel, 1)
    await section.getByTestId('plan-execution-start-button').click()
    await expect(section.getByTestId('plan-execution-start-dialog')).toBeVisible()
    await expect(section.getByTestId('plan-execution-start-ready')).toBeVisible({ timeout: 20_000 })
    await section.getByTestId('plan-execution-start-confirm').click()
    await expect(section.getByTestId('plan-execution-state')).toContainText('Running', { timeout: 20_000 })
    const worktree = join(root, '.worktrees', 'walk-api')
    await expect.poll(() => existsSync(worktree), { timeout: 30_000 }).toBe(true)

    // Round 1 fails its review (the review:fail signature).
    mkdirSync(join(worktree, 'src'), { recursive: true })
    writeFileSync(join(worktree, 'src', 'walk-api.ts'), 'export const walkthrough = 1\n')
    git(['add', '-A'], worktree)
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'implement walk-api'], worktree)
    git(['push', '-q', 'origin', 'HEAD:refs/heads/walk-api'], worktree)
    submitRound(root, 'result', implementer, reviewer)
    submitRound(root, 'findings', implementer, reviewer, { verdict: 'fail' })

    // The implementer of record (the task holder, not the root chat) asks
    // through decision_ask; the card goes to the Lead role group (the asker
    // is outside it).
    const asked = decisionTool(root, taskHolder(root), 'ask', {
      question: 'Which schema should walk-api ship?', options: ['Narrow', 'Wide'],
    })
    expect(asked.addressed_to).toBe('lead')
    const cardId = String(asked.card_id)
    const record = decisionTool(root, lead, 'record', {
      plan_id: planId, card_id: cardId, option_index: 1, rationale: 'Narrow ships first.',
    })
    expect(record.choice).toBe('Narrow')

    // The card renders inline in the change's execution row with the Lead's
    // recorded decision (the detail is re-pushed after the decision write).
    await expect(panel.getByTestId('plan-decision-card').getByTestId('plan-decision-current')).toContainText('Narrow', { timeout: 20_000 })
    await expect(panel.getByTestId('plan-decision-card').getByTestId('plan-decision-current')).toContainText('Supervision lead')

    // The owner overrides it in the Plans view: a required rationale, the
    // decision it replaces sent as expectedDecisionId.
    await panel.getByTestId('plan-decision-override').click()
    const dialog = panel.getByTestId('plan-decision-override-dialog')
    await dialog.getByLabel('Option 2: Wide').check()
    await dialog.getByLabel('override rationale').fill('The dependent change needs the wide schema; re-deciding.')
    await panel.getByTestId('plan-decision-override-confirm').click()

    // The override's fix task exists: the card lists it and the attention
    // queue carries the plan-fix item.
    await expect(panel.getByTestId('plan-decision-fixes')).toBeVisible({ timeout: 20_000 })
    const queue = page.getByTestId('team-attention-queue')
    await expect(queue.locator('[data-kind="plan-fix"]')).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByTestId('plan-decision-history')).toContainText('superseded')

    // Round 2 fails its review the same way: two consecutive review:fail
    // rounds stall the change as a repeating failure, the monitor raises
    // the alert, and the report and the attention queue show it.
    writeFileSync(join(worktree, 'src', 'walk-two.ts'), 'export const walkthroughTwo = 2\n')
    git(['add', '-A'], worktree)
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'extend walk-api'], worktree)
    git(['push', '-q', 'origin', 'HEAD:refs/heads/walk-api'], worktree)
    submitRound(root, 'result', implementer, reviewer)
    submitRound(root, 'findings', implementer, reviewer, { verdict: 'fail' })
    await expect(panel.getByTestId('plan-supervision-stall-walk-api')).toContainText('Stalled: repeating failure', { timeout: 90_000 })
    await expect(panel.getByTestId('plan-supervision-stall-walk-api')).toContainText('review:fail')
    await expect(queue.locator('[data-kind="plan-stall"]')).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: info.outputPath('supervision-stall.png') })
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(origin, { recursive: true, force: true }) }
})

