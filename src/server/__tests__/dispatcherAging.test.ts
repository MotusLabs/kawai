// Group-mail aging (group-mail-task-affinity D4, task 5.1): rows G1–G6 of
// design.md's group-aging table through the production composition (hazard
// M1) — the real mailbox and task stores, the dispatcher with the task-owner
// resolver, and the profile router over a lead group with `affinity:
// task-owner`. Each row has one idle member with a direct message waiting
// beside one group message; the row states which is delivered first.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { GROUP_AGING_MS, MailDispatcher, type MailRecipient } from '../team/dispatcher'
import { MailboxStore, type EnqueueInput, type TeamMessage } from '../team/mailboxStore'
import { ProfileRouter } from '../team/routing/router'
import { taskOwnerResolver } from '../team/taskOwnerResolver'
import { TaskStore } from '../team/taskStore'
import { loadTeamGroups } from '../team/teamGroups'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'

const MIN = 60_000

let root: string
let repo: string
let team: TeamIdentity

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-dispatcher-aging-')))
  repo = path.join(root, 'repo')
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanGitEnv() })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  }
  fs.mkdirSync(repo)
  git(['init', '-q'])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'])
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'lead.md'), '---\naffinity: task-owner\naffinityWait: 30\n---\nLead.')
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let dir: string
let db: SessionDatabase
let store: MailboxStore
let tasks: TaskStore
let records: Map<string, ChatSessionRecord>
let recipients: MailRecipient[]
let delivered: string[]
let clock: number
let dispatcher: MailDispatcher

const record = (sessionId: string): ChatSessionRecord => ({
  sessionId, name: sessionId, projectPath: repo, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '', groupId: 'lead',
})
const lead = (sessionId: string, idle: boolean): MailRecipient => ({
  sessionId, teamId: team.teamId, groupId: 'lead', idle, pendingRequest: false, available: true, worktree: repo,
})
const iso = (ms: number) => new Date(ms).toISOString()
/** A message created `ageMin` minutes ago (`deliverAt` optional, also minutes ago). */
const enqueue = (input: Partial<EnqueueInput>, ageMin: number) => store.enqueue({
  teamId: team.teamId, toKind: 'group', toId: 'lead', fromSession: 'dev', fromGroup: 'devs', originPath: repo, body: 'b', ...input,
}, iso(clock - ageMin * MIN))
const run = async () => { dispatcher.notify(); await dispatcher.settled() }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(root, 'case-'))
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  store = new MailboxStore(db.db)
  tasks = new TaskStore(db.db, store)
  records = new Map([['a', record('a')], ['b', record('b')]])
  recipients = []
  delivered = []
  // The wall clock: `dueGroupMail` compares `deliver_at` with it.
  clock = Date.now()
  const router = new ProfileRouter({
    groupOf: async message => (await loadTeamGroups(repo, path.join(dir, 'home'))).catalog.groups.get(message.toId ?? '')?.group,
    members: (_teamId, groupId) => [...records.values()].filter(row => row.groupId === groupId && recipients.some(entry => entry.sessionId === row.sessionId))
      .map(row => ({ sessionId: row.sessionId, profileId: 'default', cwd: repo })),
    targetWorktree: () => null,
    staffing: { spawnContext: async () => null, spawnFor: async () => null },
    rules: { rule: () => undefined },
    limits: {
      forProfile: () => [], forProvider: () => [], providerCooldownUntil: () => null,
      cooldownFor: (_id, providerId) => ({ until: null, provider: false, providerId: providerId ?? null }),
    },
    usageOf: () => null, providerUsageOf: () => null,
    now: () => clock,
  })
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients,
    prepare: async () => {}, interrupt: async id => { recipients.find(row => row.sessionId === id)!.idle = true },
    deliver: (id, peer) => { delivered.push(peer.messageId); recipients.find(row => row.sessionId === id)!.idle = false },
    watchReceipt: () => {},
    router,
    taskOwner: taskOwnerResolver({ tasks, getRecord: id => records.get(id), teamOf: id => (records.has(id) ? team.teamId : undefined) }),
    now: () => clock,
  })
})
afterEach(() => { dispatcher.close(); db.close() })

interface Row {
  id: string
  /** The group message: its priority, age in minutes, and an optional scheduled due time (minutes ago). */
  group: { priority: 'normal' | 'urgent'; ageMin: number; dueMin?: number }
  /** The direct message's priority. */
  direct: 'normal' | 'urgent'
  /** `a` idle (and `b` busy) unless the row names the owner state. */
  owner?: 'busy-a, idle b' | 'idle a'
  /** Which message the idle member gets first. */
  first: 'direct' | 'group'
}

// design.md's group-aging table, verbatim; G1b is G1 for a scheduled message
// created long ago but due only 5 minutes ago.
const ROWS: Row[] = [
  { id: 'G1', group: { priority: 'normal', ageMin: 5 }, direct: 'normal', first: 'direct' },
  { id: 'G1b', group: { priority: 'normal', ageMin: 60, dueMin: 5 }, direct: 'normal', first: 'direct' },
  { id: 'G2', group: { priority: 'normal', ageMin: 15 }, direct: 'normal', first: 'group' },
  { id: 'G3', group: { priority: 'normal', ageMin: 60 }, direct: 'urgent', first: 'direct' },
  { id: 'G4', group: { priority: 'urgent', ageMin: 0 }, direct: 'normal', first: 'group' },
  { id: 'G5', group: { priority: 'normal', ageMin: 20 }, direct: 'normal', owner: 'busy-a, idle b', first: 'direct' },
  { id: 'G6', group: { priority: 'normal', ageMin: 20 }, direct: 'normal', owner: 'idle a', first: 'group' },
]

describe('aged normal group mail is routed before normal direct mail (G1–G6)', () => {
  for (const row of ROWS) {
    // G1, G1b:
    // @covers: agent-mailbox › Delivery order › Direct before group at equal priority
    // G2, G6:
    // @covers: agent-mailbox › Delivery order › Aged group mail before direct mail
    // G3:
    // @covers: agent-mailbox › Delivery order › Urgent direct mail still first
    // G4:
    // @covers: agent-mailbox › Delivery order › Urgent group mail before normal direct mail
    test(`${row.id}: ${row.group.priority} group mail ${row.group.dueMin !== undefined ? `due ${row.group.dueMin} min` : `${row.group.ageMin} min old`}, ${row.direct} direct${row.owner ? `, ${row.owner}` : ''} → ${row.first} first`, async () => {
      // The idle member who would take the group message, and whose direct mail waits.
      const taker = row.owner === 'busy-a, idle b' ? 'b' : 'a'
      recipients = row.owner === 'busy-a, idle b' ? [lead('a', false), lead('b', true)] : [lead('a', true)]
      if (row.owner === 'idle a') recipients.push(lead('b', true))
      const task = row.owner ? tasks.create({ teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'agent', sessionId: 'a' } }).id : null
      const group = enqueue({
        priority: row.group.priority, ...(task ? { affinityTask: task } : {}),
        ...(row.group.dueMin !== undefined ? { deliverAt: iso(clock - row.group.dueMin * MIN) } : {}),
      }, row.group.ageMin)
      const direct = enqueue({ toKind: 'session', toId: taker, priority: row.direct }, 1)
      await run()
      const groupTo = (message: TeamMessage) => store.get(message.id)?.claimedBy ?? null
      if (row.first === 'group') {
        expect(delivered[0]).toBe(group.id)
        expect(groupTo(group)).toBe(taker)
        expect(store.get(direct.id)?.state).toBe('queued')
      } else {
        expect(delivered[0]).toBe(direct.id)
        expect(store.get(group.id)?.state).toBe('queued')
      }
      // G5: the owner hold still applies to the aged message.
      if (row.id === 'G5') expect(groupTo(group)).toBeNull()
    })
  }

  test('the threshold is 15 minutes from the due time, inclusive', async () => {
    expect(GROUP_AGING_MS).toBe(15 * MIN)
    recipients = [lead('a', true)]
    const justUnder = enqueue({ deliverAt: iso(clock - GROUP_AGING_MS + 1) }, 60)
    enqueue({ toKind: 'session', toId: 'a' }, 1)
    await run()
    expect(store.get(justUnder.id)?.state).toBe('queued')
  })
})
