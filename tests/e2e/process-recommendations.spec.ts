// Incident advice in the Metrics tab (process-quota-history-and-incident-
// advice 4.6, contract r2 V4), against the SDK-free fixture and the isolated
// durable DB. A fixture quota incident is seeded through the production
// stores and evaluator: glm on zai hit a final limit, kimi on moon was
// observed with fresh capacity two minutes earlier, and glm-flash shares the
// limited account. The Metrics tab lists the incident with its advice, and
// its detail shows the alternatives with freshness, the exclusion, the
// provisional flag and the unknowns — read from the snapshot, with no
// Prometheus configured.
// Local execution requires the fixture webServer (AGENTBOARD_CHAT_FIXTURE=1);
// CI runs it — never run test:e2e against a live kawai server.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

function isolatedDb(): string {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse touching a non-isolated database')
  return dbPath
}

// Scripts answer through process.stdout.write after a marker: the stores log to stdout too.
function bunScript(script: string, input: unknown): string {
  return execFileSync('bun', ['-e', script], { cwd: process.cwd(), input: JSON.stringify(input), encoding: 'utf8' })
}

async function createChat(page: Page, root: string, name: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Project Path').fill(root)
  await expect(dialog.getByLabel('Group').locator('option', { hasText: 'Devs' })).toHaveCount(1)
  await dialog.getByLabel('Group').selectOption('devs')
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
}

/** The fixture incident, through RecommendationStore, QuotaObservationStore and evaluateIncident; returns its id. */
function seedIncident(root: string): string {
  return bunScript(`
    import { Database } from 'bun:sqlite';
    import { RecommendationStore } from './src/server/metrics/recommendations/store';
    import { QuotaObservationStore } from './src/server/metrics/observations/quotaObservations';
    import { assessmentState, evaluateIncident } from './src/server/metrics/recommendations/evaluator';
    import { resolveTeam } from './src/server/team/teamIdentity';
    const [file, root] = JSON.parse(await Bun.stdin.text());
    const db = new Database(file);
    db.exec('PRAGMA busy_timeout = 5000');
    const teamId = (await resolveTeam(root)).teamId;
    const now = Date.now();
    const observedAt = new Date(now - 120000).toISOString();
    const history = new QuotaObservationStore(db);
    history.record({ teams: [teamId], providerId: 'moon', accountAlias: 'moon@moon.test', accountScope: 'scope-moon', accountBasis: 'routed',
      reason: 'worker', outcome: 'supported', observedAt,
      report: { status: 'allowed', source: 'provider', receivedAt: observedAt,
        windows: [{ key: 'zai:time_limit', label: 'Tool calls', percentUsed: 40, resetsAt: null }] } });
    const snapshot = {
      version: 1,
      limited: { profileId: 'glm', providerId: 'zai', accountScope: 'scope-zai', window: 'five_hour',
        resetsAt: new Date(now + 3600000).toISOString(), cooldownUntil: new Date(now + 3600000).toISOString() },
      group: { id: 'devs', max: 2, live: 1 },
      candidates: [
        { profileId: 'kimi', providerId: 'moon', accountScope: 'scope-moon', cooldownUntil: null, cap: null, live: 0, sharesLoginWith: [], restriction: null },
        { profileId: 'glm-flash', providerId: 'zai', accountScope: 'scope-zai', cooldownUntil: null, cap: null, live: 0, sharesLoginWith: [], restriction: null },
      ],
      writer: { required: false, occupants: [] },
    };
    const store = new RecommendationStore(db);
    const cutoff = new Date(now).toISOString();
    const { recommendation } = store.create({ teamId, kind: 'quota', episodeKey: 'e2e:quota:zai', sessionId: null, taskId: null, groupId: 'devs',
      profileId: 'glm', providerId: 'zai', attentionId: null, cutoff, snapshot, snapshotBasis: 'incident' });
    const evaluation = evaluateIncident({ kind: 'quota', snapshot, cutoff: now, observations: history.list(teamId, { until: cutoff }),
      limits: [], open: true, comparisons: 0 });
    if (!store.append(recommendation.id, evaluation, cutoff, previous => assessmentState(previous, evaluation.advice))) throw new Error('no assessment');
    db.close();
    process.stdout.write('@@id@@' + recommendation.id);
  `, [isolatedDb(), root]).split('@@id@@').at(-1)!.trim()
}

// @covers: process-recommendations › Incident advice is available before statistical baselines › First quota incident
test('a fixture quota incident shows its advice, alternatives, freshness, constraints and uncertainty in the Metrics tab', async ({ page }, info) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-process-advice-')))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/devs.md'), '---\nlabel: Devs\n---\nBuild what the task says')
  try {
    await page.goto('/')
    await createChat(page, root, 'Advice dev')
    const id = seedIncident(root)
    await page.evaluate(teamKey => { window.location.hash = `#/team/${encodeURIComponent(teamKey)}/metrics` }, root)
    await expect(page.getByTestId('metrics-view')).toBeVisible()
    await page.getByTestId('metrics-refresh').click()
    const row = page.locator(`[data-testid="advice-row"][data-recommendation="${id}"]`)
    await expect(row).toContainText('Quota limit · glm on zai')
    await expect(row).toContainText('Switch to an alternative')
    await row.getByRole('button').click()
    const detail = page.getByTestId('advice-detail')
    await expect(detail).toBeVisible()
    const kimi = detail.locator('[data-testid="advice-alternative"][data-profile="kimi"]')
    await expect(kimi.getByTestId('advice-headroom')).toHaveText('fresh capacity')
    await expect(kimi.getByTestId('advice-freshness')).toContainText('zai:time_limit 40% · 2 min old')
    await expect(detail.locator('[data-testid="advice-alternative"][data-profile="glm-flash"]').getByTestId('advice-exclusion'))
      .toContainText('shares the limited account')
    await expect(detail.getByTestId('advice-provisional').first()).toBeVisible()
    await expect(detail.getByTestId('advice-unknowns').first()).toContainText('unknown')
    await expect(detail).toContainText('saving unknown')
    await page.getByTestId('incident-advice').screenshot({ path: info.outputPath('incident-advice.png') })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
