// Disputes and their decisions (review-findings-ledger 3.1–3.2, D6; tables
// DS and DD) through the production path: TaskResultService's dispute and
// decide, the task tools, and the real DecisionService with its Lead
// decision, owner answer, and owner override, wired by connectFindingCards
// exactly as the plan composition wires it. The ledger is read through the
// fold every reader uses.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { TaskResultService } from '../team/TaskResultService'
import { taskHandlers } from '../team/taskTools'
import { connectFindingCards } from '../plans/decisions/findingCards'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createDecisionBench, type DecisionBench } from './decisionHarness'
import { teamTaskStage } from '../../shared/teamTaskStage'

let world: PlanWorld
let bench: DecisionBench
let results: TaskResultService
let ownershipRefusal: string | null

beforeAll(async () => { world = await createPlanWorld('kawai-finding-disputes-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createDecisionBench(world)
  ownershipRefusal = null
  results = new TaskResultService(bench.taskService, {
    getSession: id => bench.records.get(id),
    // DS6: the ownership seam the execution supplies; a Restart's old holder is refused here.
    ownership: { checkResult: async () => ownershipRefusal, isKawaiMessage: () => false, revisionOf: () => null } as never,
  })
  connectFindingCards({
    findings: results.findingsLedger, decisions: bench.decide, decisionStore: bench.decisions, taskStore: bench.tasks, mailbox: bench.mail,
    identityOf: () => world.team,
  })
})

const dev = { kind: 'agent' as const, sessionId: 'dev' }
const lead = { kind: 'agent' as const, sessionId: 'lead' }
const human = () => bench.human
const tools = (session: string) => taskHandlers(bench.taskService, session, results) as Record<string, (input: unknown) => Promise<any>>
const state = (taskId: string, id = 'F1') => results.findingsLedger.ledger(taskId).find(row => row.id === id)?.state
const events = () => (bench.db.db.prepare('SELECT count(*) AS n FROM team_task_finding_events').get() as { n: number }).n

/** A task with a result by `dev` and a counted review raising one accepted P1 (and a P2). */
async function reviewed(planId: string | null) {
  const taskId = planId ? await bench.onTask('dev', planId) : bench.tasks.create({ teamId: world.team.teamId, title: 'Manual', direction: 'Build', creator: { kind: 'agent', sessionId: 'lead' } }).id
  const task = bench.tasks.get(taskId)!
  const result = await results.submit(dev, taskId, { summary: 'r1', commit: 'abc' })
  results.findingsLedger.submit({
    teamId: world.team.teamId, task, result, author: { kind: 'agent', sessionId: 'lead2' }, handoffId: null, counted: true,
    submission: { kind: 'review', findings: [
      { level: 'P1', clause: task.identity, evidence: 'src/a.ts:3', impact: 'wrong' },
      { level: 'P2', clause: task.identity, evidence: 'src/b.ts:3', impact: 'style' },
    ], dispositions: [] },
  })
  return { taskId, task, result }
}
const cardOf = (taskId: string) => bench.db.db.prepare('SELECT card_id FROM team_task_finding_cards WHERE task_id = ?').get(taskId) as { card_id: string }

describe('table DS — disputes', () => {
  // @covers: review-findings › The developer disputes findings with counter-evidence › The developer disputes an accepted finding
  test('DS1 the author disputes an accepted finding: it reads disputed, with the counter-evidence', async () => {
    const { taskId } = await reviewed(null)
    const reply = await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'bun test a.test.ts passes' }] })
    expect(reply.disputed).toEqual([{ id: 'F1', cardId: null }])
    const row = results.findingsLedger.ledger(taskId)[0]!
    expect([row.state, row.transitions.at(-1)!.note]).toEqual(['disputed', 'bun test a.test.ts passes'])
    expect(bench.mail.forTask(taskId).some(message => message.tags.includes('finding-dispute') && message.toId === 'lead')).toBe(true)
  })
  // @covers: review-findings › The developer disputes findings with counter-evidence › A second dispute of the same finding
  test('DS2 a finding upheld after a dispute cannot be disputed again in the same state', async () => {
    const { taskId } = await reviewed(null)
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'no' }] })
    await tools('lead').task_decide_dispute({ task_id: taskId, finding_id: 'F1', decision: 'uphold', rationale: 'reproduced' })
    const before = events()
    await expect(tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'again' }] })).rejects.toThrow('F1 was already disputed')
    expect([state(taskId), events()]).toEqual(['accepted', before])
  })
  test('DS3 a non-blocking finding cannot be disputed', async () => {
    const { taskId } = await reviewed(null)
    await expect(tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F2', counter_evidence: 'x' }] })).rejects.toThrow('F2 is not blocking')
  })
  test('DS4 a disputed finding cannot be disputed again', async () => {
    const { taskId } = await reviewed(null)
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })
    await expect(tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'y' }] })).rejects.toThrow('already disputed')
  })
  // @covers: review-findings › The developer disputes findings with counter-evidence › A reviewer cannot dispute
  test('DS5 a session that submitted no result is refused, and the finding stays accepted', async () => {
    const { taskId } = await reviewed(null)
    await expect(tools('lead2').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })).rejects.toThrow('submitted a result')
    expect(state(taskId)).toBe('accepted')
  })
  test('DS6 the holder a Restart replaced is refused by the ownership check', async () => {
    const { taskId } = await reviewed(null)
    ownershipRefusal = 'Task is held by another session after a Restart'
    await expect(tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })).rejects.toThrow('after a Restart')
    expect([state(taskId), events()]).toEqual(['accepted', 0])
  })
  test('DS7 eleven disputes in one call are refused naming 10', async () => {
    const { taskId } = await reviewed(null)
    const disputes = Array.from({ length: 11 }, (_, k) => ({ id: `F${k + 1}`, counter_evidence: 'x' }))
    await expect(tools('dev').task_dispute_findings({ task_id: taskId, disputes })).rejects.toThrow('at most 10')
    expect(events()).toBe(0)
  })
})

describe('manual decisions', () => {
  // @covers: review-findings › A dispute's decision upholds or rejects the finding › The creator rejects a dispute
  test('the creator rejects a dispute; the journal names the creator, the finding, and the rationale', async () => {
    const { taskId } = await reviewed(null)
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })
    await tools('lead').task_decide_dispute({ task_id: taskId, finding_id: 'F1', decision: 'reject', rationale: 'the test proves it' })
    expect(state(taskId)).toBe('rejected')
    expect(bench.tasks.journal(taskId).at(-1)).toMatchObject({ author: { kind: 'agent', sessionId: 'lead' }, text: 'Rejected the dispute of F1: the test proves it' })
  })
  // @covers: review-findings › A dispute's decision upholds or rejects the finding › Only the creator decides a manual dispute
  // @covers: review-findings › The verdict is derived from the ledger › A rejected dispute clears fixes requested
  test('a rejected dispute turns every reader\'s verdict to pass; the stored submission is unchanged', async () => {
    const { taskId } = await reviewed(null)
    const read = async () => (await bench.taskService.get({ kind: 'agent', sessionId: 'lead' }, taskId)).task
    const before = await read()
    expect(before.outstandingResult?.reviewVerdict).toBe('fail')
    expect(teamTaskStage(before, before.assignment, before.outstandingResult)).toBe('fixes-requested')
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })
    await tools('lead').task_decide_dispute({ task_id: taskId, finding_id: 'F1', decision: 'reject', rationale: 'r' })
    const after = await read()
    expect(after.outstandingResult?.reviewVerdict).toBe('pass')
    expect(teamTaskStage(after, after.assignment, after.outstandingResult)).toBe('awaiting-acceptance')
    expect(bench.tasks.list(world.team.teamId).find(task => task.id === taskId)?.outstandingResult?.reviewVerdict).toBe('pass')
    expect(bench.tasks.results.listByTask(taskId).flatMap(result => result.findings).map(row => row.verdict)).toEqual(['fail'])
  })
  test('a session that is not the creator cannot decide, and the finding stays disputed', async () => {
    const { taskId } = await reviewed(null)
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })
    await expect(tools('lead2').task_decide_dispute({ task_id: taskId, finding_id: 'F1', decision: 'reject', rationale: 'r' })).rejects.toThrow('creator or the human')
    expect(state(taskId)).toBe('disputed')
  })
  test('a plan change\'s dispute cannot be decided with the tool', async () => {
    const planId = await bench.approvedPlan()
    const { taskId } = await reviewed(planId)
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })
    await expect(results.decideDispute(human(), taskId, { findingId: 'F1', decision: 'reject', rationale: 'r' })).rejects.toThrow('decision cards')
  })
})

describe('table DD — card decisions', () => {
  // @covers: plan-decisions › Kawai raises a card for each disputed finding › The Lead decides a dispute
  test('DD2 the Lead gets one card with Uphold and Reject, and Reject F1 makes it rejected', async () => {
    const planId = await bench.approvedPlan()
    const { taskId } = await reviewed(planId)
    const reply = await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'it works' }] })
    const card = bench.decisions.card(world.team.teamId, reply.disputed[0].cardId)!
    expect(card).toMatchObject({ addressedTo: 'lead', addressedGroup: 'leads', taskId, options: ['Uphold F1', 'Reject F1'], askedBy: { session: 'dev' } })
    expect(card.context).toContain('src/a.ts:3')
    expect(card.context).toContain('it works')
    await bench.decide.record(lead, { plan_id: planId, card_id: card.id, choice: 'Reject F1', rationale: 'refuted' })
    expect(state(taskId)).toBe('rejected')
  })
  test('DD1 Uphold restores the state before the dispute', async () => {
    const planId = await bench.approvedPlan()
    const { taskId } = await reviewed(planId)
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })
    await bench.decide.record(lead, { plan_id: planId, card_id: cardOf(taskId).card_id, choice: 'Uphold F1', rationale: 'reproduced' })
    expect(state(taskId)).toBe('accepted')
  })
  test('DD1 Uphold of a still-open finding restores still-open, not accepted', async () => {
    const { taskId, task } = await reviewed(null)
    const r2 = await results.submit(dev, taskId, { summary: 'r2', commit: 'def' })
    results.findingsLedger.submit({ teamId: world.team.teamId, task, result: r2, author: { kind: 'agent', sessionId: 'lead2' }, handoffId: null, counted: true,
      submission: { kind: 'review', findings: [], dispositions: [{ id: 'F1', disposition: 'still-open', evidence: 'still at a.ts:3' }] } })
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })
    await tools('lead').task_decide_dispute({ task_id: taskId, finding_id: 'F1', decision: 'uphold', rationale: 'r' })
    expect(state(taskId)).toBe('still-open')
  })
  // @covers: plan-decisions › Kawai raises a card for each disputed finding › No Lead role
  test('with no Lead role the card is addressed to the owner, whose answer decides it', async () => {
    const planId = await bench.approvedPlan(false)
    const { taskId } = await reviewed(planId)
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })
    const card = bench.decisions.card(world.team.teamId, cardOf(taskId).card_id)!
    expect(card.addressedTo).toBe('owner')
    await bench.decide.answer(human(), { planId, cardId: card.id, choice: 'Reject F1', rationale: 'r', commandId: 'a-1' })
    expect(state(taskId)).toBe('rejected')
  })
  // @covers: plan-decisions › Kawai raises a card for each disputed finding › The owner overrides a rejection
  test('DD3 the owner overrides a rejection with Uphold: the state before the dispute, journaled, with a fix task', async () => {
    const planId = await bench.approvedPlan()
    const { taskId } = await reviewed(planId)
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })
    const cardId = cardOf(taskId).card_id
    const first = (await bench.decide.record(lead, { plan_id: planId, card_id: cardId, choice: 'Reject F1', rationale: 'r' })).decision
    const outcome = await bench.decide.override(human(), { planId, cardId, expectedDecisionId: first.id, choice: 'Uphold F1', rationale: 'it is real', commandId: 'o-1' })
    expect(state(taskId)).toBe('accepted')
    expect(outcome.fixTaskId).not.toBeNull()
    expect(bench.tasks.journal(taskId).some(entry => entry.text.startsWith(`Upheld F1 on card ${cardId}`))).toBe(true)
  })
  test('DD4 an override of Uphold with Reject rejects the finding', async () => {
    const planId = await bench.approvedPlan()
    const { taskId } = await reviewed(planId)
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })
    const cardId = cardOf(taskId).card_id
    const first = (await bench.decide.record(lead, { plan_id: planId, card_id: cardId, choice: 'Uphold F1', rationale: 'r' })).decision
    await bench.decide.override(human(), { planId, cardId, expectedDecisionId: first.id, choice: 'Reject F1', rationale: 'no', commandId: 'o-1' })
    expect(state(taskId)).toBe('rejected')
  })
  // @covers: plan-decisions › Kawai raises a card for each disputed finding › A superseded finding's card
  test('DD5 a decision on a superseded finding is journaled and leaves it superseded', async () => {
    const planId = await bench.approvedPlan()
    const { taskId } = await reviewed(planId)
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })
    bench.tasks.findings.insertEvent({ taskId, findingId: 'F1', kind: 'superseded', actor: { kind: 'system', sessionId: null }, sourceKey: 'revision:test' })
    await bench.decide.record(lead, { plan_id: planId, card_id: cardOf(taskId).card_id, choice: 'Uphold F1', rationale: 'r' })
    expect(state(taskId)).toBe('superseded')
    expect(bench.tasks.journal(taskId).at(-1)!.text).toContain('left F1 unchanged')
  })
  test('DD5 a re-map keeps the dispute: a revision published after it moves the citation, and the card\'s Reject still applies', async () => {
    const planId = await bench.approvedPlan()
    const { taskId } = await reviewed(planId)
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })
    await bench.taskService.amend(human(), taskId, { direction: 'Build it, revised' })
    expect(results.findingsLedger.ledger(taskId)[0]!.transitions.map(entry => entry.kind)).toEqual(['accepted', 'disputed', 'remapped'])
    expect(state(taskId)).toBe('disputed')
    await bench.decide.record(lead, { plan_id: planId, card_id: cardOf(taskId).card_id, choice: 'Reject F1', rationale: 'refuted' })
    expect(state(taskId)).toBe('rejected')
  })
  test('DD6 a decision applies once: a replay and the startup pass write nothing new, and a lost event is repaired once', async () => {
    const planId = await bench.approvedPlan()
    const { taskId } = await reviewed(planId)
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })
    const cardId = cardOf(taskId).card_id
    const decision = (await bench.decide.record(lead, { plan_id: planId, card_id: cardId, choice: 'Reject F1', rationale: 'r' })).decision
    const before = events()
    expect(results.findingsLedger.disputes.applyCardDecision(cardId, decision)).toBe(false)
    expect(results.findingsLedger.disputes.replay(link => bench.decisions.decisionsOfCard(world.team.teamId, link.cardId))).toBe(0)
    expect(events()).toBe(before)
    bench.db.db.prepare('DELETE FROM team_task_finding_events WHERE source_key = ?').run(`decision:${decision.id}`)
    expect(state(taskId)).toBe('disputed')
    expect(results.findingsLedger.disputes.replay(link => bench.decisions.decisionsOfCard(world.team.teamId, link.cardId))).toBe(1)
    expect(state(taskId)).toBe('rejected')
  })
  test('DD7 an override after a later review disposed of the finding is ignored', async () => {
    const planId = await bench.approvedPlan()
    const { taskId, task } = await reviewed(planId)
    await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: 'F1', counter_evidence: 'x' }] })
    const cardId = cardOf(taskId).card_id
    const first = (await bench.decide.record(lead, { plan_id: planId, card_id: cardId, choice: 'Uphold F1', rationale: 'r' })).decision
    const r2 = await results.submit(dev, taskId, { summary: 'r2', commit: 'def' })
    results.findingsLedger.submit({ teamId: world.team.teamId, task, result: r2, author: { kind: 'agent', sessionId: 'lead2' }, handoffId: null, counted: true,
      submission: { kind: 'review', findings: [], dispositions: [{ id: 'F1', disposition: 'resolved' }] } })
    await bench.decide.override(human(), { planId, cardId, expectedDecisionId: first.id, choice: 'Reject F1', rationale: 'no', commandId: 'o-1' })
    expect(state(taskId)).toBe('resolved')
  })
})
