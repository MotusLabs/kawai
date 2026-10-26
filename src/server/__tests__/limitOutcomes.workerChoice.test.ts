// A worker choice across limit outcomes (dispatch-worker-choice D4, task
// 2.5): a forward drops the choice and still excludes the limited worker; a
// release returns the original message to its group with its choice intact.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../db'
import { MailboxStore, type TeamMessage } from '../team/mailboxStore'
import { LimitEventStore } from '../team/routing/limitEvents'
import { LimitOutcomes } from '../team/routing/limitOutcomes'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import type { LimitOutcome, LimitOutcomeContext } from '../../shared/routing'
import { schemaDb } from './schemaDb'

const MIN = 60_000
const T0 = Date.parse('2026-10-17T08:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

let db: Database
let store: MailboxStore
let limits: LimitEventStore
let outcomes: LimitOutcomes
let records: Map<string, ChatSessionRecord>
let groups: Map<string, GroupDefinition>
/** A group rule's onLimit, when the test installs one. */
let onLimit: ((ctx: LimitOutcomeContext) => Promise<LimitOutcome>) | null

const group = (id: string, frontmatter = '') => {
  const parsed = parseGroupFile(id, `---\n${frontmatter}\n---\nWork.`)
  if (!parsed.ok) throw new Error(parsed.error)
  groups.set(id, parsed.group)
}
const record = (sessionId: string, extra: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId, name: `name-${sessionId}`, projectPath: '/repo', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  groupId: 'devs', claudeProfileId: 'glm', ...extra,
})

beforeEach(() => {
  db = schemaDb(':memory:')
  store = new MailboxStore(db)
  limits = new LimitEventStore(db, () => T0)
  records = new Map([['dev', record('dev')], ['lead', record('lead', { groupId: 'leads' })]])
  groups = new Map()
  onLimit = null
  outcomes = new LimitOutcomes(db, {
    store, limits,
    rules: { rule: () => (onLimit ? { hasOnLimit: true, onLimit } as never : undefined) },
    getRecord: id => records.get(id),
    teamOf: id => (records.has(id) ? 'team' : undefined),
    groupOf: (_sessionId, groupId) => groups.get(groupId),
    taskTitle: () => null,
    targetWorktree: () => null,
    restoreSession: id => { records.get(id)!.archivedAt = null },
    onError: error => { throw error },
    now: () => T0,
  })
})
afterEach(() => db.close())

/** Delivers `worker: zai` mail to the glm dev, then ends its turn on a final zai limit 6 h out. */
async function limitedChoice(): Promise<TeamMessage> {
  const message = store.enqueue({
    teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo',
    body: 'Implement api', taskId: 'task-1', workerChoice: 'zai',
  })
  store.claim(message.id, 'dev'); store.markPushed(message.id); store.markDelivered(message.id)
  outcomes.delivered('dev', store.get(message.id)!)
  // Progress, so `otherwise` decides rather than the no-progress release.
  outcomes.toolCall('dev', 'Edit', { file_path: 'src/a.ts' })
  outcomes.toolCall('dev', 'Read', { file_path: 'src/b.ts' })
  limits.record({
    profileId: 'glm', sessionId: 'dev', groupId: 'devs', kind: 'rate_limit', final: true, status: 429,
    message: 'API Error: 429 quota', resetsAt: iso(T0 + 6 * 60 * MIN), providerId: null, window: null,
  })
  await outcomes.turnEnded('dev', true)
  return message
}

describe('a worker choice across limit outcomes (2.5)', () => {
  // @covers: agent-mailbox › A worker choice does not survive a limit forward › Chosen provider hits its limit
  test('a forward carries no choice and still excludes the limited worker', async () => {
    group('devs', 'onLimit: { otherwise: forward }')
    const message = await limitedChoice()
    expect(store.get(message.id)).toMatchObject({ state: 'forwarded', workerChoice: 'zai' })
    const forwardedId = store.get(message.id)!.reason!.replace('forwarded: ', '')
    const forwarded = store.get(forwardedId)!
    expect(forwarded).toMatchObject({ state: 'queued', toId: 'devs', excludedProfile: 'glm' })
    // An absent choice reads as no key at all, exactly like mail sent without one (1.3).
    expect('workerChoice' in forwarded).toBe(false)
  })

  test('a release returns the original message to its group with its choice', async () => {
    group('devs', 'onLimit: { otherwise: release }')
    const message = await limitedChoice()
    expect(store.get(message.id)).toMatchObject({ state: 'queued', toKind: 'group', toId: 'devs', workerChoice: 'zai' })
  })

  // @covers: team-routing-rules › Rules see the worker choice › Rule reads the choice
  test('the onLimit rule sees the choice (2.6)', async () => {
    group('devs')
    const seen: LimitOutcomeContext[] = []
    onLimit = async ctx => { seen.push(ctx); return { type: 'release' } }
    await limitedChoice()
    expect(seen.map(ctx => ctx.message.worker)).toEqual(['zai'])
  })
})
