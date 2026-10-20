// The supervision loader (plan-supervision 8.1, design D10): one store-backed
// case per named wait, read through `readPlanSupervision` over the real plan,
// execution, task, assignment, mailbox, result, decision, and integration
// stores. Runtime facts (the holder's session facts and the mailbox blocker)
// come from a recording double that checks what it is asked for.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { HolderFacts } from '../../shared/planSupervision'
import { ExecutionStore } from '../plans/execution/executionStore'
import { IntegrationStore } from '../plans/landing/integration/integrationStore'
import { readPlanSupervision, readSupervisionInputs, type SupervisionReads } from '../plans/supervision/supervisionRead'
import { TaskResultStore } from '../team/taskResultStore'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createDecisionBench, type DecisionBench } from './decisionHarness'

let world: PlanWorld
let bench: DecisionBench
let executions: ExecutionStore
let integration: IntegrationStore
let holderFacts: Partial<HolderFacts>
let holderCalls: Array<[string, string | null]>
let blockerCalls: string[]
let conditions: string[]

beforeAll(async () => { world = await createPlanWorld('kawai-supervision-read-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createDecisionBench(world)
  executions = new ExecutionStore(bench.db.db)
  integration = new IntegrationStore(bench.db.db)
  holderFacts = {}
  holderCalls = []
  blockerCalls = []
  conditions = []
})

const NOW = new Date('2026-10-20T12:00:00.000Z')
const teamId = () => world.team.teamId

function reads(): SupervisionReads {
  return {
    db: bench.db.db, mail: bench.mail, executions, plans: bench.plans, decisions: bench.decisions, integration,
    conditionsOf: () => conditions,
    runtime: {
      holder: (session, taskId) => {
        holderCalls.push([session, taskId])
        return {
          session, group: 'middle-devs', profile: 'default', gone: false, turnRunning: false, pendingRequest: null, backgroundTasks: 0, workers: 0,
          dueDirectMail: false, parkedUntil: null, coolingUntil: null, lastTurnEndAt: null, lastTaskMailAt: null, ...holderFacts,
        }
      },
      blocker: messageId => { blockerCalls.push(messageId); return 'group cap 1/1' },
    },
  }
}

/** An approved plan (api, then ui depending on it) with a running execution of its revision. */
async function started(baseBranch = 'master') {
  const planId = await bench.approvedPlan()
  const revision = bench.plans.approvedRevision(planId)!.revision
  const execution = executions.insertExecution({
    teamId: teamId(), planId, revision, contentHash: 'h', reportId: 'r', inputHash: 'i', landingMode: 'direct', baseBranch, baseCommit: 'abc',
    floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } },
    maxParallel: 3, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }, { change: 'ui', landed: false }],
  })
  return { planId, executionId: execution.id }
}

function setChange(executionId: string, change: string, values: { state: string; step?: string | null; taskId?: string | null; stopDetail?: unknown }) {
  bench.db.db.prepare('UPDATE plan_execution_changes SET state = ?, step = ?, task_id = ?, stop_detail_json = ? WHERE execution_id = ? AND change = ?')
    .run(values.state, values.step ?? null, values.taskId ?? null, values.stopDetail === undefined ? null : JSON.stringify(values.stopDetail), executionId, change)
}

/** api implementing on a task dispatched to `dev`; returns the task and the instruction mail id. */
async function implementing(executionId: string, planId: string) {
  const taskId = await bench.onTask('dev', planId, 'api')
  setChange(executionId, 'api', { state: 'implementing', taskId })
  const outcome = await bench.assignments.dispatch(bench.human, { taskId, target: { kind: 'session', id: 'dev' }, instruction: 'Build the API', requestKey: `k-${taskId}` })
  return { taskId, messageId: outcome.assignment.messageId! }
}

const setMail = (id: string, state: string, deliveredAt: string | null = null) =>
  bench.db.db.prepare('UPDATE team_messages SET state = ?, delivered_at = ?, claimed_by = ? WHERE id = ?').run(state, deliveredAt, deliveredAt ? 'dev' : null, id)

async function supervise(planId: string, change: string) {
  return readPlanSupervision(reads(), teamId(), planId, NOW).find(entry => entry.change === change)!
}

describe('waiting before provisioning', () => {
  test('dependency: ui waits on api, which is still implementing', async () => {
    const { planId } = await started()
    const ui = await supervise(planId, 'ui')
    expect(ui.outcome).toBe('waiting')
    expect(ui.cause).toEqual({ kind: 'dependency', changes: ['api'], stopped: [] })
  })

  test('dependency on a stopped change names it stopped', async () => {
    const { planId, executionId } = await started()
    setChange(executionId, 'api', { state: 'stopped' })
    expect((await supervise(planId, 'ui')).cause).toEqual({ kind: 'dependency', changes: ['api'], stopped: ['api'] })
  })

  test('parallel-limit: a ready change with no dependency names the execution limit', async () => {
    const { planId } = await started()
    expect((await supervise(planId, 'api')).cause).toEqual({ kind: 'parallel-limit', limit: 3 })
  })
})

describe('running-stage waits', () => {
  test('effect: a pending effect of the change, with its kind and tries', async () => {
    const { planId, executionId } = await started()
    await implementing(executionId, planId)
    executions.insertEffect({ executionId, change: 'api', roundId: null, kind: 'push', effectKey: 'k-push', command: {} })
    const api = await supervise(planId, 'api')
    expect(api.cause).toMatchObject({ kind: 'effect', effect: 'push', state: 'pending', tries: 0 })
  })

  test("effect: another change's effect does not hold this one; an execution-level one does", async () => {
    const { planId, executionId } = await started()
    await implementing(executionId, planId)
    executions.insertEffect({ executionId, change: 'ui', roundId: null, kind: 'push', effectKey: 'k-ui', command: {} })
    expect((await supervise(planId, 'api')).cause.kind).not.toBe('effect')
    executions.insertEffect({ executionId, change: null, roundId: null, kind: 'create-integration', effectKey: 'k-exec', command: {} })
    expect((await supervise(planId, 'api')).cause).toMatchObject({ kind: 'effect', effect: 'create-integration' })
  })

  test('uncertain-delivery: the instruction mail is held uncertain', async () => {
    const { planId, executionId } = await started()
    const { messageId } = await implementing(executionId, planId)
    setMail(messageId, 'uncertain')
    expect((await supervise(planId, 'api')).cause).toEqual({ kind: 'uncertain-delivery', messageId })
  })

  test('staffing: the queued instruction carries the mailbox blocker', async () => {
    const { planId, executionId } = await started()
    const { messageId } = await implementing(executionId, planId)
    const api = await supervise(planId, 'api')
    expect(api.cause).toEqual({ kind: 'staffing', blocker: 'group cap 1/1' })
    expect(blockerCalls).toContain(messageId)
  })

  test('parked: parked instruction mail names the holder; a cooling profile reads parked with cooling', async () => {
    const { planId, executionId } = await started()
    const { messageId, taskId } = await implementing(executionId, planId)
    setMail(messageId, 'parked', '2026-10-20T10:00:00.000Z')
    holderFacts = { parkedUntil: '2026-10-20T15:00:00.000Z' }
    expect((await supervise(planId, 'api')).cause).toEqual({ kind: 'parked', session: 'dev', profile: 'default', until: '2026-10-20T15:00:00.000Z', cooling: false })
    expect(holderCalls).toContainEqual(['dev', taskId])
    setMail(messageId, 'delivered', '2026-10-20T10:00:00.000Z')
    holderFacts = { coolingUntil: '2026-10-20T13:00:00.000Z' }
    expect((await supervise(planId, 'api')).cause).toEqual({ kind: 'parked', session: 'dev', profile: 'default', until: '2026-10-20T13:00:00.000Z', cooling: true })
  })

  test('request: the holder awaits an approval', async () => {
    const { planId, executionId } = await started()
    const { messageId } = await implementing(executionId, planId)
    setMail(messageId, 'delivered', '2026-10-20T10:00:00.000Z')
    holderFacts = { pendingRequest: 'approval' }
    expect((await supervise(planId, 'api')).cause).toEqual({ kind: 'request', session: 'dev', request: 'approval' })
  })

  test('decision-card: an open card asked from the task; a decided one no longer holds it', async () => {
    const { planId, executionId } = await started()
    const { messageId } = await implementing(executionId, planId)
    setMail(messageId, 'delivered', '2026-10-20T10:00:00.000Z')
    const { card } = await bench.decide.ask({ kind: 'agent', sessionId: 'dev' }, { question: 'Which store?', options: ['sqlite', 'files'] })
    expect((await supervise(planId, 'api')).cause).toEqual({ kind: 'decision-card', cardId: card.id, addressedTo: 'lead', addressedGroup: 'leads' })
    await bench.decide.record({ kind: 'agent', sessionId: 'lead' }, { plan_id: planId, card_id: card.id, option_index: 1, rationale: 'one file' })
    expect((await supervise(planId, 'api')).cause.kind).not.toBe('decision-card')
  })

  test('ci: the newest round has pending checks', async () => {
    const { planId, executionId } = await started()
    const { taskId } = await implementing(executionId, planId)
    const { round } = executions.insertRound({ executionId, change: 'api', attemptId: 'a1', resultId: 'res-1', commitSha: 'c1', fixRound: false })
    executions.setRoundCi(round.id, [
      { name: 'ci', source: 'actions', conclusion: 'in_progress', link: null, startedAt: null, completedAt: null },
      { name: 'e2e', source: 'actions', conclusion: 'success', link: null, startedAt: null, completedAt: '2026-10-20T11:00:00.000Z' },
    ], null)
    setChange(executionId, 'api', { state: 'gating', step: 'awaiting-ci', taskId })
    expect((await supervise(planId, 'api')).cause).toEqual({ kind: 'ci', pending: ['ci'] })
  })

  test('member-release: a releasing change names the member and reason', async () => {
    const { planId, executionId } = await started()
    setChange(executionId, 'api', { state: 'gating', step: 'releasing', stopDetail: { session: 'dev', message: 'dev is busy' } })
    expect((await supervise(planId, 'api')).cause).toEqual({ kind: 'member-release', member: 'dev', reason: 'dev is busy' })
  })

  test('condition: an unresolved acceptance condition holds the change', async () => {
    const { planId, executionId } = await started()
    conditions = ['Docs updated']
    setChange(executionId, 'api', { state: 'gating', step: 'conditions' })
    expect((await supervise(planId, 'api')).cause).toEqual({ kind: 'condition', conditions: ['Docs updated'] })
  })

  test('landing-slot: the slot holder is named', async () => {
    const { planId, executionId } = await started()
    bench.db.db.prepare('INSERT INTO plan_landing_slots (team_id, holder_kind, holder_id, since) VALUES (?, ?, ?, ?)').run(teamId(), 'change', 'other:api', NOW.toISOString())
    setChange(executionId, 'api', { state: 'gating', step: 'awaiting-slot' })
    expect((await supervise(planId, 'api')).cause).toEqual({ kind: 'landing-slot', holderKind: 'change', holderId: 'other:api' })
  })
})

describe('the rest of the input', () => {
  test('no execution: the approved revision reads not started, in order', async () => {
    const planId = await bench.approvedPlan()
    expect(readPlanSupervision(reads(), teamId(), planId, NOW).map(entry => [entry.change, entry.outcome])).toEqual([['api', 'not-started'], ['ui', 'not-started']])
  })

  test('another team reads nothing', async () => {
    const { planId } = await started()
    expect(readPlanSupervision(reads(), 'team-other', planId, NOW)).toEqual([])
    expect(readSupervisionInputs(reads(), 'team-other', planId)).toBeNull()
  })

  test('a landing fact reads landed, and the dependent stops waiting on it', async () => {
    const { planId, executionId } = await started()
    setChange(executionId, 'api', { state: 'landed' })
    executions.insertLanding({ planId, change: 'api', executionId, teamId: teamId(), mechanism: 'direct', prNumber: 1, prUrl: null, headSha: 'h', baseSha: 'b', mergeSha: 'm', treeVerified: true })
    expect((await supervise(planId, 'api')).cause).toEqual({ kind: 'landed', treeVerified: true })
    expect((await supervise(planId, 'ui')).cause).toEqual({ kind: 'parallel-limit', limit: 3 })
  })

  test('rounds carry the CI pass time and the deciding findings; results and candidates feed progress', async () => {
    const { planId, executionId } = await started('feature/integration')
    const { taskId, messageId } = await implementing(executionId, planId)
    setMail(messageId, 'delivered', '2026-10-20T09:00:00.000Z')
    const results = new TaskResultStore(bench.db.db)
    const result = results.insert({ teamId: teamId(), taskId, summary: 's', commit: 'c1', diff: null, worktree: world.feature, tests: [], limitations: null, submittedBy: { kind: 'agent', sessionId: 'dev' }, taskRevision: 1 }, '2026-10-20T09:30:00.000Z')
    const { round } = executions.insertRound({ executionId, change: 'api', attemptId: 'a1', resultId: result.id, commitSha: 'c1', fixRound: false })
    executions.setRoundCi(round.id, [{ name: 'ci', source: 'actions', conclusion: 'success', link: null, startedAt: null, completedAt: '2026-10-20T10:00:00.000Z' }], null)
    executions.setRoundReview(round.id, 'asg-review')
    const findings = results.insertFindings({ teamId: teamId(), taskId, resultId: result.id, handoffId: null, kind: 'review', verdict: 'fail', findings: 'Missing test', author: { kind: 'agent', sessionId: 'lead' } }, '2026-10-20T10:30:00.000Z')
    executions.decideRound(round.id, 'fail', { verdictFindingsId: findings.id })
    integration.insertCandidate({ teamId: teamId(), branch: 'feature/integration', kind: 'increment', executionId, change: 'api', baselineSha: 'b', commitSha: 'c', treeSha: 't', state: 'verifying' })
    setChange(executionId, 'api', { state: 'implementing', taskId })
    const input = readSupervisionInputs(reads(), teamId(), planId)!.inputs.find(entry => entry.change === 'api')!
    expect(input.rounds).toEqual([expect.objectContaining({ id: round.id, ciPassedAt: '2026-10-20T10:00:00.000Z', verdict: 'fail', verdictAt: '2026-10-20T10:30:00.000Z', findingsSummary: 'Missing test', outcome: 'fail' })])
    expect(input.results).toEqual([{ createdAt: '2026-10-20T09:30:00.000Z' }])
    expect(input.candidates).toEqual([expect.objectContaining({ state: 'verifying' })])
    expect(input.instruction).toMatchObject({ messageId, state: 'delivered', deliveredAt: '2026-10-20T09:00:00.000Z' })
    const api = await supervise(planId, 'api')
    expect(api.progress).toEqual({ kind: 'verdict', at: '2026-10-20T10:30:00.000Z' })
    expect(api.lastRound).toMatchObject({ verdict: 'fail', findingsSummary: 'Missing test' })
  })

  test('a step Kawai holds reads no instruction, so a stale assignment never names a wait', async () => {
    const { planId, executionId } = await started()
    const { taskId } = await implementing(executionId, planId)
    setChange(executionId, 'api', { state: 'gating', step: null, taskId })
    const input = readSupervisionInputs(reads(), teamId(), planId)!.inputs.find(entry => entry.change === 'api')!
    expect(input.instruction).toBeNull()
    expect(holderCalls).toEqual([])
  })

  test('a delivered instruction past its deadline with an idle holder stalls as no-progress', async () => {
    const { planId, executionId } = await started()
    const { messageId } = await implementing(executionId, planId)
    setMail(messageId, 'delivered', '2026-10-20T08:00:00.000Z')
    holderFacts = { lastTurnEndAt: '2026-10-20T08:30:00.000Z' }
    const api = await supervise(planId, 'api')
    expect(api.outcome).toBe('stalled')
    expect(api.stall).toMatchObject({ kind: 'no-progress', idle: true, episodeKey: '2026-10-20T08:00:00.000Z' })
  })
})
