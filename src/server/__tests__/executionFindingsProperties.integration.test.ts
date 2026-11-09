// Properties P1 and P3 at the executor seam (review-findings-ledger 5.5,
// design "Properties"; seed 0xF1ED6E5): seeded reviews, disputes, and card
// decisions on a plan change, driven by the executor tick over the matrix
// harness with the real DecisionService, and a crash inside the re-gate's
// transaction after its insert.
// - P1: every round the tick decides reads the ledger's one fold — fail with
//   the fold's blocking ids, a hold while a dispute is pending, else pass.
// - P3: a failed round is re-gated at most once, across crashes and further
//   ticks, and exactly once when every finding it failed on was rejected and
//   nothing blocks or is disputed.
// Each case starts its own execution (about half a second), so this seam runs
// 24 cases; the service-level sequences run the 300
// (findingsLedgerProperties.integration.test.ts).
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { blocking, disputeRefusal, foldLedger, pendingDisputes, roundReview, type SubmittedFinding } from '../../shared/findingsLedger'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { connectFindingCards } from '../plans/decisions/findingCards'
import { DecisionService } from '../plans/decisions/DecisionService'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { decisionReplyGuard } from '../plans/decisions/decisionReplyGuard'
import { TeamMailbox } from '../team/TeamMailbox'
import { createMatrixBench, createMatrixWorld, removeMatrixWorld, startedExecution, submitWork, type MatrixBench, type MatrixWorld } from './executionMatrixHarness'

const CASES = 24

let matrix: MatrixWorld
let h: MatrixBench
let decide: DecisionService

beforeAll(async () => { matrix = await createMatrixWorld('kawai-findings-exec-props-') })
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

const claim = (messageId: string, session: string) => { h.mail.claim(messageId, session); h.mail.markPushed(messageId); h.mail.markDelivered(messageId) }

test('P1/P3 at the executor seam: rounds decide by the fold, and a refuted failed round re-gates exactly once across crashes', async () => {
  const rand = mulberry32(0xf1ed6e5)
  const pick = <T>(values: readonly T[]): T => values[Math.floor(rand() * values.length)]!
  let crashNext = false
  h.executor.close()
  const executor = h.makeExecutor({ regateAfterInsert: () => { if (crashNext) { crashNext = false; throw new Error('simulated crash after the insert') } } })
  const tally = { fail: 0, held: 0, pass: 0, regated: 0, crashes: 0 }
  try {
    for (let index = 0; index < CASES; index++) {
      const change = `prop-${index}`
      const executionId = await startedExecution(h, [{ change }])
      const planId = h.executions.execution(executionId)!.planId
      await h.tick(executor)
      await submitWork(h, executionId, change, `src/${change}.ts`, 'one\n')
      await h.tick(executor)
      const taskId = h.executions.change(executionId, change)!.taskId!
      const fold = () => foldLedger(h.bench.tasks.findings.countedSubmissions(taskId), h.bench.tasks.findings.events(taskId))
      const identity = h.tasks.store.get(taskId)!.identity!
      const round = h.executions.rounds(executionId, change).at(-1)!
      claim(h.tasks.store.assignmentsOf(taskId).find(entry => entry.id === round.reviewAssignmentId)!.messageId!, 'rev1')
      const items: SubmittedFinding[] = Array.from({ length: Math.floor(rand() * 4) }, (_, k) => ({
        level: pick(['P0', 'P1', 'P1', 'P2'] as const), clause: identity, evidence: `src/f${k}.ts:1 is wrong`, impact: 'wrong',
      }))
      await h.results.submitFindings(h.bench.agent('rev1'), taskId, { resultId: round.resultId, kind: 'review', items })

      /** Dispute some open blockers and decide some of the open disputes, by the cards' owner answers. */
      const disputeAndDecide = async (disputeRate: number, rejectRate: number, skipRate = 0.2) => {
        const open = blocking(fold()).filter(row => disputeRefusal(row, row.id) === null && rand() < disputeRate)
        if (open.length > 0) await h.results.disputeFindings(h.bench.agent('dev'), taskId, open.map(row => ({ id: row.id, counterEvidence: `${row.id} is intended` })))
        for (const row of pendingDisputes(fold())) {
          if (rand() < skipRate) continue
          const cardId = (h.bench.db.db.prepare('SELECT card_id FROM team_task_finding_cards WHERE task_id = ? AND finding_id = ? ORDER BY rowid DESC LIMIT 1')
            .get(taskId, row.id) as { card_id: string }).card_id
          const choice = rand() < rejectRate ? `Reject ${row.id}` : `Uphold ${row.id}`
          await decide.answer(h.bench.human, { planId, cardId, choice, rationale: 'decided', commandId: `${change}-${row.id}-${cardId}` })
        }
      }

      // Disputes may come before the verdict: the round then waits on them (P1, table RD).
      if (rand() < 0.5) await disputeAndDecide(1, 0.5, 0.5)
      for (let tick = 0; tick < 3 && h.executions.rounds(executionId, change)[0]!.outcome === null; tick++) {
        const expected = roundReview(fold())
        const blockers = blocking(fold()).map(row => row.id)
        await h.tick(executor)
        const decided = h.executions.rounds(executionId, change)[0]!
        if (expected === 'pending-dispute') {
          expect(decided.outcome).toBeNull()
          tally.held++
          await disputeAndDecide(0, 0.5)
        } else {
          expect(decided.outcome).toBe(expected)
          if (expected === 'fail') expect(decided.blockingIds).toEqual(blockers)
        }
      }
      const first = h.executions.rounds(executionId, change)[0]!
      if (first.outcome === 'pass') { tally.pass++; continue }
      if (first.outcome !== 'fail') continue
      tally.fail++

      // The failed round's fix goes out; its blockers are disputed and decided, then the tick may re-gate.
      const fix = h.tasks.store.assignmentsOf(taskId).filter(entry => entry.handoffKind === 'fix').at(-1)
      if (fix?.messageId) claim(fix.messageId, 'dev')
      await disputeAndDecide(0.8, 0.7)
      const ledger = fold()
      const refuted = first.blockingIds!.length > 0 && first.blockingIds!.every(id => ledger.find(row => row.id === id)?.state === 'rejected')
        && blocking(ledger).length === 0 && pendingDisputes(ledger).length === 0
      crashNext = rand() < 0.4
      const armed = crashNext
      for (let tick = 0; tick < 3; tick++) {
        await h.tick(executor)
        expect(h.executions.rounds(executionId, change).filter(entry => entry.regateOf === first.id).length).toBeLessThanOrEqual(1)
      }
      // The armed crash fired only if the re-gate ran: its insert rolled back, a later tick re-ran it.
      if (armed && !crashNext) tally.crashes++
      const regates = h.executions.rounds(executionId, change).filter(entry => entry.regateOf === first.id)
      expect(regates).toHaveLength(refuted ? 1 : 0)
      if (refuted) tally.regated++
      crashNext = false
    }
  } finally { executor.close() }
  // The sample reaches each path the properties are about.
  expect(tally.fail).toBeGreaterThan(5)
  expect(tally.pass).toBeGreaterThan(2)
  expect(tally.held).toBeGreaterThan(0)
  expect(tally.regated).toBeGreaterThan(0)
  expect(tally.crashes).toBeGreaterThan(0)
}, 180_000)
