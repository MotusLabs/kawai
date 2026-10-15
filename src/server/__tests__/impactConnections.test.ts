// strategy-revision-impact 5.1–5.2: the owner's impact commands over the chat
// connection — decide and request round trips by repository and worktree
// path, an unknown path and another team's review refused with no data, both
// types listed for the WS router — and the D9 pushes: a plan submission
// refreshes an open Strategy view, a decision and a strategy approval refresh
// an open Plans view, and a refused approval carries the detail's gate.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import { StrategyService } from '../strategy/StrategyService'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createImpactBench, type ImpactBench } from './impactHarness'

let world: PlanWorld
let bench: ImpactBench
let connections: ChatConnections
let messages: ServerMessage[]
const connection = { send: (message: ServerMessage) => messages.push(message) }

beforeAll(async () => { world = await createPlanWorld('kawai-impact-connections-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createImpactBench(world)
  messages = []
  const teamScopes = new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId, world.otherTeam.teamId] })
  const strategies = new StrategyService(bench.strategies, { getSession: id => bench.records.get(id), homeDir: world.home })
  const manager = { whenRestored: () => Promise.resolve(), teamScopes, strategies, plans: bench.service, impact: bench.impact } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  // As ChatSessionManager wires them (D9): each store refreshes both views of its team.
  const teamOf = (strategyId: string) => bench.strategies.get(strategyId)?.repoBindings.find(binding => binding.kind === 'team')?.root
  const both = (teamId: string | undefined) => {
    if (!teamId) return
    connections.publishStrategies(teamId)
    connections.publishPlans(teamId)
  }
  bench.plans.subscribe(plan => {
    connections.publishPlans(plan.teamId, plan.id)
    connections.publishStrategies(plan.teamId)
  })
  bench.strategies.subscribe(strategy => both(teamOf(strategy.id)))
  bench.impact.store.subscribe(strategyId => both(teamOf(strategyId)))
})

const send = (message: ClientMessage) => connections.handle(connection, message)
const all = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type)
const last = <T extends ServerMessage['type']>(type: T) => all(type).at(-1)
let commands = 0
const decide = (teamPath: string, planId: string, reviewId: string, extra: Partial<Extract<ClientMessage, { type: 'strategy-impact-decide' }>> = {}) => send({
  type: 'strategy-impact-decide', teamPath, requestId: `req-${++commands}`, reviewId, planId,
  disposition: 'continue', rationale: 'Still fits', expectedDecisionId: null, commandId: `cmd-${commands}`, ...extra,
})

describe('impact commands', () => {
  test('decide and request round trip by repository and worktree path; the detail carries the impact', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    await send({ type: 'strategy-open', teamPath: world.repo })
    expect(last('strategy-detail')!.impact!.assessment!.affected.map(row => row.planId)).toEqual([planId])
    await decide(world.feature, planId, reviewId)
    const decided = last('strategy-result')!
    expect(decided).toMatchObject({ teamPath: world.feature, requestId: `req-${commands}`, replayed: false, decision: { planId, disposition: 'continue' } })
    expect(last('strategy-detail')!.impact!.assessment!.affected[0]!.effectiveDecision!.id).toBe(decided.decision!.id)
    // A resend of the same command replays the recorded decision.
    await decide(world.feature, planId, reviewId, { commandId: `cmd-${commands}` })
    expect(last('strategy-result')).toMatchObject({ replayed: true, decision: { id: decided.decision!.id } })
    await send({ type: 'strategy-impact-request', teamPath: world.repo, requestId: 'ask-1', reviewId, group: 'lead', commandId: 'ask-cmd-1' })
    const asked = last('strategy-result')!
    expect(asked).toMatchObject({ teamPath: world.repo, requestId: 'ask-1', replayed: false, messageId: expect.any(String) })
    expect(bench.mail.listForTeam(world.team.teamId).map(message => message.id)).toEqual([asked.messageId!])
    expect(last('strategy-detail')!.impact!.reviews[0]!.requests.map(request => request.messageId)).toEqual([asked.messageId!])
  })

  test('an unknown path and another team\'s review are refused with no data', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    await decide('/nowhere', planId, reviewId)
    expect(messages).toEqual([{ type: 'strategy-result', teamPath: '/nowhere', requestId: `req-${commands}`, error: expect.stringContaining('/nowhere') }])
    messages = []
    await decide(world.other, planId, reviewId)
    await send({ type: 'strategy-impact-request', teamPath: world.other, requestId: 'ask-x', reviewId, group: 'lead', commandId: 'ask-x' })
    expect(messages.map(message => Object.keys(message).sort())).toEqual([
      ['error', 'requestId', 'teamPath', 'type'], ['error', 'requestId', 'teamPath', 'type'],
    ])
    expect(bench.impact.detail(world.team.teamId)!.reviews[0]!.decisions).toEqual([])
    expect(bench.mail.listForTeam(world.team.teamId)).toEqual([])
  })

  test('the WS router lists both commands', () => {
    expect(CHAT_CONNECTION_TYPES).toContain('strategy-impact-decide')
    expect(CHAT_CONNECTION_TYPES).toContain('strategy-impact-request')
  })
})

describe('pushes (D9)', () => {
  test('an open Strategy view refreshes on a plan submission', async () => {
    bench.approveStrategy()
    await send({ type: 'strategy-open', teamPath: world.repo })
    expect(last('strategy-detail')!.impact!.assessment!.unaffected).toEqual([])
    messages = []
    const { planId } = await bench.draftInReview()
    expect(last('strategy-detail')!.impact!.assessment!.unaffected.map(row => row.planId)).toEqual([planId])
  })

  test('an open Plans view refreshes on a decision and on a strategy approval', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    await send({ type: 'team-plans-open', teamPath: world.repo })
    await send({ type: 'team-plan-open', teamPath: world.repo, planId })
    expect(last('team-plans-snapshot')!.impact![planId]!.gate!.state).toBe('decision-required')
    expect(last('team-plan-detail')!.impact!.group).toBe('affected')
    messages = []
    await decide(world.repo, planId, reviewId)
    expect(last('team-plans-snapshot')!.impact![planId]!.gate!.state).toBe('continue')
    expect(last('team-plan-detail')!.impact!.gate!.state).toBe('continue')
    messages = []
    bench.approveStrategy({ purpose: 'Third direction' })
    expect(last('team-plans-snapshot')!.impact![planId]!.gate).toMatchObject({ state: 'decision-required', decisionId: null })
    expect(last('team-plan-detail')!.impact!.reviewRevision).toBe(3)
  })

  test("a refused approval's result carries the same gate as the plan detail", async () => {
    bench.approveStrategy()
    const { planId, revision, hash } = await bench.draftInReview()
    bench.approveStrategy({ purpose: 'Revised direction' })
    await send({ type: 'team-plan-open', teamPath: world.repo, planId })
    await send({ type: 'team-plan-approve', teamPath: world.repo, requestId: 'approve-1', planId, revision, contentHash: hash, expectedApprovedRevision: null, commandId: 'approve-cmd' })
    const result = last('team-plan-result')!
    expect(result.failures!.map(failure => failure.name)).toEqual(['strategy-pin-current'])
    const detailGate = last('team-plan-detail')!.impact!.revisions.find(entry => entry.revision === revision)!.gate
    expect(result.impact).toEqual(detailGate)
    expect(result.impact!.state).toBe('decision-required')
  })
})
