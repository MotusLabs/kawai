// Team member release races (team-member-release review F1, F2, F4): a
// MemberRelease driven directly over in-memory stores, so a test can pause
// the definition resolver mid-transition and mutate the mailbox, the roster,
// or the task underneath it — and inject an archive that refuses.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../db'
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

test('markSpawnedForClosedTask re-checks after the await: a reopen during the definition load marks nothing (F2)', async () => {
  const t = task()
  tasks.setStatus(t.id, 'done')
  records.set('spawned-9', record('spawned-9', { projectPath: featX, spawned: true, taskId: t.id }))
  const paused = pausedDefinitions()
  const releases = makeReleases({ definition: paused.definition })
  const marking = releases.markSpawnedForClosedTask('spawned-9', t.id)
  await suspended()
  // The task is reopened while the definition load is suspended.
  tasks.setStatus(t.id, 'active')
  paused.release()
  await marking
  expect(releases.pending()).toEqual([])
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
