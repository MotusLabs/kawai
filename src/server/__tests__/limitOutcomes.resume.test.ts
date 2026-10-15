// Resume handling of limit outcomes (team-mailbox-management): parked work
// cancelled mid-resume, and resume replacement on unpark, release, forward,
// and re-park. Split from limitOutcomes.test.ts to stay under 500 lines; the
// setup mirrors it.
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ChatSessionRecord } from '../db'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import { MailboxStore, type TeamMessage } from '../team/mailboxStore'
import { LimitEventStore } from '../team/routing/limitEvents'
import { LimitOutcomes } from '../team/routing/limitOutcomes'
import type { LimitOutcome, LimitOutcomeContext } from '../../shared/routing'

const T0 = Date.parse('2026-10-12T12:00:00.000Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

let now: number
let db: Database
let store: MailboxStore
let limits: LimitEventStore
let outcomes: LimitOutcomes
let records: Map<string, ChatSessionRecord>
let groups: Map<string, GroupDefinition>
let ruleOnLimit: ((ctx: LimitOutcomeContext) => Promise<LimitOutcome>) | null

const group = (id: string) => {
  const parsed = parseGroupFile(id, '---\n\n---\nWork.')
  if (!parsed.ok) throw new Error(parsed.error)
  groups.set(id, parsed.group)
}
const record = (sessionId: string, extra: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId, name: `name-${sessionId}`, projectPath: '/repo', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  groupId: 'devs', claudeProfileId: 'glm', ...extra,
})

beforeEach(() => {
  now = T0
  db = schemaDb(':memory:')
  store = new MailboxStore(db)
  limits = new LimitEventStore(db, () => now)
  records = new Map([['dev', record('dev')], ['lead', record('lead', { groupId: 'leads' })]])
  groups = new Map()
  group('devs')
  group('architects')
  ruleOnLimit = null
  outcomes = new LimitOutcomes(db, {
    store, limits,
    rules: { rule: () => (ruleOnLimit ? { hasOnLimit: true, onLimit: ruleOnLimit } as never : undefined) },
    getRecord: id => records.get(id),
    teamOf: id => (records.has(id) ? 'team' : undefined),
    groupOf: (_sessionId, groupId) => groups.get(groupId),
    taskTitle: id => (id === 'task-1' ? 'Export CSV' : null),
    targetWorktree: message => message.taskId === 'task-1' ? '/repo/worktree' : null,
    restoreSession: id => { records.get(id)!.archivedAt = null },
    onError: error => { throw error },
    now: () => now,
  })
})
afterEach(() => db.close())

/** Group mail claimed and delivered to `sessionId` as its current turn. */
function deliver(sessionId = 'dev'): TeamMessage {
  const message = store.enqueue({
    teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo',
    body: 'Build the export', taskId: 'task-1',
  })
  store.claim(message.id, sessionId); store.markPushed(message.id); store.markDelivered(message.id)
  outcomes.delivered(sessionId, store.get(message.id)!)
  return store.get(message.id)!
}

/** A final limit event during the session's turn, then the turn's end. */
async function hitLimit(resetInMs: number | null, sessionId = 'dev', profileId = 'glm') {
  limits.record({
    profileId, sessionId, groupId: 'devs', kind: 'rate_limit', final: true, status: 429, message: 'API Error: 429 quota',
    resetsAt: resetInMs === null ? null : iso(now + resetInMs),
  })
  await outcomes.turnEnded(sessionId, true)
}

const work = (sessionId = 'dev', calls = 2) => {
  for (let i = 0; i < calls; i++) outcomes.toolCall(sessionId, i % 2 ? 'Edit' : 'Read', { file_path: `src/f${i}.ts` })
}

describe('parked work cancelled mid-resume (team-mailbox-management)', () => {
  /** Parked work whose resume turn has started (the resume is delivered). */
  async function resuming() {
    const m = deliver()
    work()
    await hitLimit(40 * MIN)
    const resumeId = store.get(m.id)!.resumeMessageId!
    store.claim(resumeId, 'dev'); store.markPushed(resumeId); store.markDelivered(resumeId)
    outcomes.delivered('dev', store.get(resumeId)!)
    return { m, resumeId }
  }
  const mailCount = () => store.listForTeam('team').length
  const manager = { kind: 'agent', sessionId: 'lead' } as const

  test('a cancel during the resume turn is refused; the limit again re-parks with a fresh resume and a second cancel succeeds', async () => {
    const { m, resumeId } = await resuming()
    expect(store.cancelResult(m.id, manager, 'x')).toMatchObject({ ok: false, code: 'resume-in-flight', holder: 'dev' })
    await hitLimit(40 * MIN)
    const reparked = store.get(m.id)!
    expect(reparked).toMatchObject({ state: 'parked', parkCount: 2 })
    expect(reparked.resumeMessageId).not.toBe(resumeId)
    expect(store.get(resumeId)?.state).toBe('delivered')
    expect(store.cancel(m.id, manager, 'now')).toBe(true)
    expect(store.get(reparked.resumeMessageId!)?.state).toBe('cancelled')
    expect(store.get(m.id)?.state).toBe('cancelled')
  })

  test('work forced to cancelled during its resume turn is dropped: no park, forward, or resume mail', async () => {
    const { m } = await resuming()
    db.prepare("UPDATE team_messages SET state = 'cancelled' WHERE id = ?").run(m.id)
    const before = mailCount()
    await hitLimit(40 * MIN)
    expect(store.get(m.id)).toMatchObject({ state: 'cancelled', parkCount: 1 })
    expect(mailCount()).toBe(before)
    expect(store.parkedBy('dev')).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_handoff_notes').get()).toEqual({ n: 0 })
  })

  test('a successful turn leaves forced-cancelled work cancelled', async () => {
    const { m } = await resuming()
    db.prepare("UPDATE team_messages SET state = 'cancelled' WHERE id = ?").run(m.id)
    work('dev', 1)
    await outcomes.turnEnded('dev', true)
    expect(store.get(m.id)?.state).toBe('cancelled')
  })

  test('work settled while the onLimit rule is still running is respected', async () => {
    const { m } = await resuming()
    let finishRule!: (value: LimitOutcome) => void
    ruleOnLimit = () => new Promise(resolve => { finishRule = resolve })
    const pending = hitLimit(40 * MIN)
    db.prepare("UPDATE team_messages SET state = 'cancelled' WHERE id = ?").run(m.id)
    const before = mailCount()
    finishRule({ type: 'park' })
    await pending
    expect(store.get(m.id)?.state).toBe('cancelled')
    expect(mailCount()).toBe(before)
  })
})

describe('resume replacement leaves no live resume (team-mailbox-management S1/S2)', () => {
  const liveResumes = () => store.listForTeam('team').filter(row => row.tags.includes('resume') && ['queued', 'awaiting-request'].includes(row.state))

  test('unpark by a successful turn cancels the linked resume', async () => {
    const m = deliver(); work()
    await hitLimit(40 * MIN)
    const resumeId = store.get(m.id)!.resumeMessageId!
    await outcomes.turnEnded('dev', true)
    expect(store.get(m.id)).toMatchObject({ state: 'delivered', resumeMessageId: null })
    expect(store.get(resumeId)?.state).toBe('cancelled')
    expect(liveResumes()).toEqual([])
  })

  test('release after the third park cancels the linked resume', async () => {
    const m = deliver(); work()
    for (let round = 1; round <= 3; round++) {
      await hitLimit(10 * MIN)
      const resumeId = store.get(m.id)!.resumeMessageId!
      store.claim(resumeId, 'dev'); store.markPushed(resumeId); store.markDelivered(resumeId)
      outcomes.delivered('dev', store.get(resumeId)!)
    }
    await hitLimit(10 * MIN)
    expect(store.get(m.id)).toMatchObject({ state: 'queued', resumeMessageId: null })
    expect(liveResumes()).toEqual([])
  })

  test('forwarding parked work cancels the linked resume', async () => {
    const m = deliver(); work()
    await hitLimit(40 * MIN)
    const resumeId = store.get(m.id)!.resumeMessageId!
    outcomes.handOff(m.id, { kind: 'group', id: 'architects' })
    expect(store.get(m.id)).toMatchObject({ state: 'forwarded', resumeMessageId: null })
    expect(store.get(resumeId)?.state).toBe('cancelled')
    expect(liveResumes()).toEqual([])
  })

  test('re-parking leaves a delivered old resume alone and links a fresh one', async () => {
    const m = deliver(); work()
    await hitLimit(40 * MIN)
    const oldId = store.get(m.id)!.resumeMessageId!
    store.claim(oldId, 'dev'); store.markPushed(oldId); store.markDelivered(oldId)
    outcomes.delivered('dev', store.get(oldId)!)
    await hitLimit(40 * MIN)
    const fresh = store.get(m.id)!.resumeMessageId!
    expect(fresh).not.toBe(oldId)
    expect(store.get(oldId)?.state).toBe('delivered')
    expect(store.get(fresh)?.state).toBe('queued')
  })
})
