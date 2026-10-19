// The owner's answer and override with its fix task (plan-supervision 5.4–5.6;
// design D6, D7) through the real DecisionService and stores.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { FIX_ACCEPTANCE } from '../plans/decisions/fixTasks'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createDecisionBench, type DecisionBench } from './decisionHarness'

let world: PlanWorld
let bench: DecisionBench

beforeAll(async () => { world = await createPlanWorld('kawai-owner-decisions-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createDecisionBench(world)
})

const dev = { kind: 'agent' as const, sessionId: 'dev' }
const lead = { kind: 'agent' as const, sessionId: 'lead' }
const human = () => bench.human
const count = (table: string) => (bench.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

async function card(withLead = true) {
  const planId = await bench.approvedPlan(withLead)
  const taskId = await bench.onTask('dev', planId)
  const asked = await bench.decide.ask(dev, { question: 'Which store?', options: ['SQLite', 'Files'] })
  return { planId, taskId, card: asked.card }
}

async function decided(withLead = true) {
  const setup = await card(withLead)
  const first = withLead
    ? await bench.decide.record(lead, { plan_id: setup.planId, card_id: setup.card.id, option_index: 1, rationale: 'Durable' })
    : await bench.decide.answer(human(), { planId: setup.planId, cardId: setup.card.id, optionIndex: 1, rationale: 'Durable', commandId: 'a-1' })
  return { ...setup, first: first.decision }
}

describe("the owner's answer (D6)", () => {
  test('agent callers are refused first', async () => {
    const { planId, card: c } = await card()
    await expect(bench.decide.answer(lead, { planId, cardId: c.id, choice: 'x', commandId: 'c' })).rejects.toThrow('Only the owner answers')
    await expect(bench.decide.override(lead, { planId, cardId: c.id, expectedDecisionId: 'd', choice: 'x', rationale: 'r', commandId: 'c' })).rejects.toThrow('Only the owner overrides')
  })

  test('the answer goes to the asker in the question thread; queued question mail is cancelled by the human', async () => {
    const { planId, taskId, card: c } = await card()
    const outcome = await bench.decide.answer(human(), { planId, cardId: c.id, optionIndex: 2, commandId: 'a-1' })
    expect(outcome.decision).toMatchObject({ kind: 'answer', seq: 1, choice: 'Files', rationale: null, decidedBy: { kind: 'human', session: null }, commandId: 'a-1' })
    expect(bench.mail.get(c.messageId!)).toMatchObject({ state: 'cancelled' })
    const event = bench.db.db.prepare("SELECT actor, reason FROM team_message_events WHERE message_id = ? AND kind = 'cancelled'").get(c.messageId!) as { actor: string; reason: string }
    expect(event).toMatchObject({ actor: 'human', reason: 'answered by the owner' })
    expect(outcome.message).toMatchObject({ fromKind: 'human', toKind: 'session', toId: 'dev', taskId, tags: ['decision-answer'], inReplyTo: c.messageId })
  })

  test('claimed question mail is left alone, and the Lead is then refused naming the owner', async () => {
    const { planId, card: c } = await card()
    expect(bench.mail.claim(c.messageId!, 'lead')).toBe(true)
    await bench.decide.answer(human(), { planId, cardId: c.id, choice: 'Neither', rationale: 'r', commandId: 'a-1' })
    expect(bench.mail.get(c.messageId!)!.state).toBe('claimed')
    await expect(bench.decide.record(lead, { plan_id: planId, card_id: c.id, option_index: 1, rationale: 'r' })).rejects.toThrow('already decided by the owner')
  })

  test('an owner-addressed card gets direct mail to the asker on its task', async () => {
    const { planId, taskId, card: c } = await card(false)
    const outcome = await bench.decide.answer(human(), { planId, cardId: c.id, optionIndex: 1, commandId: 'a-1' })
    expect(outcome.message).toMatchObject({ fromKind: 'human', toKind: 'session', toId: 'dev', taskId, tags: ['decision-answer'] })
  })

  test('replay compares the D6 fields; a different payload is refused naming the field', async () => {
    const { planId, card: c } = await card()
    const first = await bench.decide.answer(human(), { planId, cardId: c.id, optionIndex: 1, rationale: ' why ', commandId: 'a-1' })
    expect(await bench.decide.answer(human(), { planId, cardId: c.id, optionIndex: 1, rationale: 'why', commandId: 'a-1' }))
      .toMatchObject({ replayed: true, decision: { id: first.decision.id } })
    await expect(bench.decide.answer(human(), { planId, cardId: c.id, optionIndex: 2, rationale: 'why', commandId: 'a-1' })).rejects.toThrow('different optionIndex')
    await expect(bench.decide.answer(human(), { planId, cardId: c.id, optionIndex: 1, rationale: 'other', commandId: 'a-1' })).rejects.toThrow('different rationale')
    await expect(bench.decide.answer(human(), { planId, cardId: c.id, optionIndex: 1, commandId: 'a-2' })).rejects.toThrow('already decided by the owner')
    expect(count('plan_decisions')).toBe(1)
  })

  test('a decided card is refused naming the decider', async () => {
    const { planId, card: c, first } = await decided()
    await expect(bench.decide.answer(human(), { planId, cardId: c.id, optionIndex: 2, commandId: 'a-1' })).rejects.toThrow(`already decided by lead (leads) (${first.id}`)
  })

  test('a race with decision_record leaves one first decision', async () => {
    const { planId, card: c } = await card()
    const results = await Promise.allSettled([
      bench.decide.record(lead, { plan_id: planId, card_id: c.id, option_index: 1, rationale: 'r' }),
      bench.decide.answer(human(), { planId, cardId: c.id, optionIndex: 2, commandId: 'a-1' }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.message).toContain('already decided by')
    expect(bench.decisions.decisionsOfCard(world.team.teamId, c.id)).toHaveLength(1)
    expect(count("team_messages WHERE tags LIKE '%decision-answer%'")).toBe(1)
  })
})

describe("the owner's override (D6) and its fix task (D7)", () => {
  test('an open card is refused with answer it instead; a missing rationale is refused', async () => {
    const { planId, card: c } = await card()
    await expect(bench.decide.override(human(), { planId, cardId: c.id, expectedDecisionId: 'x', choice: 'y', rationale: 'r', commandId: 'o-1' })).rejects.toThrow('answer it instead')
    const first = (await bench.decide.record(lead, { plan_id: planId, card_id: c.id, option_index: 1, rationale: 'r' })).decision
    await expect(bench.decide.override(human(), { planId, cardId: c.id, expectedDecisionId: first.id, choice: 'y', rationale: ' ', commandId: 'o-1' })).rejects.toThrow('needs a rationale')
  })

  test('the override and its fix task commit together; the fix follows D7 and goes to the Lead role', async () => {
    const { planId, taskId, card: c, first } = await decided()
    const outcome = await bench.decide.override(human(), { planId, cardId: c.id, expectedDecisionId: first.id, optionIndex: 2, rationale: 'Files are enough', commandId: 'o-1' })
    expect(outcome.decision).toMatchObject({ kind: 'override', seq: 2, choice: 'Files', decidedBy: { kind: 'human' }, affected: [taskId] })
    const fix = bench.tasks.get(outcome.fixTaskId!)!
    expect(fix).toMatchObject({ title: 'Forward fix: Which store? — Wave C', worktree: null, openspecChange: null, parentId: null, planId: null, creator: { kind: 'system', sessionId: null } })
    const revision = bench.tasks.revisions(fix.id)[0]!
    expect(revision.acceptance).toBe(FIX_ACCEPTANCE)
    for (const part of [c.id, first.id, 'SQLite', 'Durable', outcome.decision.id, 'Files are enough', taskId, `fixes: ["${fix.id}"]`, 'plan_submit_for_review']) expect(revision.direction).toContain(part)
    expect(bench.decisions.fixTaskBySource(world.team.teamId, 'override', outcome.decision.id)).toMatchObject({ taskId: fix.id, planId })
    const instruction = bench.mail.forTask(fix.id)[0]!
    expect(instruction).toMatchObject({ fromKind: 'system', toKind: 'group', toId: 'leads', tags: ['plan-fix'], allowedProfiles: ['opus'] })
    expect(instruction.body).toContain(`fixes: ["${fix.id}"]`)
    const assignment = bench.db.db.prepare('SELECT request_key FROM team_task_assignments WHERE task_id = ?').get(fix.id) as { request_key: string }
    expect(assignment.request_key).toBe(`fix:${outcome.decision.id}`)
    expect(count("team_messages WHERE tags LIKE '%decision-answer%'")).toBe(1)
  })

  test('with no Lead role the fix task is created and nothing is dispatched', async () => {
    const { planId, card: c, first } = await decided(false)
    const outcome = await bench.decide.override(human(), { planId, cardId: c.id, expectedDecisionId: first.id, choice: 'Files', rationale: 'r', commandId: 'o-1' })
    expect(bench.tasks.get(outcome.fixTaskId!)).toBeTruthy()
    expect(bench.mail.forTask(outcome.fixTaskId!)).toEqual([])
  })

  test('replay returns the decision; a stale expected decision is refused naming the current one', async () => {
    const { planId, card: c, first } = await decided()
    const input = { planId, cardId: c.id, expectedDecisionId: first.id, choice: 'Files', rationale: 'r', commandId: 'o-1' }
    const one = await bench.decide.override(human(), input)
    expect(await bench.decide.override(human(), input)).toMatchObject({ replayed: true, decision: { id: one.decision.id }, fixTaskId: one.fixTaskId })
    await expect(bench.decide.override(human(), { ...input, rationale: 'other' })).rejects.toThrow('different rationale')
    await expect(bench.decide.override(human(), { ...input, commandId: 'o-2' })).rejects.toThrow(`current decision is ${one.decision.id}`)
    expect(count('plan_fix_tasks')).toBe(1)
  })

  test('a second override cancels the earlier open fix with a note naming the newer override', async () => {
    const { planId, card: c, first } = await decided()
    const one = await bench.decide.override(human(), { planId, cardId: c.id, expectedDecisionId: first.id, choice: 'Files', rationale: 'r', commandId: 'o-1' })
    const two = await bench.decide.override(human(), { planId, cardId: c.id, expectedDecisionId: one.decision.id, choice: 'SQLite', rationale: 'back', commandId: 'o-2' })
    expect(bench.tasks.get(one.fixTaskId!)!.status).toBe('cancelled')
    expect(bench.tasks.journal(one.fixTaskId!).at(-1)!.text).toContain(two.decision.id)
    expect(bench.tasks.get(two.fixTaskId!)!.status).toBe('open')
  })

  test('a cancelled plan is refused; a completed one is reopened under override:<id>:reopen', async () => {
    const { planId, card: c, first } = await decided()
    await bench.service.close(bench.human, { planId, outcome: 'completed', reason: 'done enough', commandId: 'close-1' })
    const outcome = await bench.decide.override(human(), { planId, cardId: c.id, expectedDecisionId: first.id, choice: 'Files', rationale: 'r', commandId: 'o-1' })
    expect(bench.plans.get(planId)!.lifecycle).toBe('open')
    expect(bench.plans.events(planId).at(-1)).toMatchObject({ kind: 'reopened', commandId: 'override:o-1:reopen' })
    await bench.service.close(bench.human, { planId, outcome: 'cancelled', reason: 'stop', commandId: 'close-2' })
    await expect(bench.decide.override(human(), { planId, cardId: c.id, expectedDecisionId: outcome.decision.id, choice: 'SQLite', rationale: 'r', commandId: 'o-2' }))
      .rejects.toThrow('reopen the plan first')
  })

  test('a failure at any step writes nothing: decision, fix, reopen, cancel, and dispatch roll back together', async () => {
    const { planId, card: c, first } = await decided()
    const one = await bench.decide.override(human(), { planId, cardId: c.id, expectedDecisionId: first.id, choice: 'Files', rationale: 'r', commandId: 'o-1' })
    await bench.service.close(bench.human, { planId, outcome: 'completed', reason: 'done enough', commandId: 'close-1' })
    const before = { decisions: count('plan_decisions'), fixes: count('plan_fix_tasks'), tasks: count('team_tasks'), events: count('plan_events'), mail: count('team_messages') }
    const dispatch = bench.assignments.dispatchWithin.bind(bench.assignments)
    bench.assignments.dispatchWithin = () => { throw new Error('dispatch broke') }
    await expect(bench.decide.override(human(), { planId, cardId: c.id, expectedDecisionId: one.decision.id, choice: 'SQLite', rationale: 'r', commandId: 'o-2' })).rejects.toThrow('dispatch broke')
    bench.assignments.dispatchWithin = dispatch
    expect({ decisions: count('plan_decisions'), fixes: count('plan_fix_tasks'), tasks: count('team_tasks'), events: count('plan_events'), mail: count('team_messages') }).toEqual(before)
    expect(bench.plans.get(planId)!.lifecycle).toBe('completed')
    expect(bench.tasks.get(one.fixTaskId!)!.status).toBe('open')
  })
})
