// The agent surface for integration branches (integration-candidates 7.1,
// D12): `plan_get` lists each integration branch with its head, its
// candidates newest first, and its promotions; the implement and fix
// instructions name the integration branch as the base and forbid pushing to
// it; the plan note says so; and no tool promotes, cancels a promotion, or
// writes an integration branch.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { StrategyStore } from '../strategy/strategyStore'
import { PlanService } from '../plans/PlanService'
import { planHandlers } from '../plans/planTools'
import { IntegrationStore } from '../plans/landing/integration/integrationStore'
import { integrationViews } from '../plans/landing/integration/integrationView'
import { fixInstruction, implementInstruction } from '../plans/execution/instructions'
import { TEAM_ALLOWED_TOOLS } from '../team/mailboxTools'
import { buildTeamPrompt } from '../team/teamPrompt'
import { createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'

let world: PlanWorld
let bench: PlanBench
let integration: IntegrationStore
let service: PlanService

beforeAll(async () => { world = await createPlanWorld('kawai-integration-agent-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createPlanBench(world)
  integration = new IntegrationStore(bench.db.db)
  service = new PlanService(bench.plans, {
    getSession: id => bench.records.get(id),
    strategies: new StrategyStore(bench.db.db),
    homeDir: world.home,
    integrationOf: planId => integrationViews(integration, planId),
  })
})

const sha = (char: string) => char.repeat(40)

describe('plan_get integration (7.1, D12)', () => {
  test('lists the branch, its head, the candidates newest first with states and outside commits, and the promotions', async () => {
    const { planId, revision } = await bench.draftInReview()
    await bench.approve(planId, revision)
    const teamId = world.team.teamId
    integration.recordCreation({ teamId, branch: 'wave/c', planId, targetBranch: 'master', executionId: 'exec-1', sha: sha('0') })
    const first = integration.insertCandidate({ teamId, branch: 'wave/c', kind: 'increment', change: 'api', baselineSha: sha('0'), commitSha: sha('1'), treeSha: sha('a'), state: 'verifying' })
    integration.transitionCandidate(first.id, 'passed')
    integration.transitionCandidate(first.id, 'landed')
    const outside = [{ sha: sha('9'), author: 'Owner', subject: 'hand fix' }]
    integration.insertCandidate({ teamId, branch: 'wave/c', kind: 'increment', change: 'ui', baselineSha: sha('1'), commitSha: sha('2'), treeSha: sha('b'), outside, state: 'verifying' })
    integration.insertPromotion({ teamId, planId, branch: 'wave/c', commandId: 'cmd-1', fromSha: sha('1'), throughSeq: 1, targetBranch: 'master', floor: {} })

    const detail = await planHandlers(service, 'lead').plan_get({ plan_id: planId })
    expect(detail.integration).toHaveLength(1)
    const view = detail.integration![0]!
    expect(view).toMatchObject({ branch: 'wave/c', targetBranch: 'master', head: sha('1'), createdSha: sha('0'), promotedThroughSeq: 0 })
    expect(view.candidates.map(row => [row.seq, row.change, row.state, row.outside?.length ?? 0])).toEqual([[2, 'ui', 'verifying', 1], [1, 'api', 'landed', 0]])
    expect(view.promotions.map(row => [row.number, row.promotionBranch, row.state, row.step])).toEqual([[1, 'wave/c--promote-1', 'running', 'branch']])
    // Server-only evidence (the floor snapshot, CI, timers) never reaches an agent.
    expect(Object.keys(view.promotions[0]!)).not.toContain('floor')
  })

  test('a merged promotion counts its carried candidates as promoted', async () => {
    const { planId, revision } = await bench.draftInReview()
    await bench.approve(planId, revision)
    const teamId = world.team.teamId
    integration.recordCreation({ teamId, branch: 'wave/d', planId, targetBranch: 'master', executionId: 'exec-1', sha: sha('0') })
    const promotion = integration.insertPromotion({ teamId, planId, branch: 'wave/d', commandId: 'cmd-1', fromSha: sha('1'), throughSeq: 3, targetBranch: 'master', floor: {} })
    integration.finishPromotion(promotion.id, 'merged')
    const detail = await planHandlers(service, 'lead').plan_get({ plan_id: planId })
    expect(detail.integration![0]!.promotedThroughSeq).toBe(3)
  })

  test('a promotion carries its CI with the flaky names marked, null before CI ran', async () => {
    const { planId, revision } = await bench.draftInReview()
    await bench.approve(planId, revision)
    const teamId = world.team.teamId
    integration.recordCreation({ teamId, branch: 'wave/e', planId, targetBranch: 'master', executionId: 'exec-1', sha: sha('0') })
    const promotion = integration.insertPromotion({ teamId, planId, branch: 'wave/e', commandId: 'cmd-1', fromSha: sha('1'), throughSeq: 1, targetBranch: 'master', floor: {} })
    expect((await planHandlers(service, 'lead').plan_get({ plan_id: planId })).integration![0]!.promotions[0]!.ci).toBeNull()
    const run = (conclusion: string, completedAt: string) => ({ name: 'ci', source: 'status', conclusion, link: null, startedAt: completedAt, completedAt })
    integration.patchPromotion(promotion.id, { ci: [run('failure', '2026-01-01T00:00:00Z'), run('success', '2026-01-01T00:10:00Z')] })
    const ci = (await planHandlers(service, 'lead').plan_get({ plan_id: planId })).integration![0]!.promotions[0]!.ci
    expect(ci?.checks).toHaveLength(2)
    expect(ci?.flaky).toEqual(['ci'])
  })

  test('a plan with no integration branch reads an empty list; without the wiring the field is absent', async () => {
    const { planId, revision } = await bench.draftInReview()
    await bench.approve(planId, revision)
    expect((await planHandlers(service, 'lead').plan_get({ plan_id: planId })).integration).toEqual([])
    const bare = new PlanService(bench.plans, { getSession: id => bench.records.get(id), strategies: new StrategyStore(bench.db.db), homeDir: world.home })
    expect((await planHandlers(bare, 'lead').plan_get({ plan_id: planId })).integration).toBeUndefined()
  })
})

describe('no agent tool promotes or writes an integration branch (7.1, D12)', () => {
  test('neither the plan tools nor the team allow-list carry a promote, cancel-promotion, or integration-write tool', () => {
    const tools = planHandlers(service, 'lead')
    for (const name of ['plan_promote', 'plan_promotion_cancel', 'plan_cancel_promotion', 'integration_promote', 'integration_fast_forward', 'integration_create']) {
      expect(tools).not.toHaveProperty(name)
    }
    expect(TEAM_ALLOWED_TOOLS.filter(name => /promot|integration/.test(name))).toEqual([])
  })
})

describe('instructions and the plan note name the integration branch (7.1, D12)', () => {
  const base = {
    planTitle: 'Wave', revision: 1, change: 'api', worktree: '/w', branch: 'api', baseline: sha('0'), head: sha('0'),
    acceptance: [], extraChecks: [], guidance: '', taskId: 'task-1', manifestHash: 'm',
  }

  test('the implement and fix instructions name the base and forbid pushing to it; direct landing names none', () => {
    const line = 'Base: the integration branch wave/c — your branch starts from it and lands on it. Kawai alone writes wave/c (it fast-forwards it and promotes it into the default branch); never push to it.'
    expect(implementInstruction({ ...base, integrationBranch: 'wave/c' })).toContain(line)
    expect(fixInstruction({ ...base, integrationBranch: 'wave/c', failingChecks: [], findings: [], fixRounds: 0, continueFrom: sha('1') })).toContain(line)
    expect(implementInstruction({ ...base, integrationBranch: null })).not.toContain('integration branch')
    expect(implementInstruction(base)).not.toContain('integration branch')
  })

  test('the plan note explains plan_get integration and that Kawai alone writes the branch', () => {
    const outbound = { internal: ['example.internal'], modelProviders: [], mcpServers: [], extraModelProviderHosts: [] } as never
    const prompt = buildTeamPrompt({ outbound, sessionId: 'chat-x', groups: [] })
    expect(prompt).toContain('`plan_get` shows it under `integration`')
    expect(prompt).toContain('Kawai alone writes an integration branch — never push to it')
    expect(prompt).toContain('only the human promotes it into the default branch or cancels a promotion; no tool of yours does either')
  })
})
