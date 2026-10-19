// End-to-end process metrics on a fixture team (team-process-metrics 11.1),
// against the SDK-free fixture and the isolated durable DB. Two reviewer
// chats start under two versions of `reviewers.md` (each start's group-file
// hash recorded by the driver's spawn hook), each runs a fixture turn, then
// results and review findings go through the task tool handlers bound to the
// dev and reviewer sessions and the lead closes the tasks. `team_metrics` 7d
// sliced by group-file hash, read through its tool handler, must match what
// the Metrics tab shows for the same window and slice: every metric's value
// and n, and every slice row's key, value, and n.
// Local execution requires the fixture webServer (AGENTBOARD_CHAT_FIXTURE=1);
// CI runs it — never run test:e2e against a live kawai server.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

interface MetricRead { id: string; text: string; n: number; slices: Array<{ key: string; text: string; n: number }> | null }

function isolatedDb(): string {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse touching a non-isolated database')
  return dbPath
}

// Scripts answer through process.stdout.write: the runner sets FORCE_COLOR,
// under which bun's console.log colors a printed number.
function bunScript(script: string, input: unknown): string {
  return execFileSync('bun', ['-e', script], { cwd: process.cwd(), input: JSON.stringify(input), encoding: 'utf8' })
}

/** How many rows of `table` a session has, read from the isolated DB. */
function rowsOf(table: 'agent_starts' | 'chat_turn_usage', sessionId: string): number {
  return Number(bunScript(`
    import { Database } from 'bun:sqlite';
    const [file, table, sessionId] = JSON.parse(await Bun.stdin.text());
    const db = new Database(file, { readonly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    process.stdout.write(String(db.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE session_id = ?').get(sessionId).n));
  `, [isolatedDb(), table, sessionId]).trim())
}

async function createChat(page: Page, root: string, name: string, group: string, label: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Project Path').fill(root)
  await expect(dialog.getByLabel('Group').locator('option', { hasText: label })).toHaveCount(1)
  await dialog.getByLabel('Group').selectOption(group)
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
  const id = (await page.locator('[data-session-id^="chat-"]').filter({ hasText: name }).first().getAttribute('data-session-id'))!
  // The agent starts on attach; its start row carries the group file's hash at that moment.
  await expect.poll(() => rowsOf('agent_starts', id), { timeout: 15_000 }).toBeGreaterThan(0)
  return id
}

/** One fixture turn in the selected chat, recorded in chat_turn_usage. */
async function runTurn(page: Page, sessionId: string, text: string) {
  await page.getByLabel('Message Claude').fill(text)
  await page.getByLabel('Message Claude').press('Enter')
  await expect.poll(() => rowsOf('chat_turn_usage', sessionId), { timeout: 15_000 }).toBeGreaterThan(0)
}

/**
 * Tasks created by the lead, a result per task submitted by the dev, review
 * findings by the reviewer of each version (v1 fails 2 of 3, v2 fails 1 of 3),
 * then every task closed by the lead — all through the task tool handlers
 * bound to those sessions. Returns `team_metrics` 7d sliced by group-file hash,
 * read through its tool handler and formatted as the tab formats it.
 */
function workAndRead(root: string, ids: { lead: string; dev: string; rev1: string; rev2: string }): MetricRead[] {
  // The stores log to stdout too; the read follows the last marker.
  return JSON.parse(bunScript(`
    import { initDatabase } from './src/server/db';
    import { AssignmentStore } from './src/server/team/assignmentStore';
    import { MailboxStore } from './src/server/team/mailboxStore';
    import { TaskStore } from './src/server/team/taskStore';
    import { TaskService } from './src/server/team/TaskService';
    import { TaskResultService } from './src/server/team/TaskResultService';
    import { taskHandlers } from './src/server/team/taskTools';
    import { resolveTeam } from './src/server/team/teamIdentity';
    import { MetricsReader } from './src/server/metrics/computeMetrics';
    import { metricsHandlers } from './src/server/metrics/metricsTools';
    import { METRIC_DEF_BY_ID } from './src/shared/processMetrics';
    import { formatValue } from './src/client/components/team/metrics/metricFormat';
    import { retryOnSqliteBusy } from './src/server/__tests__/sqliteBusyRetry';
    const [file, root, ids] = JSON.parse(await Bun.stdin.text());
    const sessions = initDatabase({ path: file });
    sessions.db.exec('PRAGMA busy_timeout = 5000');
    const deps = { getSession: id => sessions.getChatSession(id) };
    const mail = new MailboxStore(sessions.db);
    const tasks = new TaskService(new TaskStore(sessions.db, mail, new AssignmentStore(sessions.db, mail)), deps);
    const results = new TaskResultService(tasks, deps);
    const lead = taskHandlers(tasks, ids.lead, results);
    const dev = taskHandlers(tasks, ids.dev, results);
    const verdicts = [[ids.rev1, 'fail'], [ids.rev1, 'fail'], [ids.rev1, 'pass'], [ids.rev2, 'pass'], [ids.rev2, 'pass'], [ids.rev2, 'fail']];
    // Each write re-runs whole on SQLITE_BUSY: the server is a second writer,
    // and the deferred read→write upgrade bypasses the busy handler.
    for (const [index, [reviewerId, verdict]] of verdicts.entries()) {
      const task = await retryOnSqliteBusy(() => lead.task_create({ title: 'Metrics task ' + (index + 1), direction: 'Build it' }));
      await retryOnSqliteBusy(() => dev.task_update_status({ task_id: task.id, status: 'active' }));
      const result = await retryOnSqliteBusy(() => dev.task_submit_result({ task_id: task.id, summary: 'Built ' + (index + 1), commit: 'c0ffee' + index }));
      await retryOnSqliteBusy(() => taskHandlers(tasks, reviewerId, results).task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', verdict, findings: verdict === 'fail' ? 'Missing tests' : 'Looks right' }));
      await retryOnSqliteBusy(() => lead.task_update_status({ task_id: task.id, status: 'done' }));
    }
    const teamId = (await resolveTeam(root)).teamId;
    const tool = metricsHandlers({ teamOf: () => teamId, reader: new MetricsReader(sessions.db) }, ids.lead);
    const read = await tool.team_metrics({ window: '7d', slice: { kind: 'groupFileHash' } });
    const text = (id, value) => formatValue(value, METRIC_DEF_BY_ID.get(id).unit);
    process.stdout.write('\\n@@metrics@@' + JSON.stringify(read.metrics.map(metric => ({
      id: metric.id, text: text(metric.id, metric.value), n: metric.n,
      slices: metric.slices ? metric.slices.map(row => ({ key: row.key, text: text(metric.id, row.value), n: row.n })) : null,
    }))));
    sessions.close();
  `, [isolatedDb(), root, ids]).split('@@metrics@@').at(-1)!)
}

/** What the Metrics tab shows for every metric row: value, n, and slice rows. */
async function readTab(page: Page): Promise<MetricRead[]> {
  return page.getByTestId('metric-row').evaluateAll(rows => rows.map(row => {
    const n = (el: Element | null) => Number((el?.textContent ?? '').replace('n=', ''))
    const slices = row.querySelector('[data-testid="metric-slices"]')
    return {
      id: row.getAttribute('data-metric-id')!,
      text: row.querySelector('[data-testid="metric-value"]')!.textContent!,
      n: n(row.querySelector('[data-testid="metric-n"]')),
      slices: slices ? [...slices.querySelectorAll('[data-testid="metric-slices-row"]')].map(cells => ({
        key: cells.getAttribute('data-key')!,
        text: cells.children[1]!.textContent!,
        n: n(cells.children[2]!),
      })) : null,
    }
  }))
}

test('team_metrics 7d sliced by reviewer prompt version matches the Metrics tab', async ({ page }, info) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-process-metrics-')))
  const groups = join(root, '.kawai/groups')
  mkdirSync(groups, { recursive: true })
  writeFileSync(join(groups, 'lead.md'), '---\nlabel: Lead\ncanCreateTasks: true\n---\nPlan the work')
  writeFileSync(join(groups, 'devs.md'), '---\nlabel: Devs\n---\nBuild what the task says')
  writeFileSync(join(groups, 'reviewers.md'), '---\nlabel: Reviewers\n---\nReview the result.')
  try {
    await page.goto('/')
    const lead = await createChat(page, root, 'Metrics lead', 'lead', 'Lead')
    const dev = await createChat(page, root, 'Metrics dev', 'devs', 'Devs')
    const rev1 = await createChat(page, root, 'Reviewer v1', 'reviewers', 'Reviewers')
    await runTurn(page, rev1, 'Review the first batch')
    // A new reviewer prompt version: the next reviewer start hashes the edited file.
    writeFileSync(join(groups, 'reviewers.md'), '---\nlabel: Reviewers\n---\nRun the tests before reading the diff, then review the result.')
    const rev2 = await createChat(page, root, 'Reviewer v2', 'reviewers', 'Reviewers')
    await runTurn(page, rev2, 'Review the second batch')

    const expected = workAndRead(root, { lead, dev, rev1, rev2 })
    const findings = expected.find(metric => metric.id === 'finding_fail_rate')!
    // Both reviewer versions appear as their own slice rows, three findings each.
    expect(findings.slices?.map(row => row.n)).toEqual([3, 3])
    expect(findings.slices?.map(row => row.text).sort()).toEqual(['33.3%', '66.7%'])
    expect(expected.find(metric => metric.id === 'tokens_total')!.slices?.length).toBe(2)

    await page.evaluate(teamKey => { window.location.hash = `#/team/${encodeURIComponent(teamKey)}/metrics` }, root)
    await expect(page.getByTestId('metrics-view')).toBeVisible()
    await page.getByTestId('metrics-window-7d').click()
    await page.getByTestId('metrics-slice').selectOption('groupFileHash')
    await page.getByTestId('metrics-refresh').click()
    for (const toggle of await page.getByTestId('metric-family-toggle').all()) {
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
    }
    await expect(page.locator('[data-metric-id="finding_fail_rate"] [data-testid="metric-slices-row"]')).toHaveCount(2)
    await page.locator('[data-testid="metric-family"][data-family="quality"]').screenshot({ path: info.outputPath('metrics-by-reviewer-version.png') })

    const shown = await readTab(page)
    expect(shown.map(metric => metric.id).sort()).toEqual(expected.map(metric => metric.id).sort())
    const byId = new Map(shown.map(metric => [metric.id, metric]))
    for (const metric of expected) expect(byId.get(metric.id), metric.id).toEqual(metric)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
