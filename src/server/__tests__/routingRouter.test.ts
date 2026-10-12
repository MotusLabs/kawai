// ProfileRouter: rule decisions, fallbacks, holds, cooldown, and the log —
// with stub staffing, rules, and limits.
import { beforeEach, describe, expect, test } from 'bun:test'
import type { EligibleMember } from '../team/dispatcher'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import type { TeamMessage } from '../team/mailboxStore'
import { DECISION_LOG_SIZE, ProfileRouter, type GroupMemberRecord } from '../team/routing/router'
import type { RouteContext, RouteDecision, LimitEvent } from '../../shared/routing'

const T0 = Date.parse('2026-10-12T12:00:00.000Z')

function group(frontmatter: string): GroupDefinition {
  const parsed = parseGroupFile('devs', `---\n${frontmatter}\n---\nBuild.`)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.group
}

const message = (over: Partial<TeamMessage> = {}): TeamMessage => ({
  id: 'm1', teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo',
  priority: 'normal', tags: ['t'], threadId: 'm1', inReplyTo: null, hop: 1, body: 'SECRET BODY', state: 'queued',
  claimedBy: null, claimedAt: null, deliverAt: null, createdAt: '', pushedAt: null, deliveredAt: null, reason: null,
  possibleDuplicate: false, attachThread: false, taskId: 'task-1', ...over,
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

function makeRouter() {
  return new ProfileRouter({
    groupOf: async () => def,
    members: () => members,
    targetWorktree: () => '/wt',
    staffing: {
      spawnContext: async () => ({ worktree: '/wt', allowed: spawnAllowed, pendingProfiles: [] }),
      spawnFor: async (m, _wt, _g, profileId) => {
        spawns.push(profileId)
        return { message: m, sessionId: `spawned-${profileId}` }
      },
    },
    rules: {
      rule: () => (rule ? { route: async (ctx: RouteContext) => { ruleCalls.push(ctx); return rule!(ctx) } } as never : undefined),
    },
    limits: { forProfile: id => events[id] ?? [] },
    usageOf: id => (id === 'claude' ? { status: 'warning', windows: [{ key: 'five_hour', label: '5h', percentUsed: 80, resetsAt: null }], receivedAt: 'r', source: 'pull' } : null),
    now: () => now,
  })
}

const finalEvent = (profileId: string, resetsAt: string | null): LimitEvent => ({
  id: crypto.randomUUID(), profileId, sessionId: 's', groupId: 'devs', at: new Date(now).toISOString(), kind: 'rate_limit',
  final: true, status: 429, message: 'quota', resetsAt,
})

beforeEach(() => {
  now = T0
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
})

describe('built-in routing', () => {
  test('first-available takes the longest-idle member', async () => {
    expect(await makeRouter().route(message(), { eligible: [eligible('a', 50), eligible('b', 5)], attempt: 0 }))
      .toEqual({ kind: 'member', sessionId: 'a' })
  })

  test('profile-order prefers the earlier profile', async () => {
    def = group('profiles: [claude, glm]\nstrategy: profile-order')
    expect(await makeRouter().route(message(), { eligible: [eligible('a', 50), eligible('b', 5)], attempt: 0 }))
      .toEqual({ kind: 'member', sessionId: 'b' })
  })

  test('only the limited profile cools: mail goes to the other member', async () => {
    events.glm = [finalEvent('glm', null)]
    expect(await makeRouter().route(message(), { eligible: [eligible('a', 50), eligible('b', 5)], attempt: 0 }))
      .toEqual({ kind: 'member', sessionId: 'b' })
  })

  test('a cooling-only candidate set holds until the cooldown ends', async () => {
    events.glm = [finalEvent('glm', new Date(T0 + 40 * 60_000).toISOString())]
    expect(await makeRouter().route(message(), { eligible: [eligible('a')], attempt: 0 }))
      .toEqual({ kind: 'hold', retryAt: T0 + 40 * 60_000 })
  })

  test('a spawn slot is used when no member is eligible', async () => {
    def = group('profiles: [claude, glm]\nmax: 5')
    spawnAllowed = true
    const result = await makeRouter().route(message(), { eligible: [], attempt: 0 })
    expect(result).toMatchObject({ kind: 'spawned', assignment: { sessionId: 'spawned-claude' } })
    expect(spawns).toEqual(['claude'])
  })

  test('a full group (max reached) offers no spawn slot', async () => {
    spawnAllowed = true
    expect(await makeRouter().route(message(), { eligible: [], attempt: 0 })).toEqual({ kind: 'none' })
    expect(spawns).toEqual([])
  })

  test('nothing eligible and no spawn: none', async () => {
    expect(await makeRouter().route(message(), { eligible: [], attempt: 0 })).toEqual({ kind: 'none' })
  })

  test('a missing group falls back to the longest-idle eligible member', async () => {
    def = undefined
    expect(await makeRouter().route(message(), { eligible: [eligible('a')], attempt: 0 })).toEqual({ kind: 'member', sessionId: 'a' })
    expect(await makeRouter().route(message(), { eligible: [], attempt: 0 })).toEqual({ kind: 'none' })
  })
})

describe('rules', () => {
  test('a rule sees metadata, candidates, caps, usage, and limits — never the body — and its pick decides', async () => {
    rule = async ctx => ({ type: 'pick', candidateId: ctx.candidates.find(c => c.profileId === 'glm')!.id })
    events.glm = [{ ...finalEvent('glm', null), final: false }]
    const router = makeRouter()
    expect(await router.route(message(), { eligible: [eligible('a', 1), eligible('b', 99)], attempt: 0 }))
      .toEqual({ kind: 'member', sessionId: 'a' })
    const ctx = ruleCalls[0]!
    expect(JSON.stringify(ctx)).not.toContain('SECRET BODY')
    expect(ctx.message).toEqual({ id: 'm1', priority: 'normal', senderGroup: 'leads', tags: ['t'], worktree: '/wt', taskId: 'task-1' })
    expect(ctx.group).toMatchObject({ id: 'devs', max: 1, live: 2, profiles: [{ profileId: 'claude', live: 1 }, { profileId: 'glm', live: 1 }] })
    expect(ctx.profiles.claude!.usage).toMatchObject({ status: 'warning', source: 'pull' })
    expect(ctx.profiles.glm!.limitEvents).toHaveLength(1)
    expect(ctx.profiles.glm!.cooldownUntil).toBeNull()
    expect(router.decisions('team')[0]).toMatchObject({ source: 'rule', decision: 'member:a', messageId: 'm1' })
  })

  test('a rule may pick a cooling profile (it decides otherwise)', async () => {
    events.glm = [finalEvent('glm', null)]
    rule = async () => ({ type: 'pick', candidateId: 'member:a' })
    expect(await makeRouter().route(message(), { eligible: [eligible('a'), eligible('b')], attempt: 0 }))
      .toEqual({ kind: 'member', sessionId: 'a' })
  })

  test('picking a spawn slot spawns that profile', async () => {
    def = group('profiles: [claude, glm]\nmax: 5')
    spawnAllowed = true
    rule = async () => ({ type: 'pick', candidateId: 'spawn:glm' })
    await makeRouter().route(message(), { eligible: [], attempt: 0 })
    expect(spawns).toEqual(['glm'])
  })

  test('default, throws, timeouts, and unknown picks fall back to the built-in strategy and are logged', async () => {
    const router = makeRouter()
    const view = { eligible: [eligible('a', 50), eligible('b', 5)], attempt: 0 }
    for (const behaviour of [
      async (): Promise<RouteDecision> => ({ type: 'default' }),
      async (): Promise<RouteDecision> => { throw new Error('route did not return within 3000 ms') },
      async (): Promise<RouteDecision> => ({ type: 'pick', candidateId: 'member:ghost' }),
    ]) {
      rule = behaviour
      expect(await router.route(message(), view)).toEqual({ kind: 'member', sessionId: 'a' })
    }
    const log = router.decisions('team')
    expect(log.filter(entry => entry.source === 'fallback').map(entry => entry.reason)).toEqual(
      expect.arrayContaining(['rule failed: route did not return within 3000 ms', 'rule picked unknown candidate member:ghost']))
  })

  test('attempt 2 (after a stale re-route) skips the rule', async () => {
    rule = async () => ({ type: 'pick', candidateId: 'member:b' })
    expect(await makeRouter().route(message(), { eligible: [eligible('a', 50), eligible('b', 5)], attempt: 2 }))
      .toEqual({ kind: 'member', sessionId: 'a' })
    expect(ruleCalls).toHaveLength(0)
  })

  test('a hold sticks until its retry time or until the candidates change', async () => {
    rule = async () => ({ type: 'hold', reason: 'quota low', retryAfterMs: 600_000 })
    const router = makeRouter()
    const view = { eligible: [eligible('a')], attempt: 0 }
    expect(await router.route(message(), view)).toEqual({ kind: 'hold', retryAt: T0 + 600_000 })
    expect(await router.route(message(), view)).toEqual({ kind: 'hold', retryAt: T0 + 600_000 })
    expect(ruleCalls).toHaveLength(1)
    // Candidates changed: asked again.
    await router.route(message(), { eligible: [eligible('a'), eligible('b')], attempt: 0 })
    expect(ruleCalls).toHaveLength(2)
    // Retry time passed: asked again.
    now = T0 + 600_001
    await router.route(message(), { eligible: [eligible('a'), eligible('b')], attempt: 0 })
    expect(ruleCalls).toHaveLength(3)
    expect(router.decisions('team')[0]).toMatchObject({ source: 'rule', decision: 'hold', reason: 'quota low' })
  })

  test('the decision log is bounded per group and scoped by team', async () => {
    const router = makeRouter()
    for (let i = 0; i < DECISION_LOG_SIZE + 5; i++) await router.route(message({ id: `m${i}` }), { eligible: [eligible('a')], attempt: 0 })
    expect(router.decisions('team')).toHaveLength(DECISION_LOG_SIZE)
    expect(router.decisions('other')).toEqual([])
  })
})
