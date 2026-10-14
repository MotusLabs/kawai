// Team member release (team-member-release): pending rows at task close
// (D1), the single readiness definition (D3), release inside the dispatch
// cycle before routing (D2), closed-task mail dead-lettered `task-closed`
// (D8), durability across restart, cancellation on reopen and restore, and
// the `release_member` entry (D6) — all through a real SessionMailbox over
// a git repo with worktrees, driven the production way (dispatch passes).
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatSessionRecord } from '../db'
import type { ChatSessionDriver } from '../chat/ChatSessionDriver'
import { cleanGitEnv } from '../git/gitCommand'
import { SessionMailbox } from '../team/sessionMailbox'
import { SessionTeams } from '../team/sessionTeams'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import type { EnqueueInput } from '../team/mailboxStore'
import type { SpawnRequest } from '../team/staffing'

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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-release-')))
  repo = path.join(root, 'repo')
  featX = path.join(root, 'feat-x')
  featY = path.join(root, 'feat-y')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-x', featX], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-y', featY], repo)
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => { clearTeamCache(); fs.rmSync(root, { recursive: true, force: true }) })

let dir: string
let db: Database
let records: Map<string, ChatSessionRecord>
let teams: SessionTeams
let runtime: SessionMailbox
let archived: string[]
let liveWorkers: Set<string>
let pendingCards: Set<string>
type DeliveredEnvelope = { session: string; messageId: string; thread: number; task: string | null }
let received: DeliveredEnvelope[]
let spawnCalls: SpawnRequest[]
/** Errors of the current runtime only: late continuations of a torn-down one must not fail the next test. */
let errors: unknown[]

const writeGroup = (id: string, frontmatter = '') => {
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', `${id}.md`), `---\n${frontmatter}\n---\nWork.`)
}
const record = (sessionId: string, extra: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId, name: sessionId, projectPath: repo, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  groupId: 'devs', ...extra,
})
const makeRuntime = () => {
  // Per-runtime collector: a torn-down runtime's late continuations must not fail the next test.
  const runtimeErrors: unknown[] = []
  errors = runtimeErrors
  return new SessionMailbox(db, {
  teams, records: () => records.values(), getRecord: id => records.get(id),
  getDriver: id => ({
    getPendingRequests: () => (pendingCards.has(id) ? [{ type: 'approval' }] : []),
    deliver: (envelope: { messageId: string; thread?: unknown[]; task?: { id: string } | null }) => {
      records.get(id)!.status = 'working'
      received.push({ session: id, messageId: envelope.messageId, thread: envelope.thread?.length ?? 0, task: envelope.task?.id ?? null })
    },
  }) as unknown as ChatSessionDriver,
  available: rec => rec.archivedAt == null,
  prepare: async () => {},
  restore: () => {},
  watchReceipt: () => {},
  archive: id => { archived.push(id); records.get(id)!.archivedAt = new Date().toISOString() },
  hasLiveWorkers: id => liveWorkers.has(id),
  spawn: async request => {
    spawnCalls.push(request)
    const sessionId = `spawned-${spawnCalls.length}`
    records.set(sessionId, record(sessionId, {
      projectPath: request.projectPath, groupId: request.groupId, spawned: true, taskId: request.taskId,
      ...(request.profileId ? { claudeProfileId: request.profileId } : {}),
    }))
    await teams.track(sessionId, request.projectPath)
    return { ok: true, sessionId }
  },
  transcriptFor: () => null,
  homeDir: dir,
  onError: error => { runtimeErrors.push(error) },
  })
}
const trackAll = async () => Promise.all([...records.keys()].map(id => teams.track(id, records.get(id)!.projectPath)))
const close = async (taskId: string, status: 'done' | 'cancelled' = 'done') =>
  runtime.tasks.setStatus({ kind: 'human', team }, taskId, status)
const task = (worktree: string | null) => runtime.tasks.store.create({
  teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'human', sessionId: null }, worktree,
})
const mail = (extra: Partial<EnqueueInput> = {}) =>
  runtime.mailbox.store.enqueue({ teamId: team.teamId, toKind: 'group', toId: 'devs', fromSession: null, fromGroup: null, originPath: repo, body: 'work', ...extra })
const pass = async () => {
  runtime.dispatcher.notify(); await runtime.dispatcher.settled()
  // Surface collected dispatch errors as the test's own failure.
  if (errors.length > 0) throw new Error(`dispatch errors: ${errors.map(String).join(' | ')}`)
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(root, 'case-'))
  fs.rmSync(path.join(repo, '.kawai'), { recursive: true, force: true })
  writeGroup('devs')
  writeGroup('qa')
  db = new Database(':memory:')
  records = new Map()
  teams = new SessionTeams({ homeDir: dir })
  archived = []; liveWorkers = new Set(); pendingCards = new Set(); received = []; spawnCalls = []
  runtime = makeRuntime()
  runtime.dispatcher.release()
})
afterEach(() => { runtime.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

test('closing a task marks only its live spawned members; reopen and restore cancel (D1)', async () => {
  const t = task(featX)
  records.set('dev-1', record('dev-1', { name: 'Dev one', projectPath: featX, spawned: true, taskId: t.id }))
  records.set('dev-2', record('dev-2', { spawned: true, taskId: t.id, archivedAt: 'gone' }))
  records.set('human-1', record('human-1', { taskId: t.id }))
  const other = task(featY)
  records.set('dev-3', record('dev-3', { projectPath: featY, spawned: true, taskId: other.id }))
  await trackAll()
  await close(t.id)
  expect(runtime.releases.pending().map(row => row.sessionId)).toEqual(['dev-1'])
  expect(runtime.releases.pending()[0]).toMatchObject({ taskId: t.id, teamId: team.teamId, requestedBy: { kind: 'human', sessionId: null } })
  // The close journals who closed it; a spawn completing later reads this back.
  expect(runtime.tasks.store.journal(t.id).map(entry => entry.text)).toEqual(['Task done.'])
  await runtime.tasks.setStatus({ kind: 'human', team }, t.id, 'active')
  expect(runtime.releases.pending()).toEqual([])
  // Close again, then a hand archive of the member cancels its row.
  await close(t.id)
  runtime.cancelPendingRelease('dev-1')
  expect(runtime.releases.pending()).toEqual([])
})

test('an opted-out group keeps its members (releaseOnTaskClose: false)', async () => {
  writeGroup('qa', 'releaseOnTaskClose: false')
  const t = task(featX)
  records.set('qa-1', record('qa-1', { groupId: 'qa', projectPath: featX, spawned: true, taskId: t.id }))
  await trackAll()
  await close(t.id)
  expect(runtime.releases.pending()).toEqual([])
})

test('a busy member is released once its turn ends; approvals, workers, and mail hold it (D3)', async () => {
  const t = task(featX)
  records.set('dev-1', record('dev-1', { name: 'Dev one', projectPath: featX, spawned: true, taskId: t.id }))
  await trackAll()
  await close(t.id)
  records.get('dev-1')!.status = 'working'
  await pass()
  expect(archived).toEqual([])
  records.get('dev-1')!.status = 'waiting'
  pendingCards.add('dev-1')
  await pass()
  expect(archived).toEqual([])
  pendingCards.delete('dev-1')
  liveWorkers.add('dev-1')
  await pass()
  expect(archived).toEqual([])
  liveWorkers.delete('dev-1')
  await pass()
  expect(archived).toEqual(['dev-1'])
  expect(records.get('dev-1')!.archivedAt).toBeTruthy()
  expect(runtime.releases.pending()).toEqual([])
  const entry = runtime.tasks.store.journal(t.id).find(row => row.author.kind === 'system')
  expect(entry?.text).toBe('Released Dev one (dev-1): task done by the human.')
})

test('claimed, parked, and due direct mail hold the release until settled (D3)', async () => {
  const t = task(featX)
  records.set('dev-1', record('dev-1', { projectPath: featX, spawned: true, taskId: t.id }))
  await trackAll()
  // A claimed instruction: not ready.
  const instruction = mail({ taskId: t.id })
  runtime.mailbox.store.claim(instruction.id, 'dev-1')
  await close(t.id)
  await pass()
  expect(archived).toEqual([])
  // Delivered (receipt settled): the claim no longer holds.
  runtime.mailbox.store.markPushed(instruction.id)
  runtime.mailbox.store.markDelivered(instruction.id)
  // Due direct mail still waiting: holds.
  const note = mail({ toKind: 'session', toId: 'dev-1', taskId: null })
  await pass()
  expect(archived).toEqual([])
  expect(received.map(row => row.session)).toEqual(['dev-1'])
  // The turn ran (busy) and its receipt settled; the member idles again — released.
  runtime.mailbox.store.markDelivered(note.id)
  records.get('dev-1')!.status = 'waiting'
  await pass()
  expect(archived).toEqual(['dev-1'])
})

test('parked work holds the release', async () => {
  const t = task(featX)
  records.set('dev-1', record('dev-1', { projectPath: featX, spawned: true, taskId: t.id }))
  await trackAll()
  const instruction = mail({ taskId: t.id })
  runtime.mailbox.store.claim(instruction.id, 'dev-1')
  runtime.mailbox.store.markPushed(instruction.id)
  runtime.mailbox.store.markDelivered(instruction.id)
  runtime.mailbox.store.park(instruction.id, new Date(Date.now() + 3600_000).toISOString(), 'resume-1')
  await close(t.id)
  await pass()
  expect(archived).toEqual([])
  runtime.mailbox.store.unpark(instruction.id)
  await pass()
  expect(archived).toEqual(['dev-1'])
})

test('pending releases survive a restart and free capacity for waiting mail (D1/D2)', async () => {
  writeGroup('devs', 'max: 1')
  const t1 = task(featX)
  records.set('dev-1', record('dev-1', { projectPath: featX, spawned: true, taskId: t1.id }))
  const t2 = task(featY)
  const waiting = mail({ taskId: t2.id })
  await trackAll()
  await close(t1.id)
  // The member is busy: the pending release waits, and the queued second
  // task cannot spawn — the group is at max and the writer slot is held.
  records.get('dev-1')!.status = 'working'
  await pass()
  expect(spawnCalls).toEqual([])
  expect(archived).toEqual([])
  expect(runtime.waitingFor(team.teamId)[waiting.id]).toBeTruthy()
  // Restart: a fresh mailbox over the same database still holds the row.
  runtime.close()
  runtime = makeRuntime()
  runtime.dispatcher.release()
  records.get('dev-1')!.status = 'waiting'
  await pass()
  expect(archived).toEqual(['dev-1'])
  // The freed capacity served the waiting mail in the same pass.
  expect(spawnCalls.map(call => call.taskId)).toEqual([t2.id])
  expect(runtime.waitingFor(team.teamId)[waiting.id]).toBeUndefined()
})

test('a spawn in flight at close gets no first turn, is marked, and is released (D1)', async () => {
  const t = task(featX)
  const instruction = mail({ taskId: t.id })
  runtime.mailbox.store.reserveForSpawn(instruction.id)
  await close(t.id)
  expect(runtime.mailbox.store.get(instruction.id)).toMatchObject({ state: 'dead', reason: 'task-closed' })
  // The spawn completes: a spawned record for the now-closed task.
  records.set('spawned-1', record('spawned-1', { projectPath: featX, spawned: true, taskId: t.id }))
  await teams.track('spawned-1', featX)
  await runtime.releases.markSpawnedForClosedTask('spawned-1', t.id)
  expect(runtime.releases.pending().map(row => row.sessionId)).toEqual(['spawned-1'])
  await pass()
  expect(received).toEqual([])
  expect(archived).toEqual(['spawned-1'])
})

test('closed-task group mail is dead-lettered at close and for late arrivals; direct and unscoped mail pass (D8)', async () => {
  writeGroup('leads', 'worktreeScoped: false')
  records.set('lead-1', record('lead-1', { groupId: 'leads', projectPath: repo }))
  records.set('dev-1', record('dev-1', { projectPath: featX, spawned: true, taskId: null }))
  await trackAll()
  const t = task(featX)
  const queued = mail({ taskId: t.id })
  const scheduled = mail({ taskId: t.id, deliverAt: new Date(Date.now() + 3600_000).toISOString() })
  await close(t.id)
  for (const row of [queued, scheduled]) {
    expect(runtime.mailbox.store.get(row.id)).toMatchObject({ state: 'dead', reason: 'task-closed' })
  }
  // A late arrival after the close: dead-lettered in the dispatcher, never delivered or spawned.
  const late = mail({ taskId: t.id })
  await pass()
  expect(runtime.mailbox.store.get(late.id)).toMatchObject({ state: 'dead', reason: 'task-closed' })
  expect(spawnCalls).toEqual([])
  expect(runtime.waitingFor(team.teamId)[late.id]).toBeUndefined()
  // Direct mail to the live member and group mail to an unscoped group still arrive.
  const direct = mail({ toKind: 'session', toId: 'dev-1', taskId: t.id })
  const report = mail({ toId: 'leads', taskId: t.id })
  await pass()
  expect(received.map(row => row.messageId)).toEqual([direct.id, report.id])
  expect(received.map(row => row.session)).toEqual(['dev-1', 'lead-1'])
  // Reopening does not revive the dead letter.
  await runtime.tasks.setStatus({ kind: 'human', team }, t.id, 'open')
  expect(runtime.mailbox.store.get(queued.id)?.state).toBe('dead')
})

test('release_member: permitted by default, archives and journals; refusals name the reason (D6)', async () => {
  const t = task(featX)
  records.set('lead-1', record('lead-1', { name: 'Lead one', groupId: 'leads' }))
  writeGroup('leads')
  records.set('dev-1', record('dev-1', { name: 'Dev one', projectPath: featX, spawned: true, taskId: t.id }))
  records.set('human-1', record('human-1', { name: 'Human dev' }))
  await trackAll()
  const release = (target: string, reason?: string) => runtime.releases.releaseByAgent('lead-1', target, reason)
  await expect(release('lead-1')).rejects.toThrow('cannot release yourself')
  await expect(release('human-1')).rejects.toThrow('Only spawned members')
  await expect(release('nope')).rejects.toThrow('archived or unknown')
  records.get('dev-1')!.status = 'working'
  await expect(release('dev-1')).rejects.toThrow('not ready for release: it is busy')
  records.get('dev-1')!.status = 'waiting'
  liveWorkers.add('dev-1')
  await expect(release('dev-1')).rejects.toThrow('background worker')
  liveWorkers.delete('dev-1')
  const result = await release('dev-1', 'merged')
  expect(result).toEqual({ sessionId: 'dev-1', taskId: t.id })
  expect(archived).toEqual(['dev-1'])
  expect(runtime.tasks.store.journal(t.id).at(-1)).toMatchObject({
    author: { kind: 'system', sessionId: null },
    text: 'Released Dev one (dev-1) at the request of Lead one (lead-1): merged.',
  })
  // The task and its status are untouched; the released member is archived.
  expect(runtime.tasks.store.get(t.id)?.status).toBe('open')
  // An opted-out caller group is refused.
  writeGroup('leads', 'canReleaseMembers: false')
  await expect(release('dev-1')).rejects.toThrow('opted out of releasing members')
})

test('an other-team spawned member is refused', async () => {
  writeGroup('leads')
  const other = fs.realpathSync(fs.mkdtempSync(path.join(root, 'other-repo')))
  git(['init', '-q', other])
  records.set('lead-1', record('lead-1', { groupId: 'leads' }))
  records.set('dev-1', record('dev-1', { projectPath: other, spawned: true, taskId: null }))
  await trackAll()
  await expect(runtime.releases.releaseByAgent('lead-1', 'dev-1')).rejects.toThrow('not a member of your team')
  fs.rmSync(other, { recursive: true, force: true })
})

test('worktree scoping: scoped groups keep worktree routing; unscoped groups take any idle member (D5)', async () => {
  writeGroup('leads', 'worktreeScoped: false')
  records.set('dev-main', record('dev-main', { projectPath: repo }))
  records.set('lead-1', record('lead-1', { groupId: 'leads', projectPath: repo }))
  await trackAll()
  const t = task(featX)
  const devsMail = mail({ taskId: t.id })
  const leadsMail = mail({ toId: 'leads', taskId: t.id })
  await pass()
  // The unscoped lead in the main checkout takes its task mail; the scoped
  // dev in the main checkout does not — it waits for a member in feat-x.
  expect(received.map(row => row.messageId)).toEqual([leadsMail.id])
  expect(runtime.mailbox.store.get(devsMail.id)?.state).toBe('queued')
})

test('an unscoped group never spawns for task mail, and no idle member means it waits', async () => {
  writeGroup('leads', 'worktreeScoped: false')
  await trackAll()
  const t = task(featY)
  const m = mail({ toId: 'leads', taskId: t.id })
  await pass()
  expect(spawnCalls).toEqual([])
  expect(runtime.mailbox.store.get(m.id)?.state).toBe('queued')
})

test('a killed sender\'s reply falls back to its unscoped group and arrives with its thread', async () => {
  writeGroup('leads', 'worktreeScoped: false')
  records.set('lead-1', record('lead-1', { groupId: 'leads', projectPath: repo }))
  await trackAll()
  const t = task(featX)
  // A delivered message from a lead that has since been killed.
  const original = mail({ toKind: 'session', toId: 'lead-1', fromSession: 'lead-old', fromGroup: 'leads', taskId: t.id })
  runtime.mailbox.store.claim(original.id, 'lead-1')
  runtime.mailbox.store.markPushed(original.id)
  runtime.mailbox.store.markDelivered(original.id)
  records.get('lead-1')!.status = 'waiting'
  const reply = await runtime.mailbox.reply({ kind: 'agent', sessionId: 'lead-1' }, { message_id: original.id, body: 'verdict' })
  expect(reply).toMatchObject({ toKind: 'group', toId: 'leads', taskId: t.id, attachThread: true })
  await pass()
  expect(received).toEqual([{ session: 'lead-1', messageId: reply.id, thread: 1, task: t.id }])
})

test('the close transition re-reads state at the commit: a claim during the await survives, a late member is marked (F1)', async () => {
  // Drive MemberRelease directly so the definition resolver can pause the
  // hook mid-transition and mutate the mailbox and roster underneath it.
  const MemberRelease = (await import('../team/memberRelease')).MemberRelease
  const TaskStoreMod = await import('../team/taskStore')
  const tasks = new TaskStoreMod.TaskStore(db, runtime.mailbox.store)
  const t = tasks.create({ teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'human', sessionId: null }, worktree: featX })
  const instruction = runtime.mailbox.store.enqueue({ teamId: team.teamId, toKind: 'group', toId: 'devs', fromSession: null, fromGroup: null, originPath: repo, body: 'work', taskId: t.id })
  records.set('dev-1', record('dev-1', { projectPath: featX, spawned: true, taskId: t.id }))
  await teams.track('dev-1', featX)
  let releaseDefinitions!: () => void
  const releases = new MemberRelease(db, {
    store: runtime.mailbox.store, tasks,
    records: () => records.values(), getRecord: id => records.get(id),
    teamOf: id => (records.has(id) ? team : undefined),
    definition: () => new Promise(resolve => { releaseDefinitions = () => resolve(undefined) }),
    cachedDefinition: () => undefined,
    recipient: () => ({ idle: true, pendingRequest: false }),
    hasLiveWorkers: () => false,
    archive: () => true,
    notify: () => {},
  })
  const hook = releases.transitionHook(t, 'done', { kind: 'human', sessionId: null })
  await new Promise(resolve => setImmediate(resolve))
  // While the hook awaits the group definitions, the instruction is claimed
  // and pushed (a dispatch pass won it) and a second spawned member appears.
  runtime.mailbox.store.claim(instruction.id, 'dev-1')
  runtime.mailbox.store.markPushed(instruction.id)
  records.set('dev-2', record('dev-2', { name: 'Dev two', projectPath: featX, spawned: true, taskId: t.id }))
  releaseDefinitions()
  ;(await hook)()
  // The claimed instruction was already delivered as a turn: it survives.
  expect(runtime.mailbox.store.get(instruction.id)).toMatchObject({ state: 'claimed', claimedBy: 'dev-1', pushedAt: expect.any(String) })
  // Both live spawned members — including the one created during the await — are marked.
  expect(releases.pending().map(row => row.sessionId).sort()).toEqual(['dev-1', 'dev-2'])
})

test('markSpawnedForClosedTask re-checks after the await: a reopen during the definition load marks nothing (F2)', async () => {
  const MemberRelease = (await import('../team/memberRelease')).MemberRelease
  const TaskStoreMod = await import('../team/taskStore')
  const tasks = new TaskStoreMod.TaskStore(db, runtime.mailbox.store)
  const t = tasks.create({ teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'human', sessionId: null }, worktree: featX })
  tasks.setStatus(t.id, 'done')
  records.set('spawned-9', record('spawned-9', { projectPath: featX, spawned: true, taskId: t.id }))
  let releaseDefinitions!: () => void
  const releases = new MemberRelease(db, {
    store: runtime.mailbox.store, tasks,
    records: () => records.values(), getRecord: id => records.get(id),
    teamOf: id => (records.has(id) ? team : undefined),
    definition: () => new Promise(resolve => { releaseDefinitions = () => resolve(undefined) }),
    cachedDefinition: () => undefined,
    recipient: () => ({ idle: true, pendingRequest: false }),
    hasLiveWorkers: () => false,
    archive: () => true,
    notify: () => {},
  })
  const marking = releases.markSpawnedForClosedTask('spawned-9', t.id)
  await new Promise(resolve => setImmediate(resolve))
  // The task is reopened while the definition load is suspended.
  tasks.setStatus(t.id, 'active')
  releaseDefinitions()
  await marking
  expect(releases.pending()).toEqual([])
})
