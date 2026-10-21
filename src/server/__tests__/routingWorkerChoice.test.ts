// The sender's worker choice in routing (dispatch-worker-choice D2/D3, tasks
// 2.1 and 2.3): the router resolves the stored selector against the group's
// workers on each pass and narrows members and spawn slots inside the role,
// keeping the role's order; members outside the role report `outside-role`,
// those inside it but off the choice `worker-choice`; a rule pick outside the
// filtered set is unknown and falls back to the built-in strategy.
import { beforeEach, describe, expect, test } from 'bun:test'
import type { EligibleMember } from '../team/dispatcher'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import type { TeamMessage } from '../team/mailboxStore'
import { ProfileRouter, type GroupMemberRecord } from '../team/routing/router'
import { evaluateEligibility, type EligibilityState } from '../team/routing/workerEligibility'
import { resolveWorkerSelector } from '../team/routing/workerSelector'
import type { RouteContext, RouteDecision } from '../../shared/routing'

const PROVIDERS: Record<string, string> = { sonnet: 'anthropic', opus: 'anthropic', glm: 'zai', 'glm-flash': 'zai' }
const providerOf = (profileId: string) => PROVIDERS[profileId] ?? profileId

function group(frontmatter: string): GroupDefinition {
  const parsed = parseGroupFile('devs', `---\n${frontmatter}\n---\nBuild.`)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.group
}

const message = (over: Partial<TeamMessage> = {}): TeamMessage => ({
  id: 'm1', teamId: 'team', toKind: 'group', toId: 'devs', fromKind: 'agent', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo',
  priority: 'normal', tags: [], threadId: 'm1', inReplyTo: null, hop: 1, body: 'work', state: 'queued',
  claimedBy: null, claimedAt: null, deliverAt: null, createdAt: '', pushedAt: null, deliveredAt: null, reason: null,
  possibleDuplicate: false, attachThread: false, taskId: 'task-1', taskRevision: null,
  claimCommit: null, parkedUntil: null, parkCount: 0, resumeMessageId: null, handoff: null, excludedProfile: null, ...over,
})

const eligible = (sessionId: string, idleForMs: number): EligibleMember => ({
  sessionId, teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true, worktree: '/wt', idleForMs,
})

let def: GroupDefinition
let members: GroupMemberRecord[]
let spawnAllowed: boolean
let spawns: string[]
let rule: ((ctx: RouteContext) => Promise<RouteDecision>) | null
let allowed: string[] | null

function makeRouter() {
  return new ProfileRouter({
    groupOf: async () => def,
    members: () => members,
    targetWorktree: () => '/wt',
    staffing: {
      spawnContext: async () => ({ worktree: '/wt', allowed: spawnAllowed, pendingProfiles: [],
        facts: { teamSpawned: 0, teamCap: 5, worktreeOccupants: [], worktreePending: 0, backoffRetryAt: null } }),
      spawnFor: async (m, _wt, _g, profileId) => { spawns.push(profileId); return { message: m, sessionId: `spawned-${profileId}` } },
    },
    rules: { rule: () => (rule ? { route: rule } as never : undefined) },
    limits: { forProfile: () => [], forProvider: () => [], cooldownFor: () => ({ until: null, provider: false, providerId: null }), providerCooldownUntil: () => null },
    providerOf,
    usageOf: () => null,
    providerUsageOf: () => null,
    allowedProfiles: () => allowed,
    now: () => Date.parse('2026-10-21T08:00:00.000Z'),
  })
}

beforeEach(() => {
  def = group('profiles: [sonnet, glm, glm-flash]\nmax: 6')
  // b (sonnet) has idled longest.
  members = [
    { sessionId: 'a', profileId: 'glm', cwd: '/wt' },
    { sessionId: 'b', profileId: 'sonnet', cwd: '/wt' },
  ]
  spawnAllowed = false
  spawns = []
  rule = null
  allowed = null
})

describe('the router narrows to the worker choice (2.1)', () => {
  test('members on other workers are skipped: the chosen provider\'s member is picked over a longer-idle one', async () => {
    const view = { eligible: [eligible('b', 500), eligible('a', 5)], attempt: 0 }
    expect(await makeRouter().route(message({ workerChoice: 'zai' }), view)).toEqual({ kind: 'member', sessionId: 'a' })
    expect(await makeRouter().route(message({ workerChoice: 'anthropic/sonnet' }), view)).toEqual({ kind: 'member', sessionId: 'b' })
  })

  test('an unset choice changes nothing: the longest-idle member is picked', async () => {
    expect(await makeRouter().route(message(), { eligible: [eligible('b', 500), eligible('a', 5)], attempt: 0 }))
      .toEqual({ kind: 'member', sessionId: 'b' })
  })

  test('spawn slots are limited to the choice and keep the group\'s order', async () => {
    def = group('profiles: [sonnet, glm, glm-flash]\nmax: 6\nstrategy: profile-order')
    members = []
    spawnAllowed = true
    expect(await makeRouter().route(message({ workerChoice: 'zai' }), { eligible: [], attempt: 0 }))
      .toMatchObject({ kind: 'spawned', assignment: { sessionId: 'spawned-glm' } })
    expect(await makeRouter().route(message({ workerChoice: 'zai/glm-flash' }), { eligible: [], attempt: 0 }))
      .toMatchObject({ kind: 'spawned', assignment: { sessionId: 'spawned-glm-flash' } })
    expect(spawns).toEqual(['glm', 'glm-flash'])
  })

  test('the selector resolves on each pass: a group edit that drops the chosen model leaves no candidate', async () => {
    const router = makeRouter()
    const view = { eligible: [eligible('b', 500), eligible('a', 5)], attempt: 0 }
    expect(await router.route(message({ workerChoice: 'zai/glm' }), view)).toEqual({ kind: 'member', sessionId: 'a' })
    def = group('profiles: [sonnet, glm-flash]\nmax: 6')
    const result = await router.route(message({ workerChoice: 'zai/glm' }), view)
    expect(result.kind).toBe('none')
    // Both dispatcher-eligible members name the choice in the breakdown.
    expect(result.kind === 'none' ? result.diagnosis?.find(entry => entry.kind === 'no-eligible-member')?.members : null).toEqual([
      { sessionId: 'a', cause: 'not on the chosen worker' },
      { sessionId: 'b', cause: 'not on the chosen worker' },
    ])
  })

  test('a choice with a role keeps only the intersection, in the role\'s order', async () => {
    def = group('profiles: [sonnet, glm, glm-flash, opus]\nmax: 6\nstrategy: profile-order')
    members = []
    spawnAllowed = true
    allowed = ['glm-flash', 'sonnet', 'glm']
    expect(await makeRouter().route(message({ workerChoice: 'zai', allowedProfiles: allowed }), { eligible: [], attempt: 0 }))
      .toMatchObject({ kind: 'spawned', assignment: { sessionId: 'spawned-glm-flash' } })
  })
})

describe('the eligibility check states each member\'s cause (2.1)', () => {
  const state = (over: Partial<EligibilityState>): EligibilityState => ({
    group: { id: 'devs', profiles: ['sonnet', 'glm', 'glm-flash', 'opus'].map(profileId => ({ profileId })), max: 8, strategy: 'profile-order' },
    members: [
      { sessionId: 's', profileId: 'sonnet', cwd: '/wt', eligible: true },
      { sessionId: 'g', profileId: 'glm', cwd: '/wt', eligible: true },
      { sessionId: 'o', profileId: 'opus', cwd: '/wt', eligible: true },
    ],
    pendingSpawnProfiles: [], spawnAllowed: true, spawnCwd: '/wt', providerOf, ...over,
  })
  const choice = (selector: string) => ({ selector, profiles: resolveWorkerSelector(selector, ['sonnet', 'glm', 'glm-flash', 'opus'], providerOf) })
  const summary = (result: ReturnType<typeof evaluateEligibility>) => ({
    candidates: result.candidates.map(candidate => candidate.id),
    excluded: result.excluded.map(entry => [
      entry.alternative.kind === 'member' ? `member:${entry.alternative.sessionId}` : `spawn:${entry.alternative.profileId}`,
      entry.reasons.map(reason => `${reason.kind}${reason.kind === 'worker-choice' ? `=${reason.detail}` : ''}`),
    ]),
  })

  test('the role is tested first: outside both reads outside-role alone; inside the role but off the choice reads worker-choice', () => {
    expect(summary(evaluateEligibility(state({ allowedProfiles: ['glm-flash', 'sonnet', 'glm'], workerChoice: choice('zai') })))).toEqual({
      candidates: ['member:g', 'spawn:glm-flash', 'spawn:glm'],
      excluded: [
        ['member:s', ['worker-choice=zai']],
        ['member:o', ['outside-role']],
        ['spawn:sonnet', ['worker-choice=zai']],
        ['spawn:opus', ['outside-role']],
      ],
    })
  })

  test('a choice never widens the role: a chosen provider\'s model outside the role stays out', () => {
    expect(summary(evaluateEligibility(state({ allowedProfiles: ['glm', 'sonnet'], workerChoice: choice('anthropic') })))).toEqual({
      candidates: ['member:s', 'spawn:sonnet'],
      excluded: [
        ['member:g', ['worker-choice=anthropic']],
        ['member:o', ['outside-role']],
        ['spawn:glm', ['worker-choice=anthropic']],
        ['spawn:glm-flash', ['outside-role']],
        ['spawn:opus', ['outside-role']],
      ],
    })
  })

  test('a null choice is the same answer as none at all', () => {
    expect(evaluateEligibility(state({ workerChoice: null }))).toEqual(evaluateEligibility(state({})))
  })

  test('an empty intersection excludes every alternative with a reason', () => {
    const result = evaluateEligibility(state({ allowedProfiles: ['opus'], workerChoice: choice('zai') }))
    expect(result.candidates).toEqual([])
    expect(summary(result).excluded.every(([, reasons]) => (reasons as string[]).length > 0)).toBe(true)
  })
})

describe('a rule pick outside the filtered set (2.3)', () => {
  test('naming a filtered-out member reads as unknown and falls back to the built-in pick', async () => {
    const seen: RouteContext[] = []
    rule = async ctx => { seen.push(ctx); return { type: 'pick', candidateId: 'member:b' } }
    const router = makeRouter()
    expect(await router.route(message({ workerChoice: 'zai' }), { eligible: [eligible('b', 500), eligible('a', 5)], attempt: 0 }))
      .toEqual({ kind: 'member', sessionId: 'a' })
    // The rule saw only the filtered candidates.
    expect(seen[0]!.candidates.map(candidate => candidate.id)).toEqual(['member:a'])
    expect(router.decisions('team')[0]).toMatchObject({ source: 'builtin', decision: 'member:a' })
    expect(router.decisions('team')[1]).toMatchObject({ source: 'fallback', reason: 'rule picked unknown candidate member:b' })
  })
})

describe('rules see the worker choice (2.6)', () => {
  test('the route context names the choice beside the other metadata, and omits it without one', async () => {
    const seen: RouteContext[] = []
    rule = async ctx => { seen.push(ctx); return { type: 'default' } }
    const router = makeRouter()
    await router.route(message({ workerChoice: 'zai' }), { eligible: [eligible('a', 5)], attempt: 0 })
    await router.route(message(), { eligible: [eligible('a', 5)], attempt: 0 })
    const { worker, ...rest } = seen[0]!.message
    expect(worker).toBe('zai')
    expect(rest).toEqual(seen[1]!.message)
    expect('worker' in seen[1]!.message).toBe(false)
  })
})
