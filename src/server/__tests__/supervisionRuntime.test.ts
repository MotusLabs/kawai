// The production SupervisionRuntime (plan-supervision D10): the holder's
// facts read from its record, driver requests, worker and task rosters, the
// mailbox store, the cooldown rule, and the turn-end record; a killed holder
// reads gone; the blocker is the mailbox waiting reason's immediate blocker.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { ChatPendingRequest } from '../../shared/chat'
import type { WaitingReason } from '../../shared/team'
import { ChatTurnEndStore } from '../chat/chatTurnEndStore'
import type { ChatSessionRecord } from '../db'
import { supervisionRuntime } from '../plans/supervision/supervisionRuntime'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createDecisionBench, type DecisionBench } from './decisionHarness'

let world: PlanWorld
let bench: DecisionBench
let pending: ChatPendingRequest[]
let workers: boolean
let tasks: boolean
let reasons: Record<string, WaitingReason>
let cooled: ChatSessionRecord[]

beforeAll(async () => { world = await createPlanWorld('kawai-supervision-runtime-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createDecisionBench(world)
  pending = []
  workers = false
  tasks = false
  reasons = {}
  cooled = []
})

const NOW = new Date('2026-10-20T12:00:00.000Z')

function runtime() {
  return supervisionRuntime({
    db: bench.db.db, mail: bench.mail, getRecord: id => bench.records.get(id),
    pendingRequests: () => pending, hasLiveWorkers: () => workers, hasRunningBackgroundTasks: () => tasks,
    waitingFor: () => reasons,
    cooldownUntil: record => { cooled.push(record); return '2026-10-20T13:00:00.000Z' },
    now: () => NOW,
  })
}

describe('holder facts', () => {
  test('an idle holder: record, profile, cooldown, and no blockers', () => {
    const facts = runtime().holder('dev', null)
    expect(facts).toEqual({
      session: 'dev', group: 'middle-devs', profile: bench.records.get('dev')!.claudeProfileId ?? 'default', gone: false, turnRunning: false, pendingRequest: null,
      backgroundTasks: 0, workers: 0, dueDirectMail: false, parkedUntil: null, coolingUntil: '2026-10-20T13:00:00.000Z', lastTurnEndAt: null, lastTaskMailAt: null,
    })
    expect(cooled.map(record => record.sessionId)).toEqual(['dev'])
  })

  test('a working holder with a question, a worker, a background task, and due direct mail', async () => {
    bench.records.set('dev', { ...bench.records.get('dev')!, status: 'working' })
    pending = [{ kind: 'question', requestId: 'q', questions: [], at: NOW.toISOString() } as unknown as ChatPendingRequest]
    workers = true
    tasks = true
    await bench.mailbox.send({ kind: 'agent', sessionId: 'lead' }, { to_kind: 'session', to_id: 'dev', body: 'ping' })
    expect(runtime().holder('dev', null)).toMatchObject({ turnRunning: true, pendingRequest: 'question', workers: 1, backgroundTasks: 1, dueDirectMail: true })
    pending = [{ kind: 'approval', requestId: 'a', tool: 'Bash', input: {}, at: NOW.toISOString() }]
    expect(runtime().holder('dev', null)!.pendingRequest).toBe('approval')
  })

  test("parked work names the newest resume time; the task's turn end and task mail are the holder's", async () => {
    const taskId = await bench.onTask('dev', null)
    const sent = await bench.mailbox.send({ kind: 'agent', sessionId: 'lead' }, { to_kind: 'session', to_id: 'dev', body: 'work', task_id: taskId })
    bench.db.db.prepare("UPDATE team_messages SET state = 'parked', claimed_by = 'dev', parked_until = ?, delivered_at = ? WHERE id = ?")
      .run('2026-10-20T15:00:00.000Z', '2026-10-20T09:00:00.000Z', sent.id)
    const ends = new ChatTurnEndStore(bench.db.db)
    ends.record('dev', taskId, '2026-10-20T10:00:00.000Z', true)
    ends.record('dev', 'task-other', '2026-10-20T11:00:00.000Z', true)
    expect(runtime().holder('dev', taskId)).toMatchObject({ parkedUntil: '2026-10-20T15:00:00.000Z', lastTurnEndAt: '2026-10-20T10:00:00.000Z', lastTaskMailAt: '2026-10-20T09:00:00.000Z' })
    expect(runtime().holder('dev', null)).toMatchObject({ lastTurnEndAt: null, lastTaskMailAt: null })
  })

  test('an archived holder reads gone; a killed one (no record) reads gone with no session facts', () => {
    bench.records.set('dev', { ...bench.records.get('dev')!, archivedAt: NOW.toISOString() })
    expect(runtime().holder('dev', null)!.gone).toBe(true)
    expect(runtime().holder('killed', null)).toMatchObject({ session: 'killed', gone: true, group: null, profile: null, coolingUntil: null })
  })
})

test("the blocker is the message's waiting reason's immediate blocker; unknown mail reads none", async () => {
  const sent = await bench.mailbox.send({ kind: 'agent', sessionId: 'lead' }, { to_kind: 'session', to_id: 'dev', body: 'x' })
  expect(runtime().blocker(sent.id)).toBeNull()
  reasons = { [sent.id]: { blocker: { kind: 'group-cap' }, others: [] } as unknown as WaitingReason }
  expect(runtime().blocker(sent.id)).toBe('group-cap')
  expect(runtime().blocker('missing')).toBeNull()
})
