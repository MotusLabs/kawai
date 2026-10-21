// The worker choice through the production composition of one dispatch pass
// (dispatch-worker-choice D2/D3, task 2.2): the real mailbox store,
// dispatcher, profile router, and worktree staffing over a git worktree. The
// chosen provider's member is picked over a longer-idle one elsewhere, and a
// capped chosen worker waits instead of spawning on another worker.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { MailDispatcher, type MailRecipient } from '../team/dispatcher'
import { MailboxStore } from '../team/mailboxStore'
import { ProfileRouter } from '../team/routing/router'
import { WorktreeStaffing, type SpawnRequest } from '../team/staffing'
import { TaskStore } from '../team/taskStore'
import { TeamCaps } from '../team/teamCaps'
import { loadTeamGroups } from '../team/teamGroups'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { TeamWorktrees, worktreeRootOf } from '../team/worktreeRoots'
import type { WaitingConstraint } from '../../shared/team'

const PROVIDERS: Record<string, string> = { sonnet: 'anthropic', glm: 'zai', 'glm-flash': 'zai' }
const providerOf = (profileId: string) => PROVIDERS[profileId] ?? profileId

function git(args: string[], cwd?: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

let root: string
let repo: string
let featX: string
let team: TeamIdentity

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-worker-choice-')))
  repo = path.join(root, 'repo')
  featX = path.join(root, 'feat-x')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-x', featX], repo)
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let dir: string
let home: string
let db: SessionDatabase
let store: MailboxStore
let tasks: TaskStore
let records: Map<string, ChatSessionRecord>
let recipients: MailRecipient[]
let delivered: Array<{ to: string; id: string }>
let spawned: SpawnRequest[]
let reasons: Map<string, WaitingConstraint[]>
let clock: number
/** Cooldown end per profile (epoch ms), read against the clock. */
let cooling: Record<string, number>
let dispatcher: MailDispatcher

const writeGroup = (frontmatter: string) => {
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), `---\n${frontmatter}\n---\nWork.`)
}
const record = (sessionId: string, profileId: string, extra: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId, name: sessionId, projectPath: featX, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  groupId: 'devs', claudeProfileId: profileId, ...extra,
})
const recipient = (sessionId: string, profileId: string, idle = true): MailRecipient => ({
  sessionId, teamId: team.teamId, groupId: 'devs', idle, pendingRequest: false, available: true,
  worktree: worktreeRootOf(featX), profileId,
})
const cooldownUntil = (profileId: string) =>
  (cooling[profileId] ?? 0) > clock ? new Date(cooling[profileId]!).toISOString() : null
const run = async () => { dispatcher.notify(); await dispatcher.settled() }
const mail = (workerChoice?: string) => store.enqueue({
  teamId: team.teamId, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: repo, body: 'work',
  taskId: tasks.create({ teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'human', sessionId: null }, worktree: featX }).id,
  ...(workerChoice ? { workerChoice } : {}),
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(root, 'case-'))
  home = path.join(dir, 'home')
  fs.rmSync(path.join(repo, '.kawai'), { recursive: true, force: true })
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  store = new MailboxStore(db.db)
  tasks = new TaskStore(db.db, store)
  records = new Map()
  recipients = []
  delivered = []
  spawned = []
  reasons = new Map()
  clock = 1_000_000
  cooling = {}
  const staffing = new WorktreeStaffing(db.db, store, {
    records: () => records.values(),
    teamOf: () => team,
    caps: new TeamCaps({ homeDir: home }),
    worktrees: new TeamWorktrees({ ttlMs: 0 }),
    now: () => clock,
    spawn: async request => {
      spawned.push(request)
      const sessionId = `spawned-${spawned.length}`
      records.set(sessionId, record(sessionId, request.profileId ?? 'default', { projectPath: request.projectPath, spawned: true }))
      return { ok: true, sessionId }
    },
  })
  const targetWorktree = (message: { taskId: string | null }) => (message.taskId ? tasks.get(message.taskId)?.worktree ?? null : null)
  const router = new ProfileRouter({
    groupOf: async message => (await loadTeamGroups(repo, home)).catalog.groups.get(message.toId ?? '')?.group,
    members: (_teamId, groupId) => [...records.values()]
      .filter(row => row.archivedAt == null && row.groupId === groupId)
      .map(row => ({ sessionId: row.sessionId, profileId: row.claudeProfileId ?? 'default', cwd: row.projectPath })),
    targetWorktree, staffing, rules: { rule: () => undefined },
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
    deliver: (id, peer) => { delivered.push({ to: id, id: peer.messageId }); recipients.find(row => row.sessionId === id)!.idle = false },
    watchReceipt: () => {},
    targetWorktree, router,
    afterPass: outcome => { for (const [id, constraints] of outcome.reasons) reasons.set(id, constraints) },
    now: () => clock,
  })
})
afterEach(() => { dispatcher.close(); db.close() })

describe('the dispatcher pass routes inside the worker choice (2.2)', () => {
  test('the chosen provider\'s member is picked over a longer-idle member elsewhere', async () => {
    writeGroup('profiles: [sonnet, glm]\nmax: 4')
    records.set('long', record('long', 'sonnet'))
    records.set('zai', record('zai', 'glm'))
    recipients.push(recipient('long', 'sonnet'))
    await run()
    clock += 60_000
    recipients.push(recipient('zai', 'glm'))
    const chosen = mail('zai')
    await run()
    expect(delivered).toEqual([{ to: 'zai', id: chosen.id }])
    // Without a choice, the longest-idle member takes the next one.
    const plain = mail()
    await run()
    expect(delivered).toEqual([{ to: 'zai', id: chosen.id }, { to: 'long', id: plain.id }])
  })

  test('a capped chosen worker waits instead of spawning on another worker', async () => {
    writeGroup('profiles: { glm: 1, sonnet: 1 }\nmax: 3')
    records.set('busy-glm', record('busy-glm', 'glm', { status: 'working' }))
    recipients.push(recipient('busy-glm', 'glm', false))
    const chosen = mail('zai/glm')
    await run()
    expect(spawned).toEqual([])
    expect(delivered).toEqual([])
    expect(store.get(chosen.id)).toMatchObject({ state: 'queued', claimedBy: null })
    expect(reasons.get(chosen.id)?.map(entry => entry.kind)).toContain('profile-cap')
    // The same mail with no choice spawns on the free worker.
    const plain = mail()
    await run()
    expect(spawned).toEqual([expect.objectContaining({ groupId: 'devs', profileId: 'sonnet', taskId: plain.taskId })])
    expect(store.get(chosen.id)).toMatchObject({ state: 'queued' })
  })
})
