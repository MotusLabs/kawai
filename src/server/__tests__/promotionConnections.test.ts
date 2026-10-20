// The human promotion commands over the chat connection (integration-candidates
// 7.2, D9, D13): the Promote preview answers with the standing, Promote and
// Cancel answer with `promotion`/`replayed` and their refusals with every
// failing entry, an unknown path and another team's plan are refused with no
// data, the three types are listed for the WS router, and a candidate,
// promotion, or effect write pushes the open plan's detail with `integration`.
// Every read is injected: nothing reaches git's origin or GitHub.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { createPlanWorld, writeGroup, type PlanWorld } from './planHarness'
import { createImpactBench, type ImpactBench } from './impactHarness'
import { composePlanServices } from '../plans/planComposition'
import type { PromotionReads } from '../plans/landing/integration/PromotionService'
import type { OpenspecAdapter } from '../plans/validation/openspecAdapter'

const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }
const sha = (char: string) => char.repeat(40)

let world: PlanWorld
let bench: ImpactBench
let connections: ChatConnections
let messages: ServerMessage[]
let composed: ReturnType<typeof composePlanServices>
let mergeCommits: boolean | null
const connection = { send: (message: ServerMessage) => messages.push(message) }

// origin: wave/c at 1, master at 0 (lacking 1), no promotion branch yet.
const reads: PromotionReads = {
  remoteHead: async (_main, branch) => branch === 'wave/c' ? sha('1') : branch === 'master' ? sha('0') : null,
  contains: async (_main, _branches, ancestor, descendant) => ancestor === descendant || (ancestor === sha('0') && descendant === sha('1')),
  allowMergeCommit: async () => mergeCommits,
}

beforeAll(async () => {
  world = await createPlanWorld('kawai-promotion-connections-')
  fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', 'api'), { recursive: true })
  fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', 'api', 'proposal.md'), '# api\n')
  writeGroup(world, 'reviewers', 'Review.')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))

beforeEach(() => {
  bench?.db.close()
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
  bench = createImpactBench(world)
  messages = []
  mergeCommits = true
  const planServices = composePlanServices({
    db: bench.db.db, plans: bench.plans, strategies: bench.strategies, impact: bench.impact, adapter: fakeAdapter(),
    getSession: id => bench.records.get(id), homeDir: world.home,
    caps: { planExecution: async () => ({ floorChecks: FLOOR, maxParallelChanges: 2, mergeMethod: 'merge' }) },
    executionProbe: async () => ({ findings: [], repo: 'acme/app', base: { branch: 'master', head: sha('0'), tree: 'ttt' } }),
    promotionReads: reads,
  })
  bench.service = planServices.plans
  composed = planServices
  const teamScopes = new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId, world.otherTeam.teamId] })
  const manager = {
    whenRestored: () => Promise.resolve(), teamScopes, plans: planServices.plans, executions: planServices.executions,
    promotions: planServices.promotions, impact: bench.impact, validation: planServices.validation, validationDetail: planServices.validationDetail,
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  bench.plans.subscribe(plan => connections.publishPlans(plan.teamId, plan.id))
  // The same subscription ChatSessionManager installs (its wiring is proven by the manager bench, 9.1).
  planServices.integrationStore.subscribe((teamId, planId) => connections.publishPlans(teamId, planId))
})

const fakeAdapter = (): OpenspecAdapter => ({
  probe: async () => ({ tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'], ok: true, error: null }),
  validate: async () => ({ ok: true, error: null, valid: true, issues: [], issueCount: 0 }),
  showDeltas: async () => ({ ok: true, error: null, touches: [] }),
}) as unknown as OpenspecAdapter

const send = (message: ClientMessage) => connections.handle(connection, message)
const all = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type)
const last = <T extends ServerMessage['type']>(type: T) => all(type).at(-1)

async function until(probe: () => boolean, tries = 100): Promise<void> {
  for (let attempt = 0; attempt < tries && !probe(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
}

/** An approved plan whose integration branch wave/c holds one landed candidate at 1. */
async function landedPlan(): Promise<string> {
  const { planId, revision } = await bench.draftInReview()
  await bench.approve(planId, revision)
  const teamId = world.team.teamId
  const store = composed.integrationStore
  store.recordCreation({ teamId, branch: 'wave/c', planId, targetBranch: 'master', executionId: 'exec-1', sha: sha('0') })
  const candidate = store.insertCandidate({ teamId, branch: 'wave/c', kind: 'increment', change: 'api', baselineSha: sha('0'), commitSha: sha('1'), treeSha: sha('a'), state: 'verifying' })
  store.transitionCandidate(candidate.id, 'passed')
  store.transitionCandidate(candidate.id, 'landed')
  return planId
}

describe('promotion commands (7.2, D9, D13)', () => {
  test('every promotion type is listed for the WS router', () => {
    for (const type of ['team-plan-promotion-preview', 'team-plan-promote', 'team-plan-promotion-cancel'] as const) {
      expect(CHAT_CONNECTION_TYPES).toContain(type)
    }
  })

  test('preview answers with the pinned head and carried candidates; an unknown path and another team are refused with no data', async () => {
    const planId = await landedPlan()
    await send({ type: 'team-plan-promotion-preview', teamPath: world.repo, requestId: 'p1', planId, branch: 'wave/c' })
    const answer = last('team-plan-result')
    expect(answer).toMatchObject({ requestId: 'p1', promotionPreview: { branch: 'wave/c', targetBranch: 'master', head: sha('1'), throughSeq: 1, failures: [] } })
    expect(answer?.promotionPreview?.carried.map(candidate => candidate.change)).toEqual(['api'])

    messages = []
    const unknown = path.join(world.root, 'nowhere')
    await send({ type: 'team-plan-promotion-preview', teamPath: unknown, requestId: 'p2', planId, branch: 'wave/c' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'p2', error: expect.stringContaining(unknown) })
    expect(last('team-plan-result')?.promotionPreview).toBeUndefined()
    messages = []
    await send({ type: 'team-plan-promotion-preview', teamPath: world.other, requestId: 'p3', planId, branch: 'wave/c' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'p3', error: expect.stringContaining('not found') })
    expect(last('team-plan-result')?.promotionPreview).toBeUndefined()
  })

  test('Promote answers with the promotion and replays; a refusal names every failing entry and writes nothing', async () => {
    const planId = await landedPlan()
    mergeCommits = false
    await send({ type: 'team-plan-promote', teamPath: world.repo, requestId: 'p4', planId, branch: 'wave/c', fromSha: sha('1'), commandId: 'promote-0' })
    const refused = last('team-plan-result')
    expect(refused?.error).toBeTruthy()
    expect(refused?.failures?.map(failure => failure.name)).toEqual(['merge-commits-allowed'])
    expect(refused?.promotion).toBeUndefined()
    expect(composed.integrationStore.promotionsOf(planId)).toEqual([])

    mergeCommits = true
    messages = []
    await send({ type: 'team-plan-promote', teamPath: world.repo, requestId: 'p5', planId, branch: 'wave/c', fromSha: sha('1'), commandId: 'promote-1' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'p5', replayed: false, promotion: { number: 1, promotionBranch: 'wave/c--promote-1', state: 'running' } })
    await send({ type: 'team-plan-promote', teamPath: world.repo, requestId: 'p6', planId, branch: 'wave/c', fromSha: sha('1'), commandId: 'promote-1' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'p6', replayed: true, promotion: { number: 1 } })
    expect(composed.integrationStore.promotionsOf(planId)).toHaveLength(1)
  })

  test('Cancel finishes the promotion and replays; an empty reason and another team are refused', async () => {
    const planId = await landedPlan()
    await send({ type: 'team-plan-promote', teamPath: world.repo, requestId: 'c0', planId, branch: 'wave/c', fromSha: sha('1'), commandId: 'promote-1' })
    const promotionId = last('team-plan-result')!.promotion!.id

    messages = []
    await send({ type: 'team-plan-promotion-cancel', teamPath: world.repo, requestId: 'c1', promotionId, reason: '  ', commandId: 'cancel-0' })
    expect(last('team-plan-result')?.error).toBeTruthy()
    expect(composed.integrationStore.promotion(promotionId)?.state).toBe('running')
    await send({ type: 'team-plan-promotion-cancel', teamPath: world.other, requestId: 'c2', promotionId, reason: 'no', commandId: 'cancel-x' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'c2', error: expect.stringContaining('not found') })
    expect(composed.integrationStore.promotion(promotionId)?.state).toBe('running')

    await send({ type: 'team-plan-promotion-cancel', teamPath: world.repo, requestId: 'c3', promotionId, reason: 'not today', commandId: 'cancel-1' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'c3', replayed: false, promotion: { id: promotionId, state: 'finished', outcome: 'cancelled' } })
    await send({ type: 'team-plan-promotion-cancel', teamPath: world.repo, requestId: 'c4', promotionId, reason: 'not today', commandId: 'cancel-1' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'c4', replayed: true })
  })

  test('a candidate write and a promotion write push the open detail with `integration`', async () => {
    const planId = await landedPlan()
    await send({ type: 'team-plan-open', teamPath: world.repo, planId })
    await until(() => all('team-plan-detail').length > 0)
    expect(last('team-plan-detail')?.detail?.integration?.[0]?.candidates).toHaveLength(1)

    messages = []
    composed.integrationStore.insertCandidate({ teamId: world.team.teamId, branch: 'wave/c', kind: 'increment', change: 'ui', baselineSha: sha('1'), commitSha: sha('2'), treeSha: sha('b'), state: 'verifying' })
    await until(() => all('team-plan-detail').some(message => message.detail?.integration?.[0]?.candidates.length === 2))
    expect(last('team-plan-detail')?.detail?.integration?.[0]?.candidates.map(candidate => candidate.change)).toEqual(['ui', 'api'])

    messages = []
    composed.integrationStore.insertPromotion({ teamId: world.team.teamId, planId, branch: 'wave/c', commandId: 'cmd-9', fromSha: sha('1'), throughSeq: 1, targetBranch: 'master', floor: {} })
    await until(() => all('team-plan-detail').some(message => (message.detail?.integration?.[0]?.promotions.length ?? 0) === 1))
    expect(last('team-plan-detail')?.detail?.integration?.[0]?.promotions.map(promotion => promotion.number)).toEqual([1])
  })
})
