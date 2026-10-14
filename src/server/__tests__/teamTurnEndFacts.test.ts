// The summary's incremental turn-end ledger (team-workspace review item 3):
// live events append, each task-bound session's transcript replays exactly
// once, and killed sessions prune.
import { describe, expect, test } from 'bun:test'
import { TurnEndFacts } from '../team/turnEndFacts'
import type { ChatSessionRecord } from '../db'

const record = (sessionId: string, overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId,
  name: sessionId,
  projectPath: '/repo',
  sdkSessionId: 'sdk-' + sessionId,
  status: 'waiting',
  createdAt: '2026-10-14T00:00:00Z',
  lastActivityAt: '2026-10-14T01:00:00Z',
  taskId: 'task-1',
  ...overrides,
})

const historyOf = (events: Record<string, Array<{ type: string; at: string }>>) => {
  const calls: string[] = []
  const facts = new TurnEndFacts(sessionId => {
    calls.push(sessionId)
    return events[sessionId] ?? null
  })
  return { facts, calls }
}

describe('TurnEndFacts', () => {
  test('a task-bound session seeds once; later reads and turn ends never replay', () => {
    const { facts, calls } = historyOf({
      'chat-1': [{ type: 'turn_completed', at: '2026-10-14T08:00:00Z' }],
    })
    const records = [record('chat-1')]
    expect(facts.forRecords(records)).toEqual([{ sessionId: 'chat-1', taskId: 'task-1', at: '2026-10-14T08:00:00Z' }])
    facts.record('chat-1', 'task-1', '2026-10-14T09:00:00Z')
    expect(facts.forRecords(records)).toHaveLength(2)
    facts.record('chat-1', 'task-1', '2026-10-14T09:30:00Z')
    expect(facts.forRecords(records)).toHaveLength(3)
    expect(calls).toEqual(['chat-1']) // one replay, however many turns followed
  })

  test('a turn end recorded before seeding is not duplicated by the replay', () => {
    const { facts } = historyOf({
      'chat-1': [{ type: 'turn_completed', at: '2026-10-14T08:00:00Z' }],
    })
    facts.record('chat-1', 'task-1', '2026-10-14T08:00:00Z')
    expect(facts.forRecords([record('chat-1')])).toHaveLength(1)
  })

  test('sessions without a task never seed; killed sessions prune', () => {
    const { facts, calls } = historyOf({
      'chat-1': [{ type: 'turn_completed', at: '2026-10-14T08:00:00Z' }],
      'chat-2': [{ type: 'turn_completed', at: '2026-10-14T08:00:00Z' }],
    })
    expect(facts.forRecords([record('chat-1', { taskId: null })])).toEqual([])
    expect(calls).toEqual([])
    // A killed session leaves the record set; its entry goes with it, so a
    // session id returning (a fresh session reusing the transcript) seeds anew.
    expect(facts.forRecords([record('chat-1')])).toHaveLength(1)
    expect(facts.forRecords([])).toEqual([])
    expect(facts.forRecords([record('chat-1')])).toHaveLength(1)
    expect(calls).toEqual(['chat-1', 'chat-1'])
  })

  test('an archived session keeps its facts without replaying', () => {
    const { facts, calls } = historyOf({
      'chat-1': [{ type: 'turn_completed', at: '2026-10-14T08:00:00Z' }],
    })
    const archived = record('chat-1', { archivedAt: '2026-10-14T10:00:00Z' })
    expect(facts.forRecords([archived])).toHaveLength(1)
    expect(facts.forRecords([archived])).toHaveLength(1)
    expect(calls).toEqual(['chat-1'])
  })
})
