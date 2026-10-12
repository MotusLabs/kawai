// Worktree staffing (team-tasks D4/D6): worktree-filtered pickup, the three
// caps with durable reservations, spawn failure and restart reconciliation,
// and dead-lettering mail for a removed worktree — never creating one.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { MailDispatcher, type MailRecipient } from '../team/dispatcher'
import { MailboxStore } from '../team/mailboxStore'
import { WorktreeStaffing, type SpawnRequest, type SpawnResult } from '../team/staffing'
import { TaskStore } from '../team/taskStore'
import { TeamCaps, teamCapsFile } from '../team/teamCaps'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { TeamWorktrees, worktreeRootOf } from '../team/worktreeRoots'

function git(args: string[], cwd?: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

let root: string
let repo: string
let featX: string
let featY: string
let team: TeamIdentity

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-staffing-')))
  repo = path.join(root, 'repo')
  featX = path.join(root, 'feat-x')
  featY = path.join(root, 'feat-y')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-x', featX], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-y', featY], repo)
  fs.mkdirSync(path.join(featX, 'src'), { recursive: true })
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
let idleMembers: Array<{ groupId: string; worktree: string }>
let spawned: SpawnRequest[]
let spawnFails: string | null
let staffing: WorktreeStaffing
let clock: number

const writeGroup = (id: string, frontmatter: string) => {
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', `${id}.md`), `---\n${frontmatter}\n---\nWork.`)
}
const record = (sessionId: string, extra: Partial<ChatSessionRecord>): ChatSessionRecord => ({
  sessionId, name: sessionId, projectPath: repo, sdkSessionId: null, status: 'working', createdAt: '', lastActivityAt: '', groupId: 'devs', ...extra,
})
const makeStaffing = (onError?: (error: unknown) => void) => new WorktreeStaffing(db.db, store, {
  records: () => records.values(),
  teamOf: () => team,
  hasIdleMember: (teamId, groupId, worktree) => teamId === team.teamId && idleMembers.some(row => row.groupId === groupId && row.worktree === worktree),
  caps: new TeamCaps({ homeDir: home }),
  worktrees: new TeamWorktrees({ ttlMs: 0 }),
  ...(onError ? { onError } : {}),
  homeDir: home,
  now: () => clock,
  spawn: async (request): Promise<SpawnResult> => {
    spawned.push(request)
    if (spawnFails) return { ok: false, error: spawnFails }
    const sessionId = `spawned-${spawned.length}`
    records.set(sessionId, record(sessionId, { projectPath: request.projectPath, groupId: request.groupId, spawned: true, taskId: request.taskId, status: 'waiting' }))
    return { ok: true, sessionId }
  },
})
const task = (worktree: string | null) => tasks.create({ teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'human', sessionId: null }, worktree })
const mail = (taskId: string | null, extra: Partial<Parameters<MailboxStore['enqueue']>[0]> = {}) => store.enqueue({
  teamId: team.teamId, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: repo, body: 'work', taskId, ...extra,
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(root, 'case-'))
  home = path.join(dir, 'home')
  fs.rmSync(path.join(repo, '.kawai'), { recursive: true, force: true })
  writeGroup('devs', 'max: 3\nprofile: glm\napproval: auto')
  writeGroup('qa', 'max: 2')
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  store = new MailboxStore(db.db)
  tasks = new TaskStore(db.db, store)
  records = new Map([['lead', record('lead', { groupId: 'leads' })]])
  idleMembers = []
  spawned = []
  spawnFails = null
  clock = 1_000_000
  staffing = makeStaffing()
})
afterEach(() => db.close())

describe('spawning', () => {
  test('an unstaffed worktree gets a member with the group settings and the message reserved for it', async () => {
    const t = task(featX)
    const m = mail(t.id)
    const assignments = await staffing.run()
    expect(spawned).toEqual([{ projectPath: featX, groupId: 'devs', profileId: 'glm', approvalPolicy: 'auto', taskId: t.id }])
    expect(assignments).toEqual([{ message: expect.objectContaining({ id: m.id, state: 'spawning' }), sessionId: 'spawned-1' }])
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM team_spawns').get()).toEqual({ n: 0 })
  })

  test('group defaults: default profile and manual approval', async () => {
    writeGroup('devs', 'max: 1')
    mail(task(featX).id)
    await staffing.run()
    expect(spawned[0]).toEqual({ projectPath: featX, groupId: 'devs', approvalPolicy: 'manual', taskId: expect.any(String) })
  })

  test('an idle member already in the worktree takes the mail: no spawn', async () => {
    idleMembers.push({ groupId: 'devs', worktree: featX })
    mail(task(featX).id)
    expect(await staffing.run()).toEqual([])
    expect(spawned).toEqual([])
  })

  test('mail without a task, or whose task has no worktree, or direct mail is never staffed', async () => {
    mail(null)
    mail(task(null).id)
    mail(task(featX).id, { toKind: 'session', toId: 'lead' })
    expect(await staffing.run()).toEqual([])
    expect(spawned).toEqual([])
  })
})

describe('caps', () => {
  test('group max counts every live member, spawned or not; the message waits', async () => {
    writeGroup('devs', 'max: 2')
    records.set('dev-1', record('dev-1', { projectPath: featY }))
    records.set('dev-2', record('dev-2', { projectPath: repo }))
    const m = mail(task(featX).id)
    expect(await staffing.run()).toEqual([])
    expect(store.get(m.id)?.state).toBe('queued')
    // Archiving a member frees its slot; the next pass spawns.
    records.get('dev-2')!.archivedAt = '2026-10-11'
    expect(await staffing.run()).toHaveLength(1)
  })

  test('one spawned writer per worktree, even busy in a subdirectory, and of another group', async () => {
    records.set('writer', record('writer', { projectPath: path.join(featX, 'src'), spawned: true, groupId: 'qa' }))
    const m = mail(task(featX).id)
    expect(await staffing.run()).toEqual([])
    expect(store.get(m.id)?.state).toBe('queued')
    // A manually created (not spawned) member in the worktree does not hold the writer slot.
    records.get('writer')!.spawned = false
    expect(await staffing.run()).toHaveLength(1)
  })

  test('a second message for a staffed worktree waits for the spawned member', async () => {
    const t = task(featX)
    mail(t.id)
    const second = mail(t.id)
    const assignments = await staffing.run()
    expect(assignments).toHaveLength(1)
    expect(spawned).toHaveLength(1)
    expect(store.get(second.id)?.state).toBe('queued')
  })

  test('the team spawn cap from ~/.kawai/teams.json bounds spawned sessions; killing one frees a slot', async () => {
    fs.mkdirSync(path.dirname(teamCapsFile(home)), { recursive: true })
    fs.writeFileSync(teamCapsFile(home), JSON.stringify({ maxSpawnedSessions: 1 }))
    mail(task(featX).id)
    const waiting = mail(task(featY).id)
    expect(await staffing.run()).toHaveLength(1)
    expect(store.get(waiting.id)?.state).toBe('queued')
    records.delete('spawned-1')
    expect(await staffing.run()).toHaveLength(1)
    expect(spawned.map(request => request.projectPath)).toEqual([featX, featY])
  })

  test('the default team cap is 5', async () => {
    writeGroup('devs', 'max: 10')
    const worktrees = Array.from({ length: 6 }, (_, index) => {
      const target = path.join(root, `cap-${index}`)
      if (!fs.existsSync(target)) git(['worktree', 'add', '-q', '-b', `cap-${index}`, target], repo)
      return target
    })
    for (const target of worktrees) mail(task(target).id)
    expect(await staffing.run()).toHaveLength(5)
    for (const target of worktrees) git(['worktree', 'remove', '--force', target], repo)
  })

  test('competing passes reserve inside one transaction and never exceed a cap', async () => {
    const t = task(featX)
    mail(t.id)
    mail(t.id)
    const other = makeStaffing()
    const results = await Promise.all([staffing.run(), other.run(), staffing.run()])
    expect(results.flat()).toHaveLength(1)
    expect(spawned).toHaveLength(1)
  })

  test('a pending reservation counts toward the caps', async () => {
    db.db.prepare("INSERT INTO team_spawns (id, message_id, team_id, group_id, worktree, created_at) VALUES ('r', 'm', ?, 'qa', ?, 'now')").run(team.teamId, featX)
    mail(task(featX).id)
    expect(await staffing.run()).toEqual([])
  })
})

describe('failure, restart, and removal', () => {
  test('a failed spawn drops its reservation, requeues the mail, and backs off', async () => {
    spawnFails = 'profile glm is not defined'
    const errors: unknown[] = []
    staffing = makeStaffing(error => errors.push(error))
    const m = mail(task(featX).id)
    expect(await staffing.run()).toEqual([])
    expect(store.get(m.id)).toMatchObject({ state: 'queued', claimedBy: null })
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM team_spawns').get()).toEqual({ n: 0 })
    expect(String(errors[0])).toContain('profile glm is not defined')
    await staffing.run()
    expect(spawned).toHaveLength(1)
    clock += 31_000
    spawnFails = null
    expect(await staffing.run()).toHaveLength(1)
  })

  test('startup reconciliation drops interrupted reservations and requeues reserved mail', () => {
    const m = mail(task(featX).id)
    store.reserveForSpawn(m.id)
    db.db.prepare("INSERT INTO team_spawns (id, message_id, team_id, group_id, worktree, created_at) VALUES ('r', ?, ?, 'devs', ?, 'now')").run(m.id, team.teamId, featX)
    const pushed = mail(null)
    store.claim(pushed.id, 'dev'); store.markPushed(pushed.id)
    staffing.reconcile()
    expect(store.get(m.id)?.state).toBe('queued')
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM team_spawns').get()).toEqual({ n: 0 })
    // Pushed claims are left to receipt recovery, never requeued here.
    expect(store.get(pushed.id)).toMatchObject({ state: 'claimed', pushedAt: expect.any(String) })
  })

  test('mail for a removed worktree is dead-lettered and no worktree is created', async () => {
    const doomed = path.join(root, 'doomed')
    git(['worktree', 'add', '-q', '-b', 'doomed', doomed], repo)
    const t = task(doomed)
    const m = mail(t.id)
    fs.rmSync(doomed, { recursive: true, force: true })
    const before = git(['worktree', 'list', '--porcelain'], repo)
    expect(await staffing.run()).toEqual([])
    expect(store.get(m.id)).toMatchObject({ state: 'dead', reason: `worktree-missing: ${doomed}` })
    expect(spawned).toEqual([])
    expect(git(['worktree', 'list', '--porcelain'], repo)).toBe(before)
    expect(fs.existsSync(doomed)).toBe(false)
    git(['worktree', 'prune'], repo)
  })
})

describe('dispatcher routing by worktree', () => {
  let recipients: MailRecipient[]
  let delivered: Array<{ to: string; id: string }>
  let dispatcher: MailDispatcher
  const member = (sessionId: string, projectPath: string, idle = true): MailRecipient => ({
    sessionId, teamId: team.teamId, groupId: 'devs', idle, pendingRequest: false, available: true, worktree: worktreeRootOf(projectPath),
  })
  const run = async () => { dispatcher.notify(); await dispatcher.settled() }
  beforeEach(() => {
    recipients = []
    delivered = []
    dispatcher = new MailDispatcher(store, {
      recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
      deliver: (id, peer) => { delivered.push({ to: id, id: peer.messageId }); recipients.find(row => row.sessionId === id)!.idle = false },
      watchReceipt: () => {},
      targetWorktree: message => (message.taskId ? tasks.get(message.taskId)?.worktree ?? null : null),
    })
  })
  afterEach(() => dispatcher.close())

  test('only a member in the target worktree takes it — including from a subdirectory', async () => {
    recipients.push(member('main', repo), member('in-y', featY), member('in-x-src', path.join(featX, 'src')))
    const m = mail(task(featX).id)
    await run()
    expect(delivered).toEqual([{ to: 'in-x-src', id: m.id }])
  })

  test('a member elsewhere skips worktree mail but keeps ordinary mail in order', async () => {
    recipients.push(member('main', repo))
    const targeted = mail(task(featX).id, { priority: 'urgent' })
    const plain = mail(null)
    await run()
    expect(delivered).toEqual([{ to: 'main', id: plain.id }])
    expect(store.get(targeted.id)?.state).toBe('queued')
  })

  test('a cwd move into the worktree makes the member eligible; moving out does not keep it', async () => {
    const dev = member('dev', repo)
    recipients.push(dev)
    const m = mail(task(featX).id)
    await run()
    expect(delivered).toEqual([])
    dev.worktree = worktreeRootOf(path.join(featX, 'src'))
    await run()
    expect(delivered).toEqual([{ to: 'dev', id: m.id }])
  })

  test('the staffing hook delivers reserved mail as the spawned member’s first turn, once', async () => {
    const m = mail(task(featX).id)
    const staff = makeStaffing()
    dispatcher.close()
    dispatcher = new MailDispatcher(store, {
      recipients: () => [...records.values()].filter(row => row.spawned).map(row => member(row.sessionId, row.projectPath)),
      prepare: async () => {}, interrupt: async () => {},
      deliver: (id, peer) => delivered.push({ to: id, id: peer.messageId }),
      watchReceipt: () => {},
      targetWorktree: message => (message.taskId ? tasks.get(message.taskId)?.worktree ?? null : null),
      staff: () => staff.run(),
    })
    await run()
    await run()
    expect(delivered).toEqual([{ to: 'spawned-1', id: m.id }])
    expect(store.get(m.id)).toMatchObject({ state: 'claimed', claimedBy: 'spawned-1' })
  })

  test('reserved mail the spawned member could not take goes back to the queue', async () => {
    const m = mail(task(featX).id)
    const staff = makeStaffing()
    dispatcher.close()
    dispatcher = new MailDispatcher(store, {
      recipients: () => [], prepare: async () => {}, interrupt: async () => {},
      deliver: () => { throw new Error('unreachable') }, watchReceipt: () => {},
      targetWorktree: message => (message.taskId ? tasks.get(message.taskId)?.worktree ?? null : null),
      staff: () => staff.run(),
    })
    await run()
    expect(store.get(m.id)).toMatchObject({ state: 'queued', claimedBy: null })
  })
})
