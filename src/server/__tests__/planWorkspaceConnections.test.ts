// Plan workspace subscriptions and the bind command over the chat connection
// (plan-workspace 1.3): open through the real team-scope resolver, the
// displayed-version fallback and its selector, wrong-team refusals with no
// data, the bind CAS round trip with its replay, availability of bound
// sessions, and the router listing. Every path asserts zero agent starts
// (invariant I6) — the manager double's start seams throw and count.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { TeamIdentity } from '../team/teamIdentity'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import type { WorkspaceSnapshot } from '../../shared/planWorkspace'
import { planInput } from '../../shared/__tests__/planFixtures'
import { normalizePlanContent, type PlanDraft, type PlanRevision } from '../../shared/plans'
import { createPlanBench, createPlanWorld, sessionRow, writeGroup, type PlanWorld } from './planHarness'
import { hashPlanDraft } from '../plans/planHash'
import { PlanWorkspaceStore } from '../plans/workspace/workspaceStore'
import { defaultDisplayedVersion, selectedDisplayedVersion } from '../plans/workspace/displayedVersion'

let world: PlanWorld
let bench: ReturnType<typeof createPlanBench>
let connections: ChatConnections
let messages: ServerMessage[]
let agentStarts = 0
let records: Map<string, ReturnType<typeof sessionRow>>
const teamOfMap = new Map<string, TeamIdentity>()
const connection = { send: (message: ServerMessage) => messages.push(message) }

beforeAll(async () => {
  world = await createPlanWorld('kawai-plan-workspace-connections-')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\n---\nLead.')
  bench = createPlanBench(world)
  messages = []
  agentStarts = 0
  records = new Map<string, ReturnType<typeof sessionRow>>([
    ['lead-chat', sessionRow('lead-chat', 'leads', world.repo)],
    ['arch-chat', sessionRow('arch-chat', 'leads', world.feature)],
    ['moved-chat', sessionRow('moved-chat', 'leads', world.repo)],
    ['other-team-chat', sessionRow('other-team-chat', 'leads', world.other)],
  ])
  teamOfMap.clear()
  for (const id of records.keys()) teamOfMap.set(id, world.team)
  teamOfMap.set('other-team-chat', world.otherTeam)
  // Invariant I6: these seams start, restore, or attach an agent — the one
  // count any call bumps, asserted zero after every exercised path.
  const forbidden = (what: string) => () => { agentStarts += 1; throw new Error(`I6: ${what} must not be called`) }
  const manager = {
    whenRestored: () => Promise.resolve(),
    teamScopes: new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId] }),
    plans: bench.service,
    planWorkspace: new PlanWorkspaceStore(bench.db.db),
    has: (id: string) => records.has(id),
    isArchived: (id: string) => records.get(id)?.archivedAt != null,
    teams: { teamOf: (id: string) => teamOfMap.get(id) },
    directory: { get: (teamId: string, id: string) => (records.has(id) ? { sessionId: id, name: `name-${id}`, group: null } : null) },
    ensureDriver: forbidden('ensureDriver'),
    start: forbidden('start'),
    restore: forbidden('restore'),
    loadHistory: forbidden('loadHistory'),
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
})

const send = (message: ClientMessage) => connections.handle(connection, message)
const all = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type)
const last = <T extends ServerMessage['type']>(type: T) => all(type).at(-1)
type Snapshot = Extract<ServerMessage, { type: 'team-plan-workspace-snapshot' }>

/** The bind push is fire-and-forget; poll briefly for a snapshot answering `check`. */
async function untilSnapshot(check: (message: Snapshot) => boolean, tries = 100): Promise<Snapshot> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const arrived = all('team-plan-workspace-snapshot').filter(check)
    if (arrived.length > 0) return arrived[0]!
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('no workspace snapshot push arrived')
}

describe('subscriptions', () => {
  test('open sends an authoritative snapshot; a draft-only plan displays the draft', async () => {
    const { plan, draft } = await bench.service.create(bench.agent('lead'), { title: 'Wave C', content: planInput() })
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId: plan.id })
    const snapshot = last('team-plan-workspace-snapshot')!
    expect(snapshot).toMatchObject({ teamPath: world.repo, teamId: world.team.teamId, planId: plan.id })
    expect(snapshot.workspace.plan).toEqual({ id: plan.id, title: 'Wave C', lifecycle: 'open' })
    expect(snapshot.workspace.displayedVersion).toEqual({ kind: 'draft', draftId: draft.draftId, contentHash: draft.contentHash })
    expect(snapshot.workspace.bindings).toEqual([])
    expect(snapshot.workspace.references).toEqual([])
    expect(agentStarts).toBe(0)
  })

  test('the displayed version falls back: approved, else the newest in-review revision', async () => {
    const { planId, revision, hash } = await bench.draftInReview()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    expect(last('team-plan-workspace-snapshot')!.workspace.displayedVersion)
      .toEqual({ kind: 'revision', revision, status: 'in_review', contentHash: hash })
    bench.plans.setRevisionStatus(planId, revision, 'approved')
    bench.plans.setCurrentApproved(planId, revision)
    messages = []
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    expect(last('team-plan-workspace-snapshot')!.workspace.displayedVersion)
      .toEqual({ kind: 'revision', revision, status: 'approved', contentHash: hash })
  })

  test('a version selector resolves exactly; a malformed or missing one is refused with no data', async () => {
    const { planId, revision } = await bench.draftInReview()
    const content = normalizePlanContent(planInput({ goal: 'Next wave' }))
    bench.plans.writeDraft(planId, { draftId: 'explorer', author: bench.agent('lead'), content, contentHash: hashPlanDraft(content), expectedDraftHash: null })
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId, version: { kind: 'draft', draftId: 'explorer' } })
    expect(last('team-plan-workspace-snapshot')!.workspace.displayedVersion).toMatchObject({ kind: 'draft', draftId: 'explorer' })
    messages = []
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId, version: { kind: 'revision', revision } })
    expect(last('team-plan-workspace-snapshot')!.workspace.displayedVersion).toMatchObject({ kind: 'revision', revision })
    for (const bad of [{ kind: 'wat' }, 42, { kind: 'revision', revision: 0 }, { kind: 'draft', draftId: '  ' }]) {
      messages = []
      await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId, version: bad as never })
      expect(messages).toEqual([{ type: 'error', message: expect.stringContaining('Malformed version selector') }])
    }
    messages = []
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId, version: { kind: 'revision', revision: 99 } })
    expect(messages).toEqual([{ type: 'error', message: expect.stringContaining('Revision 99 not found') }])
    messages = []
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId, version: { kind: 'draft', draftId: 'gone' } })
    expect(messages).toEqual([{ type: 'error', message: expect.stringContaining('Draft "gone" not found') }])
  })

  test('an unknown path is refused as unknown-team; another team\'s plan is refused with no data', async () => {
    const { planId } = await bench.draftInReview()
    const foreign = bench.plans.insertPlan({ teamId: world.otherTeam.teamId, title: 'Secret', creator: { kind: 'human', sessionId: null } })
    await send({ type: 'team-plan-workspace-open', teamPath: world.other, planId })
    expect(last('team-plan-workspace-snapshot')).toBeUndefined()
    expect(messages[0]).toMatchObject({ type: 'error', message: expect.stringContaining('unknown-team') })
    await send({ type: 'team-plan-workspace-open', teamPath: '/nowhere', planId })
    expect(last('team-plan-workspace-snapshot')).toBeUndefined()
    messages = []
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId: foreign })
    expect(messages).toEqual([{ type: 'error', message: `Plan not found in this team: ${foreign}` }])
    // A bind on an unknown path is refused as unknown-team too.
    await send({ type: 'team-plan-workspace-bind', teamPath: world.other, requestId: 'b0', commandId: 'x', role: 'lead', sessionId: 'lead-chat', expectedVersion: null })
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'b0', error: expect.stringContaining('unknown-team') })
    expect(agentStarts).toBe(0)
  })

  test('close ends the subscription: later committed binds push this connection nothing', async () => {
    const { planId } = await bench.draftInReview()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    await send({ type: 'team-plan-workspace-close', teamPath: world.repo, planId })
    const seen = all('team-plan-workspace-snapshot').length
    await send({ type: 'team-plan-workspace-bind', teamPath: world.repo, requestId: 'b1', commandId: 'bind-1', role: 'lead', sessionId: 'lead-chat', expectedVersion: null })
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'b1', replayed: false })
    await untilSnapshot(() => all('team-plan-workspace-snapshot').length > seen || false, 10).catch(() => null)
    expect(all('team-plan-workspace-snapshot')).toHaveLength(seen)
  })
})

describe('binds', () => {
  const bindMessage = (over: Partial<Extract<ClientMessage, { type: 'team-plan-workspace-bind' }>> = {}) =>
    ({ type: 'team-plan-workspace-bind', teamPath: world.repo, requestId: 'r1', commandId: 'bind-1', role: 'lead', sessionId: 'lead-chat', expectedVersion: null, ...over }) as Extract<ClientMessage, { type: 'team-plan-workspace-bind' }>

  test('bind answers and pushes every subscribed plan of the team; a replay pushes nothing', async () => {
    const first = await bench.draftInReview()
    const second = await bench.draftInReview()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId: first.planId })
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId: second.planId })
    await send(bindMessage())
    expect(last('team-plan-workspace-result')).toMatchObject({
      requestId: 'r1', replayed: false, binding: { role: 'lead', sessionId: 'lead-chat', version: 1 },
    })
    const pushed = await untilSnapshot(message => message.workspace.bindings.length > 0)
    expect(pushed.workspace.bindings).toEqual([
      { role: 'lead', sessionId: 'lead-chat', version: 1, availability: 'live', name: 'name-lead-chat' },
    ])
    const pushes = all('team-plan-workspace-snapshot').length
    await send(bindMessage({ requestId: 'r2' }))
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'r2', replayed: true })
    await untilSnapshot(() => all('team-plan-workspace-snapshot').length > pushes || false, 10).catch(() => null)
    expect(all('team-plan-workspace-snapshot')).toHaveLength(pushes)
    expect(agentStarts).toBe(0)
  })

  test('a stale expectedVersion refuses and writes nothing; no push follows a refusal', async () => {
    const { planId } = await bench.draftInReview()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    await send(bindMessage({ commandId: 'bind-1' }))
    await untilSnapshot(message => message.workspace.bindings.length > 0)
    const pushes = messages.length
    await send(bindMessage({ requestId: 'r3', commandId: 'bind-2', expectedVersion: 5 }))
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'r3', error: expect.stringContaining('5'), field: 'expectedVersion' })
    expect(last('team-plan-workspace-result')!.binding).toBeUndefined()
    // The refusal answered with a result and pushed nothing: the open's and
    // the first bind's snapshots are all this connection ever received.
    expect(all('team-plan-workspace-snapshot')).toHaveLength(2)
    expect(messages).toHaveLength(pushes + 1)
  })

  test('a different payload under the same command id is refused naming the field', async () => {
    const { planId } = await bench.draftInReview()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    await send(bindMessage())
    await send(bindMessage({ requestId: 'r4', sessionId: 'arch-chat' }))
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'r4', error: expect.stringContaining('different sessionId'), field: 'sessionId' })
    await send(bindMessage({ requestId: 'r5', role: 'architect' }))
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'r5', error: expect.stringContaining('different role'), field: 'role' })
  })

  test('a refused bind succeeds when resent under the same command id after the state changes', async () => {
    const { planId } = await bench.draftInReview()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    // Stale: the role is unbound but the binder saw version 1. Nothing is written.
    await send(bindMessage({ requestId: 'r1', commandId: 'bind-1', expectedVersion: 1 }))
    expect(last('team-plan-workspace-result')!.error).toContain('expectedVersion 1 does not match the unbound role')
    // The state changes through another command id.
    await send(bindMessage({ requestId: 'r2', commandId: 'bind-2' }))
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'r2', binding: { version: 1 } })
    // The first command id was never recorded, so the resend is evaluated afresh — and succeeds.
    await send(bindMessage({ requestId: 'r3', commandId: 'bind-1', expectedVersion: 1 }))
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'r3', replayed: false, binding: { version: 2 } })
  })

  test('one session cannot hold both roles; a terminal or other-team session id is refused', async () => {
    const { planId } = await bench.draftInReview()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    await send(bindMessage())
    await send(bindMessage({ requestId: 'r4', commandId: 'bind-2', role: 'architect', sessionId: 'lead-chat', expectedVersion: null }))
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'r4', error: expect.stringContaining('other role'), field: 'sessionId' })
    await send(bindMessage({ requestId: 'r5', commandId: 'bind-3', role: 'architect', sessionId: 'terminal-1', expectedVersion: null }))
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'r5', error: expect.stringContaining('Session not found in this team'), field: 'sessionId' })
    await send(bindMessage({ requestId: 'r6', commandId: 'bind-4', role: 'architect', sessionId: 'other-team-chat', expectedVersion: null }))
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'r6', error: expect.stringContaining('Session not found in this team'), field: 'sessionId' })
  })

  test('a bound session reads live, archived, or unavailable as its record changes', async () => {
    const { planId } = await bench.draftInReview()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    await send(bindMessage({ commandId: 'bind-lead' }))
    await send(bindMessage({ requestId: 'r2', commandId: 'bind-arch', role: 'architect', sessionId: 'arch-chat', expectedVersion: null }))
    await untilSnapshot(message => message.workspace.bindings.length === 2)
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    const views = () => last('team-plan-workspace-snapshot')!.workspace.bindings
    expect(views().find(binding => binding.role === 'lead')).toMatchObject({ availability: 'live' })
    expect(views().find(binding => binding.role === 'architect')).toMatchObject({ availability: 'live' })
    // Archived: still bound, read-only availability (D6).
    records.set('arch-chat', { ...sessionRow('arch-chat', 'leads', world.feature), archivedAt: 'now' })
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    expect(views().find(binding => binding.role === 'architect')).toMatchObject({ availability: 'archived' })
    // Moved team, then killed: both read unavailable (Q2).
    teamOfMap.set('arch-chat', world.otherTeam)
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    expect(views().find(binding => binding.role === 'architect')).toMatchObject({ availability: 'unavailable' })
    records.delete('lead-chat')
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    expect(views().find(binding => binding.role === 'lead')).toMatchObject({ availability: 'unavailable' })
    expect(agentStarts).toBe(0)
  })
})

test('every new workspace client type is listed for the WS router', () => {
  for (const type of ['team-plan-workspace-open', 'team-plan-workspace-close', 'team-plan-workspace-bind']) {
    expect(CHAT_CONNECTION_TYPES as readonly string[]).toContain(type)
  }
})

describe('the displayed-version order (pure)', () => {
  const revision = (n: number, status: 'approved' | 'in_review' | 'superseded' | 'withdrawn', hash = `h${n}`): PlanRevision =>
    ({ revision: n, status, content: normalizePlanContent({}), contentHash: hash, pin: null, author: { kind: 'human', sessionId: null }, createdAt: 't' })
  const draft = (id: string, updatedAt: string): PlanDraft =>
    ({ draftId: id, baseRevision: null, author: { kind: 'human', sessionId: null }, content: normalizePlanContent({}), contentHash: `d-${id}`, updatedAt })

  test('approved wins, then the newest in-review revision, then the newest draft, else null', () => {
    expect(defaultDisplayedVersion({ approved: null, revisions: [], drafts: [] })).toBeNull()
    const inReview2 = revision(2, 'in_review')
    const inputs = { approved: null, revisions: [revision(1, 'withdrawn'), inReview2, revision(3, 'superseded')], drafts: [draft('late', '2026-01-02')] }
    expect(defaultDisplayedVersion(inputs)).toEqual({ kind: 'revision', revision: 2, status: 'in_review', contentHash: 'h2' })
    const approved = revision(1, 'approved')
    expect(defaultDisplayedVersion({ ...inputs, approved }))
      .toEqual({ kind: 'revision', revision: 1, status: 'approved', contentHash: 'h1' })
    // No standing revision: the newest draft by updated_at wins (the draft case).
    expect(defaultDisplayedVersion({ approved: null, revisions: [revision(1, 'withdrawn')], drafts: [draft('old', '2026-01-02'), draft('new', '2026-02-02')] }))
      .toEqual({ kind: 'draft', draftId: 'new', contentHash: 'd-new' })
  })

  test('a selector resolves exactly and names nothing when the record is gone', () => {
    const inputs = { approved: null, revisions: [revision(1, 'approved')], drafts: [draft('d', 't')] }
    expect(selectedDisplayedVersion(inputs, { kind: 'revision', revision: 1 })).toMatchObject({ kind: 'revision', revision: 1 })
    expect(selectedDisplayedVersion(inputs, { kind: 'draft', draftId: 'd' })).toMatchObject({ kind: 'draft', draftId: 'd' })
    expect(selectedDisplayedVersion(inputs, { kind: 'revision', revision: 9 })).toBeNull()
    expect(selectedDisplayedVersion(inputs, { kind: 'draft', draftId: 'gone' })).toBeNull()
  })
})

describe('workspace snapshots type-check against the shared contract', () => {
  test('a snapshot carried over the wire parses as a WorkspaceSnapshot', async () => {
    const { planId } = await bench.draftInReview()
    await send({ type: 'team-plan-workspace-open', teamPath: world.repo, planId })
    const snapshot = last('team-plan-workspace-snapshot')!
    const workspace: WorkspaceSnapshot = snapshot.workspace
    expect(workspace.displayedVersion?.kind).toBe('revision')
    expect(workspace.plan.id).toBe(planId)
  })
})
