// Re-gating a refuted review (review-findings-ledger 5.3, D8) through the
// executor tick over the matrix harness: a review rejected on its disputes
// passes its result as a new round on the kept CI and review, once — across
// a restart and a crash inside the step — while a superseded finding is no
// refutation. Disputes go through the real DecisionService, wired as the
// plan composition wires it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { connectFindingCards } from '../plans/decisions/findingCards'
import { DecisionService } from '../plans/decisions/DecisionService'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { decisionReplyGuard } from '../plans/decisions/decisionReplyGuard'
import { attemptStatus } from '../plans/execution/attemptStatus'
import { TeamMailbox } from '../team/TeamMailbox'
import type { SubmittedFinding } from '../../shared/findingsLedger'
import { createMatrixBench, createMatrixWorld, removeMatrixWorld, startedExecution, submitWork, type MatrixBench, type MatrixWorld } from './executionMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench
let decide: DecisionService

beforeAll(async () => { matrix = await createMatrixWorld('kawai-regate-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => {
  h = createMatrixBench(matrix)
  const decisions = new DecisionStore(h.bench.db.db)
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
const rounds = (executionId: string, change: string) => h.executions.rounds(executionId, change)

/** R1 reviewed with one accepted P1 per file; its round failed; the fix handoff was claimed by the developer. */
async function failedOn(change: string, files: string[]) {
  const executionId = await startedExecution(h, [{ change }])
  await h.tick()
  await submitWork(h, executionId, change, `src/${change}.ts`, 'one\n')
  await h.tick()
  const taskId = row(executionId, change).taskId!
  const identity = h.tasks.store.get(taskId)!.identity!
  const round = rounds(executionId, change).at(-1)!
  const review = h.tasks.store.assignmentsOf(taskId).find(entry => entry.id === round.reviewAssignmentId)!
  h.mail.claim(review.messageId!, 'rev1'); h.mail.markPushed(review.messageId!); h.mail.markDelivered(review.messageId!)
  const items: SubmittedFinding[] = files.map(file => ({ level: 'P1', clause: identity, evidence: `${file}:1 is wrong`, impact: 'wrong' }))
  await h.results.submitFindings(h.bench.agent('rev1'), taskId, { resultId: round.resultId, kind: 'review', items })
  await h.tick()
  const fix = h.tasks.store.assignmentsOf(taskId).filter(entry => entry.handoffKind === 'fix').at(-1)!
  h.mail.claim(fix.messageId!, 'dev'); h.mail.markPushed(fix.messageId!); h.mail.markDelivered(fix.messageId!)
  const planId = h.executions.execution(executionId)!.planId
  return { executionId, taskId, planId, failed: rounds(executionId, change).at(-1)! }
}

async function rejectDispute(planId: string, taskId: string, id: string, key: string) {
  const disputed = await h.results.disputeFindings(h.bench.agent('dev'), taskId, [{ id, counterEvidence: `${id} describes intended behaviour` }])
  await decide.answer(h.bench.human, { planId, cardId: disputed.disputed[0]!.cardId!, choice: `Reject ${id}`, rationale: 'refuted', commandId: key })
}

describe('rejected disputes re-gate the failed round (D8)', () => {
  // @covers: plan-execution › Rejected disputes re-gate a failed round's result › A refuted review passes without a new commit
  test('RG1 R1 failed on F1 alone; F1 rejected on its dispute: a new passing round for R1, fix count reset, attempt answered', async () => {
    const { executionId, taskId, planId, failed } = await failedOn('rg-one', ['src/a.ts'])
    expect(failed).toMatchObject({ outcome: 'fail', blockingIds: ['F1'] })
    await rejectDispute(planId, taskId, 'F1', 'rg-one-1')
    await h.tick()
    const all = rounds(executionId, 'rg-one')
    const regate = all.find(round => round.regateOf === failed.id)!
    expect(regate).toMatchObject({ outcome: 'pass', resultId: failed.resultId, commitSha: failed.commitSha, reviewAssignmentId: failed.reviewAssignmentId, verdictFindingsId: failed.verdictFindingsId, ci: failed.ci })
    expect(row(executionId, 'rg-one').fixRounds).toBe(0)
    expect(row(executionId, 'rg-one').passedAt).not.toBeNull()
    const attempt = h.executions.attempts(executionId, 'rg-one').at(-1)!
    expect(attempt.kind).toBe('fix')
    expect(attemptStatus(attempt, h.tasks.store.assignmentsOf(taskId), all)).toBe('answered')
    const fix = h.tasks.store.assignmentsOf(taskId).find(entry => entry.id === attempt.assignmentId)!
    expect(fix.supersededBy).toBe(regate.id)
    expect(h.mail.forTask(taskId).some(message => message.toId === 'dev' && message.tags.includes('review-regate'))).toBe(true)
    expect(h.tasks.store.journal(taskId).some(entry => entry.text.startsWith(`Re-gated result ${failed.resultId}`))).toBe(true)
    await h.tick()
    expect(rounds(executionId, 'rg-one').filter(round => round.regateOf !== null)).toHaveLength(1)
  })

  // @covers: plan-execution › Rejected disputes re-gate a failed round's result › A superseded finding is not a refutation
  test('RG8 F1 rejected, F2 superseded by a new contract: no new round, the change waits for a result on the new revision', async () => {
    const { executionId, taskId, planId, failed } = await failedOn('rg-super', ['src/a.ts', 'src/b.ts'])
    await rejectDispute(planId, taskId, 'F1', 'rg-super-1')
    // Revision 2 with a contract: F2's revision citation cannot carry over and is superseded (RM4).
    await h.tasks.amend(h.bench.human, taskId, { contract: ['## Implementation contract', '### Acceptance', '- A1: Exports rows', '### Invariants', '- I1: Never twice',
      '### Scope', '- `src/**`', '### Verification', '- V1: check passes', '### Excluded', '- X1: No metrics'].join('\n') })
    expect(h.results.findingsLedger.ledger(taskId).map(entry => [entry.id, entry.state])).toEqual([['F1', 'rejected'], ['F2', 'superseded']])
    await h.tick()
    expect(rounds(executionId, 'rg-super').some(round => round.regateOf === failed.id)).toBe(false)
    expect(row(executionId, 'rg-super').state).toBe('implementing')
  })

  test('RG2 one blocker rejected while the other is still disputed: no round yet', async () => {
    const { executionId, taskId, planId, failed } = await failedOn('rg-wait', ['src/a.ts', 'src/b.ts'])
    await rejectDispute(planId, taskId, 'F1', 'rg-wait-1')
    await h.results.disputeFindings(h.bench.agent('dev'), taskId, [{ id: 'F2', counterEvidence: 'b.ts:1 is intended' }])
    await h.tick()
    expect(rounds(executionId, 'rg-wait').some(round => round.regateOf === failed.id)).toBe(false)
  })

  // @covers: plan-execution › Rejected disputes re-gate a failed round's result › A restart between the decision and the re-gate
  test('a restart after the rejection and before the re-gate creates exactly one round', async () => {
    const { executionId, taskId, planId, failed } = await failedOn('rg-restart', ['src/a.ts'])
    h.executor.close()
    await rejectDispute(planId, taskId, 'F1', 'rg-restart-1')
    expect(rounds(executionId, 'rg-restart').some(round => round.regateOf === failed.id)).toBe(false)
    const restarted = h.makeExecutor()
    try {
      await h.tick(restarted)
      await h.tick(restarted)
      expect(rounds(executionId, 'rg-restart').filter(round => round.regateOf === failed.id)).toHaveLength(1)
    } finally { restarted.close() }
  })

  test('a crash inside the re-gate after its insert writes nothing; the next tick re-gates once', async () => {
    const { executionId, taskId, planId, failed } = await failedOn('rg-crash', ['src/a.ts'])
    h.executor.close()
    let crashes = 1
    const crashing = h.makeExecutor({ regateAfterInsert: () => { if (crashes-- > 0) throw new Error('simulated crash after the insert') } })
    try {
      await rejectDispute(planId, taskId, 'F1', 'rg-crash-1')
      await h.tick(crashing)
      expect(rounds(executionId, 'rg-crash').filter(round => round.regateOf === failed.id)).toHaveLength(0)
      expect(row(executionId, 'rg-crash').state).toBe('implementing')
      await h.tick(crashing)
      await h.tick(crashing)
      expect(rounds(executionId, 'rg-crash').filter(round => round.regateOf === failed.id)).toHaveLength(1)
    } finally { crashing.close() }
  })
})
