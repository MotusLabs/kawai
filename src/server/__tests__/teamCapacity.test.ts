// team_capacity (dispatch-worker-choice D6, 3.3): every group or one, an
// unknown group refused by name, unknown usage as null, a cooling provider's
// end from cooldownFor, and live counts — pending spawns included — equal to
// what buildCandidates and the router's rule context count for the same
// state. Real LimitEventStore and WorktreeStaffing over one database.
// sharesLoginWith (3.3a): computed over every group's workers whatever the
// filter, a mixed provider never marked, and nothing secret in the answer.
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatUsageReport } from '../../shared/chat'
import type { RouteContext, RouteGroup } from '../../shared/routing'
import { resolveClaudeProfile } from '../chat/ClaudeProfiles'
import type { ChatSessionRecord } from '../db'
import { capacityDescriptions, capacityHandlers, CAPACITY_TOOL_NAMES } from '../team/capacityTools'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import type { GroupCatalog } from '../team/groupCatalog'
import { MailboxStore, type TeamMessage } from '../team/mailboxStore'
import { TEAM_ALLOWED_TOOLS, teamToolTable } from '../team/mailboxTools'
import { buildCandidates } from '../team/routing/candidates'
import { LimitEventStore } from '../team/routing/limitEvents'
import { liveGroupMembers, ProfileRouter } from '../team/routing/router'
import { storedLoginKey } from '../team/routing/sharedLogins'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCapacity } from '../team/teamCapacity'
import type { TeamIdentity } from '../team/teamIdentity'
import { TeamCaps } from '../team/teamCaps'
import type { TeamMailbox } from '../team/TeamMailbox'
import { schemaDb } from './schemaDb'

const T0 = Date.parse('2026-10-22T03:00:00.000Z')
const TEAM: TeamIdentity = { teamId: '/repo/.git', groupsRoot: '/repo' }
const OTHER: TeamIdentity = { teamId: '/other/.git', groupsRoot: '/other' }
const PROVIDERS: Record<string, string> = { glm: 'zai', 'glm-flash': 'zai', opus: 'claude', sonnet: 'claude' }
const providerOf = (id: string) => PROVIDERS[id] ?? id

let db: Database
let mail: MailboxStore
let limits: LimitEventStore
let staffing: WorktreeStaffing
let records: Map<string, ChatSessionRecord>
let teamOf: Map<string, TeamIdentity>
let catalogs: Map<string, GroupCatalog>
let usage: Map<string, ChatUsageReport>
let loginKeys: Map<string, string | null>

function group(id: string, frontmatter: string): GroupDefinition {
  const parsed = parseGroupFile(id, `---\n${frontmatter}\n---\nWork.`)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.group
}
const catalogOf = (...groups: GroupDefinition[]): GroupCatalog =>
  ({ groups: new Map(groups.map(entry => [entry.id, { group: entry }])), errors: [], warnings: [], providers: new Map() }) as never

const record = (sessionId: string, extra: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId, name: sessionId, projectPath: '/repo/.worktrees/a', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  groupId: 'devs', claudeProfileId: 'glm', ...extra,
})
const addRecord = (sessionId: string, extra: Partial<ChatSessionRecord> = {}, team = TEAM) => {
  records.set(sessionId, record(sessionId, extra))
  teamOf.set(sessionId, team)
}
const reserve = (groupId: string, profileId: string, worktree = '/repo/.worktrees/b') => db.prepare(
  `INSERT INTO team_spawns (id, message_id, team_id, group_id, worktree, created_at, profile_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
).run(crypto.randomUUID(), crypto.randomUUID(), TEAM.teamId, groupId, worktree, new Date(T0).toISOString(), profileId)

function capacity() {
  return new TeamCapacity({
    teams: { teamOf: id => teamOf.get(id), catalogOf: id => { const team = teamOf.get(id); return team ? catalogs.get(team.teamId) : undefined } },
    records: () => records.values(),
    pendingSpawns: teamId => staffing.pendingFor(teamId),
    limits,
    providerOf,
    providerLabel: id => (id === 'zai' ? 'Z.AI' : null),
    providerUsageOf: id => usage.get(id) ?? null,
    loginKeyOf: (profileId, groupsRoot) => {
      expect(groupsRoot).toBe(TEAM.groupsRoot)
      return loginKeys.get(profileId) ?? null
    },
    now: () => T0,
  })
}

beforeEach(() => {
  db = schemaDb(':memory:')
  mail = new MailboxStore(db)
  limits = new LimitEventStore(db, () => T0)
  records = new Map()
  teamOf = new Map()
  usage = new Map()
  loginKeys = new Map()
  staffing = new WorktreeStaffing(db, mail, {
    records: () => records.values(), teamOf: id => teamOf.get(id), caps: new TeamCaps({}),
    worktrees: { exists: async () => true } as never,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
    now: () => T0,
  })
  catalogs = new Map([
    [TEAM.teamId, catalogOf(group('devs', 'profiles: { glm: 2, opus: 1 }'), group('leads', 'profiles: [sonnet]'))],
    [OTHER.teamId, catalogOf(group('ops', 'profiles: [glm]'))],
  ])
  addRecord('lead', { groupId: 'leads', claudeProfileId: 'sonnet', projectPath: '/repo' })
})
afterEach(() => db.close())

describe('team_capacity groups (3.3)', () => {
  test('no arguments lists every group of the caller\'s team with each worker\'s provider, cap, and live count', () => {
    addRecord('dev-1')
    const answer = capacity().read('lead')
    expect(answer.computedAt).toBe(new Date(T0).toISOString())
    expect(answer.groups.map(entry => entry.id)).toEqual(['devs', 'leads'])
    expect(answer.groups[0]).toEqual({
      id: 'devs', max: 3, live: 1, strategy: 'first-available',
      workers: [
        { model: 'glm', provider: 'zai', cap: 2, live: 1, cooldownUntil: null },
        { model: 'opus', provider: 'claude', cap: 1, live: 0, cooldownUntil: null },
      ],
    })
    expect(answer.groups[1]!.workers).toEqual([{ model: 'sonnet', provider: 'claude', cap: null, live: 1, cooldownUntil: null }])
    expect(answer.providers.map(provider => provider.id)).toEqual(['zai', 'claude'])
  })

  test('a group argument lists only that group and its providers', () => {
    const answer = capacity().read('lead', { group: 'leads' })
    expect(answer.groups.map(entry => entry.id)).toEqual(['leads'])
    expect(answer.providers.map(provider => provider.id)).toEqual(['claude'])
  })

  test('an unknown group is refused naming it, and another team\'s group is unknown to the caller', () => {
    expect(() => capacity().read('lead', { group: 'nobody' })).toThrow('Unknown group "nobody" in your team.')
    expect(() => capacity().read('lead', { group: 'ops' })).toThrow('Unknown group "ops" in your team.')
    expect(() => capacity().read('stranger')).toThrow('belongs to no team')
  })

  test('archived members, other groups, and other teams never count', () => {
    addRecord('dev-1')
    addRecord('gone', { archivedAt: new Date(T0).toISOString() })
    addRecord('foreign', {}, OTHER)
    addRecord('lead-2', { groupId: 'leads', claudeProfileId: 'glm' })
    const devs = capacity().read('lead', { group: 'devs' }).groups[0]!
    expect(devs.live).toBe(1)
    expect(devs.workers.find(worker => worker.model === 'glm')!.live).toBe(1)
  })
})

describe('team_capacity live counts equal routing\'s (I2)', () => {
  test('routing counting two live members on a worker capped at two reports 2 of 2', () => {
    addRecord('dev-1')
    reserve('devs', 'glm')
    const glm = capacity().read('lead').groups[0]!.workers[0]!
    expect([glm.live, glm.cap]).toEqual([2, 2])
  })

  test('with a busy member and a pending spawn, the counts equal buildCandidates\' and the router\'s rule context', async () => {
    addRecord('dev-busy', { status: 'working' })
    addRecord('dev-idle', { claudeProfileId: 'opus' })
    reserve('devs', 'glm')
    reserve('leads', 'sonnet')
    const answer = capacity().read('lead', { group: 'devs' }).groups[0]!
    const def = catalogs.get(TEAM.teamId)!.groups.get('devs')!.group
    const members = liveGroupMembers(records.values(), id => teamOf.get(id)?.teamId, TEAM.teamId, 'devs')
    const counted = buildCandidates({
      group: def, members: members.map(member => ({ ...member, eligible: member.sessionId === 'dev-idle' })),
      pendingSpawnProfiles: ['glm'], spawnAllowed: true, spawnCwd: '/repo/.worktrees/a', providerOf,
    }).group
    const shape = (entry: RouteGroup) => ({ live: entry.live, max: entry.max, workers: entry.profiles.map(worker => [worker.profileId, worker.live, worker.cap ?? null]) })
    const reported = { live: answer.live, max: answer.max, workers: answer.workers.map(worker => [worker.model, worker.live, worker.cap]) }
    expect(reported).toEqual(shape(counted))
    expect(reported).toEqual({ live: 3, max: 3, workers: [['glm', 2, 2], ['opus', 1, 1]] })

    // The router's own pass over the same records and staffing: its rule sees these counts.
    let seen: RouteGroup | null = null
    const router = new ProfileRouter({
      groupOf: async () => def,
      members: (teamId, groupId) => liveGroupMembers(records.values(), id => teamOf.get(id)?.teamId, teamId, groupId),
      targetWorktree: () => '/repo/.worktrees/a',
      staffing,
      rules: { rule: () => ({ route: async (ctx: RouteContext) => { seen = ctx.group; return { type: 'default' } } }) as never },
      limits, providerOf, usageOf: () => null, providerUsageOf: () => null, now: () => T0,
    })
    const message = mail.enqueue({
      teamId: TEAM.teamId, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo',
      body: 'Build', taskId: 'task-1',
    }) as TeamMessage
    await router.route(message, { attempt: 0, eligible: [{ sessionId: 'dev-idle', idleForMs: 5 }] } as never)
    expect(seen).not.toBeNull()
    expect(reported).toEqual(shape(seen!))
  })
})

describe('team_capacity usage and cooldowns', () => {
  test('a provider kawai holds no report for reads usage null, never zero, with its cooldown still reported', () => {
    limits.record({
      profileId: 'glm', sessionId: 'dev-1', groupId: 'devs', kind: 'rate_limit', final: true, status: 429, message: 'quota',
      resetsAt: new Date(T0 + 3_600_000).toISOString(), providerId: 'zai', window: 'five_hour',
    })
    const zai = capacity().read('lead').providers.find(provider => provider.id === 'zai')!
    expect(zai.usage).toBeNull()
    expect(zai.cooldownUntil).toBe(new Date(T0 + 3_600_000).toISOString())
  })

  test('a held report shows each window\'s percent used and reset, status, received time, and source', () => {
    usage.set('claude', {
      status: 'warning', receivedAt: '2026-10-22T02:59:00.000Z', source: 'push',
      windows: [{ key: 'five_hour', label: '5-hour', percentUsed: 81, resetsAt: '2026-10-22T05:00:00.000Z' }],
    } as ChatUsageReport)
    const claude = capacity().read('lead').providers.find(provider => provider.id === 'claude')!
    expect(claude.usage).toEqual({
      status: 'warning', receivedAt: '2026-10-22T02:59:00.000Z', source: 'push',
      windows: [{ key: 'five_hour', percentUsed: 81, resetsAt: '2026-10-22T05:00:00.000Z' }],
    })
    expect(claude.label).toBeNull()
    expect(claude.sharesLoginWith).toEqual([])
  })

  test('a cooling provider names its end on the provider and on each worker, taken from cooldownFor', () => {
    const end = new Date(T0 + 2 * 3_600_000).toISOString()
    limits.record({
      profileId: 'glm', sessionId: 'dev-1', groupId: 'devs', kind: 'rate_limit', final: true, status: 429, message: 'quota',
      resetsAt: end, providerId: 'zai', window: 'five_hour',
    })
    const answer = capacity().read('lead')
    const glm = answer.groups[0]!.workers.find(worker => worker.model === 'glm')!
    expect(glm.cooldownUntil).toBe(limits.cooldownFor('glm', 'zai').until)
    expect(glm.cooldownUntil).toBe(end)
    expect(answer.providers.find(provider => provider.id === 'zai')!.cooldownUntil).toBe(end)
    expect(answer.groups[0]!.workers.find(worker => worker.model === 'opus')!.cooldownUntil).toBeNull()
  })

  test('an out-of-credit limit marks its workers credit, with the hour-capped end from cooldownFor; other workers carry no flag', () => {
    limits.record({
      profileId: 'glm', sessionId: 'dev-1', groupId: 'devs', kind: 'unknown', final: true, status: 402,
      message: 'API Error: 402 This request requires more credits', resetsAt: null, providerId: 'zai', window: 'credit',
    })
    const workers = capacity().read('lead').groups[0]!.workers
    const glm = workers.find(worker => worker.model === 'glm')!
    expect(limits.cooldownFor('glm', 'zai').credit).toBe(true)
    expect(glm).toEqual({ model: 'glm', provider: 'zai', cap: 2, live: 0, cooldownUntil: new Date(T0 + 3_600_000).toISOString(), credit: true })
    expect(workers.find(worker => worker.model === 'opus')).not.toHaveProperty('credit')
  })

  test('a model-scoped window cools only its worker, not the provider', () => {
    limits.record({
      profileId: 'opus', sessionId: 'dev-1', groupId: 'devs', kind: 'rate_limit', final: true, status: 429, message: 'quota',
      resetsAt: new Date(T0 + 3_600_000).toISOString(), providerId: 'claude', window: 'seven_day_opus',
    })
    const answer = capacity().read('lead')
    expect(answer.groups[0]!.workers.find(worker => worker.model === 'opus')!.cooldownUntil).not.toBeNull()
    expect(answer.providers.find(provider => provider.id === 'claude')!.cooldownUntil).toBeNull()
  })
})

describe('team_capacity reads only (I1) and its tool', () => {
  test('a read writes nothing to the database and leaves queued mail queued', () => {
    addRecord('dev-1')
    reserve('devs', 'glm')
    const queued = mail.enqueue({
      teamId: TEAM.teamId, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo', body: 'x', taskId: 't',
    })
    const changes = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    capacity().read('lead')
    capacity().read('lead', { group: 'devs' })
    expect((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(changes)
    expect(mail.get(queued.id)?.state).toBe('queued')
  })

  test('the handler binds the caller and strips any team argument', async () => {
    const tool = capacityHandlers(capacity(), 'lead')
    const answer = await tool.team_capacity({ group: 'devs', team_id: OTHER.teamId, teamId: OTHER.teamId })
    expect(answer.groups.map(entry => entry.id)).toEqual(['devs'])
    await expect(tool.team_capacity({ group: 'ops' })).rejects.toThrow('Unknown group "ops"')
  })

  test('the description states unknown usage and that an empty sharesLoginWith means not detected', () => {
    expect(capacityDescriptions.team_capacity).toContain('usage null means kawai holds no report')
    expect(capacityDescriptions.team_capacity).toContain('an empty list means sharing was not detected')
  })

  test('team_capacity is allowed without cards and registered in the one team tool table when capacity is wired', () => {
    expect(CAPACITY_TOOL_NAMES).toEqual(['team_capacity'])
    expect(TEAM_ALLOWED_TOOLS).toContain('mcp__kawai-team__team_capacity')
    const mailbox = {} as TeamMailbox
    expect(teamToolTable(mailbox, 'lead').map(tool => tool.name)).not.toContain('team_capacity')
    const table = teamToolTable(mailbox, 'lead', { capacity: capacity() })
    const spec = table.find(tool => tool.name === 'team_capacity')!
    expect(spec.description).toBe(capacityDescriptions.team_capacity)
    expect(spec.schema.safeParse({ group: '' }).success).toBe(false)
  })
})

describe('team_capacity sharesLoginWith (3.3a)', () => {
  beforeEach(() => {
    PROVIDERS['first-opus'] = 'first'
    catalogs.set(TEAM.teamId, catalogOf(
      group('devs', 'profiles: { glm: 2, opus: 1 }'), group('leads', 'profiles: [sonnet]'), group('solo', 'profiles: [first-opus]'),
    ))
  })
  afterEach(() => { delete PROVIDERS['first-opus'] })

  test('providers whose workers all key on one login name each other', () => {
    for (const id of ['opus', 'sonnet', 'first-opus']) loginKeys.set(id, '/home/example/.claude')
    const providers = capacity().read('lead').providers
    expect(providers.find(provider => provider.id === 'claude')!.sharesLoginWith).toEqual(['first'])
    expect(providers.find(provider => provider.id === 'first')!.sharesLoginWith).toEqual(['claude'])
    expect(providers.find(provider => provider.id === 'zai')!.sharesLoginWith).toEqual([])
  })

  test('a provider with one stored-login worker and one without is never marked', () => {
    loginKeys.set('opus', '/home/example/.claude')
    loginKeys.set('first-opus', '/home/example/.claude')
    const providers = capacity().read('lead').providers
    expect(providers.find(provider => provider.id === 'claude')!.sharesLoginWith).toEqual([])
    expect(providers.find(provider => provider.id === 'first')!.sharesLoginWith).toEqual([])
  })

  test('a filtered answer gives a provider the same sharesLoginWith as the whole, naming providers it does not list', () => {
    for (const id of ['opus', 'sonnet', 'first-opus']) loginKeys.set(id, '/home/example/.claude')
    const whole = capacity().read('lead').providers.find(provider => provider.id === 'claude')!
    const filtered = capacity().read('lead', { group: 'leads' })
    expect(filtered.providers.map(provider => provider.id)).toEqual(['claude'])
    expect(filtered.providers[0]!.sharesLoginWith).toEqual(whole.sharesLoginWith)
    expect(filtered.providers[0]!.sharesLoginWith).toEqual(['first'])
  })

  test('the answer carries no login key, env value, credential, config dir, or base URL (I5)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-capacity-i5-'))
    try {
      fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
      fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
        first: { label: 'First', models: { 'first-opus': { model: 'opus' } } },
        keyed: { label: 'Keyed', authTokenEnv: 'EXAMPLE_KEYED_TOKEN', env: { ANTHROPIC_BASE_URL: 'https://keyed.example.internal/api' }, models: { 'keyed-opus': { model: 'opus' } } },
        proxied: { label: 'Proxied', env: { ANTHROPIC_BASE_URL: 'https://proxy.example.internal/anthropic' }, models: { 'proxied-opus': { model: 'opus' } } },
      }))
      fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), '{}')
      const token = ['example-', 'keyed-', 'secret'].join('')
      const apiKey = ['sk-ant-', 'example-', 'secret'].join('')
      const configDir = path.join(home, 'custom-claude-dir')
      const values = [token, apiKey, configDir, 'keyed.example.internal', 'proxy.example.internal', home]
      Object.assign(PROVIDERS, { 'keyed-opus': 'keyed', 'proxied-opus': 'proxied' })
      catalogs.set(TEAM.teamId, catalogOf(group('mixed', 'profiles: [first-opus, keyed-opus, proxied-opus]')))
      for (const withApiKey of [false, true]) {
        const env = {
          HOME: home, CLAUDE_CONFIG_DIR: configDir, EXAMPLE_KEYED_TOKEN: token,
          ANTHROPIC_API_KEY: withApiKey ? apiKey : undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined,
        } as unknown as Record<string, string>
        const reader = new TeamCapacity({
          teams: { teamOf: id => teamOf.get(id), catalogOf: () => catalogs.get(TEAM.teamId) },
          records: () => records.values(), pendingSpawns: teamId => staffing.pendingFor(teamId), limits, providerOf,
          providerLabel: () => null, providerUsageOf: () => null, now: () => T0,
          loginKeyOf: profileId => storedLoginKey(resolveClaudeProfile(profileId, env, { homeDir: home }), env),
        })
        const text = JSON.stringify(reader.read('lead'))
        for (const value of values) expect(text.includes(value)).toBe(false)
        // The stored-login worker was keyed (on the custom dir) only without the API key.
        expect(storedLoginKey(resolveClaudeProfile('first-opus', env, { homeDir: home }), env)).toBe(withApiKey ? null : configDir)
      }
    } finally {
      for (const id of ['keyed-opus', 'proxied-opus']) delete PROVIDERS[id]
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
