// decision_ask and decision_record (plan-supervision 5.2, 5.3; design D4,
// D5) through the real DecisionService, mailbox, and stores.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { DecisionRefusal } from '../plans/decisions/decisionInputs'
import { NEEDS_PLAN_WORK } from '../plans/decisions/decisionScope'
import { createPlanWorld, sessionRow, type PlanWorld } from './planHarness'
import { createDecisionBench, type DecisionBench } from './decisionHarness'

let world: PlanWorld
let bench: DecisionBench

beforeAll(async () => { world = await createPlanWorld('kawai-decision-ask-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createDecisionBench(world)
})

const dev = { kind: 'agent' as const, sessionId: 'dev' }
const lead = { kind: 'agent' as const, sessionId: 'lead' }
const count = (table: string) => (bench.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('decision_ask resolves the plan from the session (D4)', () => {
  test("a task linked to a plan: the plan, the task's change, and the current approved revision", async () => {
    const planId = await bench.approvedPlan()
    const taskId = await bench.onTask('dev', planId, 'ui')
    const { card } = await bench.decide.ask(dev, { question: 'Which store?' })
    expect(card).toMatchObject({ planId, change: 'ui', taskId, revision: bench.plans.get(planId)!.currentApprovedRevision })
  })

  test("a Kawai execution task: the execution's revision", async () => {
    const planId = await bench.approvedPlan()
    const taskId = await bench.onTask('dev', planId)
    bench.db.db.prepare(`INSERT INTO plan_executions (id, team_id, plan_id, revision, content_hash, report_id, input_hash, landing_mode, base_branch, base_commit,
      floor_json, max_parallel, merge_method, state, started_at) VALUES ('exec-1', ?, ?, 7, 'h', 'r', 'i', 'direct', 'master', 'c', '{}', 1, 'merge', 'running', '2026-01-01T00:00:00Z')`)
      .run(world.team.teamId, planId)
    bench.db.db.prepare(`INSERT INTO plan_execution_changes (execution_id, change, team_id, position, state, task_id, owns, updated_at)
      VALUES ('exec-1', 'api', ?, 0, 'implementing', ?, 1, '2026-01-01T00:00:00Z')`).run(world.team.teamId, taskId)
    expect((await bench.decide.ask(dev, { question: 'q' })).card.revision).toBe(7)
  })

  test('a fix task: the plan, with no change', async () => {
    const planId = await bench.approvedPlan()
    const taskId = await bench.onTask('dev', null)
    bench.decisions.insertFixTask({ taskId, teamId: world.team.teamId, planId, sourceKind: 'override', sourceId: 'decision-x' })
    expect((await bench.decide.ask(dev, { question: 'q' })).card).toMatchObject({ planId, change: null, taskId })
  })

  test('the Lead role naming plan_id: no task, change, or revision; addressed to the owner', async () => {
    const planId = await bench.approvedPlan()
    const { card, message } = await bench.decide.ask(lead, { question: 'q', plan_id: planId })
    expect(card).toMatchObject({ planId, taskId: null, change: null, revision: null, addressedTo: 'owner', addressedGroup: null, messageId: null })
    expect(message).toBeNull()
  })

  test("anything else is refused with D4's message and writes nothing", async () => {
    const planId = await bench.approvedPlan(false)
    await expect(bench.decide.ask(dev, { question: 'q' })).rejects.toThrow(NEEDS_PLAN_WORK)
    await expect(bench.decide.ask(dev, { question: 'q', plan_id: planId })).rejects.toThrow(NEEDS_PLAN_WORK)
    await expect(bench.decide.ask(lead, { question: 'q', plan_id: planId })).rejects.toThrow(NEEDS_PLAN_WORK)
    await bench.onTask('dev', null)
    await expect(bench.decide.ask(dev, { question: 'q' })).rejects.toThrow(NEEDS_PLAN_WORK)
    // A plan with a Lead role: naming it is only the Lead's way in.
    const led = await bench.approvedPlan()
    await expect(bench.decide.ask(dev, { question: 'q', plan_id: led })).rejects.toThrow(NEEDS_PLAN_WORK)
    expect(count('plan_decision_cards')).toBe(0)
  })

  test("a conflicting plan_id is refused; another team's plan reads as not found", async () => {
    const planId = await bench.approvedPlan()
    const other = await bench.approvedPlan()
    await bench.onTask('dev', planId)
    await expect(bench.decide.ask(dev, { question: 'q', plan_id: other })).rejects.toThrow('names another plan')
    expect((await bench.decide.ask(dev, { question: 'q', plan_id: planId })).card.planId).toBe(planId)
    bench.records.set('stranger', { ...sessionRow('stranger', 'leads', world.other) })
    await expect(bench.decide.ask({ kind: 'agent', sessionId: 'stranger' }, { question: 'q', plan_id: planId })).rejects.toThrow('Plan not found in this team')
  })
})

describe('decision_ask addressing and limits (D4)', () => {
  test('a Lead-addressed card commits with its task-less decision-question group mail', async () => {
    const planId = await bench.approvedPlan()
    const taskId = await bench.onTask('dev', planId)
    const { card, message, guidance } = await bench.decide.ask(dev, { question: 'Which store?', options: ['SQLite', 'Files'], context: 'See D3' })
    expect(card).toMatchObject({ addressedTo: 'lead', addressedGroup: 'leads', askedBy: { session: 'dev', group: 'middle-devs', profile: 'default' } })
    expect(card.messageId).toBe(message!.id)
    expect(bench.mail.get(card.messageId!)).toMatchObject({ toKind: 'group', toId: 'leads', fromSession: 'dev', priority: 'normal', tags: ['decision-question'], taskId: null, state: 'queued' })
    const body = message!.body
    for (const part of [card.id, planId, 'change api', taskId, 'Which store?', '1. SQLite', '2. Files', 'Context: See D3', 'decision_record']) expect(body).toContain(part)
    expect(guidance).toContain('arrives as mail in this thread')
    expect(bench.changes).toEqual([planId])
  })

  test('a mail failure rolls the card back', async () => {
    const planId = await bench.approvedPlan()
    await bench.onTask('dev', planId)
    const enqueue = bench.mail.enqueue.bind(bench.mail)
    bench.mail.enqueue = () => { throw new Error('disk full') }
    await expect(bench.decide.ask(dev, { question: 'q' })).rejects.toThrow('disk full')
    bench.mail.enqueue = enqueue
    expect(count('plan_decision_cards')).toBe(0)
  })

  test('a plan without a Lead role addresses the owner and sends no mail', async () => {
    const planId = await bench.approvedPlan(false)
    await bench.onTask('dev', planId)
    const { card, message } = await bench.decide.ask(dev, { question: 'q' })
    expect(card).toMatchObject({ addressedTo: 'owner', addressedGroup: null, messageId: null })
    expect(message).toBeNull()
    expect(count('team_messages')).toBe(0)
  })

  test('the input limits are enforced at their boundaries', async () => {
    const planId = await bench.approvedPlan(false)
    await bench.onTask('dev', planId)
    const ok = async (input: Parameters<DecisionBench['decide']['ask']>[1]) => (await bench.decide.ask(dev, input)).card.id
    const bad = (input: Parameters<DecisionBench['decide']['ask']>[1], text: string) => expect(bench.decide.ask(dev, input)).rejects.toThrow(text)
    expect(await ok({ question: 'q'.repeat(2000), options: Array(8).fill('o'.repeat(300)), context: 'c'.repeat(4000) })).toStartWith('card-')
    await bad({ question: '  ' }, '1–2000')
    await bad({ question: 'q'.repeat(2001) }, '1–2000')
    await bad({ question: 'q', options: Array(9).fill('o') }, 'At most 8')
    await bad({ question: 'q', options: ['o'.repeat(301)] }, 'Option 1 needs')
    await bad({ question: 'q', options: [' '] }, 'Option 1 needs')
    await bad({ question: 'q', context: 'c'.repeat(4001) }, 'at most 4000')
    expect(count('plan_decision_cards')).toBe(1)
  })
})

describe('decision_record (D5)', () => {
  async function leadCard() {
    const planId = await bench.approvedPlan()
    const taskId = await bench.onTask('dev', planId)
    const { card } = await bench.decide.ask(dev, { question: 'Which store?', options: ['SQLite', 'Files'] })
    return { planId, taskId, card }
  }

  test('only the addressed group answers; owner-addressed cards are refused', async () => {
    const { planId, card } = await leadCard()
    await expect(bench.decide.record(dev, { plan_id: planId, card_id: card.id, option_index: 1, rationale: 'r' })).rejects.toThrow('cannot decide it')
    const owner = await bench.decide.ask(lead, { question: 'q', plan_id: planId })
    await expect(bench.decide.record(lead, { plan_id: planId, card_id: owner.card.id, choice: 'x', rationale: 'r' })).rejects.toThrow('addressed to the owner')
    expect(count('plan_decisions')).toBe(0)
  })

  test("the answer goes through the reply path to the asker, on the card's task, tagged decision-answer", async () => {
    const { planId, taskId, card } = await leadCard()
    const outcome = await bench.decide.record(lead, { plan_id: planId, card_id: card.id, option_index: 2, rationale: 'Simpler' })
    expect(outcome.decision).toMatchObject({ seq: 1, kind: 'answer', choice: 'Files', optionIndex: 2, rationale: 'Simpler', affected: [taskId], decidedBy: { kind: 'agent', session: 'lead', group: 'leads' } })
    expect(outcome.decision.replyMessageId).toBe(outcome.message!.id)
    expect(outcome.message).toMatchObject({ toKind: 'session', toId: 'dev', fromSession: 'lead', taskId, tags: ['decision-answer'], inReplyTo: card.messageId })
    expect(outcome.message!.body).toContain('Files')
    expect(outcome.message!.body).toContain('Simpler')
  })

  test('the same session and choice replays; anything else is refused naming the decider', async () => {
    const { planId, card } = await leadCard()
    const first = await bench.decide.record(lead, { plan_id: planId, card_id: card.id, option_index: 1, rationale: 'r' })
    const again = await bench.decide.record(lead, { plan_id: planId, card_id: card.id, choice: 'SQLite', rationale: 'other words' })
    expect(again).toMatchObject({ replayed: true, decision: { id: first.decision.id } })
    await expect(bench.decide.record(lead, { plan_id: planId, card_id: card.id, option_index: 2, rationale: 'r' })).rejects.toThrow('already decided by lead (leads)')
    await expect(bench.decide.record({ kind: 'agent', sessionId: 'lead2' }, { plan_id: planId, card_id: card.id, option_index: 1, rationale: 'r' }))
      .rejects.toThrow(`already decided by lead (leads) (${first.decision.id}`)
    expect(count('plan_decisions')).toBe(1)
    expect(count(`team_messages WHERE thread_id = '${bench.mail.get(card.messageId!)!.threadId}'`)).toBe(2)
  })

  test("a killed asker's answer falls back to its group", async () => {
    const { planId, card } = await leadCard()
    bench.records.delete('dev')
    const outcome = await bench.decide.record(lead, { plan_id: planId, card_id: card.id, option_index: 1, rationale: 'r' })
    expect(outcome.message).toMatchObject({ toKind: 'group', toId: 'middle-devs', state: 'queued' })
  })

  test('choice, rationale, and affected_tasks are validated; nothing is written on refusal', async () => {
    const { planId, card } = await leadCard()
    const at = (input: Record<string, unknown>) => bench.decide.record(lead, { plan_id: planId, card_id: card.id, rationale: 'r', ...input })
    await expect(at({ option_index: 3 })).rejects.toThrow('option_index must be 1–2')
    await expect(at({ option_index: 1, choice: 'x' })).rejects.toThrow('not both')
    await expect(at({})).rejects.toThrow('needs option_index or')
    await expect(at({ choice: 'x'.repeat(2001) })).rejects.toThrow('needs option_index or')
    await expect(at({ choice: 'x', rationale: ' ' })).rejects.toThrow('needs a rationale')
    await expect(at({ choice: 'x', rationale: 'r'.repeat(4001) })).rejects.toThrow('at most 4000')
    const otherTask = bench.tasks.create({ teamId: world.otherTeam.teamId, title: 't', direction: 'd', creator: { kind: 'human', sessionId: null } })
    await expect(at({ choice: 'x', affected_tasks: [otherTask.id] })).rejects.toThrow('Task not found in this team')
    expect(count('plan_decisions')).toBe(0)
    expect((await at({ choice: 'x', affected_tasks: [] })).decision.affected).toEqual([])
  })

  test('an own call needs the Lead role and creates a decided card with no mail', async () => {
    const planId = await bench.approvedPlan()
    const taskId = await bench.onTask('dev', planId)
    await expect(bench.decide.record(dev, { plan_id: planId, question: 'q', choice: 'x', rationale: 'r' })).rejects.toThrow("needs the plan's Lead role (leads)")
    await expect(bench.decide.record(lead, { plan_id: planId, choice: 'x', rationale: 'r' })).rejects.toThrow('needs the question')
    const outcome = await bench.decide.record(lead, { plan_id: planId, question: 'Ship Friday?', options: ['yes', 'no'], option_index: 1, rationale: 'r', affected_tasks: [taskId] })
    expect(outcome.card).toMatchObject({ addressedTo: 'lead', addressedGroup: 'leads', askedBy: { session: 'lead' }, messageId: null, taskId: null, question: 'Ship Friday?' })
    expect(outcome.decision).toMatchObject({ kind: 'own-call', seq: 1, choice: 'yes', affected: [taskId], replyMessageId: null })
    expect(outcome.message).toBeNull()
    expect(count('team_messages')).toBe(0)
  })

  test("another team's plan or card reads as not found", async () => {
    const { planId, card } = await leadCard()
    await expect(bench.decide.record(lead, { plan_id: 'plan-nope', card_id: card.id, choice: 'x', rationale: 'r' })).rejects.toThrow('Plan not found')
    await expect(bench.decide.record(lead, { plan_id: planId, card_id: 'card-nope', choice: 'x', rationale: 'r' })).rejects.toThrow(DecisionRefusal)
  })
})
