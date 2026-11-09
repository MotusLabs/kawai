// review-convergence spec scenarios over the matrix bench's production
// executor that the DO/DX tables leave implicit (task 11.1): a plan with no
// Lead role asks the owner without mail; a signal leaves the findings and the
// round as they were (I1); and the Lead's Amend publishes nothing — the
// change waits on the owner's revision (I4).
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { foldLedger } from '../../shared/findingsLedger'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { derivePlanSupervision } from '../plans/supervision/supervisionRead'
import { decideDiagnosis, openDiagnosis } from './diagnosisTestKit'
import {
  createMatrixBench, createMatrixWorld, removeMatrixWorld, shapedReview, startedExecution, submitWork,
  type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench

beforeAll(async () => { matrix = await createMatrixWorld('kawai-diagnosis-scenarios-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix) })
afterEach(() => { h.executor.close(); h.bench.db.close() })

const teamId = () => matrix.world.team.teamId
const WITH_LEAD = { roles: [{ group: 'middle-devs', profiles: ['default'] }, { group: 'reviewers', profiles: [] }, { group: 'leads', profiles: ['opus'] }], leadGroup: 'leads' }
const NO_LEAD = { roles: [{ group: 'middle-devs', profiles: ['default'] }, { group: 'reviewers', profiles: [] }] }
const row = (executionId: string, change: string) => h.executions.change(executionId, change)!
const messageCount = () => (h.bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n

let content = 0
async function failedRound(executionId: string, change: string, shape: { raise: string[]; resolve: number }): Promise<void> {
  content += 1
  await submitWork(h, executionId, change, `src/${change}.ts`, `export const v = ${content}\n`)
  await h.tick()
  await shapedReview(h, executionId, change, 'fail', shape)
}

/** Three flat failed reviews: S4 opens a diagnosis on the third. */
async function stagnating(change: string, roles: typeof WITH_LEAD): Promise<string> {
  const executionId = await startedExecution(h, [{ change }], roles)
  await h.tick()
  for (const raise of [['one thing is wrong'], [], []]) {
    await failedRound(executionId, change, { raise, resolve: 0 })
    await h.tick()
  }
  return executionId
}

// @covers: plan-supervision › A stall alerts the Lead role once per episode › No Lead role
test('with no Lead role the diagnosis card is addressed to the owner and no mail is sent', async () => {
  const executionId = await startedExecution(h, [{ change: 'nl-a' }], NO_LEAD)
  await h.tick()
  for (const raise of [['one thing is wrong'], []]) {
    await failedRound(executionId, 'nl-a', { raise, resolve: 0 })
    await h.tick()
  }
  await failedRound(executionId, 'nl-a', { raise: [], resolve: 0 })
  const before = messageCount()
  await h.tick()
  const diagnosis = openDiagnosis(h.bench.db.db, executionId, 'nl-a')!
  const card = new DecisionStore(h.bench.db.db).card(teamId(), diagnosis.cardId)!
  expect(card).toMatchObject({ kind: 'diagnosis', addressedTo: 'owner', addressedGroup: null, messageId: null })
  expect(diagnosis.messageId).toBeNull()
  expect(messageCount()).toBe(before)
})

// @covers: review-convergence › A signal never decides a finding › Signals leave the ledger alone
test('S3 fires on a round that failed on two new findings: both still read accepted, and the round still reads failed', async () => {
  const executionId = await startedExecution(h, [{ change: 'sl-a' }], WITH_LEAD)
  await h.tick()
  await failedRound(executionId, 'sl-a', { raise: ['src/a.ts:1 off by one'], resolve: 0 })
  await h.tick()
  // The second review resolves F1 and raises F2 and F3: 2 raised against 1 resolved.
  await failedRound(executionId, 'sl-a', { raise: ['src/b.ts:2 drops the header', 'src/c.ts:3 sorts descending'], resolve: 1 })
  await h.tick()
  const diagnosis = openDiagnosis(h.bench.db.db, executionId, 'sl-a')!
  expect(diagnosis.signals.map(signal => signal.kind)).toContain('S3')
  const taskId = row(executionId, 'sl-a').taskId!
  const ledger = foldLedger(h.tasks.store.findings.countedSubmissions(taskId), h.tasks.store.findings.events(taskId))
  expect(ledger.map(entry => [entry.id, entry.state])).toEqual([['F1', 'resolved'], ['F2', 'accepted'], ['F3', 'accepted']])
  expect(h.executions.round(diagnosis.roundId)!.outcome).toBe('fail')
  expect(h.tasks.store.findings.events(taskId).filter(event => event.kind === 'rejected')).toEqual([])
})

// @covers: review-convergence › Amend the contract waits for the owner's revision › The Lead cannot publish it
test('the Lead\'s Amend publishes no task revision; the change waits on the owner\'s revision 2', async () => {
  const executionId = await stagnating('lp-a', WITH_LEAD)
  const taskId = row(executionId, 'lp-a').taskId!
  decideDiagnosis(h.bench.db.db, teamId(), executionId, 'lp-a', 'Amend the contract')
  for (let pass = 0; pass < 3; pass++) await h.tick()
  expect(h.tasks.store.get(taskId)!.revision).toBe(1)
  expect(h.tasks.store.revisions(taskId)).toHaveLength(1)
  expect(row(executionId, 'lp-a').step).toBe('diagnosing')
  const reads = { db: h.bench.db.db, mail: h.mail, executions: h.executions, plans: h.bench.plans, decisions: new DecisionStore(h.bench.db.db), conditionsOf: () => [], runtime: { holder: () => null, blocker: () => null } }
  const derived = derivePlanSupervision(reads, teamId(), h.executions.execution(executionId)!.planId, new Date(h.clock.now))!
  expect(derived.changes[0]!.alsoApplying).toContainEqual({ kind: 'contract-revision', taskId, revision: 2 })
})
