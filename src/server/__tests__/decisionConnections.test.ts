// The owner's decision commands over the chat connection (plan-supervision
// §7.1–7.2, D15): `team-plan-decide` and `team-plan-override` answer with
// `team-plan-result` carrying `decision`; another team's plan or card is
// refused with no data and nothing written; a resend replays the prior
// decision; a refusal shows its message; both types are listed for the WS
// router; and an answer pushes the open detail once, carrying the decision.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import { DecisionService } from '../plans/decisions/DecisionService'
import { ExecutionStore } from '../plans/execution/executionStore'
import { PlanService } from '../plans/PlanService'
import { readPlanSupervisionDetail } from '../plans/supervision/planSupervisionDetail'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createDecisionBench, type DecisionBench } from './decisionHarness'

let world: PlanWorld
let bench: DecisionBench
let decide: DecisionService
let connections: ChatConnections
let messages: ServerMessage[]
const connection = { send: (message: ServerMessage) => messages.push(message) }

beforeAll(async () => { world = await createPlanWorld('kawai-decision-connections-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))

beforeEach(() => {
  bench?.db.close()
  bench = createDecisionBench(world)
  messages = []
  // Production composition: a decision write announces its plan (D15).
  decide = new DecisionService({ ...bench.decide.deps, onChange: planId => bench.plans.announce(planId) })
  const executions = new ExecutionStore(bench.db.db)
  const plans = new PlanService(bench.plans, {
    getSession: id => bench.records.get(id), strategies: bench.strategies, homeDir: world.home,
    supervisionOf: (teamId, planId) => readPlanSupervisionDetail({
      db: bench.db.db, mail: bench.mail, executions, plans: bench.plans, decisions: bench.decisions,
      conditionsOf: () => [], tasks: bench.tasks, runtime: { holder: () => null, blocker: () => null },
    }, teamId, planId, new Date()),
  })
  const teamScopes = new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId, world.otherTeam.teamId] })
  const manager = {
    whenRestored: () => Promise.resolve(), teamScopes, plans, decisions: decide,
    impact: { planImpacts: () => ({}), planImpact: () => null, gate: () => null },
    validationDetail: { invalidate: () => {}, detail: async () => [] },
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  bench.plans.subscribe(plan => connections.publishPlans(plan.teamId, plan.id))
})

const send = (message: ClientMessage) => connections.handle(connection, message)
const all = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type)
const last = <T extends ServerMessage['type']>(type: T) => all(type).at(-1)

/** A plan without a Lead role: the dev's question goes to the owner. */
async function ownerCard() {
  const planId = await bench.approvedPlan(false)
  await bench.onTask('dev', planId, 'api')
  const { card } = await decide.ask({ kind: 'agent', sessionId: 'dev' }, { question: 'Which store?', options: ['sqlite', 'files'] })
  expect(card.addressedTo).toBe('owner')
  return { planId, card }
}

async function untilDetail(probe: (message: Extract<ServerMessage, { type: 'team-plan-detail' }>) => boolean, tries = 100) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (all('team-plan-detail').some(probe)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('both decision commands are listed for the WS router', () => {
  expect(CHAT_CONNECTION_TYPES as readonly string[]).toContain('team-plan-decide')
  expect(CHAT_CONNECTION_TYPES as readonly string[]).toContain('team-plan-override')
})

describe('team-plan-decide and team-plan-override (7.1)', () => {
  test("another team's plan, a card of another plan, and an unknown path are refused with nothing written", async () => {
    const { planId, card } = await ownerCard()
    const otherPlan = await bench.approvedPlan(false)
    await send({ type: 'team-plan-decide', teamPath: world.other, requestId: 'd1', planId, cardId: card.id, optionIndex: 1, commandId: 'c1' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'd1', error: expect.stringContaining(planId) })
    expect(last('team-plan-result')?.decision).toBeUndefined()
    await send({ type: 'team-plan-decide', teamPath: world.repo, requestId: 'd2', planId: otherPlan, cardId: card.id, optionIndex: 1, commandId: 'c2' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'd2', reason: 'not-found', error: expect.stringContaining('Decision card not found') })
    await send({ type: 'team-plan-override', teamPath: '/nowhere', requestId: 'd3', planId, cardId: card.id, expectedDecisionId: 'x', optionIndex: 2, rationale: 'r', commandId: 'c3' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'd3', error: expect.stringContaining('/nowhere') })
    expect(bench.decisions.decisionsOfCard(world.team.teamId, card.id)).toEqual([])
  })

  test('an answer returns the decision; a resend replays it; an override returns its fix task', async () => {
    const { planId, card } = await ownerCard()
    const answer = { type: 'team-plan-decide' as const, teamPath: world.repo, requestId: 'a1', planId, cardId: card.id, optionIndex: 1, rationale: 'one file', commandId: 'c-ans' }
    await send(answer)
    const first = last('team-plan-result')!
    expect(first).toMatchObject({ requestId: 'a1', replayed: false, decision: { card: { id: card.id }, decision: { kind: 'answer', choice: 'sqlite', rationale: 'one file' } } })
    await send({ ...answer, requestId: 'a2' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'a2', replayed: true, decision: { decision: { id: first.decision!.decision.id } } })
    expect(bench.decisions.decisionsOfCard(world.team.teamId, card.id)).toHaveLength(1)

    await send({ type: 'team-plan-override', teamPath: world.repo, requestId: 'o1', planId, cardId: card.id, expectedDecisionId: first.decision!.decision.id, optionIndex: 2, rationale: 'files are simpler', commandId: 'c-ovr' })
    const overridden = last('team-plan-result')!
    expect(overridden).toMatchObject({ requestId: 'o1', replayed: false, decision: { decision: { kind: 'override', choice: 'files' }, fixTaskId: expect.stringMatching(/^task-/) } })
  })

  test('a refusal shows its message: a changed resend, an open card overridden, a stale predecessor', async () => {
    const { planId, card } = await ownerCard()
    await send({ type: 'team-plan-override', teamPath: world.repo, requestId: 'r1', planId, cardId: card.id, expectedDecisionId: 'none', optionIndex: 2, rationale: 'r', commandId: 'c-r1' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'r1', error: expect.stringContaining('answer it instead') })
    await send({ type: 'team-plan-decide', teamPath: world.repo, requestId: 'r2', planId, cardId: card.id, optionIndex: 1, commandId: 'c-r2' })
    await send({ type: 'team-plan-decide', teamPath: world.repo, requestId: 'r3', planId, cardId: card.id, optionIndex: 2, commandId: 'c-r2' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'r3', reason: 'replay-mismatch', error: expect.stringContaining('different') })
    await send({ type: 'team-plan-override', teamPath: world.repo, requestId: 'r4', planId, cardId: card.id, expectedDecisionId: 'dec-stale', optionIndex: 2, rationale: 'r', commandId: 'c-r4' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'r4', error: expect.any(String) })
    expect(last('team-plan-result')?.decision).toBeUndefined()
    expect(bench.decisions.decisionsOfCard(world.team.teamId, card.id)).toHaveLength(1)
  })
})

test('an answer pushes the open detail once, carrying the decision (7.2)', async () => {
  const { planId, card } = await ownerCard()
  await send({ type: 'team-plan-open', teamPath: world.repo, planId })
  expect(last('team-plan-detail')?.detail.decisions?.[0]).toMatchObject({ card: { id: card.id }, state: 'open', current: null })
  messages = []
  await send({ type: 'team-plan-decide', teamPath: world.repo, requestId: 'p1', planId, cardId: card.id, optionIndex: 1, commandId: 'c-push' })
  await untilDetail(message => message.detail.decisions?.[0]?.state === 'decided')
  const details = all('team-plan-detail')
  expect(details).toHaveLength(1)
  expect(details[0]!.detail.decisions![0]).toMatchObject({ state: 'decided', current: { choice: 'sqlite', decidedBy: { kind: 'human' } } })
  expect(details[0]!.detail.supervision).toBeDefined()
  expect(details[0]!.detail.usage).toBeDefined()
})
