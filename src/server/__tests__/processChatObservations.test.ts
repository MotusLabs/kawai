// Managed intervals are measured from live events, never inferred from replayed text.
import { expect, test } from 'bun:test';
import type { ChatEvent, ChatContextUsage } from '../../shared/chat';
import { schemaDb } from './schemaDb';
import { observedToolTiming } from '../metrics/observations/toolTiming';
import { ProcessObservationService } from '../metrics/observations/service';
const origin = Date.parse('2026-10-18T00:00:00Z');
function harness() {
  const db = schemaDb();
  let now = origin, sequence = 0, taskId: string | null = 'task-a', model = 'model-a';
  const identity = () => ({ teamId: 'team', sessionId: 'chat', taskId, startId: 'start-1', groupId: 'dev', model });
  const service = new ProcessObservationService(db, identity, () => now);
  const emit = (data: Record<string, unknown>, second: number) => { now = origin + second * 1000; service.chat.event('chat', { id: `e${++sequence}`, at: new Date(now).toISOString(), turnId: 'turn', ...data } as ChatEvent); };
  const rows = () => service.store.forTeam('team');
  return { db, service, emit, rows, identity, time: (s: number) => { now = origin + s * 1000; }, task: (id: string | null) => { taskId = id; }, model: (value: string) => { model = value; } };
}
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
  expect(h.rows().filter(r => r.kind === 'tool' && r.data.durationSeconds !== null).map(r => r.data.durationSeconds)).toEqual([5, 6]);
  expect(h.rows().find(r => r.kind === 'activity')?.data.durationSeconds).toBe(3);
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
