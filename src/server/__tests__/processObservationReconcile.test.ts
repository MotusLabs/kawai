// Recovery reads operational rows after commit; collection cannot roll back acceptance or mail.
import { expect, test } from 'bun:test';
import { schemaDb } from './schemaDb';
import { AssignmentStore } from '../team/assignmentStore';
import { TaskStore } from '../team/taskStore';
import { MailboxStore } from '../team/mailboxStore';
import { loadMetricsInputs } from '../metrics/metricsQuery';
import { ChatTurnUsageStore } from '../chat/chatTurnUsageStore';
import { ProcessObservationService } from '../metrics/observations/service';
const at = '2026-10-18T00:00:00.000Z';
const accepted = '2026-10-18T00:01:00.000Z';
const nextMicrotask = () => new Promise<void>(resolve => queueMicrotask(resolve));
test('post-commit acceptance and mailbox settlement survive recorder failure, recover once with identities', async () => {
  const db = schemaDb(), tasks = new TaskStore(db), mail = new MailboxStore(db);
  const service = new ProcessObservationService(db, () => ({}), () => Date.parse(accepted));
  service.start([notify => tasks.subscribe(task => notify(task.id)), notify => mail.subscribe((_team, message) => notify(message?.taskId ?? undefined))]);
  const task = tasks.create({ teamId: 'team', title: 'private title', direction: 'private direction', creator: { kind: 'human', sessionId: null } }, at);
  const result = tasks.results.insert({ teamId: 'team', taskId: task.id, taskRevision: 1, summary: 'private summary', commit: null, diff: null, worktree: null, tests: [], limitations: null, submittedBy: { kind: 'agent', sessionId: 'dev' } }, at);
  service.store.accumulate = () => { throw Error('unavailable'); };
  tasks.setStatus(task.id, 'done', () => { tasks.results.markAccepted(result.id, { kind: 'human', sessionId: null }, accepted); }, { kind: 'human', sessionId: null }, accepted);
  const message = mail.enqueue({ teamId: 'team', fromSession: null, fromGroup: null, toKind: 'group', toId: 'dev', originPath: '/private/repo', body: 'private body', taskId: task.id }, at);
  mail.cancel(message.id, { kind: 'human' });
  await nextMicrotask();
  expect(tasks.get(task.id)?.status).toBe('done');
  expect(tasks.results.get(result.id)?.acceptedAt).toBe(accepted);
  expect(mail.get(message.id)?.state).toBe('cancelled');
  expect(service.recorder.failures).toBeGreaterThan(0);
  // Restoring collection (new service as on restart) reconciles committed sources.
  service.stop();
  const recovered = new ProcessObservationService(db, () => ({}), () => Date.parse(accepted));
  const priorFailures = recovered.recorder.failures;
  recovered.reconcile.run();
  recovered.reconcile.task(task.id);
  recovered.reconcile.run();
  const rows = recovered.store.forTeam('team'), acceptances = rows.filter(row => row.kind === 'acceptance');
  expect(acceptances).toHaveLength(1);
  expect(acceptances[0]).toMatchObject({ taskId: task.id, resultId: result.id, taskRevision: 1, data: { actorKind: 'human', mechanism: 'manual', first: true, durationSeconds: 60 } });
  expect(rows.filter(row => row.kind === 'mail').length).toBeGreaterThan(0);
  expect(JSON.stringify(rows)).not.toContain('private');
  expect(recovered.store.forTeam('another-team')).toEqual([]);
  expect(recovered.recorder.failures).toBe(priorFailures);
  db.close();
});
test('pruned usage rowids can be reused without losing or duplicating a later turn', () => {
  const db = schemaDb(), service = new ProcessObservationService(db, () => ({}), () => Date.parse(at)), usage = new ChatTurnUsageStore(db, () => Date.parse(at));
  const row = { sessionId: 's', turnId: 'first', teamId: 'team', groupId: null, profileId: null, model: null, taskId: null, startId: null, ok: true, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }, numTurns: 1, endedAt: at };
  usage.record(row);
  service.reconcile.run();
  db.exec('DELETE FROM chat_turn_usage');
  usage.record({ ...row, turnId: 'second' });
  service.reconcile.run();
  service.reconcile.run();
  expect(service.store.forTeam('team').filter(r => r.kind === 'usage')).toHaveLength(2);
  db.close();
});
test('75-day usage survives retention while older rows prune in bounded batches and coverage stays partial', () => {
  const db = schemaDb(), now = Date.parse(at), store = new ChatTurnUsageStore(db, () => now);
  const row = { sessionId: 's', turnId: 'recent', teamId: 'team', groupId: null, profileId: null, model: null, taskId: null, startId: null, ok: true, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }, numTurns: 1, endedAt: new Date(now - 75 * 86400000).toISOString() };
  store.record(row);
  for (let n = 0; n < 600; n++)
    store.record({ ...row, turnId: `old-${n}`, endedAt: new Date(now - 91 * 86400000).toISOString() });
  new ChatTurnUsageStore(db, () => now);
  expect(store.forSession('s')).toHaveLength(101);
  expect(store.forSession('s').some(r => r.turnId === 'recent')).toBe(true);
  new ChatTurnUsageStore(db, () => now);
  expect(store.forSession('s')).toHaveLength(1);
  const inputs = loadMetricsInputs(db, 'team', now - 7 * 86400000, now);
  expect(inputs.usageHorizon).toBe(now - 75 * 86400000);
  expect(inputs.usageHorizon).toBeGreaterThan(now - 90 * 86400000); // no invented coverage for previously pruned history
  db.close();
});
test('handoff and finding references survive replay, and reopen or repeated acceptance never recounts the first result', () => {
  const db = schemaDb(), mail = new MailboxStore(db), tasks = new TaskStore(db), assignments = new AssignmentStore(db, mail);
  const service = new ProcessObservationService(db, () => ({}), () => Date.parse(accepted));
  const task = tasks.create({ teamId: 'team', title: 't', direction: 'd', creator: { kind: 'human', sessionId: null } }, at);
  const result = tasks.results.insert({ teamId: 'team', taskId: task.id, taskRevision: 1, summary: 's', commit: null, diff: null, worktree: null, tests: [], limitations: null, submittedBy: { kind: 'agent', sessionId: 'dev' } }, at);
  const message = mail.enqueue({ teamId: 'team', fromSession: 'dev', fromGroup: 'devs', toKind: 'group', toId: 'reviewers', originPath: '/repo', body: 'not copied', taskId: task.id }, at);
  const assignment = assignments.insert({ teamId: 'team', taskId: task.id, requestKey: 'review', targetKind: 'group', targetId: 'reviewers', role: 'reviewers', instruction: 'not copied', creator: { kind: 'agent', sessionId: 'dev' }, messageId: message.id, handoff: { kind: 'review', resultId: result.id, expectedResponse: null } }, at).assignment;
  tasks.results.insertFindings({ teamId: 'team', taskId: task.id, resultId: result.id, handoffId: assignment.id, kind: 'review', verdict: 'pass', findings: 'not copied', author: { kind: 'agent', sessionId: 'reviewer' } }, accepted);
  tasks.results.markAccepted(result.id, { kind: 'human', sessionId: null }, accepted);
  tasks.setStatus(task.id, 'done');
  service.reconcile.run();
  const first = service.store.forTeam('team');
  expect(first.find(row => row.kind === 'finding')).toMatchObject({ assignmentId: assignment.id, resultId: result.id, actorSession: 'reviewer', taskRevision: 1 });
  expect(first.find(row => row.kind === 'assignment')).toMatchObject({ assignmentId: assignment.id, resultId: result.id, taskRevision: 1, data: { handoffKind: 'review' } });
  tasks.setStatus(task.id, 'active');
  tasks.results.markAccepted(result.id, { kind: 'human', sessionId: null }, '2026-10-18T00:02:00Z');
  service.reconcile.task(task.id);
  service.reconcile.task(task.id);
  expect(service.store.forTeam('team').filter(row => row.kind === 'acceptance')).toHaveLength(1);
  expect((db.prepare("SELECT sum(value) n FROM process_export_totals WHERE family='task_acceptance_duration_seconds' AND bucket='count'").get() as {
    n: number;
  }).n).toBe(1);
  db.close();
});
test('detail retention drains a backlog in bounded subsequent ticks without waiting another hour', () => {
  const db = schemaDb();
  let now = Date.parse(at);
  const service = new ProcessObservationService(db, () => ({}), () => now);
  for (let i = 0; i < 1001; i++)
    service.store.record({ sourceKey: `old:${i}`, kind: 'turn_started', observedAt: at, data: {} });
  now += 91 * 86400000;
  const count = () => Number((db.prepare('SELECT count(*) n FROM process_observations').get() as {
    n: number;
  }).n);
  service.tick();
  expect(count()).toBe(501);
  service.tick();
  expect(count()).toBe(1);
  service.tick();
  expect(count()).toBe(0);
  expect(service.store.checkpoint('last-prune')).toBe(String(now));
  db.close();
});
test('landing acceptance requires the system actor and the exact landed result rather than any landing on the task', () => {
  const db = schemaDb(), tasks = new TaskStore(db), service = new ProcessObservationService(db, () => ({}), () => Date.parse(accepted));
  for (const [name, actor] of [['manual', 'human'], ['landed', 'system']] as const) {
    const task = tasks.create({ teamId: 'team', title: name, direction: 'd', creator: { kind: 'human', sessionId: null } }, at);
    const result = tasks.results.insert({ teamId: 'team', taskId: task.id, taskRevision: 1, summary: 's', commit: null, diff: null, worktree: null, tests: [], limitations: null, submittedBy: { kind: 'agent', sessionId: 'dev' } }, at);
    db.prepare('INSERT INTO plan_execution_changes(execution_id,change,team_id,position,state,task_id,updated_at) VALUES (?,?,?,0,?,?,?)').run(name, name, 'team', 'landed', task.id, accepted);
    db.prepare('INSERT INTO plan_execution_rounds(id,execution_id,change,attempt_id,number,result_id,commit_sha,fix_round) VALUES (?,?,?,?,1,?,?,0)').run(name, name, name, 'attempt', result.id, 'head');
    db.prepare('INSERT INTO plan_change_landings(plan_id,change,execution_id,team_id,mechanism,head_sha,base_sha,merge_sha,landed_at,tree_verified) VALUES (?,?,?,?,?,?,?,?,?,1)').run(name, name, name, 'team', 'direct', 'head', 'base', 'merge', accepted);
    tasks.results.markAccepted(result.id, { kind: actor, sessionId: null }, accepted);
  }
  service.reconcile.run();
  const rows = service.store.forTeam('team').filter(row => row.kind === 'acceptance');
  expect(rows.map(row => [row.data.actorKind, row.data.mechanism]).sort()).toEqual([['human', 'manual'], ['system', 'direct-landing']]);
  db.close();
});
