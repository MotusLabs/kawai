// Per-turn usage (team-process-metrics D1): the store writes each turn once,
// prunes past 90 days, and keeps a killed session's rows; the tracker pins
// each turn's task and agent start at turn start — mail's task (or none) for
// a mail-started turn, the session's task otherwise — so nothing that happens
// mid-turn moves it, and an interrupted turn writes nothing.
import { expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import { ChatTurnUsageStore, TURN_USAGE_RETENTION_MS, TurnUsageTracker, type TurnUsageRow } from '../chat/chatTurnUsageStore'
import { schemaDb } from './schemaDb'

const usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheCreationTokens: 4 }
const row = (overrides: Partial<TurnUsageRow> = {}): TurnUsageRow => ({
  sessionId: 'chat-a', turnId: 't-1', teamId: '/repo/.git', groupId: 'devs', profileId: 'default', model: 'm',
  taskId: 'task-1', startId: 'start-1', ok: true, usage, numTurns: 3, endedAt: '2026-10-16T00:00:00.000Z', ...overrides,
})

test('a turn is recorded once; rows past 90 days are pruned at startup', () => {
  const db = schemaDb()
  const store = new ChatTurnUsageStore(db)
  store.record(row())
  store.record(row({ usage: { ...usage, outputTokens: 999 } }))
  expect(store.forSession('chat-a')).toEqual([row()])

  const now = Date.parse('2026-10-16T00:00:00.000Z')
  store.record(row({ turnId: 't-old', endedAt: new Date(now - TURN_USAGE_RETENTION_MS - 1000).toISOString() }))
  store.record(row({ turnId: 't-kept', endedAt: new Date(now - TURN_USAGE_RETENTION_MS + 60_000).toISOString() }))
  new ChatTurnUsageStore(db, () => now)
  expect(store.forSession('chat-a').map(r => r.turnId).sort()).toEqual(['t-1', 't-kept'])
  db.close()
})

/** A tracker over a scripted session: its task and latest start can change between events. */
function harness() {
  const db = schemaDb()
  const store = new ChatTurnUsageStore(db)
  const state = { task: null as string | null, start: 'start-1' as string | null }
  const tracker = new TurnUsageTracker(store, {
    sessionTask: () => state.task,
    latestStart: () => state.start,
    context: () => ({ teamId: '/repo/.git', groupId: 'devs', profileId: 'default', model: 'm' }),
  })
  let seq = 0
  const at = () => `2026-10-16T00:00:${String(seq).padStart(2, '0')}.000Z`
  const emit = (event: Record<string, unknown>) => tracker.onEvent('chat-a', { id: `e${++seq}`, sequence: seq, at: at(), ...event } as unknown as ChatEvent)
  const started = (turnId: string) => emit({ type: 'turn_started', turnId })
  const mail = (turnId: string, taskId?: string) => emit({
    type: 'peer_message', turnId, messageId: `m-${seq}`, senderSession: 'chat-lead', body: 'hi',
    ...(taskId ? { task: { id: taskId } } : {}),
  })
  const completed = (turnId: string, extra: Record<string, unknown> = {}) => emit({ type: 'turn_completed', turnId, subtype: 'success', numTurns: 2, usage, ...extra })
  const tasks = () => store.forSession('chat-a').map(r => [r.turnId, r.taskId])
  return { db, store, state, tracker, started, mail, completed, emit, tasks }
}

test('task-less mail to a task-bound session pins no task; task mail pins its task', () => {
  const h = harness()
  h.state.task = 'task-T'
  h.started('t-1'); h.mail('t-1'); h.completed('t-1')
  h.started('t-2'); h.mail('t-2', 'task-U'); h.completed('t-2')
  h.started('t-3'); h.completed('t-3')
  expect(h.tasks()).toEqual([['t-1', null], ['t-2', 'task-U'], ['t-3', 'task-T']])
  h.db.close()
})

test('an association change or mail mid-turn neither retargets the turn nor carries over', () => {
  const h = harness()
  h.state.task = 'task-T'
  h.started('t-1')
  // Mail for another turn id (never happens mid-turn, but must not retarget) and an association change.
  h.mail('t-other', 'task-U')
  h.state.task = 'task-U'
  h.completed('t-1')
  // The next turn is human-started: the session's task at its own start, not U's mail.
  h.state.task = 'task-T'
  h.started('t-2'); h.completed('t-2')
  expect(h.tasks()).toEqual([['t-1', 'task-T'], ['t-2', 'task-T']])
  h.db.close()
})

test('the start is pinned at turn start; an interrupted turn writes nothing; an unpinned completion falls back', () => {
  const h = harness()
  h.started('t-1')
  h.state.start = 'start-2'
  h.completed('t-1')
  h.started('t-2'); h.emit({ type: 'turn_interrupted', turnId: 't-2' })
  h.state.task = 'task-late'
  h.completed('t-restart')
  h.completed('t-restart')
  const rows = h.store.forSession('chat-a')
  expect(rows.map(r => [r.turnId, r.taskId, r.startId])).toEqual([['t-1', null, 'start-1'], ['t-restart', 'task-late', 'start-2']])
  expect(rows[0]).toMatchObject({ groupId: 'devs', ok: true, numTurns: 2, usage })
  h.db.close()
})

test('a completion without usage remains unknown', () => {
  const h = harness()
  h.started('t-1'); h.completed('t-1', { usage: undefined, subtype: 'error_during_execution', numTurns: undefined })
  expect(h.store.forSession('chat-a')).toEqual([])
  h.db.close()
})
