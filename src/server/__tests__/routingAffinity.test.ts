// Owner affinity through the production composition (group-mail-task-affinity
// D1/D3, task 3.2; hazard M1): the real mailbox and task stores, the
// dispatcher with the production task-owner resolver, and the profile router
// over a lead group with `affinity: task-owner`. Rows B1–B10 of design.md's
// routing table, the route half of R1–R7, a real rule loaded through the rule
// registry (B8, B9), and property P3 (the router's hold or pick agrees with
// `ownerAffinity`, on unscheduled and scheduled rows).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { MailDispatcher, type MailRecipient, type RouteView } from '../team/dispatcher'
import { parseGroupFile } from '../team/groupFile'
import { MailboxStore, type TeamMessage } from '../team/mailboxStore'
import { builtinPick } from '../team/routing/builtin'
import { RuleRegistry } from '../team/routing/ruleLoader'
import { ProfileRouter, type ProfileRouterOptions } from '../team/routing/router'
import { ownerAffinity, type MemberExclusionKind } from '../team/routing/workerEligibility'
import { taskOwnerResolver } from '../team/taskOwnerResolver'
import { TaskStore } from '../team/taskStore'
import { loadTeamGroups } from '../team/teamGroups'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import type { WaitingConstraint } from '../../shared/team'

const MIN = 60_000
const CREATED = Date.parse('2026-01-05T10:00:00.000Z')
const PROVIDERS: Record<string, string> = { opus: 'anthropic', glm: 'zai' }
const providerOf = (profileId: string) => PROVIDERS[profileId] ?? profileId

let root: string
let repo: string
let home: string
let team: TeamIdentity
let registry: RuleRegistry

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-routing-affinity-')))
  repo = path.join(root, 'repo')
  home = path.join(root, 'home')
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanGitEnv() })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  }
  fs.mkdirSync(repo)
  git(['init', '-q'])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'])
  clearTeamCache()
  team = await resolveTeam(repo)
  // A10/A11: one real rule, loaded through the registry. It holds naming the
  // owner when the message is tagged `hold`, picks `b` when tagged `pick-b`,
  // and otherwise defers to the built-in strategy.
  fs.mkdirSync(path.join(home, '.kawai', 'routing'), { recursive: true })
  fs.writeFileSync(path.join(home, '.kawai', 'routing', 'lead.ts'), `export default {
  route(ctx) {
    if (ctx.message.tags.includes('hold')) return { type: 'hold', reason: 'owner ' + (ctx.message.taskOwner ?? 'none') }
    const b = ctx.candidates.find(c => c.sessionId === 'b')
    if (ctx.message.tags.includes('pick-b') && b) return { type: 'pick', candidateId: b.id }
    return { type: 'default' }
  },
}
`)
  registry = new RuleRegistry({ homeDir: home, env: {} })
  const report = await registry.reload()
  expect(report.rules).toMatchObject([{ groupId: 'lead', ok: true }])
})
afterAll(() => { registry.close(); fs.rmSync(root, { recursive: true, force: true }) })

let dir: string
let db: SessionDatabase
let store: MailboxStore
let tasks: TaskStore
let records: Map<string, ChatSessionRecord>
let recipients: MailRecipient[]
let delivered: Array<{ to: string; id: string }>
let reasons: Map<string, WaitingConstraint[]>
let clock: number
let cooling: Record<string, number>
let withRule: boolean
let dispatcher: MailDispatcher

const writeLead = (frontmatter = '') => {
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'lead.md'),
    `---\ncanCreateTasks: true\nprofiles: [opus, glm]\naffinity: task-owner\naffinityWait: 30\n${frontmatter}\n---\nLead.`)
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), '---\n---\nBuild.')
}
const record = (sessionId: string, groupId: string, profileId: string, extra: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId, name: sessionId, projectPath: repo, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  groupId, claudeProfileId: profileId, ...extra,
})
const lead = (sessionId: string, profileId = 'opus', over: Partial<MailRecipient> = {}): MailRecipient => ({
  sessionId, teamId: team.teamId, groupId: 'lead', idle: true, pendingRequest: false, available: true, worktree: repo, profileId, ...over,
})
const cooldownUntil = (profileId: string) => ((cooling[profileId] ?? 0) > clock ? new Date(cooling[profileId]!).toISOString() : null)
const run = async () => { dispatcher.notify(); await dispatcher.settled() }
const at = (minutes: number) => { clock = CREATED + minutes * MIN }
const set = (sessionId: string, over: Partial<MailRecipient>) => Object.assign(recipients.find(row => row.sessionId === sessionId)!, over)
const leadTask = (owner = 'a') => tasks.create({ teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'agent', sessionId: owner } }).id
const mail = (affinityTask: string | null, extra: { tags?: string[]; workerChoice?: string; deliverAt?: string } = {}) => store.enqueue({
  teamId: team.teamId, toKind: 'group', toId: 'lead', fromSession: 'dev', fromGroup: 'devs', originPath: repo, body: 'report',
  ...(affinityTask ? { affinityTask } : {}), ...extra,
}, new Date(CREATED).toISOString())
const deliveredTo = (message: TeamMessage) => delivered.find(entry => entry.id === message.id)?.to ?? null

/** `b` idle since minute -10, `a` since minute -1 (both idle at the send). */
async function bothIdle(aProfile = 'opus', bProfile = 'opus') {
  recipients = [lead('b', bProfile)]
  at(-10); await run()
  recipients.push(lead('a', aProfile))
  records.set('a', record('a', 'lead', aProfile))
  records.set('b', record('b', 'lead', bProfile))
  at(-1); await run()
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(root, 'case-'))
  writeLead()
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  store = new MailboxStore(db.db)
  tasks = new TaskStore(db.db, store)
  records = new Map([['dev', record('dev', 'devs', 'glm')]])
  recipients = []
  delivered = []
  reasons = new Map()
  cooling = {}
  withRule = false
  at(0)
  const router = new ProfileRouter({
    groupOf: async message => (await loadTeamGroups(repo, path.join(dir, 'home'))).catalog.groups.get(message.toId ?? '')?.group,
    members: (_teamId, groupId) => [...records.values()]
      .filter(row => row.archivedAt == null && row.groupId === groupId)
      .map(row => ({ sessionId: row.sessionId, profileId: row.claudeProfileId ?? 'default', cwd: row.projectPath })),
    targetWorktree: () => null,
    staffing: { spawnContext: async () => null, spawnFor: async () => null },
    rules: { rule: id => (withRule ? registry.rule(id) : undefined) },
    limits: {
      forProfile: () => [], forProvider: () => [], providerCooldownUntil: () => null,
      cooldownFor: (id, providerId) => ({ until: cooldownUntil(id), provider: false, providerId: providerId ?? null }),
    },
    providerOf, usageOf: () => null, providerUsageOf: () => null,
    now: () => clock,
  })
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients.map(row => ({ ...row, cooldownUntil: cooldownUntil(row.profileId ?? 'default') })),
    prepare: async () => {}, interrupt: async () => {},
    deliver: (id, peer) => { delivered.push({ to: id, id: peer.messageId }); set(id, { idle: false }) },
    watchReceipt: () => {},
    router,
    taskOwner: taskOwnerResolver({ tasks, getRecord: id => records.get(id), teamOf: id => (records.has(id) ? team.teamId : undefined) }),
    afterPass: outcome => { for (const [id, constraints] of outcome.reasons) reasons.set(id, constraints) },
    now: () => clock,
  })
})
afterEach(() => { dispatcher.close(); db.close() })

describe('owner affinity through the dispatcher and router (B1–B10)', () => {
  test('B1: without an affinity task the longest-idle member takes it', async () => {
    await bothIdle()
    const message = mail(null)
    at(1); await run()
    expect(deliveredTo(message)).toBe('b')
  })

  // @covers: team-routing-rules › Groups may route by task owner › Owner preferred over the longest-idle member
  test('B2 (R1, R2): the idle owner takes it over a member idle longer', async () => {
    await bothIdle()
    const message = mail(leadTask('a'))
    at(1); await run()
    expect(deliveredTo(message)).toBe('a')
  })

  // @covers: team-routing-rules › A busy task owner holds its mail for a bounded wait › Owner busy within the wait
  // @covers: team-routing-rules › A busy task owner holds its mail for a bounded wait › Owner frees up within the wait
  test('B4: a busy owner holds the message with owner-busy until it frees up', async () => {
    await bothIdle()
    set('a', { idle: false })
    const message = mail(leadTask('a'))
    at(10); await run()
    expect(deliveredTo(message)).toBeNull()
    expect(reasons.get(message.id)?.[0]).toEqual({ kind: 'owner-busy', sessionIds: ['a'], retryAt: new Date(CREATED + 30 * MIN).toISOString() })
    set('a', { idle: true })
    at(12); await run()
    expect(deliveredTo(message)).toBe('a')
  })

  test('B4: an owner awaiting a card holds it too', async () => {
    await bothIdle()
    set('a', { pendingRequest: true })
    const message = mail(leadTask('a'))
    at(10); await run()
    expect(deliveredTo(message)).toBeNull()
    expect(reasons.get(message.id)?.map(entry => entry.kind)).toEqual(['owner-busy'])
  })

  // @covers: team-routing-rules › A busy task owner holds its mail for a bounded wait › Wait runs out
  test('B7: at due+wait with the owner still busy, the other member takes it', async () => {
    await bothIdle()
    set('a', { idle: false })
    const message = mail(leadTask('a'))
    at(29); await run()
    expect(deliveredTo(message)).toBeNull()
    at(30); await run()
    expect(deliveredTo(message)).toBe('b')
  })

  // @covers: team-routing-rules › A busy task owner holds its mail for a bounded wait › No other candidate
  test('B6: the wait over and every member busy, it waits as before; the owner takes it once idle', async () => {
    await bothIdle()
    set('a', { idle: false })
    set('b', { idle: false })
    const message = mail(leadTask('a'))
    at(10); await run()
    expect(reasons.get(message.id)?.[0]?.kind).toBe('owner-busy')
    at(31); await run()
    expect(deliveredTo(message)).toBeNull()
    expect(reasons.get(message.id)?.map(entry => entry.kind)).not.toContain('owner-busy')
    expect(reasons.get(message.id)?.map(entry => entry.kind)).toContain('no-eligible-member')
    set('a', { idle: true })
    at(32); await run()
    expect(deliveredTo(message)).toBe('a')
  })

  // @covers: team-routing-rules › A busy task owner holds its mail for a bounded wait › Context-exhausted owner does not hold
  test('B7: a context-exhausted, parked, or unavailable owner gives way at once', async () => {
    for (const over of [{ contextExhausted: true }, { parked: true }, { available: false }] as Array<Partial<MailRecipient>>) {
      await bothIdle()
      set('a', { idle: false, ...over })
      const message = mail(leadTask('a'))
      at(1); await run()
      expect({ over, to: deliveredTo(message), why: reasons.get(message.id) }).toEqual({ over, to: 'b', why: undefined })
    }
  })

  // @covers: team-routing-rules › A busy task owner holds its mail for a bounded wait › Cooling owner does not hold
  test('B7: an owner on a cooling profile, idle or busy, gives way at once', async () => {
    for (const busy of [false, true]) {
      await bothIdle('opus', 'glm')
      cooling = { opus: CREATED + 120 * MIN }
      if (busy) set('a', { idle: false })
      const message = mail(leadTask('a'))
      at(1); await run()
      expect(deliveredTo(message)).toBe('b')
      cooling = {}
    }
  })

  test('B7: an owner outside the worker choice gives way at once', async () => {
    for (const busy of [false, true]) {
      await bothIdle('opus', 'glm')
      if (busy) set('a', { idle: false })
      const message = mail(leadTask('a'), { workerChoice: 'zai' })
      at(1); await run()
      expect(deliveredTo(message)).toBe('b')
    }
  })

  test('B7: an archived owner is no live member, so nothing waits for it', async () => {
    await bothIdle()
    const task = leadTask('a')
    records.set('a', record('a', 'lead', 'opus', { archivedAt: new Date(CREATED).toISOString() }))
    recipients = recipients.filter(row => row.sessionId !== 'a')
    const message = mail(task)
    at(1); await run()
    expect(deliveredTo(message)).toBe('b')
  })

  // @covers: team-routing-rules › Rules see the task owner › Rule overrides the owner
  test('B8: a real rule picking b beats the idle owner and the busy owner hold', async () => {
    withRule = true
    for (const busy of [false, true]) {
      await bothIdle()
      if (busy) set('a', { idle: false })
      const message = mail(leadTask('a'), { tags: ['pick-b'] })
      at(1); await run()
      expect(deliveredTo(message)).toBe('b')
    }
  })

  // @covers: team-routing-rules › Rules see the task owner › Rule reads the owner
  test('B9: a real rule\'s hold wins over the idle owner, and the rule sees the owner', async () => {
    withRule = true
    await bothIdle()
    const message = mail(leadTask('a'), { tags: ['hold'] })
    at(1); await run()
    expect(deliveredTo(message)).toBeNull()
    expect(reasons.get(message.id)).toEqual([{ kind: 'routing-hold', detail: 'owner a' }])
  })

  test('a rule that defers leaves the owner preference and hold to the built-in path', async () => {
    withRule = true
    await bothIdle()
    const preferred = mail(leadTask('a'))
    at(1); await run()
    expect(deliveredTo(preferred)).toBe('a')
    const held = mail(leadTask('a'))
    at(2); await run()
    expect(reasons.get(held.id)?.[0]?.kind).toBe('owner-busy')
  })

  // @covers: team-routing-rules › Groups may route by task owner › Owner preferred under profile order
  test('B3: under profile-order the owner on the second profile beats the first', async () => {
    writeLead('strategy: profile-order')
    await bothIdle('glm', 'opus')
    const message = mail(leadTask('a'))
    at(1); await run()
    expect(deliveredTo(message)).toBe('a')
  })
})

describe('the task owner at route time (R5, R7)', () => {
  // @covers: team-routing-rules › Groups may route by task owner › Owner outside the group
  // @covers: team-routing-rules › Groups may route by task owner › No task owner
  test('R5: a human task, or one a developer owns, has no task owner', async () => {
    const human = tasks.create({ teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'human', sessionId: null } }).id
    const devs = tasks.create({ teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'agent', sessionId: 'dev' } }).id
    for (const task of [human, devs]) {
      await bothIdle()
      set('b', { idle: true })
      const message = mail(task)
      at(1); await run()
      expect(deliveredTo(message)).toBe('b')
    }
  })

  test('R5: a rule sees no task owner for a developer-owned task, and the lead owner otherwise', async () => {
    withRule = true
    await bothIdle()
    const devs = mail(tasks.create({ teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'agent', sessionId: 'dev' } }).id, { tags: ['hold'] })
    const leads = mail(leadTask('a'), { tags: ['hold'] })
    at(1); await run()
    expect(reasons.get(devs.id)).toEqual([{ kind: 'routing-hold', detail: 'owner none' }])
    expect(reasons.get(leads.id)).toEqual([{ kind: 'routing-hold', detail: 'owner a' }])
  })

  test('R5: an owner whose group changed to another no longer counts', async () => {
    await bothIdle()
    const task = leadTask('a')
    records.set('a', record('a', 'devs', 'opus'))
    set('a', { idle: false })
    const message = mail(task)
    at(1); await run()
    expect(deliveredTo(message)).toBe('b')
  })

  // @covers: agent-mailbox › Group mail records its affinity task › Queued mail follows a transfer
  test('R7: mail queued for owner a follows a transfer to b, read on the next pass', async () => {
    await bothIdle()
    set('a', { idle: false })
    set('b', { idle: false })
    const task = leadTask('a')
    const message = mail(task)
    at(5); await run()
    expect(reasons.get(message.id)?.[0]).toMatchObject({ kind: 'owner-busy', sessionIds: ['a'] })
    expect(tasks.setOwner(task, 'a', 'b')).toBe(true)
    at(6); await run()
    expect(reasons.get(message.id)?.[0]).toMatchObject({ kind: 'owner-busy', sessionIds: ['b'] })
    set('a', { idle: true })
    at(7); await run()
    expect(deliveredTo(message)).toBeNull()
    set('b', { idle: true })
    at(8); await run()
    expect(deliveredTo(message)).toBe('b')
  })

  // @covers: team-routing-rules › A busy task owner holds its mail for a bounded wait › Affinity removed while mail waits
  test('B10: removing affinity from the group file releases a held message on the next pass, no restart; the row keeps its affinity task', async () => {
    await bothIdle()
    set('a', { idle: false })
    const task = leadTask('a')
    const message = mail(task)
    at(1); await run()
    expect(deliveredTo(message)).toBeNull()
    expect(reasons.get(message.id)?.[0]?.kind).toBe('owner-busy')
    fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'lead.md'), '---\nprofiles: [opus, glm]\n---\nLead.')
    at(2); await run()
    expect(deliveredTo(message)).toBe('b')
    expect(store.get(message.id)?.affinityTask).toBe(task)
  })

  test('B5: within the wait with no candidate, the hold names owner-busy first and the members\' busy states after it', async () => {
    await bothIdle()
    set('a', { idle: false })
    set('b', { idle: false })
    const message = mail(leadTask('a'))
    at(10); await run()
    expect(deliveredTo(message)).toBeNull()
    const kinds = reasons.get(message.id)?.map(entry => entry.kind) ?? []
    expect(kinds[0]).toBe('owner-busy')
    expect(kinds.slice(1)).toContain('no-eligible-member')
  })

  test('a scheduled message holds until deliver_at + wait, not created_at + wait', async () => {
    await bothIdle()
    set('a', { idle: false })
    // Created at minute 0, due at minute 20: the hold ends at minute 50.
    const message = mail(leadTask('a'), { deliverAt: new Date(CREATED + 20 * MIN).toISOString() })
    at(35); await run()
    expect(deliveredTo(message)).toBeNull()
    expect(reasons.get(message.id)?.[0]).toEqual({ kind: 'owner-busy', sessionIds: ['a'], retryAt: new Date(CREATED + 50 * MIN).toISOString() })
    at(50); await run()
    expect(deliveredTo(message)).toBe('b')
  })
})

/** A seeded generator (mulberry32). */
function rng(seed: number) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6D2B79F5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

describe('P3: the router agrees with ownerAffinity', () => {
  test('seed 1717, 500 random states: hold, prefer, and none match the router', async () => {
    const random = rng(1717)
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!
    const lead = parseGroupFile('lead', '---\nprofiles: [opus, glm]\naffinity: task-owner\naffinityWait: 30\n---\nLead.')
    if (!lead.ok) throw new Error(lead.error)
    const CAUSES: MemberExclusionKind[][] = [[], [], ['busy'], ['pending-card'], ['busy', 'pending-card'], ['parked'], ['context-exhausted'], ['unavailable'], ['busy', 'profile-cooling']]
    let holds = 0
    let prefers = 0
    for (let index = 0; index < 500; index++) {
      const now = CREATED + Math.floor(random() * 45) * MIN
      const ids = ['a', 'b', 'c'].slice(0, 1 + Math.floor(random() * 3))
      const members = ids.map(sessionId => ({ sessionId, profileId: pick(['opus', 'glm']), causes: pick(CAUSES) }))
      const coolingProfile = pick([null, null, 'opus', 'glm'])
      const owner = pick([null, 'a', 'b', 'z'])
      const choice = pick([null, null, 'zai'])
      // A third of the rows are scheduled: created earlier, due at CREATED.
      const scheduled = random() < 1 / 3
      const message = { id: `m${index}`, teamId: 't', toKind: 'group', toId: 'lead', createdAt: new Date(scheduled ? CREATED - 20 * MIN : CREATED).toISOString(), ...(scheduled ? { deliverAt: new Date(CREATED).toISOString() } : {}), tags: [], priority: 'normal', fromGroup: 'devs', taskId: null, ...(choice ? { workerChoice: choice } : {}) } as unknown as TeamMessage
      const options: ProfileRouterOptions = {
        groupOf: async () => lead.group,
        members: () => members.map(member => ({ sessionId: member.sessionId, profileId: member.profileId, cwd: '/r' })),
        targetWorktree: () => null,
        staffing: { spawnContext: async () => null, spawnFor: async () => null },
        rules: { rule: () => undefined },
        limits: {
          forProfile: () => [], forProvider: () => [], providerCooldownUntil: () => null,
          cooldownFor: (id, providerId) => ({ until: id === coolingProfile ? new Date(now + 60 * MIN).toISOString() : null, provider: false, providerId: providerId ?? null }),
        },
        providerOf, usageOf: () => null, providerUsageOf: () => null, now: () => now,
      }
      const view: RouteView = {
        attempt: 0,
        eligible: members.filter(member => member.causes.length === 0).map((member, rank) => ({
          sessionId: member.sessionId, teamId: 't', groupId: 'lead', idle: true, pendingRequest: false, available: true, idleForMs: 1000 * (rank + 1), profileId: member.profileId,
        })),
        exclusions: members.flatMap(member => member.causes.map(kind => ({ sessionId: member.sessionId, kind }))),
        taskOwner: owner,
      }
      const result = await new ProfileRouter(options).route(message, view)
      // The oracle, from the raw state: the owner's member facts, filter, and cooling.
      const ownerMember = members.find(member => member.sessionId === owner) ?? null
      const expected = ownerAffinity({
        owner, member: ownerMember ? { eligible: ownerMember.causes.length === 0, causes: ownerMember.causes } : null,
        filtered: ownerMember !== null && choice === 'zai' && providerOf(ownerMember.profileId) !== 'zai',
        cooling: ownerMember !== null && ownerMember.profileId === coolingProfile,
        dueAt: CREATED, waitMs: 30 * MIN, now,
      })
      const ownerBusy = result.kind === 'hold' && result.diagnosis?.[0]?.kind === 'owner-busy'
      expect({ index, hold: ownerBusy }).toEqual({ index, hold: expected.kind === 'hold' })
      if (expected.kind === 'hold') {
        holds++
        expect(result).toMatchObject({ kind: 'hold', retryAt: expected.until })
      } else if (expected.kind === 'prefer') {
        prefers++
        expect({ index, result }).toEqual({ index, result: { kind: 'member', sessionId: expected.sessionId } })
      } else if (result.kind === 'member') {
        // Without the owner, the built-in strategy's own pick.
        const candidates = view.eligible
          .filter(member => !(choice === 'zai' && providerOf(member.profileId ?? '') !== 'zai'))
          .map(member => ({ id: `member:${member.sessionId}`, kind: 'member' as const, profileId: member.profileId!, providerId: providerOf(member.profileId!), sessionId: member.sessionId, cwd: '/r', idleForMs: member.idleForMs }))
        expect({ index, to: result.sessionId }).toEqual({ index, to: builtinPick('first-available', candidates, ['opus', 'glm'], id => id === coolingProfile)!.sessionId! })
      }
    }
    // Non-vacuity: the generator reaches every branch.
    expect(holds).toBeGreaterThan(20)
    expect(prefers).toBeGreaterThan(20)
  })
})
