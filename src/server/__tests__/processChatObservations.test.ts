// Managed intervals are measured from live events, never inferred from replayed text.
import { expect, test } from 'bun:test';
import type { ChatEvent, ChatContextUsage } from '../../shared/chat';
import { schemaDb } from './schemaDb';
import { observedToolTiming } from '../metrics/observations/toolTiming';
import { ProcessObservationService } from '../metrics/observations/service';
import { loadMetricsInputs } from '../metrics/metricsQuery';
import { ChatTurnUsageStore, TurnUsageTracker } from '../chat/chatTurnUsageStore';
const origin = Date.parse('2026-10-18T00:00:00Z');
function harness() {
  const db = schemaDb();
  let now = origin, sequence = 0, taskId: string | null = 'task-a', model = 'model-a';
  const identity = () => ({ teamId: 'team', sessionId: 'chat', taskId, startId: 'start-1', groupId: 'dev', model });
  const service = new ProcessObservationService(db, identity, () => now);
  service.chat.recover(); // Explicit startup inventory for this timer-free fixture.
  const emit = (data: Record<string, unknown>, second: number, turnId = 'turn') => { now = origin + second * 1000; service.chat.event('chat', { id: `e${++sequence}`, at: new Date(now).toISOString(), turnId, ...data } as ChatEvent); };
  const rows = () => service.store.forTeam('team');
  return { db, service, emit, rows, identity, time: (s: number) => { now = origin + s * 1000; }, task: (id: string | null) => { taskId = id; }, model: (value: string) => { model = value; } };
}
// @covers: process-observations › Turn timing includes non-completing outcomes › Interrupted turn
test('turn identity is pinned, task-less peer mail clears it, missing usage stays unknown', () => {
  const h = harness();
  h.emit({ type: 'turn_started' }, 0);
  h.task('later-task');
  h.emit({ type: 'peer_message', task: undefined }, 1);
  h.emit({ type: 'tool_call', toolCallId: 'bash', tool: 'Bash' }, 2);
  h.task('another-task');
  h.model('edited-catalog-model');
  h.emit({ type: 'turn_interrupted' }, 3);
  const end = h.rows().find(r => r.kind === 'turn_ended')!;
  expect(end).toMatchObject({ taskId: null, startId: 'start-1', model: 'model-a', data: { usageAvailable: false, outcome: 'interrupted' } });
  // The interrupted turn keeps its known execution time instead of a zeroed duration.
  expect(end.data.durationSeconds).toBe(3);
  expect(h.rows().filter(r => r.kind === 'usage')).toEqual([]);
  expect(h.rows().find(r => r.kind === 'tool')).toMatchObject({ taskId: null });
  h.db.close();
});
test('overlapping tools retain independent time while concurrent approval waits are subtracted once', () => {
  const h = harness();
  h.emit({ type: 'turn_started' }, 0);
  h.service.chat.activity('chat', { phase: 'thinking', since: new Date(origin).toISOString() } as never);
  h.emit({ type: 'tool_call', tool: 'Bash', toolCallId: 'a' }, 1);
  h.emit({ type: 'tool_call', tool: 'Read', toolCallId: 'b' }, 2);
  h.emit({ type: 'approval_request', requestId: 'r1' }, 3);
  h.emit({ type: 'question_request', requestId: 'r2' }, 4);
  h.emit({ type: 'request_resolved', requestId: 'r1', outcome: 'allowed' }, 5);
  h.emit({ type: 'request_resolved', requestId: 'r2', outcome: 'answered' }, 7);
  h.emit({ type: 'tool_result', toolCallId: 'a' }, 10);
  h.emit({ type: 'tool_result', toolCallId: 'b' }, 12);
  h.emit({ type: 'turn_completed', subtype: 'success' }, 14);
  expect(h.rows().filter(r => r.kind === 'tool').map(r => r.data.durationSeconds)).toEqual([5, 6]);
  expect(h.rows().find(r => r.kind === 'turn_ended')?.data).toMatchObject({ thinkingSeconds: 3, requestingSeconds: 0, unmatchedResolutions: 0 });
  expect(observedToolTiming(h.rows())).toEqual({ sumSeconds: 11, unionSeconds: 7 });
  // No background task level-set is consumed; an idle task cannot extend the turn.
  expect(h.rows().filter(r => r.kind === 'turn_ended')).toHaveLength(1);
  h.db.close();
});
test('restart closes only known intervals at the checkpoint and marks the unobserved gap', () => {
  const h = harness();
  h.emit({ type: 'turn_started' }, 0);
  h.service.chat.activity('chat', { phase: 'thinking' } as never);
  h.time(20);
  h.service.chat.checkpoint();
  h.time(500);
  const restarted = new ProcessObservationService(h.db, h.identity, () => origin + 500000);
  restarted.chat.recover();
  restarted.chat.recover();
  expect(h.rows().filter(r => r.kind === 'turn_ended')).toHaveLength(1);
  expect(h.rows().find(r => r.kind === 'turn_ended')?.data).toMatchObject({ durationSeconds: 20, partial: true, usageAvailable: false });
  expect(h.rows().find(r => r.kind === 'gap')?.data).toMatchObject({ since: new Date(origin + 20000).toISOString(), until: new Date(origin + 500000).toISOString() });
  h.db.close();
});
test('failed interval transaction leaves its live checkpoint retryable', () => {
  const h = harness();
  h.emit({ type: 'turn_started' }, 0);
  h.service.store.accumulate = () => { throw Error('disk full'); };
  h.emit({ type: 'turn_completed', subtype: 'success' }, 5);
  expect(h.rows().filter(r => r.kind === 'turn_ended')).toHaveLength(0);
  expect(h.db.prepare('SELECT count(*) n FROM process_live_observations').get()).toEqual({ n: 1 });
  h.service.store.accumulate = undefined;
  h.emit({ type: 'turn_completed', subtype: 'success' }, 6);
  expect(h.rows().filter(r => r.kind === 'turn_ended')).toHaveLength(1);
  expect(h.db.prepare("SELECT count(*) n FROM process_observations WHERE kind='gap'").get()).toEqual({ n: 1 });
  h.db.close();
});
// @covers: process-observations › Context and compaction are structured observations › Boundary without post size
// @covers: process-observations › Context and compaction are structured observations › Approximate threshold
test('context deltas coalesce but thresholds, turn end and compaction boundaries remain exact', () => {
  const h = harness();
  h.emit({ type: 'turn_started' }, 0);
  const sample = (usedTokens: number, thresholdTokens = 100000): ChatContextUsage => ({ usedTokens, thresholdTokens, thresholdApproximate: true, at: new Date(origin + usedTokens).toISOString() } as ChatContextUsage);
  for (let i = 0; i < 100; i++) {
    h.time(i / 10);
    h.service.chat.context('chat', sample(i));
  }
  expect(h.rows().filter(r => r.kind === 'context')).toHaveLength(1);
  h.service.chat.context('chat', sample(200, 150000));
  h.service.chat.compaction('chat', { trigger: 'auto', preTokens: 200, postTokens: null, durationSeconds: null, outcome: 'completed' });
  h.emit({ type: 'turn_completed', subtype: 'success' }, 12);
  expect(h.rows().filter(r => r.kind === 'context')).toHaveLength(4);
  expect(h.rows().find(r => r.kind === 'compaction')?.data).toMatchObject({ postTokens: null, durationSeconds: null });
  expect(h.rows().filter(r => r.kind === 'context').every(r => r.data.approximate)).toBe(true);
  h.db.close();
});
test('repeated SDK compaction identities count once across callbacks and restart', () => {
  const h = harness(), data = { trigger: 'auto', preTokens: 200, postTokens: null, durationSeconds: null, outcome: 'completed' };
  h.service.chat.compaction('chat', data, 'boundary:uuid');
  h.service.chat.compaction('chat', data, 'boundary:uuid');
  const restarted = new ProcessObservationService(h.db, h.identity, () => origin);
  restarted.chat.compaction('chat', data, 'boundary:uuid');
  expect(h.rows().filter(r => r.kind === 'compaction')).toHaveLength(1);
  expect((h.db.prepare("SELECT sum(value) n FROM process_export_totals WHERE family='agent_compactions_total' AND bucket='value'").get() as {
    n: number;
  }).n).toBe(1);
  h.db.close();
});
// @covers: process-observations › Observations cover managed work only › Task-less coordination
test('a task-less lead turn carries team and chat identities and never joins a task execution', () => {
  const h = harness();
  h.task(null);
  h.emit({ type: 'turn_started' }, 0);
  h.emit({ type: 'tool_call', tool: 'Bash', toolCallId: 'lead-1' }, 1);
  h.emit({ type: 'tool_result', toolCallId: 'lead-1' }, 4);
  h.emit({ type: 'turn_completed', subtype: 'success' }, 5);
  expect(h.rows().filter(r => r.kind === 'tool' || r.kind === 'turn_ended').map(r => [r.kind, r.teamId, r.sessionId, r.taskId])).toEqual([
    ['tool', 'team', 'chat', null],
    ['turn_ended', 'team', 'chat', null],
  ]);
  // A task-bound turn afterwards: its measured execution through
  // loadMetricsInputs holds its own call alone, not the lead's work.
  h.task('task-a');
  h.emit({ type: 'turn_started' }, 10, 'task-turn');
  h.emit({ type: 'tool_call', tool: 'Bash', toolCallId: 'task-1' }, 11, 'task-turn');
  h.emit({ type: 'tool_result', toolCallId: 'task-1' }, 13, 'task-turn');
  h.emit({ type: 'turn_completed', subtype: 'success' }, 14, 'task-turn');
  const inputs = loadMetricsInputs(h.db, 'team', origin, origin + 20000).toolInputs!;
  expect(inputs.observations.map(r => [r.kind, r.taskId, r.data.durationSeconds])).toEqual([
    ['tool', null, 3],
    ['tool', 'task-a', 2],
  ]);
  h.db.close();
});
// @covers: process-observations › Observation ingestion is idempotent and non-blocking › Duplicate completion
test('a turn completion delivered twice records its duration and usage once', () => {
  const h = harness();
  const usage = new ChatTurnUsageStore(h.db, () => origin);
  const tracker = new TurnUsageTracker(usage, {
    sessionTask: () => null,
    latestStart: () => 'start-1',
    context: () => ({ teamId: 'team', groupId: 'dev', profileId: 'default', model: 'model-a' }),
  });
  h.emit({ type: 'turn_started' }, 0);
  const completion = {
    id: 'evt-done', at: new Date(origin + 5000).toISOString(), turnId: 'turn',
    type: 'turn_completed', subtype: 'success', numTurns: 2,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  } as unknown as ChatEvent;
  h.service.chat.event('chat', completion);
  tracker.onEvent('chat', completion);
  h.service.chat.event('chat', completion); // the same completion reaches the recorder twice
  tracker.onEvent('chat', completion);
  h.service.reconcile.run();
  h.service.reconcile.run();
  expect(h.rows().filter(r => r.kind === 'turn_ended')).toHaveLength(1);
  expect(h.rows().filter(r => r.kind === 'usage').map(r => r.data)).toEqual([
    { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, steps: 2, outcome: 'success', scope: 'completed-main-loop' },
  ]);
  const total = (family: string, bucket: string) => (h.db.prepare('SELECT sum(value) v FROM process_export_totals WHERE family=? AND bucket=?').get(family, bucket) as { v: number | null }).v;
  expect(total('agent_turn_duration_seconds', 'count')).toBe(1);
  expect(total('agent_turn_duration_seconds', 'sum')).toBe(5);
  expect(total('agent_tokens_total', 'value')).toBe(15);
  h.db.close();
});
