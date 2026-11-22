// Table S's S8 (owner-publication-handoff task 9.2) through the matrix
// bench's production executor: a change stagnates into a diagnosis, the
// Lead decides Amend and records a handoff with the amended direction
// instead of publishing (it may not), and the task's attention is the
// handoff item alone (S3). The human publishes the handoff: the executor's
// revision handling — which closes a diagnosis on any new task revision,
// whatever wrote it — closes it, dispatches exactly one fix attempt against
// the revision actually published, the convergence backstop reads zero, and
// no **Publish a task revision** item appears. Lives apart from
// `supervisionOwnerPublication.test.ts` because it needs the matrix bench.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { DiagnosisStore } from '../plans/execution/diagnosisStore'
import { changeConvergence } from '../plans/execution/executionView'
import { derivePlanSupervision } from '../plans/supervision/supervisionRead'
import { handoffAttentionFacts } from '../team/handoffAttention'
import type { PlanAttentionFact } from '../team/planAttention'
import { attentionItems, type AttentionInput } from '../team/workspaceRead'
import { decideDiagnosis, openDiagnosis } from './diagnosisTestKit'
import {
  createMatrixBench, createMatrixWorld, removeMatrixWorld, shapedReview, startedExecution, submitWork, type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'
import { writeGroup } from './planHarness'

let matrix: MatrixWorld
let h: MatrixBench

beforeAll(async () => {
  matrix = await createMatrixWorld('kawai-owner-publication-amend-')
  writeGroup(matrix.world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
})
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix) })
afterEach(() => { h.executor.close(); h.bench.db.close() })

const teamId = () => matrix.world.team.teamId
const ROLES = { roles: [{ group: 'middle-devs', profiles: ['default'] }, { group: 'reviewers', profiles: [] }, { group: 'leads', profiles: ['opus'] }], leadGroup: 'leads' }
const row = (executionId: string, change: string) => h.executions.change(executionId, change)!
const fixHandoffs = (taskId: string) => h.tasks.store.assignmentsOf(taskId).filter(entry => entry.handoffKind === 'fix')

let content = 0
async function stagnating(change: string): Promise<string> {
  const executionId = await startedExecution(h, [{ change }], ROLES)
  await h.tick()
  for (const raise of [['one thing is wrong'], [], []]) {
    content += 1
    await submitWork(h, executionId, change, `src/${change}.ts`, `export const v = ${content}\n`)
    await h.tick()
    await shapedReview(h, executionId, change, 'fail', { raise, resolve: 0 })
    await h.tick()
  }
  return executionId
}

/** The derived change and the task's attention: the plan sources over it beside the workspace read's handoff sources. */
function read(executionId: string, change: string) {
  const reads = { db: h.bench.db.db, mail: h.mail, executions: h.executions, plans: h.bench.plans, decisions: new DecisionStore(h.bench.db.db),
    conditionsOf: () => [], runtime: { holder: () => null, blocker: () => null, live: (id: string) => h.bench.records.has(id) } }
  const planId = h.executions.execution(executionId)!.planId
  const supervision = derivePlanSupervision(reads, teamId(), planId, new Date(h.clock.now))!.changes.find(entry => entry.change === change)!
  const decision = new DecisionStore(h.bench.db.db).decisionsOfCard(teamId(), new DiagnosisStore(h.bench.db.db).ofChange(executionId, change).at(-1)!.cardId).at(-1)
  const fact: PlanAttentionFact = {
    teamId: teamId(), planId, planTitle: 'Wave', leadGroup: 'leads', executionId, openCards: [], fixes: [], failedPromotion: null, correctionOpen: false,
    changes: [{ taskId: row(executionId, change).taskId, generation: row(executionId, change).generation, supervision, amendRationale: decision?.rationale ?? null }],
  }
  const manager = { tasks: h.tasks, results: { ownedByExecution: () => true } }
  const items = attentionItems({
    sessions: [], messages: [], waiting: {}, taskTitle: () => 'task', nameOf: (id: string) => id, pendingAcceptance: [], outboundViolations: [], plans: [fact],
    ...handoffAttentionFacts(manager as never, teamId(), id => id),
  } as unknown as AttentionInput)
  return { supervision, actions: items.filter(item => item.impact.taskId === row(executionId, change).taskId).map(item => `${item.kind}: ${item.nextAction}`) }
}

// @covers: plan-supervision › A pending handoff stands for the post-Amend item › Publishing the handoff closes the diagnosis
test('S8: Amend plus a handoff shows one item; publishing it as revision N closes the diagnosis and dispatches one fix against revision N, backstop zero', async () => {
  const executionId = await stagnating('am-a')
  const taskId = row(executionId, 'am-a').taskId!
  const diagnosis = openDiagnosis(h.bench.db.db, executionId, 'am-a')!
  decideDiagnosis(h.bench.db.db, teamId(), executionId, 'am-a', 'Amend the contract')
  await h.tick()
  expect(row(executionId, 'am-a').step).toBe('diagnosing')
  const { handoff } = await h.tasks.handoffs.request({ kind: 'agent', sessionId: 'lead' }, taskId, {
    baseRevision: 1, direction: 'Narrow the contract', rationale: 'the review asked for more than the change', notify: false, requestKey: 'amend-1',
  })
  const before = read(executionId, 'am-a')
  expect(before.supervision.stall?.kind).toBe('convergence')
  expect(before.supervision.alsoApplying.map(wait => wait.kind)).toEqual(['contract-revision', 'owner-publication'])
  expect(before.actions).toEqual(['publication-handoff: Publish prepared revision'])
  const fixes = fixHandoffs(taskId).length

  await h.tasks.handoffs.publish(h.bench.human, taskId, handoff.id, [])
  const published = h.tasks.store.get(taskId)!.revision
  expect(published).toBe(2)
  await h.tick()
  await h.tick()

  expect(new DiagnosisStore(h.bench.db.db).get(diagnosis.id)).toMatchObject({ closeReason: 'revision', outcome: null })
  expect(row(executionId, 'am-a')).toMatchObject({ state: 'implementing', fixRounds: 0 })
  const dispatched = fixHandoffs(taskId).slice(fixes)
  expect(dispatched).toHaveLength(1)
  expect(h.mail.get(dispatched[0]!.messageId!)!.body).toContain(`revision ${published}`)
  expect(changeConvergence(h.bench.db.db, executionId, 'am-a', taskId)?.counts ?? []).toEqual([])
  const after = read(executionId, 'am-a')
  expect(after.supervision.stall).toBeNull()
  expect(after.actions.filter(action => action.includes('Publish a task revision') || action.startsWith('publication-handoff'))).toEqual([])
})
