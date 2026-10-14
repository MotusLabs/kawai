// Team member release races (team-member-release review F1, F2, F4, and the
// late-spawn mark's failure retry): a MemberRelease driven directly over
// in-memory stores, so a test can pause the definition resolver
// mid-transition and mutate the mailbox, the roster, or the task underneath
// it — and inject a failing store or an archive that refuses.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../db'
import { logger } from '../logger'
import { MailboxStore, type EnqueueInput } from '../team/mailboxStore'
import { MemberRelease, type MemberReleaseOptions } from '../team/memberRelease'
import { TaskStore } from '../team/taskStore'
import type { TeamIdentity } from '../team/teamIdentity'

const team = { teamId: 'team', groupsRoot: '' } as unknown as TeamIdentity
const featX = '/repo/feat-x'

let db: Database
let store: MailboxStore
let tasks: TaskStore
let records: Map<string, ChatSessionRecord>

const record = (sessionId: string, extra: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId, name: sessionId, projectPath: '/repo', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  groupId: 'devs', ...extra,
})
const task = () => tasks.create({ teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'human', sessionId: null }, worktree: featX })
const mail = (extra: Partial<EnqueueInput> = {}) =>
  store.enqueue({ teamId: team.teamId, toKind: 'group', toId: 'devs', fromSession: null, fromGroup: null, originPath: '/repo', body: 'work', ...extra })
/** Let the hook reach its definition await. */
const suspended = () => new Promise(resolve => setImmediate(resolve))

/** A release over this file's stores; by default every member is settled and every archive succeeds. */
const makeReleases = (overrides: Partial<MemberReleaseOptions> = {}) => new MemberRelease(db, {
  store, tasks,
  records: () => records.values(), getRecord: id => records.get(id),
  teamOf: id => (records.has(id) ? team : undefined),
  definition: async () => undefined,
  cachedDefinition: () => undefined,
  recipient: () => ({ idle: true, pendingRequest: false }),
  hasLiveWorkers: () => false,
  hasRunningBackgroundTasks: () => false,
  archive: () => ({ ok: true }),
  notify: () => {},
  ...overrides,
})

/** A definition resolver that stays pending until `release()`. */
const pausedDefinitions = () => {
  let release!: () => void
  const definition: MemberReleaseOptions['definition'] = () => new Promise(resolve => { release = () => resolve(undefined) })
  return { definition, release: () => release() }
}

beforeEach(() => {
  db = new Database(':memory:')
  store = new MailboxStore(db)
  tasks = new TaskStore(db, store)
  records = new Map()
})
afterEach(() => { db.close() })

test('the close transition re-reads state at the commit: a claim during the await survives, a late member is marked (F1)', async () => {
  const t = task()
  const instruction = mail({ taskId: t.id })
  records.set('dev-1', record('dev-1', { projectPath: featX, spawned: true, taskId: t.id }))
  const paused = pausedDefinitions()
  const releases = makeReleases({ definition: paused.definition })
  const hook = releases.transitionHook(t, 'done', { kind: 'human', sessionId: null })
  await suspended()
  // While the hook awaits the group definitions, the instruction is claimed
  // and pushed (a dispatch pass won it) and a second spawned member appears.
  store.claim(instruction.id, 'dev-1')
  store.markPushed(instruction.id)
  records.set('dev-2', record('dev-2', { name: 'Dev two', projectPath: featX, spawned: true, taskId: t.id }))
  paused.release()
  ;(await hook)()
  // The claimed instruction was already delivered as a turn: it survives.
  expect(store.get(instruction.id)).toMatchObject({ state: 'claimed', claimedBy: 'dev-1', pushedAt: expect.any(String) })
  // Both live spawned members — including the one created during the await — are marked.
  expect(releases.pending().map(row => row.sessionId).sort()).toEqual(['dev-1', 'dev-2'])
})

test('a late-spawn mark is synchronous: an opted-out group is marked, then kept by the next cycle (F2, no await window)', async () => {
  const t = task()
  tasks.setStatus(t.id, 'done')
  records.set('spawned-9', record('spawned-9', { groupId: 'qa', projectPath: featX, spawned: true, taskId: t.id }))
  const archived: string[] = []
  const releases = makeReleases({
    cachedDefinition: (_team, groupId) => (groupId === 'qa' ? { releaseOnTaskClose: false } as never : undefined),
    archive: id => { archived.push(id); return { ok: true } },
  })
  // No definition load, so no reopen can slip in between check and write.
  expect(releases.markSpawnedForClosedTask('spawned-9', t.id)).toBe(true)
  expect(releases.pending().map(row => row.sessionId)).toEqual(['spawned-9'])
  // The cycle reads the current file before any archive: the opt-out keeps it.
  await releases.evaluate()
  expect(releases.pending()).toEqual([])
  expect(archived).toEqual([])
})

test('a failed late-spawn mark is logged with both ids and retried until it lands (MM LOW 3)', () => {
  const t = task()
  tasks.setStatus(t.id, 'done')
  records.set('spawned-9', record('spawned-9', { projectPath: featX, spawned: true, taskId: t.id }))
  const releases = makeReleases()
  const get = tasks.get.bind(tasks)
  let failures = 2
  tasks.get = id => { if (failures > 0) { failures -= 1; throw new Error('database is locked') } return get(id) }
  const warn = spyOn(logger, 'warn').mockImplementation(() => {})
  try {
    releases.markLateSpawn('spawned-9', t.id)
    expect(warn).toHaveBeenLastCalledWith('member_release_mark_failed', { sessionId: 'spawned-9', taskId: t.id, error: 'database is locked' })
    expect(releases.pending()).toEqual([])
    expect(releases.nextLateMarkRetryAt()).toBeGreaterThan(Date.now())
    // A cycle that fails again keeps it outstanding; the next one lands it.
    releases.retryLateMarks()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(releases.pending()).toEqual([])
    releases.retryLateMarks()
    expect(releases.pending().map(row => row.sessionId)).toEqual(['spawned-9'])
    expect(releases.nextLateMarkRetryAt()).toBeNull()
  } finally {
    warn.mockRestore()
  }
})

test('a refused archive journals no release: the row drops and release_member reports the error (F4)', async () => {
  const t = task()
  records.set('dev-1', record('dev-1', { projectPath: featX, spawned: true, taskId: t.id }))
  records.set('lead-1', record('lead-1', { groupId: 'leads' }))
  const releases = makeReleases({ archive: () => ({ ok: false, error: 'Unknown chat session dev-1' }) })
  let refusal = ''
  try { await releases.releaseByAgent('lead-1', 'dev-1') } catch (error) { refusal = String(error) }
  expect(refusal).toContain('could not be archived: Unknown chat session dev-1')
  tasks.setStatus(t.id, 'done', await releases.transitionHook(t, 'done', { kind: 'human', sessionId: null }))
  expect(releases.pending().map(row => row.sessionId)).toEqual(['dev-1'])
  await releases.evaluate()
  expect(releases.pending()).toEqual([])
  expect(tasks.journal(t.id).map(entry => entry.text)).toEqual(['Task done.'])
})

test('a group first seen during the close await is left to the next cycle: an unscoped group keeps its mail', async () => {
  const t = task()
  records.set('dev-1', record('dev-1', { projectPath: featX, spawned: true, taskId: t.id }))
  const leads = { worktreeScoped: false } as never
  const paused = pausedDefinitions()
  const releases = makeReleases({
    definition: paused.definition,
    cachedDefinition: (_team, groupId) => (groupId === 'leads' ? leads : undefined),
    recipient: () => ({ idle: false, pendingRequest: false }),
  })
  const hook = releases.transitionHook(t, 'done', { kind: 'human', sessionId: null })
  await suspended()
  // The unscoped group's first waiting row arrives while the hook awaits.
  const late = mail({ toId: 'leads', taskId: t.id })
  paused.release()
  tasks.setStatus(t.id, 'done', await hook)
  expect(store.get(late.id)?.state).toBe('queued')
  // The next cycle reads the current file: worktreeScoped: false keeps it.
  await releases.evaluate()
  expect(store.get(late.id)?.state).toBe('queued')
})
