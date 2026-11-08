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
import { LEAD_ROLES } from './decisionHarness'
import { REVIEW_P0_TAG, raiseReviewP0Alerts } from '../plans/supervision/reviewAlerts'
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

describe('what the fix and verify handoffs say (D7)', () => {
  const handoffs = (executionId: string, change: string, kind: string) =>
    h.tasks.store.assignmentsOf(row(executionId, change).taskId!).filter(entry => entry.handoffKind === kind)
  // @covers: plan-execution › A failed round returns the change for fixes › Only blocking findings are listed
  test('the executor\'s fix handoff lists F1 with clause, evidence, and repro; counts F2 and F3; lists neither', async () => {
    const executionId = await startedExecution(h, [{ change: 'fx-one' }])
    await h.tick()
    await submitWork(h, executionId, 'fx-one', 'src/fx-one.ts', 'x\n')
    await h.tick()
    const identity = h.tasks.store.get(row(executionId, 'fx-one').taskId!)!.identity!
    await structured(executionId, 'fx-one', [
      { ...finding(executionId, 'fx-one', 'src/a.ts'), reproduction: 'bun test a.test.ts' },
      { level: 'P2', clause: identity, evidence: 'src/style.ts:4 naming', impact: 'style' },
      { level: 'P1', clause: 'A1', evidence: 'src/x.ts:2', impact: 'cites a clause the revision lacks' },
    ])
    await h.tick()
    const fix = handoffs(executionId, 'fx-one', 'fix').at(-1)!.instruction
    expect(fix).toContain(`F1 (P1, ${identity}): src/a.ts:1 is wrong — repro: bun test a.test.ts`)
    expect(fix).toContain('2 other findings are (advisory, unsupported, out of contract) in task_get')
    expect(fix).toContain('task_dispute_findings')
    expect(fix).not.toContain('F2 (')
    expect(fix).not.toContain('F3 (')
  })
  // @covers: plan-execution › The review follows green CI › A verify review lists the open findings
  test('a fix round\'s review handoff names the open findings with their clauses and asks for a disposition of each', async () => {
    const executionId = await startedExecution(h, [{ change: 'fx-verify' }])
    await h.tick()
    await submitWork(h, executionId, 'fx-verify', 'src/fx-verify.ts', 'x\n')
    await h.tick()
    expect(handoffs(executionId, 'fx-verify', 'review')[0]!.instruction).toContain('Submit structured findings with task_submit_findings')
    await structured(executionId, 'fx-verify', ['src/a.ts', 'src/b.ts', 'src/c.ts'].map(file => finding(executionId, 'fx-verify', file)))
    await h.tick()
    const taskId = row(executionId, 'fx-verify').taskId!
    const identity = h.tasks.store.get(taskId)!.identity!
    await h.results.disputeFindings(h.bench.agent('dev'), taskId, [{ id: 'F1', counterEvidence: 'a.ts:1 is intended' }])
    await submitWork(h, executionId, 'fx-verify', 'src/fx-verify.ts', 'y\n')
    await h.tick()
    const verify = handoffs(executionId, 'fx-verify', 'review').at(-1)!.instruction
    expect(verify).toContain(`Judge it under contract identity ${identity}`)
    expect(verify).toContain(`- F2 (P1, ${identity})\n- F3 (P1, ${identity})`)
    expect(verify).toContain('give each a disposition')
    expect(verify).not.toContain('- F1 (')
  })
})

describe('review-p0 alerts (D10)', () => {
  const p0 = (executionId: string, change: string, extra: Partial<SubmittedFinding> = {}): SubmittedFinding =>
    ({ ...finding(executionId, change, 'src/auth.ts'), level: 'P0', evidence: 'src/auth.ts:7 skips the token check', ...extra })
  const leadMail = () => (h.bench.db.db.prepare("SELECT body, tags FROM team_messages WHERE to_id = 'leads'").all() as Array<{ body: string; tags: string }>)
    .filter(message => (JSON.parse(message.tags) as string[]).includes(REVIEW_P0_TAG))
  // @covers: plan-execution › An accepted P0 alerts the Lead role › A security finding alerts the Lead
  test('an accepted P0 sends the Lead one review-p0 message naming the change, F1, its clause, and its evidence; the fix goes out', async () => {
    const executionId = await startedExecution(h, [{ change: 'p0-lead' }], { roles: LEAD_ROLES.roles as never, leadGroup: 'leads' })
    await h.tick()
    await submitWork(h, executionId, 'p0-lead', 'src/p0-lead.ts', 'x\n')
    await h.tick()
    await structured(executionId, 'p0-lead', [p0(executionId, 'p0-lead')])
    await h.tick()
    await h.tick()
    const mail = leadMail()
    expect(mail).toHaveLength(1)
    const identity = h.tasks.store.get(row(executionId, 'p0-lead').taskId!)!.identity!
    expect(mail[0]!.body).toContain('change p0-lead')
    expect(mail[0]!.body).toContain('accepted F1 at P0')
    expect(mail[0]!.body).toContain(`Clause: ${identity}`)
    expect(mail[0]!.body).toContain('src/auth.ts:7 skips the token check')
    expect(newestRound(executionId, 'p0-lead').outcome).toBe('fail')
    expect(h.tasks.store.assignmentsOf(row(executionId, 'p0-lead').taskId!).some(entry => entry.handoffKind === 'fix')).toBe(true)
    // A replayed decision (a crash before the round's decide) sends nothing new.
    const round = newestRound(executionId, 'p0-lead')
    const items = h.tasks.store.results.findingsFor(round.resultId).find(entry => entry.id === round.verdictFindingsId)!.items
    const again = raiseReviewP0Alerts({ db: h.bench.db.db, mail: h.mail, plans: h.bench.plans, executions: h.executions }, matrix.world.team,
      { executionId, change: 'p0-lead', taskId: row(executionId, 'p0-lead').taskId! }, round, items)
    expect(again).toBe(0)
    expect(leadMail()).toHaveLength(1)
  })
  // @covers: plan-execution › An accepted P0 alerts the Lead role › An unsupported P0 does not alert
  test('an unsupported P0 (no evidence) sends no alert', async () => {
    const executionId = await startedExecution(h, [{ change: 'p0-bare' }], { roles: LEAD_ROLES.roles as never, leadGroup: 'leads' })
    await h.tick()
    await submitWork(h, executionId, 'p0-bare', 'src/p0-bare.ts', 'x\n')
    await h.tick()
    await structured(executionId, 'p0-bare', [p0(executionId, 'p0-bare', { evidence: null }), finding(executionId, 'p0-bare', 'src/a.ts')])
    await h.tick()
    expect(newestRound(executionId, 'p0-bare').outcome).toBe('fail')
    expect(ledger(executionId, 'p0-bare').map(entry => [entry.id, entry.level, entry.state])).toEqual([['F1', 'P0', 'unsupported'], ['F2', 'P1', 'accepted']])
    expect(leadMail()).toHaveLength(0)
  })
  test('without a Lead role the alert is a plan event the owner sees', async () => {
    const executionId = await startedExecution(h, [{ change: 'p0-owner' }])
    await h.tick()
    await submitWork(h, executionId, 'p0-owner', 'src/p0-owner.ts', 'x\n')
    await h.tick()
    await structured(executionId, 'p0-owner', [p0(executionId, 'p0-owner')])
    await h.tick()
    const planId = h.executions.execution(executionId)!.planId
    const events = h.bench.plans.events(planId).filter(event => event.kind === 'review-p0')
    expect(events).toHaveLength(1)
    expect(events[0]!.reason).toContain('accepted F1 at P0')
    expect(leadMail()).toHaveLength(0)
  })
})
