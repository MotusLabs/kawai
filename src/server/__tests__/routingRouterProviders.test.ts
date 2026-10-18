// The provider-cooldown routing tests (providers-and-workers 4.3-4.6),
// moved verbatim from routingRouter.test.ts to keep that file under 500
// lines: the router's fake limits compute both the profile's effective
// cooldown and the provider's own, so the sibling, model-scoped-forward, and
// hard-filter cases run exactly as written there.
import { beforeEach, describe, expect, test } from 'bun:test'
import type { EligibleMember } from '../team/dispatcher'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import type { TeamMessage } from '../team/mailboxStore'
import { ProfileRouter, type GroupMemberRecord } from '../team/routing/router'
import { cooldownUntil, providerCooldownUntil } from '../team/routing/limitEvents'
import type { RouteContext, RouteDecision, LimitEvent } from '../../shared/routing'

const T0 = Date.parse('2026-10-12T12:00:00.000Z')

function group(frontmatter: string): GroupDefinition {
  const parsed = parseGroupFile('devs', `---\n${frontmatter}\n---\nBuild.`)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.group
}

const message = (over: Partial<TeamMessage> = {}): TeamMessage => ({
  id: 'm1', teamId: 'team', toKind: 'group', toId: 'devs', fromKind: 'agent', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo',
  priority: 'normal', tags: ['t'], threadId: 'm1', inReplyTo: null, hop: 1, body: 'SECRET BODY', state: 'queued',
  claimedBy: null, claimedAt: null, deliverAt: null, createdAt: '', pushedAt: null, deliveredAt: null, reason: null,
  possibleDuplicate: false, attachThread: false, taskId: 'task-1', taskRevision: null,
  claimCommit: null, parkedUntil: null, parkCount: 0, resumeMessageId: null, handoff: null, excludedProfile: null, ...over,
})

const eligible = (sessionId: string, idleForMs = 10): EligibleMember => ({
  sessionId, teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true, worktree: '/wt', idleForMs,
})

let now: number
let def: GroupDefinition | undefined
let members: GroupMemberRecord[]
let rule: ((ctx: RouteContext) => Promise<RouteDecision>) | null
let ruleCalls: RouteContext[]
let events: Record<string, LimitEvent[]>
let spawnAllowed: boolean
let spawns: string[]
let facts: { teamSpawned: number; teamCap: number; worktreeOccupants: string[]; worktreePending: number; backoffRetryAt: number | null }
/** Profile → provider for the cooldown (providers-and-workers D8); identity when unset. */
let providerFor: ((profileId: string) => string) | null = null

function makeRouter() {
  return new ProfileRouter({
    groupOf: async () => def,
    members: () => members,
    targetWorktree: () => '/wt',
    staffing: {
      spawnContext: async () => ({ worktree: '/wt', allowed: spawnAllowed, pendingProfiles: [], facts }),
      spawnFor: async (m, _wt, _g, profileId) => {
        spawns.push(profileId)
        return { message: m, sessionId: `spawned-${profileId}` }
      },
    },
    excludedProfile: m => m.excludedProfile ?? undefined,
    rules: {
      rule: () => (rule ? { route: async (ctx: RouteContext) => { ruleCalls.push(ctx); return rule!(ctx) } } as never : undefined),
    },
    limits: {
      forProfile: id => events[id] ?? [],
      cooldownFor: id => {
        const pool = Object.values(events).flat()
        const providerId = providerFor?.(id) ?? null
        const until = cooldownUntil(id, providerId, pool, now)
        const providerEnd = providerCooldownUntil(providerId, pool, now)
        return { until, provider: providerEnd !== null && until !== null && Date.parse(providerEnd) >= Date.parse(until), providerId }
      },
      providerCooldownUntil: providerId => providerCooldownUntil(providerId, Object.values(events).flat(), now),
    },
    ...(providerFor ? { providerOf: providerFor } : {}),
    usageOf: () => null,
    now: () => now,
  })
}

beforeEach(() => {
  now = T0
  providerFor = null
  def = group('profiles: [claude, glm]')
  members = [
    { sessionId: 'a', profileId: 'glm', cwd: '/wt' },
    { sessionId: 'b', profileId: 'claude', cwd: '/wt' },
  ]
  rule = null
  ruleCalls = []
  events = {}
  spawnAllowed = false
  spawns = []
  facts = { teamSpawned: 0, teamCap: 5, worktreeOccupants: [], worktreePending: 0, backoffRetryAt: null }
})

const finalEvent = (profileId: string, resetsAt: string | null): LimitEvent => ({
  id: crypto.randomUUID(), profileId, sessionId: 's', groupId: 'devs', at: new Date(now).toISOString(), kind: 'rate_limit',
  final: true, status: 429, message: 'quota', resetsAt, providerId: null, window: null,
})

describe('provider-cooldown routing', () => {
  test("a forward from a model-scoped limit may reach the provider's other model", async () => {
    def = group('profiles: [opus, sonnet]\nmax: 2')
    members = [
      { sessionId: 'o', profileId: 'opus', cwd: '/wt' },
      { sessionId: 's', profileId: 'sonnet', cwd: '/wt' },
    ]
    providerFor = () => 'claude'
    // opus's own seven_day_opus window is model-scoped: the provider does not cool.
    events.opus = [{ ...finalEvent('opus', new Date(T0 + 3 * 24 * 3_600_000).toISOString()), providerId: 'claude', window: 'seven_day_opus' }]
    expect(await makeRouter().route(message({ excludedProfile: 'opus' }), { eligible: [eligible('s', 5)], attempt: 0 }))
      .toEqual({ kind: 'member', sessionId: 's' })
    providerFor = null
  })

  test('a spawn slot of the cooling provider is hard-filtered from a forward', async () => {
    def = group('profiles: [glm, glm-flash]\nmax: 2')
    providerFor = () => 'zai'
    events.glm = [{ ...finalEvent('glm', new Date(T0 + 40 * 60_000).toISOString()), providerId: 'zai', window: null }]
    spawnAllowed = true
    const result = await makeRouter().route(message({ excludedProfile: 'glm' }), { eligible: [], attempt: 0 })
    expect(result).toMatchObject({ kind: 'none' })
    expect(spawns).toEqual([])
    providerFor = null
  })

  test("a sibling model's limit cools its provider's other profile in routing", async () => {
    def = group('profiles: [claude, glm-flash]\nmax: 2')
    members = [
      { sessionId: 'f', profileId: 'glm-flash', cwd: '/wt' },
      { sessionId: 'b', profileId: 'claude', cwd: '/wt' },
    ]
    providerFor = id => (id === 'glm' || id === 'glm-flash' ? 'zai' : 'claude')
    // glm's provider-scoped limit cools glm-flash; the rule context sees the same end.
    events.glm = [{ ...finalEvent('glm', new Date(T0 + 40 * 60_000).toISOString()), providerId: 'zai', window: null }]
    expect(await makeRouter().route(message(), { eligible: [eligible('f', 50), eligible('b', 5)], attempt: 0 }))
      .toEqual({ kind: 'member', sessionId: 'b' })
    const ruleCtx = await new Promise<RouteContext>(resolve => {
      rule = async ctx => { resolve(ctx); return { type: 'default' } }
      void makeRouter().route(message(), { eligible: [eligible('f', 50), eligible('b', 5)], attempt: 0 })
    })
    expect(ruleCtx.profiles['glm-flash']!.cooldownUntil).toBe(new Date(T0 + 40 * 60_000).toISOString())
    expect(ruleCtx.profiles['claude']!.cooldownUntil).toBeNull()
    // A hold names the deciding provider in the log (providers-and-workers D15).
    members = [{ sessionId: 'f', profileId: 'glm-flash', cwd: '/wt' }]
    const router = makeRouter()
    expect(await router.route(message(), { eligible: [eligible('f')], attempt: 0 })).toMatchObject({ kind: 'hold' })
    expect(router.decisions('team').some(entry => entry.decision === 'hold' && (entry.reason ?? '').includes('provider zai'))).toBe(true)
    providerFor = null
  })
})
