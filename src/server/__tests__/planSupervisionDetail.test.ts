// The plan's supervision detail (plan-supervision 6.3, design D15/D16): the
// decision cards with history, fix status, and derived commits; each change's
// supervision with the report; and usage — read through `plan_get` on the
// real team server and through `readPlanSupervisionDetail` over the stores.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { PLAN_USAGE_NOTES } from '../../shared/planUsage'
import type { PlanImpact } from '../../shared/strategyImpact'
import { ExecutionStore } from '../plans/execution/executionStore'
import { IntegrationStore } from '../plans/landing/integration/integrationStore'
import { PlanService } from '../plans/PlanService'
import { readPlanSupervisionDetail, type SupervisionDetailReads } from '../plans/supervision/planSupervisionDetail'
import { createMailboxServer } from '../team/mailboxTools'
import { TaskResultStore } from '../team/taskResultStore'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createDecisionBench, type DecisionBench } from './decisionHarness'

type Registered = Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>

let world: PlanWorld
let bench: DecisionBench
let executions: ExecutionStore
let impact: PlanImpact | null
const servers: Array<{ close: () => Promise<void> }> = []

beforeAll(async () => { world = await createPlanWorld('kawai-supervision-detail-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createDecisionBench(world)
  executions = new ExecutionStore(bench.db.db)
  impact = null
})
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })

const NOW = new Date('2026-10-20T12:00:00.000Z')
const teamId = () => world.team.teamId
const lead = { kind: 'agent' as const, sessionId: 'lead' }
const dev = { kind: 'agent' as const, sessionId: 'dev' }

function reads(): SupervisionDetailReads {
  return {
    db: bench.db.db, mail: bench.mail, executions, plans: bench.plans, decisions: bench.decisions, integration: new IntegrationStore(bench.db.db),
    conditionsOf: () => [], tasks: bench.tasks, impact: () => impact,
    runtime: { holder: () => null, blocker: () => null },
  }
}

/** An approved plan with a running execution; api is on a task of `dev`'s. */
async function started() {
  const planId = await bench.approvedPlan()
  const execution = executions.insertExecution({
    teamId: teamId(), planId, revision: bench.plans.approvedRevision(planId)!.revision, contentHash: 'h', reportId: 'r', inputHash: 'i', landingMode: 'direct',
    baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } },
    maxParallel: 3, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }, { change: 'ui', landed: false }],
  })
  const taskId = await bench.onTask('dev', planId, 'api')
  return { planId, executionId: execution.id, taskId }
}

/** Two failed rounds failing the same check: a repeating-failure stall (D11). */
function failTwice(executionId: string, taskId: string) {
  for (const n of [1, 2]) {
    const { round } = executions.insertRound({ executionId, change: 'api', attemptId: 'a1', resultId: `res-${n}`, commitSha: `c${n}`, fixRound: n === 2 })
    executions.setRoundCi(round.id, [{ name: 'unit', source: 'actions', conclusion: 'failure', link: null, startedAt: null, completedAt: `2026-10-20T0${n}:00:00.000Z` }], null)
    executions.decideRound(round.id, 'fail')
  }
  bench.db.db.prepare("UPDATE plan_execution_changes SET state = 'implementing', step = NULL, task_id = ? WHERE execution_id = ? AND change = 'api'").run(taskId, executionId)
}

async function decidedCard(planId: string) {
  const { card } = await bench.decide.ask(dev, { question: 'Which store?', options: ['sqlite', 'files'] })
  const recorded = await bench.decide.record(lead, { plan_id: planId, card_id: card.id, option_index: 1, rationale: 'one file' })
  return { card, decision: recorded.decision }
}

describe('plan_get carries decisions, supervision, and usage (D16)', () => {
  test('a plan with a stalled change and a decided card, through the team server', async () => {
    const { planId, executionId, taskId } = await started()
    failTwice(executionId, taskId)
    const { card, decision } = await decidedCard(planId)
    const plans = new PlanService(bench.plans, {
      getSession: id => bench.records.get(id), strategies: bench.strategies, homeDir: world.home,
      supervisionOf: (team, plan) => readPlanSupervisionDetail(reads(), team, plan, NOW),
    })
    const server = await createMailboxServer(bench.mailbox, 'dev', { plans })
    servers.push(server.instance as unknown as { close: () => Promise<void> })
    const tools = (server.instance as unknown as { _registeredTools: Registered })._registeredTools
    const result = await tools.plan_get!.handler({ plan_id: planId }, {})
    expect(result.isError).toBeFalsy()
    const detail = JSON.parse(result.content[0]!.text) as Record<string, any>
    expect(detail.decisions).toHaveLength(1)
    expect(detail.decisions[0]).toMatchObject({ card: { id: card.id }, state: 'decided', current: { id: decision.id, choice: 'sqlite' }, fixes: [] })
    const api = detail.supervision.changes.find((entry: { change: string }) => entry.change === 'api')
    expect(api).toMatchObject({ outcome: 'stalled', stall: { kind: 'repeating-failure', signature: 'unit' } })
    expect(detail.supervision.report).toMatchObject({ delivery: 'Landed 0 of 2', blockers: ['api'], overrides: { overridden: 0, total: 1 } })
    expect(detail.supervision.computedAt).toBe(NOW.toISOString())
    expect(detail.usage.notes).toEqual([...PLAN_USAGE_NOTES])
    expect(detail.usage.byGroupProfile).toEqual([])
  })

  test('without the supervision seam the detail has none of the three fields', async () => {
    const { planId } = await started()
    const detail = bench.service.detailWithExecutions(planId)
    expect(detail.decisions).toBeUndefined()
    expect(detail.supervision).toBeUndefined()
    expect(detail.usage).toBeUndefined()
  })
})

describe('the detail read (D15)', () => {
  test("an override's fix task shows its status, and the affected task's commits since the current decision", async () => {
    const { planId, taskId } = await started()
    const { card, decision } = await decidedCard(planId)
    const results = new TaskResultStore(bench.db.db)
    results.insert({ teamId: teamId(), taskId, summary: 'before', commit: 'old', diff: null, worktree: null, tests: [], limitations: null, submittedBy: { kind: 'agent', sessionId: 'dev' }, taskRevision: 1 }, '2000-01-01T00:00:00.000Z')
    const overridden = await bench.decide.override(bench.human, { planId, cardId: card.id, expectedDecisionId: decision.id, optionIndex: 2, rationale: 'files are simpler', commandId: 'o-1' })
    results.insert({ teamId: teamId(), taskId, summary: 'after', commit: 'new', diff: null, worktree: null, tests: [], limitations: null, submittedBy: { kind: 'agent', sessionId: 'dev' }, taskRevision: 1 }, '2099-01-01T00:00:00.000Z')
    const view = readPlanSupervisionDetail(reads(), teamId(), planId, NOW)!.decisions[0]!
    expect(view.state).toBe('overridden')
    expect(view.decisions.map(entry => entry.kind)).toEqual(['answer', 'override'])
    expect(view.fixes).toEqual([{ decisionId: overridden.decision.id, taskId: overridden.fixTaskId!, status: expect.objectContaining({ phase: 'planning' }) }])
    expect(view.commits).toEqual([{ taskId, commits: ['new'] }])
    // The fix task's status drives the phase: cancelled reads cancelled.
    bench.db.db.prepare("UPDATE team_tasks SET status = 'cancelled' WHERE id = ?").run(overridden.fixTaskId)
    expect(readPlanSupervisionDetail(reads(), teamId(), planId, NOW)!.decisions[0]!.fixes[0]!.status.phase).toBe('cancelled')
  })

  test("the report names a non-continue impact disposition with its review", async () => {
    const { planId } = await started()
    impact = { group: 'affected', gate: { state: 'adapt', pass: false, reviewId: 'rev-1', decisionId: 'd-1', pin: null }, reviewId: 'rev-1', reviewRevision: 4, revisions: [] }
    expect(readPlanSupervisionDetail(reads(), teamId(), planId, NOW)!.supervision.report.disposition).toEqual({ disposition: 'adapt', reviewId: 'rev-1', strategyRevision: 4 })
    impact = { ...impact, gate: { ...impact.gate!, state: 'continue', pass: true } }
    expect(readPlanSupervisionDetail(reads(), teamId(), planId, NOW)!.supervision.report.disposition).toBeNull()
  })

  test('another team or an unknown plan reads null', async () => {
    const { planId } = await started()
    expect(readPlanSupervisionDetail(reads(), 'team-other', planId, NOW)).toBeNull()
    expect(readPlanSupervisionDetail(reads(), teamId(), 'plan-missing', NOW)).toBeNull()
  })
})
