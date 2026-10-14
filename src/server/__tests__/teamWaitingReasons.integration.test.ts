// Waiting reasons end to end (team-waiting-reasons E04/3.4/5.1/7.1), through
// a real SessionMailbox — dispatcher, ProfileRouter, staffing, ledger — over a
// git repository with linked worktrees. A spawn knob holds spawned-agent
// startup open, fails it once, or lets it through, so `spawning` rows and
// their backoffs are observable at real snapshot times. Every git command
// runs under cleanGitEnv.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import type { ChatSessionDriver } from '../chat/ChatSessionDriver'
import { formatEnvelope } from '../team/envelope'
import type { GroupCatalog } from '../team/groupCatalog'
import type { SessionTeams } from '../team/sessionTeams'
import { SessionMailbox } from '../team/sessionMailbox'
import { teamCapsFile } from '../team/teamCaps'
import { loadTeamGroups } from '../team/teamGroups'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import type { SpawnRequest, SpawnResult } from '../team/staffing'
import type { WaitingReason } from '../../shared/team'
import type { ChatPeerMessage } from '../../shared/chat'

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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-waiting-')))
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
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/** The spawn knob: `ok`, `hold` (startup held open), or `fail` (once). */
type SpawnMode = 'ok' | 'hold' | 'fail-once'
let spawnMode: SpawnMode
let spawnCalls: SpawnRequest[]
/** Wall time of each spawn call, to compare retries against the backoff's end. */
let spawnAt: number[]
let spawnReleases: Array<(result: SpawnResult) => void> = []
let records: Map<string, ChatSessionRecord>
let catalog: GroupCatalog
let drivers: Map<string, ChatSessionDriver>
let pendingCards: Map<string, unknown[]>
let deliveries: Array<{ sessionId: string; messageId: string }>
let runtime: SessionMailbox
let home: string
let db: SessionDatabase
let transcript: string
/** waitingFor captured at every row-change notify (the snapshot a publish assembles). */
let changeSnapshots: Array<Record<string, WaitingReason>>
/** Teams re-published because their reasons structurally changed. */
let reasonPublishes: string[]
/** Errors reported through the dispatcher/staffing error path. */
let reportedErrors: unknown[]

const writeGroup = (id: string, frontmatter: string) => {
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', `${id}.md`), `---\n${frontmatter}\n---\nWork.`)
}
const refreshCatalog = async () => { catalog = (await loadTeamGroups(repo, home)).catalog }
const record = (sessionId: string, extra: Partial<ChatSessionRecord>): ChatSessionRecord => ({
  sessionId, name: sessionId, projectPath: repo, sdkSessionId: null, status: 'working', createdAt: '', lastActivityAt: '', groupId: 'devs', ...extra,
})
const driverFor = (sessionId: string): ChatSessionDriver => {
  const existing = drivers.get(sessionId)
  if (existing) return existing
  const driver = {
    getPendingRequests: () => pendingCards.get(sessionId) ?? [],
    interrupt: async () => {},
    deliver: (envelope: ChatPeerMessage) => {
      deliveries.push({ sessionId, messageId: envelope.messageId })
      fs.appendFileSync(transcript, JSON.stringify({ type: 'user', message: { content: formatEnvelope(envelope) } }) + '\n')
      records.get(sessionId)!.status = 'working'
    },
  } as unknown as ChatSessionDriver
  drivers.set(sessionId, driver)
  return driver
}

beforeEach(async () => {
  const dirCase = fs.mkdtempSync(path.join(root, 'case-'))
  home = path.join(dirCase, 'home')
  transcript = path.join(dirCase, 'transcript.jsonl')
  fs.writeFileSync(transcript, '')
  fs.rmSync(path.join(repo, '.kawai'), { recursive: true, force: true })
  writeGroup('devs', 'max: 1\nprofile: glm\napproval: auto')
  writeGroup('leads', 'label: Team leads')
  db = initDatabase({ path: path.join(dirCase, 'db.sqlite') })
  records = new Map([['lead', record('lead', { groupId: 'leads' })]])
  drivers = new Map()
  pendingCards = new Map()
  deliveries = []
  spawnMode = 'ok'
  spawnCalls = []
  spawnAt = []
  spawnReleases = []
  changeSnapshots = []
  reasonPublishes = []
  reportedErrors = []
  await refreshCatalog()
  const teamsStub = {
    teamOf: (id: string) => (records.has(id) ? team : undefined),
    catalogOf: () => catalog,
    groupInfo: () => ({ missing: false }),
  } as unknown as SessionTeams
  runtime = new SessionMailbox(db.db, {
    teams: teamsStub,
    records: () => records.values(),
    getRecord: id => records.get(id),
    getDriver: id => (records.has(id) ? driverFor(id) : undefined),
    available: rec => rec.archivedAt == null,
    startBlocker: rec => rec.archivedAt != null ? 'This chat is archived and read-only' : null,
    prepare: async () => {},
    restore: () => {},
    watchReceipt: () => {}, archive: () => ({ ok: true }), hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false,
    spawn: async (request): Promise<SpawnResult> => {
      spawnCalls.push(request)
      spawnAt.push(Date.now())
      if (spawnMode === 'hold') return new Promise(resolve => { spawnReleases.push(resolve) })
      if (spawnMode === 'fail-once') {
        spawnMode = 'ok'
        return { ok: false, error: 'profile glm is not defined' }
      }
      const sessionId = `spawned-${spawnCalls.length}`
      records.set(sessionId, record(sessionId, { projectPath: request.projectPath, spawned: true, status: 'waiting', taskId: request.taskId ?? null, ...(request.profileId ? { claudeProfileId: request.profileId } : {}) }))
      return { ok: true, sessionId }
    },
    spawnRetryAfterMs: 80,
    transcriptFor: () => transcript,
    homeDir: home,
    onChange: team => { changeSnapshots.push(runtime.waitingFor(team)) },
    onReasonsChange: team => { reasonPublishes.push(team) },
    onError: error => { reportedErrors.push(error) },
  })
  runtime.start()
})
afterEach(async () => {
  for (let i = 0; i < 5; i++) { await runtime.dispatcher.settled(); await Bun.sleep(5) }
  runtime.close(); db.close()
})

/** Notify and drain: chained passes (a notify that arrived mid-pass) complete too. */
const settle = async () => {
  runtime.dispatcher.notify()
  for (let i = 0; i < 5; i++) { await runtime.dispatcher.settled(); await Bun.sleep(5) }
}
/** Receipt confirmation a turn end or recovery would run in production. */
const confirmReceipts = () => { for (const delivery of deliveries) runtime.settleRecipient(delivery.sessionId) }
const task = (worktree: string | null) => runtime.tasks.store.create({
  teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'human', sessionId: null }, worktree,
})
const mail = (taskId: string | null, extra: Partial<Parameters<SessionMailbox['mailbox']['store']['enqueue']>[0]> = {}) =>
  runtime.mailbox.store.enqueue({ teamId: team.teamId, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: repo, body: 'work', taskId, ...extra })
const store = () => runtime.mailbox.store
const until = async (predicate: () => boolean, deadlineMs: number) => {
  const deadline = Date.now() + deadlineMs
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10)
  return predicate()
}

test('a message held in spawning shows Starting agent with its reservation facts, then delivers once', async () => {
  spawnMode = 'hold'
  const t = await task(featX)
  const m = mail(t.id)
  runtime.dispatcher.notify()
  // The dispatch pass stays inside the awaited startup; the row is reserved.
  expect(await until(() => store().get(m.id)?.state === 'spawning', 2_000)).toBe(true)
  const waiting = runtime.waitingFor(team.teamId)
  expect(waiting[m.id]!.blocker).toMatchObject({
    kind: 'starting-agent',
    reservation: { group: 'devs', profile: 'glm', worktree: featX, startedAt: expect.any(String) },
  })
  // Its own reservation fills the group cap and holds the worktree: capacity
  // facts among the others, never the blocker (D1).
  expect(waiting[m.id]!.others).toEqual([
    { kind: 'group-cap', counts: { live: 1, cap: 1 } },
    { kind: 'worktree-occupied', counts: { live: 1, cap: 1 }, detail: featX },
  ])
  // The reserve notify's snapshot already carried it: the team_spawns row is
  // inserted before the flip (D3).
  const atReserve = changeSnapshots.find(snapshot => m.id in snapshot)
  expect(atReserve![m.id]!.blocker.kind).toBe('starting-agent')
  // An unrelated row change during the awaited startup still shows it.
  const noise = mail(null, { toKind: 'session', toId: 'lead' })
  expect(runtime.waitingFor(team.teamId)[m.id]!.blocker.kind).toBe('starting-agent')
  spawnReleases.splice(0).forEach(release => {
    const sessionId = `spawned-${spawnCalls.length}`
    records.set(sessionId, record(sessionId, { projectPath: featX, spawned: true, status: 'waiting', taskId: t.id }))
    release({ ok: true, sessionId })
  })
  await settle()
  expect(deliveries.filter(delivery => delivery.messageId === m.id)).toHaveLength(1)
  confirmReceipts()
  expect(store().get(m.id)?.state).toBe('delivered')
  // The noise stays queued with its own reason: the lead is working.
  expect(runtime.waitingFor(team.teamId)[noise.id]!.blocker).toEqual({ kind: 'recipient-busy' })
})

test('an independent occupant appearing mid-start is named among the others', async () => {
  spawnMode = 'hold'
  const t = await task(featX)
  const m = mail(t.id)
  runtime.dispatcher.notify()
  expect(await until(() => store().get(m.id)?.state === 'spawning', 2_000)).toBe(true)
  records.set('writer', record('writer', { projectPath: featX, spawned: true }))
  const waiting = runtime.waitingFor(team.teamId)
  expect(waiting[m.id]!.blocker.kind).toBe('starting-agent')
  const occupied = waiting[m.id]!.others.find(constraint => constraint.kind === 'worktree-occupied')!
  expect(occupied).toMatchObject({ counts: { live: 2, cap: 1 }, sessionIds: ['writer'], detail: featX })
  records.delete('writer')
  spawnReleases.splice(0).forEach(release => {
    const sessionId = `spawned-${spawnCalls.length}`
    records.set(sessionId, record(sessionId, { projectPath: featX, spawned: true, status: 'waiting', taskId: t.id }))
    release({ ok: true, sessionId })
  })
  await settle()
  confirmReceipts()
  expect(store().get(m.id)?.state).toBe('delivered')
})

test('a group cap blocks with its count; freeing the slot updates the reason and delivers once', async () => {
  records.set('full', record('full', { status: 'working' }))
  const t = await task(featX)
  const m = mail(t.id)
  await settle()
  expect(store().get(m.id)?.state).toBe('queued')
  const waiting = runtime.waitingFor(team.teamId)
  expect(waiting[m.id]!.blocker).toEqual({ kind: 'group-cap', counts: { live: 1, cap: 1 } })
  expect(waiting[m.id]!.others[0]).toMatchObject({ kind: 'no-eligible-member', sessionIds: ['full'], members: [{ sessionId: 'full', cause: 'working' }] })
  // Archiving the member frees the slot: the reason updates and exactly one
  // agent (a spawn) receives the message.
  records.get('full')!.archivedAt = '2026-10-11'
  await settle()
  expect(deliveries.filter(delivery => delivery.messageId === m.id)).toHaveLength(1)
  confirmReceipts()
  expect(store().get(m.id)?.state).toBe('delivered')
  expect(runtime.waitingFor(team.teamId)[m.id]).toBeUndefined()
})

test('the team spawn cap and an occupied worktree each block with the right facts', async () => {
  // Team cap: one spawned member of another group already runs elsewhere.
  writeGroup('devs', 'max: 2\nprofile: glm')
  records.set('holder', record('holder', { projectPath: featY, spawned: true, groupId: 'leads' }))
  await refreshCatalog()
  fs.mkdirSync(path.dirname(teamCapsFile(home)), { recursive: true })
  fs.writeFileSync(teamCapsFile(home), JSON.stringify({ maxSpawnedSessions: 1 }))
  const t = await task(featX)
  const m = mail(t.id)
  await settle()
  expect(runtime.waitingFor(team.teamId)[m.id]!.blocker).toEqual({ kind: 'team-spawn-cap', counts: { live: 1, cap: 1 } })

  // Occupied worktree: a busy spawned writer of the group holds feat-x.
  records.delete('holder')
  fs.rmSync(teamCapsFile(home))
  records.set('writer', record('writer', { projectPath: featX, spawned: true }))
  const second = mail(t.id)
  await settle()
  const waiting = runtime.waitingFor(team.teamId)
  expect(waiting[second.id]!.blocker).toEqual({
    kind: 'worktree-occupied', counts: { live: 1, cap: 1 }, sessionIds: ['writer'], detail: featX,
  })
  expect(waiting[second.id]!.others[0]).toMatchObject({ kind: 'no-eligible-member', sessionIds: ['writer'], members: [{ sessionId: 'writer', cause: 'working' }] })
  // The first message waits on the same occupied worktree now that the team
  // cap was lifted.
  expect(waiting[m.id]!.blocker).toEqual({
    kind: 'worktree-occupied', counts: { live: 1, cap: 1 }, sessionIds: ['writer'], detail: featX,
  })
})

test('a failed spawn records its backoff before the requeue publishes and retries at the backoff end', async () => {
  spawnMode = 'fail-once'
  const t = await task(featX)
  const m = mail(t.id)
  await settle()
  expect(spawnCalls).toHaveLength(1)
  expect(store().get(m.id)?.state).toBe('queued')
  const waiting = runtime.waitingFor(team.teamId)
  // After the failure pass the full diagnosis applies: the backoff carries
  // its retry time (the moment the retry runs), ranked among the constraints
  // by the caps-first order (D1). Captured before any asymmetric matcher:
  // Bun's toMatchObject mutates the received object.
  const backoffRetryAt = [waiting[m.id]!.blocker, ...waiting[m.id]!.others]
    .find(constraint => constraint.kind === 'spawn-backoff')?.retryAt
  expect(typeof backoffRetryAt).toBe('string')
  // The requeue's row-change snapshot already carried the backoff as its
  // reason (D3): the last captured change for this message is its requeue.
  const atRequeue = changeSnapshots.filter(snapshot => m.id in snapshot).at(-1)!
  expect(atRequeue[m.id]!.blocker.kind).toBe('spawn-backoff')
  // Nothing else changes; the retry runs no earlier than the backoff's end —
  // the retry time the reason shows is the moment the retry runs. Measured
  // against the recorded retryAt, not wall time since an arbitrary point:
  // part of the backoff elapses during the assertions above. A retry that
  // ignored the backoff would spawn on the requeue-chained pass, far before
  // retryAt, and fail this comparison.
  const retryAt = Date.parse(backoffRetryAt!)
  expect(await until(() => spawnCalls.length === 2, 2_000)).toBe(true)
  expect(spawnAt[1]).toBeGreaterThanOrEqual(retryAt - 10)
  await settle()
  expect(deliveries.filter(delivery => delivery.messageId === m.id)).toHaveLength(1)
  confirmReceipts()
  expect(store().get(m.id)?.state).toBe('delivered')
})

test('a backoff whose message left the surface never arms the timer again', async () => {
  spawnMode = 'fail-once'
  const m = mail((await task(featX)).id)
  await settle()
  expect(runtime.staffing.nextRetryAt()).not.toBeNull()
  store().cancel(m.id)
  await settle()
  expect(runtime.staffing.nextRetryAt()).toBeNull()
})

test('reason-only changes re-publish; unchanged passes stay silent', async () => {
  writeGroup('devs', 'max: 2\nprofile: glm')
  await refreshCatalog()
  records.set('a', record('a', { status: 'working' }))
  records.set('b', record('b', { status: 'working' }))
  const m = mail(null)
  await settle()
  const waiting = runtime.waitingFor(team.teamId)
  expect(waiting[m.id]!.blocker).toEqual({ kind: 'group-cap', counts: { live: 2, cap: 2 } })
  const published = reasonPublishes.length
  // An identical pass republishes nothing: the reason did not change.
  await settle()
  expect(reasonPublishes.length).toBe(published)
  // Archiving a member changes only the reason (2/2 → 1/2 with a busy
  // member): the blocker flips with no row state change. The archived member
  // stays listed as unavailable — it is still a live record.
  records.get('b')!.archivedAt = '2026-10-11'
  await settle()
  expect(reasonPublishes.length).toBeGreaterThan(published)
  expect(runtime.waitingFor(team.teamId)[m.id]!.blocker).toMatchObject({
    kind: 'no-eligible-member', sessionIds: ['a', 'b'], members: [
      { sessionId: 'a', cause: 'working' }, { sessionId: 'b', cause: 'unavailable' },
    ],
  })
})

test('a group definition removed and restored mid-wait flips the blocker', async () => {
  writeGroup('ghost', 'max: 1')
  await refreshCatalog()
  const m = mail(null, { toId: 'ghost' })
  await settle()
  expect(runtime.waitingFor(team.teamId)[m.id]!.blocker).toMatchObject({ kind: 'no-eligible-member', detail: 'the group has no live members' })
  fs.rmSync(path.join(repo, '.kawai', 'groups', 'ghost.md'))
  await refreshCatalog()
  await settle()
  expect(runtime.waitingFor(team.teamId)[m.id]!.blocker).toEqual({ kind: 'group-missing' })
  // Restored: the mail still routes to eligible members when one appears.
  writeGroup('ghost', 'max: 1')
  await refreshCatalog()
  records.set('ghost-dev', record('ghost-dev', { groupId: 'ghost', status: 'waiting' }))
  await settle()
  expect(deliveries.filter(delivery => delivery.messageId === m.id)).toHaveLength(1)
  confirmReceipts()
  expect(store().get(m.id)?.state).toBe('delivered')
})

test('direct mail reasons surface through the ledger and clear on delivery', async () => {
  records.set('busy', record('busy', { status: 'working' }))
  const blocked = mail(null, { toKind: 'session', toId: 'busy' })
  await settle()
  expect(runtime.waitingFor(team.teamId)[blocked.id]!.blocker).toEqual({ kind: 'recipient-busy' })
  records.get('busy')!.archivedAt = '2026-10-11'
  await settle()
  expect(runtime.waitingFor(team.teamId)[blocked.id]!.blocker).toEqual({
    kind: 'recipient-unavailable', detail: 'This chat is archived and read-only',
  })
})
