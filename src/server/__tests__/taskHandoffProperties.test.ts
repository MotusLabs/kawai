// Handoff properties over the real decision bench (owner-publication-handoff
// task 5.2): Table H-NEUTRAL's H28 rows — every neutral event (a card answer,
// an own call, an override that cancels no handoff's task, a note, mail,
// archival or exhaustion of the requester or holder, an acknowledgement, a
// notice retry, a restart's sweep) over every handoff state changes no
// handoff row and no revision — and property P3: a seeded command sequence
// with neutral events interleaved yields the same normalized digest of every
// handoff, event and revision row as the same sequence without them.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { createPlanWorld, writeGroup, type PlanWorld } from './planHarness'
import { createDecisionBench, type DecisionBench } from './decisionHarness'
import { propertyCases } from './helpers/propertyCases'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { HANDOFF_STATES } from '../../shared/taskHandoffs'

let world: PlanWorld
let bench: DecisionBench
let planId: string
let counter = 0
const next = () => ++counter
const human = () => bench.human
const lead = { kind: 'agent' as const, sessionId: 'lead' }
const dev = { kind: 'agent' as const, sessionId: 'dev' }
const tasks = () => bench.taskService
const swallow = async (run: () => Promise<unknown>) => { try { await run() } catch { /* a refusal is part of the sequence */ } }

beforeAll(async () => {
  world = await createPlanWorld('kawai-handoff-properties-')
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
  bench = createDecisionBench(world)
  planId = await bench.approvedPlan(true)
})
afterAll(() => {
  bench.db.close()
  fs.rmSync(world.root, { recursive: true, force: true })
})

/** Every row a handoff, its events and the task's revisions hold, with ids and times normalized by first appearance. */
function digest(taskId: string): unknown {
  const db = tasks().store.db
  const handoffs = db.prepare('SELECT * FROM team_task_handoffs WHERE task_id = ? ORDER BY rowid').all(taskId) as Array<Record<string, unknown>>
  const ids = new Map(handoffs.map((row, index) => [String(row.id), `H${index}`]))
  const norm = (value: unknown): unknown => {
    if (typeof value !== 'string') return value
    let out = value.split(taskId).join('T')
    for (const [id, alias] of ids) out = out.split(id).join(alias)
    return out
  }
  const clean = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row)
    .filter(([key]) => !['created_at', 'updated_at', 'at'].includes(key)).map(([key, value]) => [key, norm(value)]))
  const events = [...ids.keys()].flatMap(id => (db.prepare('SELECT * FROM team_task_handoff_events WHERE handoff_id = ? ORDER BY seq').all(id) as Array<Record<string, unknown>>).map(clean))
  const revisions = (db.prepare('SELECT * FROM team_task_revisions WHERE task_id = ? ORDER BY revision').all(taskId) as Array<Record<string, unknown>>).map(clean)
  const task = tasks().store.get(taskId)!
  return { handoffs: handoffs.map(clean), events, revisions, revision: task.revision, status: task.status }
}

type Command = { kind: 'request' | 'publish' | 'other' | 'decline' | 'withdraw' | 'close'; n: number }
type Neutral = 'answer' | 'own-call' | 'override' | 'note' | 'mail' | 'archive-requester' | 'exhaust-holder' | 'acknowledge' | 'notice-retry' | 'restart'
const NEUTRALS: Neutral[] = ['answer', 'own-call', 'override', 'note', 'mail', 'archive-requester', 'exhaust-holder', 'acknowledge', 'notice-retry', 'restart']

async function run(taskId: string, command: Command): Promise<void> {
  const pending = tasks().handoffs.store.pendingOf(taskId)
  switch (command.kind) {
    case 'request':
      return swallow(() => tasks().handoffs.request(lead, taskId, {
        baseRevision: tasks().store.get(taskId)!.revision, direction: `Prepared ${command.n}`, rationale: 'why', notify: false, requestKey: `k${command.n}`,
      }))
    case 'publish':
      return pending ? swallow(() => tasks().handoffs.publish(human(), taskId, pending.id, [])) : undefined
    case 'other':
      return swallow(() => tasks().publish(human(), taskId, { direction: `Other ${command.n}`, rationale: 'mine', notify: false, requestKey: `o${command.n}` }))
    case 'decline':
      return pending ? swallow(() => tasks().handoffs.settle(human(), pending.id, 'decline', 'no')) : undefined
    case 'withdraw':
      return pending ? swallow(() => tasks().handoffs.settle(lead, pending.id, 'withdraw', 'not needed')) : undefined
    case 'close':
      return swallow(() => tasks().setStatus(human(), taskId, 'cancelled'))
  }
}

async function neutral(taskId: string, event: Neutral): Promise<void> {
  const n = next()
  const record = (id: string) => bench.records.get(id)!
  switch (event) {
    case 'answer': {
      const asked = await bench.decide.ask(dev, { question: `Publish the prepared correction ${n}?`, options: ['Publish', 'Wait'] })
      return swallow(() => bench.decide.record(lead, { plan_id: planId, card_id: asked.card.id, option_index: 1, rationale: 'Publish it', affected_tasks: [taskId] }))
    }
    case 'own-call':
      return swallow(() => bench.decide.record(lead, { plan_id: planId, question: `Publish ${n}?`, options: ['Publish', 'Wait'], option_index: 1, rationale: 'yes', affected_tasks: [taskId] }))
    case 'override': {
      const asked = await bench.decide.ask(dev, { question: `Publish it ${n}?`, options: ['Publish', 'Wait'] })
      const first = await bench.decide.record(lead, { plan_id: planId, card_id: asked.card.id, option_index: 2, rationale: 'Wait' })
      return swallow(() => bench.decide.override(human(), { planId, cardId: asked.card.id, expectedDecisionId: first.decision.id, optionIndex: 1, rationale: 'Publish', commandId: `ov-${n}` }))
    }
    case 'note':
      return swallow(() => tasks().note(dev, taskId, `Please publish ${n}`))
    case 'mail':
      return swallow(() => bench.mailbox.send(dev, { to_kind: 'session', to_id: 'lead', body: `publish it ${n}`, task_id: taskId }))
    case 'archive-requester':
      bench.records.set('lead', { ...record('lead'), archivedAt: new Date().toISOString() })
      return
    case 'exhaust-holder':
      bench.records.set('dev', { ...record('dev'), contextExhausted: { at: new Date().toISOString(), reason: 'prompt_too_long' } })
      return
    case 'acknowledge':
      return swallow(() => tasks().acknowledge(dev, taskId, tasks().store.get(taskId)!.revision))
    case 'notice-retry':
      return swallow(() => tasks().notify(human(), taskId, tasks().store.get(taskId)!.revision, `retry-${n}`))
    case 'restart':
      tasks().handoffs.reconcile()
  }
}

/** A fresh plan task with `dev` on it and every record live again. */
async function freshTask(): Promise<string> {
  for (const id of ['lead', 'dev']) {
    const { archivedAt: _archived, contextExhausted: _exhausted, ...live } = bench.records.get(id)!
    bench.records.set(id, live)
  }
  return bench.onTask('dev', planId)
}

describe('H-NEUTRAL', () => {
  // @covers: task-publication-handoffs › Answers, time, and archival never settle a handoff › A yes on a card is not a publication
  // @covers: task-publication-handoffs › Answers, time, and archival never settle a handoff › An archived requester leaves the handoff pending
  test('H28: every neutral event, in every handoff state, leaves every handoff row and the revision unchanged', async () => {
    for (const state of HANDOFF_STATES) {
      const taskId = await freshTask()
      await run(taskId, { kind: 'request', n: next() })
      const handoff = tasks().handoffs.store.pendingOf(taskId)!
      if (state === 'stale') await run(taskId, { kind: 'other', n: next() })
      else if (state !== 'open') tasks().store.db.prepare('UPDATE team_task_handoffs SET state = ? WHERE id = ?').run(state, handoff.id)
      for (const event of NEUTRALS) {
        const before = digest(taskId)
        await neutral(taskId, event)
        expect([state, event, digest(taskId)]).toEqual([state, event, before])
      }
      if (state === 'open') expect(tasks().handoffs.store.get(handoff.id)!.state).toBe('open')
    }
    // The events took effect (none was a silent refusal): one of each per state.
    const count = (sql: string) => (tasks().store.db.prepare(sql).get() as { n: number }).n
    expect({
      answers: count("SELECT COUNT(*) AS n FROM plan_decisions WHERE kind = 'answer'"),
      ownCalls: count("SELECT COUNT(*) AS n FROM plan_decisions WHERE kind = 'own-call'"),
      overrides: count("SELECT COUNT(*) AS n FROM plan_decisions WHERE kind = 'override'"),
      notes: count("SELECT COUNT(*) AS n FROM team_task_journal WHERE text LIKE 'Please publish%'"),
      mail: count("SELECT COUNT(*) AS n FROM team_messages WHERE body LIKE 'publish it%'"),
      acknowledgements: count('SELECT COUNT(*) AS n FROM team_task_acknowledgements'),
    }).toEqual({ answers: 2 * HANDOFF_STATES.length, ownCalls: HANDOFF_STATES.length, overrides: HANDOFF_STATES.length, notes: HANDOFF_STATES.length, mail: HANDOFF_STATES.length, acknowledgements: HANDOFF_STATES.length })
  })
})

describe('P3: no authority from neutral events', () => {
  const CASES = 200
  test('P3: seed 0x0A11CE03, 200 cases — neutral events interleaved change no handoff, event or revision row', async () => {
    const random = mulberry32(0x0A11CE03)
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
    const kinds: Command['kind'][] = ['request', 'request', 'publish', 'other', 'decline', 'withdraw']
    for (let index = 0; index < propertyCases(CASES); index++) {
      const commands: Command[] = Array.from({ length: 2 + Math.floor(random() * 5) }, () => ({ kind: pick(kinds), n: next() }))
      if (random() < 0.3) commands.push({ kind: 'close', n: next() })
      const neutrals = commands.map(() => (random() < 0.6 ? pick(NEUTRALS) : null))
      const plain = await freshTask()
      for (const command of commands) await run(plain, command)
      const mixed = await freshTask()
      for (const [position, command] of commands.entries()) {
        await run(mixed, command)
        const event = neutrals[position]
        if (event) await neutral(mixed, event)
      }
      expect([index, commands, neutrals, digest(mixed)]).toEqual([index, commands, neutrals, digest(plain)])
    }
  }, 600_000)
})
