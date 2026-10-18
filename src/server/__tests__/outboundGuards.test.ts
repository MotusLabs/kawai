// One test per guard of the audit store and service (execution-safety-
// recovery D9/D10; task rev 2): the header counts count rows — not groups —
// of one team; acknowledgement commands are team-scoped and a repeat writes
// nothing; every page filter narrows; the counts ride the range; rows carry
// their outcome detail, live-spawn pending, named session, and parsed
// matches; the window sum adds rows over every rule; and acknowledge trims
// and bounds its command id and note. Each assertion is exact.
import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { OutboundStore, type OutboundCallInsert } from '../outbound/store'
import { OutboundService, type OutboundAuditBackups } from '../outbound/service'
import type { TeamIdentity } from '../team/teamIdentity'
import { schemaDb } from './schemaDb'
import type { OutboundMatch } from '../../shared/outbound'

const open: Database[] = []
afterEach(() => { for (const db of open.splice(0)) db.close() })

const team = (teamId: string) => ({ teamId }) as TeamIdentity
const MATCH: OutboundMatch = { rule: 'gh-write', segment: 'gh issue create -R other/repo', verdict: 'violation', destination: 'github:other/repo' }

function harness(options: { spawnLive?: boolean; backups?: OutboundAuditBackups | null } = {}) {
  const db = schemaDb()
  open.push(db)
  const store = new OutboundStore(db)
  const commits: string[] = []
  const service = new OutboundService({
    store,
    sessionOf: (_teamId, sessionId) => ({ name: `name of ${sessionId}`, clickable: sessionId === 'chat-live' }),
    spawnLive: () => options.spawnLive ?? false,
    ...(options.backups !== undefined ? { backups: () => options.backups ?? null } : {}),
    onCommit: teamId => commits.push(teamId),
  })
  let seq = 0
  const insert = (overrides: Partial<OutboundCallInsert> = {}) => {
    seq += 1
    const row: OutboundCallInsert = {
      id: `obc-${seq}`, teamId: 't1', sessionId: 'chat-1', spawnId: 'sp-1', tool: 'Bash', toolUseId: `tu-${seq}`,
      command: 'gh issue create -R other/repo', truncated: false, rule: 'gh-write', verdict: 'violation',
      destination: 'github:other/repo', matches: '[]', classifierVersion: 3, cwd: '/repo',
      createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`, ...overrides,
    }
    expect(store.insertCall(row)).toBe(true)
    return row
  }
  return { store, service, commits, insert }
}

describe('the store', () => {
  test('counts count rows of one team, per verdict and allowed rule', () => {
    const h = harness()
    for (const teamId of ['t1', 't1', 't2']) {
      h.insert({ teamId, verdict: 'allowed', rule: 'git-push', destination: 'github:origin' })
      h.insert({ teamId, verdict: 'unknown-destination', rule: 'curl', destination: 'example.internal' })
      h.insert({ teamId, verdict: 'violation' })
    }
    expect(h.store.counts('t1')).toEqual({ allowedPerRule: { 'git-push': 2 }, unknown: 2, violations: 2, unacknowledgedViolations: 2 })
    expect(h.store.counts('t2')).toEqual({ allowedPerRule: { 'git-push': 1 }, unknown: 1, violations: 1, unacknowledgedViolations: 1 })
  })

  test('a repeat of a command id inserts nothing and returns null', () => {
    const h = harness()
    const ack = {
      id: 'oba-1', teamId: 't1', commandId: 'cmd-1', rule: 'gh-write', destination: 'github:other/repo',
      throughCreatedAt: '2026-01-01T00:00:01.000Z', throughCallId: 'obc-1', acknowledgedAt: '2026-01-02T00:00:00.000Z',
    }
    expect(h.store.insertAcknowledgement(ack)).toEqual(ack)
    expect(h.store.insertAcknowledgement({ ...ack, id: 'oba-2' })).toBeNull()
    expect(h.store.acknowledgementByCommand('t1', 'cmd-1')!.id).toBe('oba-1')
  })

  test("another team's command id is not this team's: acknowledge writes fresh", () => {
    const h = harness()
    h.insert({ teamId: 't2' })
    const mine = h.insert({ teamId: 't1' })
    h.store.insertAcknowledgement({
      id: 'oba-other', teamId: 't2', commandId: 'cmd-shared', rule: 'gh-write', destination: 'github:other/repo',
      throughCreatedAt: '2026-01-01T00:00:01.000Z', throughCallId: 'obc-1', acknowledgedAt: '2026-01-02T00:00:00.000Z',
    })
    expect(h.store.acknowledgementByCommand('t1', 'cmd-shared')).toBeNull()
    expect(h.service.acknowledge({ kind: 'human', team: team('t1') }, { callId: mine.id, commandId: 'cmd-shared' })).toEqual({ ok: true, replayed: false })
    expect(h.store.acknowledgementByCommand('t1', 'cmd-shared')!.throughCallId).toBe(mine.id)
  })
})

describe('service.page', () => {
  test('each filter narrows the rows', () => {
    const h = harness()
    h.insert({ id: 'a', verdict: 'allowed', rule: 'git-push', destination: 'github:origin', sessionId: 'chat-a', createdAt: '2026-01-01T00:00:00.000Z' })
    h.insert({ id: 'b', verdict: 'violation', rule: 'gh-write', destination: 'github:other/repo', sessionId: 'chat-b', createdAt: '2026-01-02T00:00:00.000Z' })
    h.insert({ id: 'c', verdict: 'violation', rule: 'gh-write', destination: 'github:third/repo', sessionId: 'chat-a', createdAt: '2026-01-03T00:00:00.000Z' })
    const ids = (filters: Parameters<OutboundService['page']>[1]) => h.service.page('t1', filters).rows.map(row => row.id)
    expect(ids({})).toEqual(['c', 'b', 'a'])
    expect(ids({ verdict: 'allowed' })).toEqual(['a'])
    expect(ids({ rule: 'gh-write' })).toEqual(['c', 'b'])
    expect(ids({ destination: 'github:other/repo' })).toEqual(['b'])
    expect(ids({ sessionId: 'chat-a' })).toEqual(['c', 'a'])
    expect(ids({ from: '2026-01-02T00:00:00.000Z' })).toEqual(['c', 'b'])
    expect(ids({ to: '2026-01-02T00:00:00.000Z' })).toEqual(['a'])
  })

  test('the header counts ride the range only, never the other filters', () => {
    const h = harness()
    h.insert({ verdict: 'allowed', rule: 'git-push', createdAt: '2026-01-01T00:00:00.000Z' })
    h.insert({ verdict: 'violation', createdAt: '2026-01-02T00:00:00.000Z' })
    h.insert({ verdict: 'violation', createdAt: '2026-01-03T00:00:00.000Z' })
    expect(h.service.page('t1', { verdict: 'allowed', from: '2026-01-02T00:00:00.000Z', to: '2026-01-03T00:00:00.000Z' }).counts)
      .toEqual({ allowedPerRule: {}, unknown: 0, violations: 1, unacknowledgedViolations: 1 })
  })

  test('the backup footer reads the status; without a source it is null', () => {
    const backups: OutboundAuditBackups = { dir: '/b', newest: [], failures: [] }
    expect(harness({ backups }).service.page('t1', {}).backups).toEqual(backups)
    expect(harness().service.page('t1', {}).backups).toBeNull()
  })

  test('a row carries its outcome detail, its named session, and its parsed matches', () => {
    const h = harness()
    h.insert({ id: 'r', sessionId: 'chat-live', toolUseId: 'tu-r', matches: JSON.stringify([MATCH, 5, { other: 1 }]) })
    h.insert({ id: 'bad', matches: 'not json' })
    h.store.insertOutcome({ sessionId: 'chat-live', toolUseId: 'tu-r', outcome: 'failed', detail: 'exit 1', createdAt: '2026-01-02T00:00:00.000Z' })
    const [bad, r] = h.service.page('t1', {}).rows
    expect(r).toMatchObject({ id: 'r', outcome: { state: 'failed', detail: 'exit 1' }, session: { id: 'chat-live', name: 'name of chat-live', clickable: true } })
    expect(r!.matches).toEqual([MATCH])
    expect(bad!.matches).toEqual([])
    expect(bad!.outcome).toEqual({ state: 'outcome-unknown' })
  })

  test('a settled-less call reads pending while its spawn lives', () => {
    const h = harness({ spawnLive: true })
    h.insert()
    expect(h.service.page('t1', {}).rows[0]!.outcome).toEqual({ state: 'pending' })
  })
})

test('the window counts add allowed rows over every rule', () => {
  const h = harness()
  h.insert({ verdict: 'allowed', rule: 'git-push' })
  h.insert({ verdict: 'allowed', rule: 'git-push' })
  h.insert({ verdict: 'allowed', rule: 'gh-pr' })
  expect(h.service.windowCounts('t1', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')).toEqual({ allowed: 3, unknown: 0, violations: 0 })
})

describe('acknowledge input', () => {
  test('a blank command id is refused and writes nothing; the id is trimmed', () => {
    const h = harness()
    const call = h.insert()
    const human = { kind: 'human' as const, team: team('t1') }
    expect(h.service.acknowledge(human, { callId: call.id, commandId: '   ' })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(h.store.unacknowledgedViolations('t1')).toHaveLength(1)
    expect(h.service.acknowledge(human, { callId: call.id, commandId: ' cmd-1 ' })).toEqual({ ok: true, replayed: false })
    expect(h.service.acknowledge(human, { callId: call.id, commandId: 'cmd-1' })).toEqual({ ok: true, replayed: true })
    expect(h.commits).toEqual(['t1'])
  })

  test('a resend naming another call is a payload refusal, judged before the call is read', () => {
    const h = harness()
    const violation = h.insert()
    const allowed = h.insert({ verdict: 'allowed', rule: 'git-push' })
    const human = { kind: 'human' as const, team: team('t1') }
    expect(h.service.acknowledge(human, { callId: violation.id, commandId: 'cmd-1' })).toEqual({ ok: true, replayed: false })
    expect(h.service.acknowledge(human, { callId: allowed.id, commandId: 'cmd-1' })).toMatchObject({ ok: false, reason: 'payload' })
  })

  test('a lost unique race resolves as the twin\'s replay and notifies nothing', () => {
    const h = harness()
    const call = h.insert()
    const human = { kind: 'human' as const, team: team('t1') }
    // The twin commits between this command's replay check and its insert.
    const lookup = h.store.acknowledgementByCommand.bind(h.store)
    let first = true
    h.store.acknowledgementByCommand = (teamId, commandId) => {
      if (!first) return lookup(teamId, commandId)
      first = false
      h.store.insertAcknowledgement({
        id: 'oba-twin', teamId, commandId, rule: call.rule, destination: call.destination,
        throughCreatedAt: call.createdAt, throughCallId: call.id, acknowledgedAt: '2026-01-02T00:00:00.000Z',
      })
      return null
    }
    expect(h.service.acknowledge(human, { callId: call.id, commandId: 'cmd-1' })).toEqual({ ok: true, replayed: true })
    expect(h.commits).toEqual([])
  })

  test('the note is trimmed and bounded at 300 characters: 300 passes, 301 is refused', () => {
    const h = harness()
    const call = h.insert()
    const human = { kind: 'human' as const, team: team('t1') }
    expect(h.service.acknowledge(human, { callId: call.id, commandId: 'c-301', note: 'n'.repeat(301) })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(h.store.acknowledgementByCommand('t1', 'c-301')).toBeNull()
    expect(h.service.acknowledge(human, { callId: call.id, commandId: 'c-300', note: ` ${'n'.repeat(300)} ` })).toEqual({ ok: true, replayed: false })
    expect(h.store.acknowledgementByCommand('t1', 'c-300')!.note).toBe('n'.repeat(300))
  })
})
