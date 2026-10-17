// The agent surface for executions (plan-execution §16): `plan_get` shows a
// running execution's change states, attempt, and latest round; the team
// prompt's plan note states the execution-task rules — results land on the
// change's branch, replies to Kawai are refused, and no tool controls an
// execution.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { StrategyStore } from '../strategy/strategyStore'
import { PlanStore } from '../plans/planStore'
import { PlanService } from '../plans/PlanService'
import { planHandlers } from '../plans/planTools'
import { ExecutionStore } from '../plans/execution/executionStore'
import { executionViews } from '../plans/execution/executionView'
import { buildTeamPrompt } from '../team/teamPrompt'
import { createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'

const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

let world: PlanWorld
let bench: PlanBench
let executions: ExecutionStore
let service: PlanService

beforeAll(async () => { world = await createPlanWorld('kawai-plan-exec-tools-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(async () => {
  bench?.db.close()
  bench = createPlanBench(world)
  executions = new ExecutionStore(bench.db.db)
  service = new PlanService(bench.plans, {
    getSession: id => bench.records.get(id),
    strategies: new StrategyStore(bench.db.db),
    homeDir: world.home,
    executionsOf: planId => executionViews(executions, planId),
  })
})

describe('plan_get executions (16.1)', () => {
  test('a running execution shows its change states, attempt, and latest round', async () => {
    const { planId, revision, hash } = await bench.draftInReview()
    await bench.approve(planId, revision)
    const execution = executions.insertExecution({
      teamId: world.team.teamId, planId, revision, contentHash: hash, reportId: 'r', inputHash: 'i',
      landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: FLOOR },
      maxParallel: 2, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }, { change: 'ui', landed: false }],
    })
    executions.insertAttempt({
      executionId: execution.id, change: 'api', kind: 'implement', assignmentId: null,
      manifest: { version: 1, plan: { id: planId, revision, contentHash: hash }, execution: execution.id, task: { id: 'task-1', revision: 1 }, validation: { reportId: 'r', inputHash: 'i' }, baseline: 'abc', startCommit: 'def', artifacts: {}, roleProfiles: [] },
      manifestHash: 'm',
    })
    executions.insertRound({ executionId: execution.id, change: 'api', attemptId: executions.attempts(execution.id, 'api')[0]!.id, resultId: 'res-1', commitSha: 'aaa', fixRound: false })
    // The implementer is at work on the round's attempt.
    executions.transition(execution.id, 'api', executions.change(execution.id, 'api')!, { state: 'implementing', taskId: 'task-1' })

    const detail = await planHandlers(service, 'lead').plan_get({ plan_id: planId })
    expect(detail.executions).toHaveLength(1)
    expect(detail.executions![0]).toMatchObject({ id: execution.id, revision, state: 'running' })
    expect(detail.executions![0]!.changes.map(row => [row.change, row.state, row.step, row.stopReason, row.fixRounds])).toEqual([
      ['api', 'implementing', null, null, 0],
      ['ui', 'waiting', null, null, 0],
    ])
    expect(executions.attempts(execution.id, 'api')).toHaveLength(1)
    expect(executions.rounds(execution.id, 'api')).toHaveLength(1)
  })

  test('without the execution wiring the detail keeps its old shape', async () => {
    const { planId, revision } = await bench.draftInReview()
    await bench.approve(planId, revision)
    const bare = new PlanService(bench.plans, { getSession: id => bench.records.get(id), strategies: new StrategyStore(bench.db.db), homeDir: world.home })
    const detail = await planHandlers(bare, 'lead').plan_get({ plan_id: planId })
    expect(detail.executions).toBeUndefined()
  })
})

describe('the plan note (16.2)', () => {
  test('states the execution rules: no control tool, results on the branch, replies refused', async () => {
    const outbound = { internal: ['example.internal'], modelProviders: [], mcpServers: [], extraModelProviderHosts: [] } as never
    const prompt = buildTeamPrompt({ outbound, sessionId: 'chat-x', groups: [] })
    expect(prompt).toContain('No tool of yours starts, stops, retries, or approves an execution')
    expect(prompt).toContain('Kawai checks it against the branch')
    expect(prompt).toContain('Reply to Kawai’s instruction mail is refused')
  })
})
