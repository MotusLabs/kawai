// Plan roles in routing (plan-execution D15, §9): `allowed_profiles` stored
// on system mail and kept by a forward without the limited profile; the
// member exclusion and waiting reason for a profile outside the role; and
// the candidate/spawn narrowing. The router-level rule test (an
// author-profile tag steering the review) lives in routingRouter.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import { LimitEventStore } from '../team/routing/limitEvents'
import { LimitOutcomes } from '../team/routing/limitOutcomes'
import { memberExclusions } from '../team/memberCauses'
import { orderConstraints } from '../team/waitingReasons'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import type { TeamMessage } from '../team/mailboxStore'
import { schemaDb } from './schemaDb'

const MIN = 60_000
const T0 = Date.parse('2026-10-17T08:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

let db: Database
let store: MailboxStore
let limits: LimitEventStore
let outcomes: LimitOutcomes
let now: number
let records: Map<string, ChatSessionRecord>
let groups: Map<string, GroupDefinition>
let errors: unknown[]

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
  now = T0
  db = schemaDb(':memory:')
  store = new MailboxStore(db)
  limits = new LimitEventStore(db, () => now)
  records = new Map([['dev', record('dev')], ['lead', record('lead', { groupId: 'leads' })]])
  groups = new Map()
  group('devs')
  errors = []
  outcomes = new LimitOutcomes(db, {
    store, limits,
    rules: { rule: () => undefined },
    getRecord: id => records.get(id),
    teamOf: id => (records.has(id) ? 'team' : undefined),
    groupOf: (_sessionId, groupId) => groups.get(groupId),
    taskTitle: () => null,
    targetWorktree: () => null,
    restoreSession: id => { records.get(id)!.archivedAt = null },
    onError: error => errors.push(error),
    now: () => now,
  })
})
afterEach(() => db.close())

const systemMail = (over: Partial<Parameters<MailboxStore['enqueue']>[0]> = {}): TeamMessage => store.enqueue({
  teamId: 'team', toKind: 'group', toId: 'devs', fromKind: 'system', fromSession: null, fromGroup: null, originPath: '/repo',
  body: 'Implement api', taskId: 'task-1', allowedProfiles: ['sonnet', 'glm'], ...over,
})

describe('9.1 allowed_profiles on the row', () => {
  test('stored on system mail, in the role\'s order; absent on ordinary mail', () => {
    expect(systemMail().allowedProfiles).toEqual(['sonnet', 'glm'])
    expect(systemMail({ allowedProfiles: null }).allowedProfiles).toBeNull()
    const ordinary = store.enqueue({
      teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo', body: 'plain',
    })
    expect(ordinary.allowedProfiles).toBeNull()
  })

  test('a forward keeps the role without the limited profile', async () => {
    const message = systemMail()
    store.claim(message.id, 'dev'); store.markPushed(message.id); store.markDelivered(message.id)
    outcomes.delivered('dev', store.get(message.id)!)
    outcomes.toolCall('dev', 'Edit', { file_path: 'src/a.ts' })
    outcomes.toolCall('dev', 'Read', { file_path: 'src/b.ts' })
    limits.record({
      profileId: 'glm', sessionId: 'dev', groupId: 'devs', kind: 'rate_limit', final: true, status: 429,
      message: 'API Error: 429 quota', resetsAt: iso(now + 6 * 60 * MIN), providerId: null, window: null,
    })
    await outcomes.turnEnded('dev', true)
    const forwardedId = store.get(message.id)!.reason!.replace('forwarded: ', '')
    expect(store.get(forwardedId)).toMatchObject({ allowedProfiles: ['sonnet'], excludedProfile: 'glm' })
  })
})

describe('9.3 the outside-role exclusion and its reason', () => {
  const recipient = (profileId: string) => ({
    sessionId: 'dev', teamId: 'team', groupId: 'devs', profileId, idle: true, pendingRequest: false, available: true,
    worktree: '/repo', cooldownUntil: null, parked: false,
  })

  test('a member outside the role names the role\'s profiles; one inside has no cause', () => {
    const message = { ...systemMail(), toKind: 'group' } as TeamMessage
    const outside = memberExclusions(recipient('mimo'), message, { targetWorktree: null, now: T0, startupFailed: false })
    expect(outside).toEqual([{ sessionId: 'dev', kind: 'outside-role', detail: 'plan role allows only sonnet, glm' }])
    const inside = memberExclusions(recipient('glm'), message, { targetWorktree: null, now: T0, startupFailed: false })
    expect(inside).toEqual([])
  })

  test('the constraint sorts with the member facts, before profile cooling', () => {
    const ordered = orderConstraints([
      { kind: 'profile-cooling', retryAt: iso(T0 + MIN) },
      { kind: 'outside-role', detail: 'plan role allows only sonnet, glm' },
    ])
    expect(ordered.map(entry => entry.kind)).toEqual(['outside-role', 'profile-cooling'])
  })
})
