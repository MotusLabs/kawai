// Coalesced workspace snapshot invalidation (plan-workspace 3.4): each
// source row (task, plan, mail, session events, context usage, provider
// usage) drives the real ChatConnections publish path, one coalesced pass
// composes each dirty target once, and the O6 no-op rule — the whole
// payload, every reading value included — keeps an unchanged view quiet.
// INVARIANT P holds on every path: the manager double's start, restore,
// attach, send, usage-refresh, and wake seams land in one forbidden list,
// asserted empty after every exercised path.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { ChatContextUsage, ChatUsageReport } from '../../shared/chat'
import type { MergedProvider } from '../chat/catalogMerge'
import type { SupervisionReads } from '../plans/supervision/supervisionRead'
import type { ServerMessage, ClientMessage } from '../../shared/types'
import { planInput } from '../../shared/__tests__/planFixtures'
import { createPlanWorld, writeGroup, type PlanWorld } from './planHarness'
import { createSupervisionBench, type SupervisionBench } from './supervisionHarness'
import { PlanWorkspaceStore } from '../plans/workspace/workspaceStore'
import { PlanWorkspaceRefs } from '../plans/workspace/workspaceRefs'

let world: PlanWorld
let sup: SupervisionBench
let connections: ChatConnections
let messages: ServerMessage[]
let forbiddenCalls: string[]
let contextReadings: Map<string, { percentage: number; at: string }>
let usageReports: Map<string, ChatUsageReport>
let blockers: Map<string, string>
let archived: Set<string>
const teamOfMap = new Map<string, { teamId: string }>()
const connection = { send: (message: ServerMessage) => messages.push(message) }

const NOW = new Date()
const freshAt = (): string => NOW.toISOString()

const contextUsage = (percentage: number, at: string): ChatContextUsage =>
  ({ usedTokens: percentage * 1000, thresholdTokens: 100_000, percentage, at })

const REPORT: ChatUsageReport = {
  status: 'allowed',
  windows: [{ key: 'five_hour', label: 'Five hours', percentUsed: 50, resetsAt: null }],
  receivedAt: freshAt(),
  source: 'push',
}

/** A gateway provider: the catalog re-homes its base URL, so it is not the host login. */
const GATEWAY: MergedProvider = {
  env: { ANTHROPIC_BASE_URL: 'https://llm.example.internal/api' },
  models: new Map(),
  operatorOrigin: false,
  originFile: 'providers.default.json',
}

// INVARIANT P: these seams start, restore, attach, send, refresh, or wake —
// the one list any call shows up in, asserted empty after every path.
function forbid(what: string): () => never {
  return () => {
    forbiddenCalls.push(what)
    throw new Error(`INVARIANT P: ${what} must not be called`)
  }
}

function wire(bench: SupervisionBench): void {
  const reads: SupervisionReads = {
    db: bench.db.db, mail: bench.mail,
    executions: bench.executions, plans: bench.plans, decisions: bench.decisions,
    conditionsOf: () => [],
    runtime: {
      holder: session => ({
        session, group: 'middle-devs', profile: 'default', gone: false, turnRunning: false, pendingRequest: null,
        backgroundTasks: 0, workers: 0, dueDirectMail: false, parkedUntil: null, coolingUntil: null,
        lastTurnEndAt: null, lastTaskMailAt: null,
      }),
      blocker: messageId => blockers.get(messageId) ?? null,
    },
  }
  const manager = {
    whenRestored: () => Promise.resolve(),
    teamScopes: new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId] }),
    plans: bench.service,
    validationDetail: { invalidate: () => {} },
    planWorkspace: new PlanWorkspaceStore(bench.db.db),
    planWorkspaceRefs: new PlanWorkspaceRefs(bench.db.db),
    planWorkspaceRuntimeReads: reads,
    has: (id: string) => ['dev', 'arch'].includes(id),
    isArchived: (id: string) => archived.has(id),
    teams: { teamOf: (id: string) => teamOfMap.get(id) },
    directory: { get: (_teamId: string, id: string) => ({ sessionId: id, name: `name-${id}`, group: null }) },
    contextReadingOf: (id: string) => contextReadings.get(id) ?? null,
    providerIdOf: (_id: string) => 'prov',
    providerUsageOf: (providerId: string) => usageReports.get(providerId) ?? null,
    providerDefinitionOf: (_id: string) => GATEWAY,
    ensureDriver: forbid('ensureDriver'),
    start: forbid('start'),
    restore: forbid('restore'),
    loadHistory: forbid('loadHistory'),
    send: forbid('send'),
    claimProviderUsagePull: forbid('claimProviderUsagePull'),
    usageLimits: { claimPull: forbid('usageLimits.claimPull') },
    dispatcher: { notify: forbid('dispatcher.notify') },
    teamMail: { staffing: { spawnFor: forbid('staffing.spawnFor') } },
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
}

const send = (message: ClientMessage) => connections.handle(connection, message)
type Snapshot = Extract<ServerMessage, { type: 'team-plan-workspace-snapshot' }>
const snapshots = (): Snapshot[] => messages.filter((m): m is Snapshot => m.type === 'team-plan-workspace-snapshot')

/** A plan created and submitted (in review, unapproved — the default display). */
async function planInReview(): Promise<string> {
  const { plan } = await sup.service.create(sup.agent('lead'), { title: 'Wave C', content: planInput() })
  const submitted = await sup.service.submit(sup.agent('lead'), { plan_id: plan.id })
  if (!submitted.ok) throw new Error(submitted.message)
  return plan.id
}

/** An unclaimed group assignment on one change, with its instruction mail id. */
async function unclaimedTask(planId: string, change: string) {
  const task = sup.tasks.create({ teamId: world.team.teamId, title: `${change} task`, direction: 'Build', creator: { kind: 'human', sessionId: null }, planId, planChange: change })
  const outcome = await sup.assignments.dispatch(sup.human, { taskId: task.id, target: { kind: 'group', id: 'middle-devs' }, instruction: 'Build', requestKey: `k-${task.id}` })
  return { task, messageId: outcome.assignment.messageId! }
}

/** Expose dev by binding the lead conversation role to it. */
function bindDev(): void {
  new PlanWorkspaceStore(sup.db.db).bind(world.team.teamId, `bind-${Date.now()}-${Math.random()}`, { role: 'lead', sessionId: 'dev', expectedVersion: null })
}

beforeAll(async () => {
  world = await createPlanWorld('kawai-plan-workspace-invalid-')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\n---\nLead.')
  writeGroup(world, 'middle-devs', '---\nmax: 3\n---\nDevs.')
  sup = createSupervisionBench(world)
  forbiddenCalls = []
  contextReadings = new Map([['dev', { percentage: 50, at: freshAt() }]])
  usageReports = new Map([['prov', REPORT]])
  blockers = new Map()
  archived = new Set()
  teamOfMap.clear()
  teamOfMap.set('dev', { teamId: world.team.teamId })
  wire(sup)
  messages = []
})

const settle = (): Promise<void> => connections.flushPlanWorkspace()

describe('source rows push once through the coalesced pass', () => {
  test('a task write dirties the plan; one pass pushes the new holders exactly once', async () => {
    const planId = await planInReview()
    await unclaimedTask(planId, 'api')
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    expect(snapshots().at(-1)!.workspace.runtime!.changes.find(c => c.change === 'api')!.holders).toHaveLength(1)
    messages = []
    await unclaimedTask(planId, 'ui')
    connections.publishTasks(world.team.teamId)
    await settle()
    expect(snapshots()).toHaveLength(1)
    const ui = snapshots()[0]!.workspace.runtime!.changes.find(c => c.change === 'ui')!
    expect(ui.holders).toHaveLength(1)
    expect(forbiddenCalls).toEqual([])
  })

  test('a plan write pushes the new displayed version exactly once', async () => {
    const planId = await planInReview()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    expect(snapshots().at(-1)!.workspace.displayedVersion).toMatchObject({ kind: 'revision', status: 'in_review' })
    messages = []
    const approved = await sup.approve(planId, 1)
    if (!approved.ok) throw new Error(approved.message)
    connections.publishPlans(world.team.teamId, planId)
    await settle()
    expect(snapshots()).toHaveLength(1)
    expect(snapshots()[0]!.workspace.displayedVersion).toMatchObject({ kind: 'revision', status: 'approved' })
    expect(forbiddenCalls).toEqual([])
  })

  test('a reason-only mail change pushes once (the blocker kind code is the shape)', async () => {
    const planId = await planInReview()
    const { messageId } = await unclaimedTask(planId, 'api')
    blockers.set(messageId, 'group-cap')
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    expect(snapshots().at(-1)!.workspace.runtime!.changes.find(c => c.change === 'api')!.holders[0]!.waitingReason).toBe('group-cap')
    messages = []
    blockers.set(messageId, 'worktree-missing')
    connections.publishMailbox(world.team.teamId)
    await settle()
    expect(snapshots()).toHaveLength(1)
    expect(snapshots()[0]!.workspace.runtime!.changes.find(c => c.change === 'api')!.holders[0]!.waitingReason).toBe('worktree-missing')
    expect(forbiddenCalls).toEqual([])
  })

  test('a session event pushes a changed availability once; an unchanged view pushes nothing', async () => {
    const planId = await planInReview()
    bindDev()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    expect(snapshots().at(-1)!.workspace.bindings[0]).toMatchObject({ sessionId: 'dev', availability: 'live' })
    // An unchanged view: the same event composes the same payload — no push.
    messages = []
    connections.observeChatEvent('dev', { type: 'turn_started' } as never)
    await settle()
    expect(snapshots()).toHaveLength(0)
    // The archive changes the binding's availability: exactly one push.
    archived.add('dev')
    connections.observeChatEvent('dev', { type: 'turn_completed' } as never)
    await settle()
    expect(snapshots()).toHaveLength(1)
    expect(snapshots()[0]!.workspace.bindings[0]).toMatchObject({ sessionId: 'dev', availability: 'archived' })
    expect(forbiddenCalls).toEqual([])
  })

  test('a value-identical context tick pushes nothing; a value change pushes once; an aged reading never forces a push', async () => {
    const planId = await planInReview()
    bindDev()
    const reading = { percentage: 50, at: freshAt() }
    contextReadings.set('dev', reading)
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    // Aged-but-unchanged: the same reading re-fired after time passed — the
    // payload is identical, and freshness is the client clock's job.
    messages = []
    connections.publishContextUsage('dev', contextUsage(50, reading.at))
    await settle()
    expect(snapshots()).toHaveLength(0)
    // A value change pushes once.
    contextReadings.set('dev', { percentage: 51, at: freshAt() })
    connections.publishContextUsage('dev', contextUsage(51, freshAt()))
    await settle()
    expect(snapshots()).toHaveLength(1)
    expect(snapshots()[0]!.workspace.health!.find(a => a.sessionId === 'dev')!.context).toMatchObject({ used: 0.51 })
    expect(forbiddenCalls).toEqual([])
  })

  test('a provider usage report pushes the new quota once', async () => {
    const planId = await planInReview()
    bindDev()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    expect(snapshots().at(-1)!.workspace.health!.find(a => a.sessionId === 'dev')!.quota).toMatchObject({ status: 'ok' })
    messages = []
    const limited: ChatUsageReport = { ...REPORT, status: 'limited', windows: [{ key: 'five_hour', label: 'Five hours', percentUsed: 100, resetsAt: null }], receivedAt: freshAt() }
    usageReports.set('prov', limited)
    connections.publishUsage('prov', limited)
    await settle()
    expect(snapshots()).toHaveLength(1)
    expect(snapshots()[0]!.workspace.health!.find(a => a.sessionId === 'dev')!.quota).toMatchObject({ status: 'limited' })
    expect(forbiddenCalls).toEqual([])
  })

  test('a burst collapses into one snapshot per pass', async () => {
    const planId = await planInReview()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    messages = []
    const approved = await sup.approve(planId, 1)
    if (!approved.ok) throw new Error(approved.message)
    connections.publishTasks(world.team.teamId)
    connections.publishPlans(world.team.teamId, planId)
    connections.publishMailbox(world.team.teamId)
    await settle()
    expect(snapshots()).toHaveLength(1)
    expect(snapshots()[0]!.workspace.displayedVersion).toMatchObject({ status: 'approved' })
    expect(forbiddenCalls).toEqual([])
  })
})

describe('unsubscribe cleanup and reconnect', () => {
  test('closing unsubscribes: later source events push nothing, and the diff key is dropped', async () => {
    const planId = await planInReview()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    await send({ type: 'team-plan-workspace-close', teamPath: world.repo, planId })
    messages = []
    const approved = await sup.approve(planId, 1)
    if (!approved.ok) throw new Error(approved.message)
    connections.publishPlans(world.team.teamId, planId)
    connections.publishTasks(world.team.teamId)
    await settle()
    expect(snapshots()).toHaveLength(0)
    // A re-open answers from scratch even though nothing changed since.
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    expect(snapshots()).toHaveLength(1)
    expect(snapshots()[0]!.workspace.displayedVersion).toMatchObject({ status: 'approved' })
    expect(forbiddenCalls).toEqual([])
  })

  test('a disconnect drops the subscription; the reconnect re-opens with fresh facts, zero forbidden calls, and no document bodies', async () => {
    const planId = await planInReview()
    bindDev()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    connections.disconnect(connection)
    messages = []
    connections.publishPlans(world.team.teamId, planId)
    await settle()
    expect(snapshots()).toHaveLength(0)
    // The reconnect: a fresh connection re-opens; the awaited snapshot is
    // authoritative — no document or checklist message rides it, and no
    // process seam was touched.
    const reconnect = { send: (message: ServerMessage) => messages.push(message) }
    await connections.handle(reconnect, { type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    expect(snapshots()).toHaveLength(1)
    expect(snapshots()[0]!.workspace.health!.map(a => a.sessionId).sort()).toEqual(['dev'])
    expect(messages.map(m => m.type)).toEqual(['team-plan-workspace-snapshot'])
    expect(forbiddenCalls).toEqual([])
  })
})

