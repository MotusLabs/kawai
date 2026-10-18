// The context-exhaustion outcome (chat-context-exhaustion D4) through a real
// SessionMailbox, replaying the incident: a spawned dev's "go" mail is
// delivered, its turn fails with the context exhausted, and kawai dead-letters
// the mail `context-exhausted`, dead-letters queued direct mail, returns parked
// work to its group, writes no limit event, and releases the member through
// member release's readiness and archive path (tasks 4.2 and 4.3); then the
// decision note reaches whoever dispatched the work, once per episode (5.1).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
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
import { CONTEXT_EXHAUSTED_TAG } from '../team/exhaustionNotes'
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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-exhausted-')))
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
let runningTasks: Set<string>
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
  archive: id => { archived.push(id); records.get(id)!.archivedAt = new Date().toISOString(); return { ok: true } },
  hasLiveWorkers: id => liveWorkers.has(id),
  hasRunningBackgroundTasks: id => runningTasks.has(id),
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
  gitHead: async cwd => (cwd === featX ? 'head123' : null),
  usageOf: profileId => (profileId === 'glm'
    ? { status: 'allowed', receivedAt: '2026-10-18T08:00:00Z', windows: [{ key: 'five_hour', label: '5-hour', percentUsed: 91.6, resetsAt: '2026-10-18T10:00:00Z' }] } as never
    : null),
  onError: error => { runtimeErrors.push(error) },
  })
}
const trackAll = async () => Promise.all([...records.keys()].map(id => teams.track(id, records.get(id)!.projectPath)))
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
  db = schemaDb(':memory:')
  records = new Map()
  teams = new SessionTeams({ homeDir: dir })
  archived = []; liveWorkers = new Set(); runningTasks = new Set(); pendingCards = new Set(); received = []; spawnCalls = []
  runtime = makeRuntime()
  runtime.dispatcher.release()
})
afterEach(() => { runtime.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const FLAG = { at: '2026-10-18T08:28:01.000Z', reason: 'blocking_limit' }
const store = () => runtime.mailbox.store
/** Deliver group task mail to the member through a dispatch pass, its receipt confirmed. */
async function deliverGo(taskId: string) {
  const go = mail({ taskId, body: 'go' })
  await pass()
  expect(received.map(row => row.messageId)).toContain(go.id)
  store().markDelivered(go.id)
  return go
}
/** The failed turn: the manager flags the record, then runs the outcome. */
const exhaust = (sessionId: string) => {
  records.get(sessionId)!.contextExhausted = FLAG
  records.get(sessionId)!.status = 'waiting'
  return runtime.contextExhausted(sessionId)
}
const limitRows = () => (db.prepare('SELECT COUNT(*) AS n FROM profile_limit_events').get() as { n: number }).n

test('the incident: the go mail is dead-lettered, parked work returns to its group, no limit event, the member is released', async () => {
  const t = task(featX)
  records.set('dev-1', record('dev-1', { name: 'Dev one', projectPath: featX, spawned: true, taskId: t.id }))
  await trackAll()
  const go = await deliverGo(t.id)
  // Earlier work parked on the member, with its resume scheduled (a parked
  // holder takes no group mail, so it is parked after the go mail arrived).
  const earlier = mail({ taskId: t.id, body: 'earlier' })
  store().claim(earlier.id, 'dev-1'); store().markPushed(earlier.id); store().markDelivered(earlier.id)
  const resume = store().enqueue({ teamId: team.teamId, toKind: 'session', toId: 'dev-1', fromSession: 'dev-1', fromGroup: 'devs',
    originPath: featX, body: 'resume', tags: ['resume'], deliverAt: '2099-01-01T00:00:00.000Z' })
  store().park(earlier.id, '2099-01-01T00:00:00.000Z', resume.id)
  // Direct mail waiting behind the turn.
  const later = mail({ toKind: 'session', toId: 'dev-1', body: 'later', deliverAt: '2099-01-01T00:00:00.000Z' })

  const outcome = exhaust('dev-1')
  expect(store().get(go.id)).toMatchObject({ state: 'dead', reason: 'context-exhausted' })
  expect(store().eventsFor(go.id).at(-1)).toMatchObject({ kind: 'dead-lettered', prevState: 'delivered' })
  expect(store().get(later.id)).toMatchObject({ state: 'dead', reason: 'context-exhausted' })
  expect(store().get(earlier.id)).toMatchObject({ state: 'queued', toKind: 'group', toId: 'devs', claimedBy: null })
  expect(store().get(resume.id)?.state).toBe('cancelled')
  expect(limitRows()).toBe(0)
  expect(outcome).toMatchObject({ sessionId: 'dev-1', dropped: { id: go.id, state: 'dead' }, deadDirect: 1, markedForRelease: true })
  expect(outcome.released.map(row => row.id)).toEqual([earlier.id])
  expect(runtime.releases.pending()).toMatchObject([{ sessionId: 'dev-1', taskId: t.id, reason: 'context-exhausted', requestedBy: { kind: 'system' } }])

  await pass()
  expect(archived).toEqual(['dev-1'])
  const entry = runtime.tasks.store.journal(t.id).find(row => row.author.kind === 'system')
  expect(entry?.text).toBe('Released Dev one (dev-1): its context is exhausted (blocking_limit).')
})

test('mail whose receipt went unconfirmed at the failed turn is dead-lettered too', async () => {
  const t = task(featX)
  records.set('dev-1', record('dev-1', { projectPath: featX, spawned: true, taskId: t.id }))
  await trackAll()
  const go = mail({ taskId: t.id, body: 'go' })
  await pass()
  if (!store().get(go.id)?.pushedAt) store().markPushed(go.id)
  // No transcript row: the turn end holds it uncertain before the outcome runs.
  runtime.settleRecipient('dev-1')
  expect(store().get(go.id)?.state).toBe('uncertain')
  expect(exhaust('dev-1')).toMatchObject({ dropped: { id: go.id, state: 'dead', reason: 'context-exhausted' } })
  expect(store().eventsFor(go.id).at(-1)).toMatchObject({ kind: 'dead-lettered', prevState: 'uncertain' })
})

test('the outcome hands over the progress since the claim and the claim commit', async () => {
  const t = task(featX)
  records.set('dev-1', record('dev-1', { projectPath: featX, spawned: true, taskId: t.id }))
  await trackAll()
  const go = await deliverGo(t.id)
  store().setClaimCommit(go.id, 'abc1234')
  runtime.toolCall('dev-1', 'Edit', { file_path: 'src/a.ts' })
  expect(exhaust('dev-1')).toMatchObject({
    claimCommit: 'abc1234', progress: { toolCalls: 1, tools: ['Edit'], filesTouched: ['src/a.ts'] },
  })
})

test('parked direct work with no group to return to is dead-lettered', async () => {
  records.set('solo', record('solo', { projectPath: featX, groupId: null }))
  await trackAll()
  const direct = mail({ toKind: 'session', toId: 'solo' })
  store().claim(direct.id, 'solo'); store().markPushed(direct.id); store().markDelivered(direct.id)
  const resume = store().enqueue({ teamId: team.teamId, toKind: 'session', toId: 'solo', fromSession: 'solo', fromGroup: null,
    originPath: featX, body: 'resume', tags: ['resume'], deliverAt: '2099-01-01T00:00:00.000Z' })
  store().park(direct.id, '2099-01-01T00:00:00.000Z', resume.id)
  exhaust('solo')
  expect(store().get(direct.id)).toMatchObject({ state: 'dead', reason: 'context-exhausted', toKind: 'session', toId: 'solo' })
})

test('a running background task holds the release, and the pending row survives a restart', async () => {
  const t = task(featX)
  records.set('dev-1', record('dev-1', { projectPath: featX, spawned: true, taskId: t.id }))
  await trackAll()
  await deliverGo(t.id)
  runningTasks.add('dev-1')
  exhaust('dev-1')
  await pass()
  expect(archived).toEqual([])
  runtime.close()
  runtime = makeRuntime()
  runtime.dispatcher.release()
  await pass()
  expect(archived).toEqual([])
  expect(runtime.releases.pending().map(row => row.reason)).toEqual(['context-exhausted'])
  runningTasks.delete('dev-1')
  await pass()
  expect(archived).toEqual(['dev-1'])
})

test('human-created and task-less sessions are never marked; a cleared flag cancels the release', async () => {
  const t = task(featX)
  records.set('human-1', record('human-1', { projectPath: featX, taskId: t.id }))
  records.set('loose', record('loose', { projectPath: featY, spawned: true }))
  records.set('dev-1', record('dev-1', { projectPath: featX, spawned: true, taskId: t.id }))
  await trackAll()
  expect(exhaust('human-1').markedForRelease).toBe(false)
  expect(exhaust('loose').markedForRelease).toBe(false)
  runningTasks.add('dev-1')
  expect(exhaust('dev-1').markedForRelease).toBe(true)
  await pass()
  // The human ran /compact: the flag cleared before the member was ready.
  records.get('dev-1')!.contextExhausted = null
  runningTasks.delete('dev-1')
  await pass()
  expect(archived).toEqual([])
  expect(runtime.releases.pending()).toEqual([])
})

describe('the decision note (D6)', () => {
  /** A lead-dispatched task with a spawned dev holding the go mail. */
  async function leadDispatch() {
    writeGroup('leads', 'canCreateTasks: true')
    records.set('lead', record('lead', { name: 'Lead', groupId: 'leads' }))
    const t = await runtime.tasks.create({ kind: 'agent', sessionId: 'lead' }, { title: 'Export', direction: 'd', worktree: featX })
    records.set('dev-1', record('dev-1', { name: 'Dev one', projectPath: featX, spawned: true, taskId: t.id, claudeProfileId: 'glm' }))
    await trackAll()
    const dispatched = await runtime.assignments.dispatch({ kind: 'agent', sessionId: 'lead' }, {
      taskId: t.id, target: { kind: 'group', id: 'devs' }, instruction: 'go', requestKey: 'k-1',
    })
    await pass()
    const go = dispatched.message!
    store().markDelivered(go.id)
    store().setClaimCommit(go.id, 'abc1234')
    runtime.toolCall('dev-1', 'Edit', { file_path: 'src/a.ts' })
    return { t, go }
  }
  const notes = () => store().listForTeam(team.teamId).filter(row => row.tags.includes(CONTEXT_EXHAUSTED_TAG))

  test('the lead gets one normal-priority note with the facts to decide; a repeat sends none', async () => {
    const { t, go } = await leadDispatch()
    exhaust('dev-1')
    const note = await runtime.lastNote
    expect(note).toMatchObject({
      toKind: 'session', toId: 'lead', fromSession: 'lead', priority: 'normal', taskId: t.id, tags: [CONTEXT_EXHAUSTED_TAG],
    })
    for (const fact of [
      'Session Dev one (dev-1)', 'blocking_limit', `Dropped message: ${go.id} — dead-lettered context-exhausted`,
      '1 tool call (Edit); files touched: src/a.ts', 'Commit at claim: abc1234', 'HEAD now: head123',
      'Task revision 1: not acknowledged by it (its last acknowledgement: none)',
      '- glm: 5-hour 92% (resets 2026-10-18T10:00:00Z); not cooling.',
    ]) expect(note!.body).toContain(fact)
    expect(runtime.exhaustionNotes.episodes(team.teamId)).toMatchObject([
      { sessionId: 'dev-1', flaggedAt: FLAG.at, taskId: t.id, droppedId: go.id, recipientSession: 'lead', noteId: note!.id },
    ])
    // A repeated evaluation of the same episode sends nothing.
    exhaust('dev-1')
    expect(await runtime.lastNote).toBeNull()
    expect(notes()).toHaveLength(1)
  })

  test('an acknowledged revision and an unknown HEAD read as such', async () => {
    writeGroup('leads', 'canCreateTasks: true')
    records.set('lead', record('lead', { groupId: 'leads' }))
    const t = await runtime.tasks.create({ kind: 'agent', sessionId: 'lead' }, { title: 'Export', direction: 'd' })
    records.set('dev-2', record('dev-2', { projectPath: featY, spawned: true, taskId: t.id }))
    await trackAll()
    runtime.tasks.store.acknowledgements.record(t.id, 'dev-2', 1, null)
    exhaust('dev-2')
    const body = (await runtime.lastNote)!.body
    expect(body).toContain('Task revision 1: acknowledged by it.')
    expect(body).toContain('HEAD now: unknown')
    expect(body).toContain('Dropped message: none tracked.')
  })

  test.each([
    ['the human dispatched it', () => {}],
    ['the dispatcher is archived', () => { records.get('lead')!.archivedAt = 'gone' }],
    ['the dispatcher was killed', () => { records.delete('lead') }],
    ['the dispatcher is flagged too', () => { records.get('lead')!.contextExhausted = FLAG }],
  ] as const)('no note when %s', async (name, arrange) => {
    writeGroup('leads', 'canCreateTasks: true')
    records.set('lead', record('lead', { groupId: 'leads' }))
    const creator = name === 'the human dispatched it' ? { kind: 'human' as const, team } : { kind: 'agent' as const, sessionId: 'lead' }
    const t = await runtime.tasks.create(creator, { title: 'Export', direction: 'd' })
    records.set('dev-1', record('dev-1', { projectPath: featX, spawned: true, taskId: t.id }))
    await trackAll()
    arrange()
    exhaust('dev-1')
    expect(await runtime.lastNote).toBeNull()
    expect(notes()).toEqual([])
    expect(runtime.exhaustionNotes.episodes(team.teamId)).toMatchObject([{ sessionId: 'dev-1', recipientSession: null, noteId: null }])
  })
})
