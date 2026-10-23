// INVARIANT P (plan-workspace 3.2, design D5; revision 2 LC6: full passivity):
// opening, closing, or inspecting the workspace, and deriving health, never
// call a start, restore, attach, send, or usage refresh/poll method on any
// session or usage source, never write a database row, and never wake the
// dispatcher or staffing; only same-team sessions relevant to the linked work
// plus the two conversation roles are exposed; missing telemetry is unknown,
// never zero. The manager stub counts every forbidden seam — the one list any
// call shows up in, asserted empty after every exercised path — and the raw
// database's `total_changes()` counter proves the read pass wrote nothing.
// The unit rows pin LC5's applicability split (CP1 rev 3, R1/R4) on the pure
// predicate and the quota mapping.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { Database } from 'bun:sqlite'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { ChatUsageReport } from '../../shared/chat'
import { hostLoginProvider, type MergedProvider } from '../chat/catalogMerge'
import { quotaReadingOf } from '../plans/workspace/workspaceRuntime'
import { workspaceHealthOf } from '../../shared/planWorkspaceHealth'
import type { WorkspaceQuotaReading } from '../../shared/planWorkspace'
import type { SupervisionReads } from '../plans/supervision/supervisionRead'
import type { ClientMessage, ServerMessage } from '../../shared/types'
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
const teamOfMap = new Map<string, { teamId: string }>()
const connection = { send: (message: ServerMessage) => messages.push(message) }

const REPORT: ChatUsageReport = {
  status: 'allowed',
  windows: [{ key: 'five_hour', label: 'Five hours', percentUsed: 50, resetsAt: null }],
  receivedAt: '2026-10-22T22:00:00.000Z',
  source: 'push',
}

/** A gateway provider: the catalog re-homes its base URL, so it is not the host login. */
const GATEWAY: MergedProvider = {
  env: { ANTHROPIC_BASE_URL: 'https://llm.example.internal/api' },
  models: new Map(),
  operatorOrigin: false,
  originFile: 'providers.default.json',
}

/** A plain provider: no base-URL override, no credential names — the host login itself. */
const HOST_LOGIN: MergedProvider = {
  env: {},
  models: new Map(),
  operatorOrigin: false,
  originFile: 'providers.default.json',
}

// INVARIANT P: these seams start, restore, attach, send, refresh, or wake
// the dispatcher and staffing (LC6) — the one list any call shows up in,
// asserted empty after every exercised path.
function forbid(what: string): () => never {
  return () => {
    forbiddenCalls.push(what)
    throw new Error(`INVARIANT P: ${what} must not be called`)
  }
}

/**
 * A database whose writes land in the same forbidden list (LC6/N1): the
 * workspace composition is a read pass, so any run/exec during a snapshot
 * is a side effect the invariant forbids, not one it tolerates.
 */
function readOnly(db: Database): Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql)
          return new Proxy(statement, {
            get(t, p) {
              if (p === 'run') {
                return () => {
                  forbiddenCalls.push(`db-write: ${sql.trim().slice(0, 80)}`)
                  throw new Error('INVARIANT P: the composition wrote')
                }
              }
              const value = Reflect.get(t, p)
              return typeof value === 'function' ? value.bind(t) : value
            },
          })
        }
      }
      if (prop === 'exec' || prop === 'run') {
        return (sql: string) => {
          forbiddenCalls.push(`db-write: ${String(sql).trim().slice(0, 80)}`)
          throw new Error('INVARIANT P: the composition wrote')
        }
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** The raw database's change counter (LC6): reads leave it unmoved. */
const totalChanges = (): number => (sup.db.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n

function wire(bench: SupervisionBench): void {
  const reads: SupervisionReads = {
    db: readOnly(bench.db.db), mail: bench.mail,
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
    planWorkspace: new PlanWorkspaceStore(bench.db.db),
    planWorkspaceRefs: new PlanWorkspaceRefs(bench.db.db),
    planWorkspaceRuntimeReads: reads,
    has: (id: string) => ['dev', 'arch', 'stranger'].includes(id),
    isArchived: (_id: string) => false,
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
    // N2: the real usage-refresh seams under their production names — the
    // manager's own provider pull and the usageLimits claim beneath it.
    claimProviderUsagePull: forbid('claimProviderUsagePull'),
    usageLimits: { claimPull: forbid('usageLimits.claimPull') },
    // LC6: the dispatcher and staffing wakes are as forbidden as the
    // process seams — the real field and method names on the manager.
    dispatcher: { notify: forbid('dispatcher.notify') },
    teamMail: { staffing: { spawnFor: forbid('staffing.spawnFor') } },
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
}

const send = (message: ClientMessage) => connections.handle(connection, message)
type Snapshot = Extract<ServerMessage, { type: 'team-plan-workspace-snapshot' }>
const lastSnapshot = (): Snapshot => messages.filter((m): m is Snapshot => m.type === 'team-plan-workspace-snapshot').at(-1)!

/** An approved plan (the fixture's `api` → `ui`), created, submitted, and approved through the service. */
async function approvedPlan(): Promise<string> {
  const { plan } = await sup.service.create(sup.agent('lead'), { title: 'Wave C', content: planInput() })
  const submitted = await sup.service.submit(sup.agent('lead'), { plan_id: plan.id })
  if (!submitted.ok) throw new Error(submitted.message)
  const approved = await sup.approve(plan.id, submitted.revision.revision)
  if (!approved.ok) throw new Error(approved.message)
  return plan.id
}

beforeAll(async () => {
  world = await createPlanWorld('kawai-plan-workspace-passive-')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\n---\nLead.')
  writeGroup(world, 'middle-devs', '---\nmax: 3\n---\nDevs.')
  sup = createSupervisionBench(world)
  forbiddenCalls = []
  contextReadings = new Map([['dev', { percentage: 50, at: '2026-10-22T22:00:00.000Z' }]])
  usageReports = new Map([['prov', REPORT]])
  blockers = new Map()
  teamOfMap.clear()
  teamOfMap.set('dev', { teamId: world.team.teamId })
  teamOfMap.set('arch', { teamId: world.team.teamId })
  teamOfMap.set('stranger', { teamId: world.otherTeam.teamId })
  wire(sup)
  messages = []
})

describe('applicability (LC5, CP1 rev 3 R1/R4)', () => {
  test.each([
    ['a base-URL override reads false', GATEWAY, false],
    ['a credential variable reads false', { ...HOST_LOGIN, authTokenEnv: 'HOST_KEY' }, false],
    ['a plain provider reads true', HOST_LOGIN, true],
    ['an undefined provider reads false (unconfirmed)', null, false],
  ])('hostLoginProvider: %s', (_name, provider, expected) => {
    expect(hostLoginProvider(provider)).toBe(expected)
  })

  const reading = (over: Partial<ChatUsageReport>): ChatUsageReport => ({ ...REPORT, ...over })

  test.each<[string, ChatUsageReport, MergedProvider | null, WorkspaceQuotaReading['source'], boolean]>([
    ['a push is the profile\'s own allowance', reading({}), GATEWAY, 'profile', true],
    ['a provider pull is the provider\'s own', reading({ source: 'provider' as const }), GATEWAY, 'provider', true],
    ['a Codex-home-keyed report is the provider\'s own', reading({ source: undefined, windows: [{ key: 'codex:primary', label: 'Primary', percentUsed: 50, resetsAt: null }] }), GATEWAY, 'provider', true],
    ['a report on the host-login provider is applicable', reading({ source: 'report' as const }), HOST_LOGIN, 'profile', true],
    ['a report on a gateway provider is the host account\'s, excluded', reading({ source: 'report' as const }), GATEWAY, 'account', false],
    ['an absent source reads as pull', reading({ source: undefined }), GATEWAY, 'account', false],
  ])('quotaReadingOf: %s', (_name, report, provider, source, applicable) => {
    const { reading: composed, applicable: isApplicable } = quotaReadingOf(report, provider)
    expect(composed.source).toBe(source)
    expect(isApplicable).toBe(applicable)
    expect(composed.status).toBe('ok')
    expect(composed.used).toBe(0.5)
    expect(composed.measuredAt).toBe('2026-10-22T22:00:00.000Z')
  })

  test('a windowless report keeps the status and no window share (LC5.3)', () => {
    const { reading: composed, applicable } = quotaReadingOf(reading({ windows: [] }), HOST_LOGIN)
    expect(composed.status).toBe('ok')
    expect(composed.used).toBeNull()
    expect(composed.resetsAt).toBeNull()
    expect(applicable).toBe(true)
  })
})

describe('passive workspace composition', () => {
  test('one workspace snapshot composes outcomes, holders, and passive readings with zero forbidden calls', async () => {
    const planId = await approvedPlan()
    const executionId = sup.start(planId)
    // A fresh delivery, so the attempt is inside the no-progress deadline.
    const { taskId } = await sup.implementing(executionId, planId, new Date().toISOString())
    expect(taskId).toBeTruthy()
    // The harness writes the mail claim with raw SQL, bypassing the
    // subscription that copies it onto the assignment row (production's
    // syncFromMail); mirror that copy so the claim is as production holds it.
    sup.db.db.prepare("UPDATE team_task_assignments SET claimed_by = 'dev' WHERE task_id = ?").run(taskId)
    // A bound architect beside the execution holder: both roles are exposed.
    new PlanWorkspaceStore(sup.db.db).bind(world.team.teamId, `bind-${Date.now()}`, { role: 'architect', sessionId: 'arch', expectedVersion: null })
    // Every fixture write is done: from here the composition must be a read pass.
    const changesAtRest = totalChanges()
    messages = []
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    const snapshot = lastSnapshot()!
    expect(snapshot.workspace.runtime).toBeTruthy()
    expect(snapshot.workspace.runtime!.execution).toEqual({ executionId, revision: 1 })
    const api = snapshot.workspace.runtime!.changes.find(change => change.change === 'api')!
    expect(api.relation).toBe('overlay')
    expect(api.executionRevision).toBe(1)
    expect(api.state).toEqual({ kind: 'implementing', stage: 'implement' })
    expect(api.holders).toEqual([
      { taskId, holder: { kind: 'session', sessionId: 'dev', name: 'name-dev' }, stage: 'implementing', waitingReason: null },
    ])
    // The dependent change waits on its dependency, with the cause label.
    const ui = snapshot.workspace.runtime!.changes.find(change => change.change === 'ui')!
    expect(ui.state).toEqual({ kind: 'waiting', cause: 'Waiting on api' })
    const health = snapshot.workspace.health!
    expect(health.map(agent => [agent.sessionId, agent.relevance]).sort()).toEqual([['arch', 'architect'], ['dev', 'holder']])
    const dev = health.find(agent => agent.sessionId === 'dev')!
    expect(dev.context).toEqual({ used: 0.5, measuredAt: '2026-10-22T22:00:00.000Z' })
    expect(dev.quota).toMatchObject({ status: 'ok', used: 0.5, source: 'profile' })
    expect(dev.quotaApplicable).toBe(true)
    expect(totalChanges()).toBe(changesAtRest)
    expect(forbiddenCalls).toEqual([])
  })

  test('no execution: holders, requested groups, and waiting reasons still show (LC4)', async () => {
    const planId = await approvedPlan()
    const task = sup.tasks.create({ teamId: world.team.teamId, title: 'api task', direction: 'Build', creator: { kind: 'human', sessionId: null }, planId, planChange: 'api' })
    const outcome = await sup.assignments.dispatch(sup.human, { taskId: task.id, target: { kind: 'group', id: 'middle-devs' }, instruction: 'Build', requestKey: `k-${task.id}` })
    const messageId = outcome.assignment.messageId!
    expect(messageId).toBeTruthy()
    // The production blocker shape (N4): the kind code `team.ts`'s waiting
    // reasons and §5's waitingLabels render (`group-cap`), never prose.
    blockers.set(messageId, 'group-cap')
    const changesAtRest = totalChanges()
    messages = []
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    const runtime = lastSnapshot()!.workspace.runtime!
    expect(runtime.execution).toBeNull()
    const api = runtime.changes.find(change => change.change === 'api')!
    expect(api.state).toEqual({ kind: 'no-execution' })
    expect(api.holders).toEqual([
      { taskId: task.id, holder: { kind: 'group-unclaimed', groupId: 'middle-devs' }, stage: 'unstarted', waitingReason: 'group-cap' },
    ])
    expect(totalChanges()).toBe(changesAtRest)
    expect(forbiddenCalls).toEqual([])
  })

  test('only same-team, linked-work sessions and the two roles are exposed', async () => {
    const planId = await approvedPlan()
    // An unrelated same-team session, an other-team stranger, and a bound role.
    const devRecord = sup.records.get('dev')!
    sup.records.set('idle', { ...devRecord, sessionId: 'idle' })
    teamOfMap.set('idle', { teamId: world.team.teamId })
    const bound = new PlanWorkspaceStore(sup.db.db)
    bound.bind(world.team.teamId, `bind-${Date.now()}`, { role: 'architect', sessionId: 'arch', expectedVersion: null })
    const changesAtRest = totalChanges()
    messages = []
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    const health = lastSnapshot()!.workspace.health!
    expect(health.map(agent => agent.sessionId).sort()).toEqual(['arch'])
    expect(totalChanges()).toBe(changesAtRest)
    expect(forbiddenCalls).toEqual([])
  })

  test('exposing a bound worker starts no process, and missing telemetry is unknown, never zero', async () => {
    const planId = await approvedPlan()
    const bound = new PlanWorkspaceStore(sup.db.db)
    bound.bind(world.team.teamId, `bind-${Date.now()}`, { role: 'lead', sessionId: 'dev', expectedVersion: null })
    contextReadings.delete('dev') // the worker holds no reading
    const changesAtRest = totalChanges()
    messages = []
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    const health = lastSnapshot()!.workspace.health!
    const dev = health.find(agent => agent.sessionId === 'dev')!
    expect(dev.relevance).toBe('lead')
    expect(dev.context).toBeNull()
    expect(totalChanges()).toBe(changesAtRest)
    expect(forbiddenCalls).toEqual([])
  })

  test('closing the workspace calls nothing and pushes nothing further', async () => {
    const planId = await approvedPlan()
    const changesAtRest = totalChanges()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    const pushesAfterOpen = messages.length
    await send({ type: 'team-plan-workspace-close', teamPath: world.repo, planId })
    expect(totalChanges()).toBe(changesAtRest)
    expect(forbiddenCalls).toEqual([])
    expect(messages.length).toBe(pushesAfterOpen)
  })

  test('two sessions of one provider read the same limited report; both dots derive red (B6)', async () => {
    const planId = await approvedPlan()
    const executionId = sup.start(planId)
    const { taskId } = await sup.implementing(executionId, planId, new Date().toISOString())
    sup.db.db.prepare("UPDATE team_task_assignments SET claimed_by = 'dev' WHERE task_id = ?").run(taskId)
    new PlanWorkspaceStore(sup.db.db).bind(world.team.teamId, `bind-${Date.now()}`, { role: 'architect', sessionId: 'arch', expectedVersion: null })
    // One provider report shared by both sessions (providerIdOf is 'prov'
    // for either), fresh so the client-side derivation sees it: limited.
    const at = new Date().toISOString()
    usageReports.set('prov', { ...REPORT, status: 'limited', windows: [{ key: 'five_hour', label: 'Five hours', percentUsed: 100, resetsAt: null }], receivedAt: at })
    contextReadings.set('dev', { percentage: 50, at })
    contextReadings.set('arch', { percentage: 40, at })
    const changesAtRest = totalChanges()
    messages = []
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    const health = lastSnapshot()!.workspace.health!
    expect(health.map(agent => agent.sessionId).sort()).toEqual(['arch', 'dev'])
    // The snapshot carries the raw shared readings; the shared derivation
    // (the same code §5 runs on a client clock) turns each into a red dot.
    for (const agent of health) {
      expect(agent.quota).toMatchObject({ status: 'limited', used: 1, source: 'profile' })
      expect(agent.quotaApplicable).toBe(true)
      expect(workspaceHealthOf(
        { context: agent.context, quota: agent.quota, quotaApplicable: agent.quotaApplicable, connected: true },
        new Date(),
      ).level).toBe('red')
    }
    expect(totalChanges()).toBe(changesAtRest)
    expect(forbiddenCalls).toEqual([])
  })
})
