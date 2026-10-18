// Exposition survives missed scrapes and restarts; labels and authorization stay bounded.
import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { schemaDb } from './schemaDb';
import { ProcessObservationService } from '../metrics/observations/service';
import { MetricsSnapshot } from '../metrics/export/snapshot';
import { BoundedLabels } from '../metrics/export/boundedLabels';
import { REGISTRY } from '../metrics/export/registry';
import { renderMetrics } from '../metrics/export/renderer';
import { registerMetricsRoute } from '../metrics/export/route';
const origin = Date.parse('2026-10-18T00:00:00Z');
function harness() {
  const db = schemaDb();
  let now = origin;
  const service = new ProcessObservationService(db, () => ({ teamId: '/private/repo', groupId: 'dev', model: 'original' }), () => now);
  const record = (key: string, value = 42) => service.store.record({ sourceKey: key, teamId: '/private/repo', groupId: 'dev', model: 'original', kind: 'usage', observedAt: new Date(now).toISOString(), data: { input: value, output: 2, cacheRead: 0, cacheCreation: 0, scope: 'completed-main-loop' } });
  return { db, service, record, time: (ms: number) => { now = origin + ms; } };
}
test('lifetime histogram and token totals survive restart, transaction rollback, replay and detail pruning', () => {
  const h = harness(), original = h.service.store.accumulate!;
  h.service.store.accumulate = row => { original(row); throw Error('rollback after aggregate writes'); };
  expect(() => h.record('usage:one')).toThrow();
  expect(h.db.prepare("SELECT count(*) n FROM process_export_totals WHERE bucket!='admitted'").get()).toEqual({ n: 0 });
  h.service.store.accumulate = original;
  h.record('usage:one');
  h.record('usage:one', 999);
  const first = new MetricsSnapshot(h.service).read();
  expect(first).toContain('kind="input"} 42');
  expect(first).toContain('kind="input",le="1000"} 1');
  expect(first).toContain('kind="input",le="+Inf"} 1');
  expect(first).not.toContain('/private/repo');
  h.time(91 * 86400000);
  h.service.store.prune();
  const restarted = new ProcessObservationService(h.db, () => ({}), () => origin + 91 * 86400000);
  const before = new MetricsSnapshot(restarted).read();
  expect(before).toContain('kind="input"} 42');
  expect(h.record('usage:one', 999)).toBeNull();
  h.db.close();
});
test('catalog churn and thousands of task/session identifiers cannot create unbounded labels', () => {
  const h = harness();
  for (let i = 0; i < 2000; i++)
    h.service.store.record({ sourceKey: `turn:${i}`, teamId: '/private/repo', groupId: 'dev', model: 'original', sessionId: `session-${i}`, taskId: `task-${i}`, turnId: `turn-${i}`, kind: 'turn_ended', observedAt: new Date(origin).toISOString(), data: { durationSeconds: 2, outcome: 'success', partial: false } });
  expect(h.db.prepare("SELECT count(*) n FROM process_export_totals WHERE family='agent_turn_duration_seconds' AND bucket='count'").get()).toEqual({ n: 1 });
  const bounds = new BoundedLabels(h.db, 250000, 4);
  for (let i = 0; i < 200; i++)
    bounds.labels('agent_tokens_total', { team: `repo-${i}`, group: `group-${i}`, provider: `provider-${i}`, model: `model-${i}`, kind: 'input' });
  for (const [dimension, cap] of [['team', 32], ['provider', 32], ['model', 64]] as const)
    expect((h.db.prepare('SELECT count(*) n FROM process_export_aliases WHERE dimension=?').get(dimension) as {
      n: number;
    }).n).toBeLessThanOrEqual(cap);
  expect((h.db.prepare("SELECT count(*) n FROM process_export_totals WHERE family='agent_tokens_total' AND bucket='admitted'").get() as {
    n: number;
  }).n).toBeLessThanOrEqual(4);
  const text = new MetricsSnapshot(h.service).read();
  expect(text).not.toContain('session-1999');
  expect(text).not.toContain('task-1999');
  expect(text).toContain('kawai_export_label_overflow_total');
  const restarted = new BoundedLabels(h.db);
  expect(restarted.labels('task_results_total', { team: '/private/repo' })).toEqual({ team: 'team_1' });
  h.db.close();
});
test('admission counts expanded buckets and reserves space for overflow diagnostics', () => {
  const db = schemaDb(), bounds = new BoundedLabels(db, 250, 10000);
  for (let i = 0; i < 100; i++)
    bounds.labels('agent_turn_duration_seconds', { team: `t${i}`, group: `g${i}`, provider: `p${i}`, model: `m${i}`, outcome: 'success' });
  expect(bounds.expandedSeries()).toBeLessThanOrEqual(250);
  expect(bounds.labels('agent_turn_duration_seconds', { team: 'overflow', outcome: 'success' })).toEqual(Object.fromEntries(REGISTRY.agent_turn_duration_seconds!.labels.map(label => [label, 'other'])));
  db.close();
});
test('renderer escapes labels and produces HELP, TYPE, cumulative buckets, count and sum', () => {
  const text = renderMetrics([{ family: 'agent_tokens_total', labels: { team: 'a"b\\c\nd' }, bucket: 'value', value: 7 }]);
  expect(text).toContain('# HELP kawai_agent_tokens_total');
  expect(text).toContain('# TYPE kawai_agent_tokens_total counter');
  expect(text).toContain('team="a\\"b\\\\c\\nd"');
});
test('snapshot is cached for five seconds and unavailable adapters emit availability without fabricated samples', () => {
  const h = harness(), snapshot = new MetricsSnapshot(h.service);
  h.record('one');
  const before = snapshot.read();
  h.record('two');
  expect(snapshot.read()).toBe(before);
  h.time(5001);
  const after = snapshot.read();
  expect(after).toContain('kind="input"} 84');
  for (const source of ['provider-quota', 'canonical-stage', 'canonical-incident'])
    expect(after).toContain(`kawai_measurement_source_available{source="${source}"} 0`);
  for (const name of ['provider_quota_used_ratio', 'limit_incidents_total', 'task_stage_duration_seconds'])
    expect(after).not.toContain(`kawai_${name}`);
  h.db.close();
});
test('disabled or invalid configuration keeps core recording working; unauthorized scrapes never read storage', async () => {
  const h = harness();
  for (const env of [{}, { KAWAI_METRICS_ENABLED: 'true' }, { KAWAI_METRICS_ENABLED: 'invalid', KAWAI_METRICS_TOKEN: 'secret' }]) {
    const app = new Hono();
    expect(registerMetricsRoute(app, h.service, env)).toBe(false);
    expect((await app.request('/metrics')).status).toBe(404);
  }
  h.record('while-disabled');
  const app = new Hono();
  registerMetricsRoute(app, h.service, { KAWAI_METRICS_ENABLED: 'true', KAWAI_METRICS_TOKEN: 'secret' });
  expect((await app.request('/metrics', { headers: { Authorization: 'Bearer secret' } })).status).toBe(200);
  h.db.close();
  expect((await app.request('/metrics')).status).toBe(401);
  expect((await app.request('/metrics', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  expect((await app.request('/metrics', { headers: { Authorization: 'Bearer secret' } })).status).toBe(200); // cached snapshot remains available
  // Fresh cache with broken storage fails only its endpoint.
  const unavailable = new Hono();
  registerMetricsRoute(unavailable, h.service, { KAWAI_METRICS_ENABLED: 'true', KAWAI_METRICS_TOKEN: 'secret' });
  expect((await unavailable.request('/metrics', { headers: { Authorization: 'Bearer secret' } })).status).toBe(503);
});
