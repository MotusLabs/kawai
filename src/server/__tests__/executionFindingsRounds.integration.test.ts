// Plan rounds decided from the findings ledger (review-findings-ledger 5.1,
// D8, table RD) through the executor tick over the matrix harness: a
// structured review fails or passes the round by the fold, a pending
// dispute holds it and the change names the dispute, the card's decision
// moves it, and the claimant's text-only findings are refused. Disputes
// are raised and decided through the real DecisionService, wired by
// connectFindingCards as the plan composition wires it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { connectFindingCards } from '../plans/decisions/findingCards'
import { DecisionService } from '../plans/decisions/DecisionService'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { decisionReplyGuard } from '../plans/decisions/decisionReplyGuard'
import { readPlanSupervision } from '../plans/supervision/supervisionRead'
import { causeLabel } from '../../shared/planSupervision'
import { TeamMailbox } from '../team/TeamMailbox'
import type { SubmittedDisposition, SubmittedFinding } from '../../shared/findingsLedger'
import { createMatrixBench, createMatrixWorld, removeMatrixWorld, startedExecution, submitWork, type MatrixBench, type MatrixWorld } from './executionMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench
let decide: DecisionService
let decisions: DecisionStore

beforeAll(async () => { matrix = await createMatrixWorld('kawai-findings-rounds-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => {
  h = createMatrixBench(matrix)
  decisions = new DecisionStore(h.bench.db.db)
  const getSession = (id: string) => h.bench.records.get(id)
  const mailbox = new TeamMailbox(h.mail, { getSession, homeDir: matrix.world.home, tasks: h.bench.tasks, replyGuard: decisionReplyGuard(decisions) })
  decide = new DecisionService({
    db: h.bench.db.db, decisions, plans: h.bench.plans, planService: h.bench.service, tasks: h.tasks, taskStore: h.bench.tasks,
    assignments: h.assignments, mailbox, getSession, homeDir: matrix.world.home, onChange: () => {},
  })
  connectFindingCards({ findings: h.results.findingsLedger, decisions: decide, decisionStore: decisions, taskStore: h.bench.tasks, mailbox: h.mail, identityOf: () => matrix.world.team })
})
afterEach(() => { h.executor.close(); h.bench.db.close() })

const row = (executionId: string, change: string) => h.executions.change(executionId, change)!
const newestRound = (executionId: string, change: string) => h.executions.rounds(executionId, change).at(-1)!
const ledger = (executionId: string, change: string) => h.results.findingsLedger.ledger(row(executionId, change).taskId!)
const finding = (executionId: string, change: string, file: string): SubmittedFinding =>
  ({ level: 'P1', clause: h.tasks.store.get(row(executionId, change).taskId!)!.identity!, evidence: `${file}:1 is wrong`, impact: 'wrong output' })

/** The newest round's review, claimed by `reviewer`, answered with structured items. */
async function structured(executionId: string, change: string, items: SubmittedFinding[], dispositions: SubmittedDisposition[] = [], reviewer = 'rev1') {
  const round = newestRound(executionId, change)
  const assignment = h.tasks.store.assignmentsOf(row(executionId, change).taskId!).find(entry => entry.id === round.reviewAssignmentId)!
  h.mail.claim(assignment.messageId!, reviewer)
  h.mail.markPushed(assignment.messageId!)
  h.mail.markDelivered(assignment.messageId!)
  return h.results.submitFindings(h.bench.agent(reviewer), row(executionId, change).taskId!, { resultId: round.resultId, kind: 'review', items, dispositions })
}

/** R1 reviewed with F1–F3 accepted, the round failed; F3 disputed by the developer; R2 submitted and its review handed off. */
async function heldOnDispute(change: string) {
  const executionId = await startedExecution(h, [{ change }])
  await h.tick()
  await submitWork(h, executionId, change, `src/${change}.ts`, 'one\n')
  await h.tick()
  await structured(executionId, change, ['src/a.ts', 'src/b.ts', 'src/c.ts'].map(file => finding(executionId, change, file)))
  await h.tick()
  expect(h.executions.rounds(executionId, change)[0]!.outcome).toBe('fail')
  const taskId = row(executionId, change).taskId!
  const disputed = await h.results.disputeFindings(h.bench.agent('dev'), taskId, [{ id: 'F3', counterEvidence: 'c.ts:1 is the documented behaviour' }])
  await submitWork(h, executionId, change, `src/${change}.ts`, 'two\n')
  await h.tick()
  await structured(executionId, change, [], [{ id: 'F1', disposition: 'resolved' }, { id: 'F2', disposition: 'resolved' }])
  await h.tick()
  return { executionId, taskId, cardId: disputed.disputed[0]!.cardId! }
}

describe('table RD — the round reads the fold', () => {
  // @covers: plan-execution › The review follows green CI › Changes requested fail the round
  test('RD1 an accepted P1 fails the round', async () => {
    const executionId = await startedExecution(h, [{ change: 'rd-one' }])
    await h.tick()
    await submitWork(h, executionId, 'rd-one', 'src/rd-one.ts', 'x\n')
    await h.tick()
    await structured(executionId, 'rd-one', [finding(executionId, 'rd-one', 'src/a.ts')])
    await h.tick()
    expect(newestRound(executionId, 'rd-one').outcome).toBe('fail')
  })
  test('RD3 an empty review with nothing open passes the round', async () => {
    const executionId = await startedExecution(h, [{ change: 'rd-three' }])
    await h.tick()
    await submitWork(h, executionId, 'rd-three', 'src/rd-three.ts', 'x\n')
    await h.tick()
    await structured(executionId, 'rd-three', [])
    await h.tick()
    expect(newestRound(executionId, 'rd-three').outcome).toBe('pass')
  })
  // @covers: plan-execution › An undecided dispute holds the round › The round waits for a dispute
  test('RD2 nothing blocking but F3 disputed: the round waits and the change names the dispute of F3', async () => {
    const { executionId } = await heldOnDispute('rd-two')
    expect(newestRound(executionId, 'rd-two').outcome).toBeNull()
    expect(ledger(executionId, 'rd-two').map(entry => [entry.id, entry.state])).toEqual([['F1', 'resolved'], ['F2', 'resolved'], ['F3', 'disputed']])
    const reads = {
      db: h.bench.db.db, mail: h.mail, executions: h.executions, plans: h.bench.plans, decisions, conditionsOf: () => [],
      runtime: { holder: () => null, blocker: () => null },
    }
    const supervision = readPlanSupervision(reads, matrix.world.team.teamId, h.executions.execution(executionId)!.planId, new Date(h.clock.now))
    const cause = supervision.find(entry => entry.change === 'rd-two')!.cause
    expect(causeLabel(cause)).toContain('Waiting on the dispute of F3')
  })
  // @covers: plan-execution › An undecided dispute holds the round › An upheld dispute fails the waiting round
  test('an upheld dispute fails the waiting round', async () => {
    const { executionId, cardId } = await heldOnDispute('rd-upheld')
    const planId = h.executions.execution(executionId)!.planId
    await decide.answer(h.bench.human, { planId, cardId, choice: 'Uphold F3', rationale: 'reproduced', commandId: 'u-1' })
    await h.tick()
    expect(newestRound(executionId, 'rd-upheld').outcome).toBe('fail')
  })
  test('a rejected dispute passes the waiting round', async () => {
    const { executionId, cardId } = await heldOnDispute('rd-rejected')
    const planId = h.executions.execution(executionId)!.planId
    await decide.answer(h.bench.human, { planId, cardId, choice: 'Reject F3', rationale: 'documented', commandId: 'r-1' })
    await h.tick()
    expect(newestRound(executionId, 'rd-rejected').outcome).toBe('pass')
  })
})

describe('the claimant answers in structured form', () => {
  // @covers: plan-execution › The review follows green CI › The claimant's text-only findings are refused
  test('the claimant\'s text-only fail is refused naming the structured form, and the round still waits', async () => {
    const executionId = await startedExecution(h, [{ change: 'rd-text' }])
    await h.tick()
    await submitWork(h, executionId, 'rd-text', 'src/rd-text.ts', 'x\n')
    await h.tick()
    const round = newestRound(executionId, 'rd-text')
    const assignment = h.tasks.store.assignmentsOf(row(executionId, 'rd-text').taskId!).find(entry => entry.id === round.reviewAssignmentId)!
    h.mail.claim(assignment.messageId!, 'rev1')
    h.mail.markPushed(assignment.messageId!)
    h.mail.markDelivered(assignment.messageId!)
    let refusal = ''
    try {
      await h.results.submitFindings(h.bench.agent('rev1'), row(executionId, 'rd-text').taskId!, { resultId: round.resultId, kind: 'review', verdict: 'fail', findings: 'broken' })
    } catch (error) { refusal = (error as Error).message }
    expect(refusal).toContain('structured findings')
    expect(h.tasks.store.results.findingsFor(round.resultId)).toEqual([])
    await h.tick()
    expect(newestRound(executionId, 'rd-text').outcome).toBeNull()
  })
})
