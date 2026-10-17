// OutboundService.acknowledge (execution-safety-recovery 4.2, D10): the
// human only — an agent's call writes nothing; a replay returns the prior
// result and a different payload is refused naming the field; the
// acknowledgement covers its (rule, destination) group through the named
// call and no later call; a non-violation and another team's call are
// refused; and one row is written with the call unchanged. Every database
// lives in a temporary directory.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { OutboundStore, type OutboundCallInsert } from '../outbound/store'
import { OutboundService } from '../outbound/service'
import { resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { cleanGitEnv } from '../git/gitCommand'
import { spawnSync } from 'node:child_process'

let dir: string
let dbPath: string
let team: TeamIdentity
let other: TeamIdentity
const opened: Array<{ close(): void }> = []

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-outbound-service-')))
  dbPath = path.join(dir, 'agentboard.db')
  for (const name of ['repo', 'other']) {
    const repo = path.join(dir, name)
    fs.mkdirSync(repo, { recursive: true })
    const git = spawnSync('git', ['init', '-q', repo], { env: cleanGitEnv() })
    if (git.status !== 0) throw new Error(git.stderr.toString())
  }
  team = await resolveTeam(path.join(dir, 'repo'))
  other = await resolveTeam(path.join(dir, 'other'))
})
afterEach(() => {
  for (const db of opened) db.close()
  opened.length = 0
  fs.rmSync(dir, { recursive: true, force: true })
})

function harness() {
  const db = initDatabase({ path: dbPath })
  opened.push(db)
  const store = new OutboundStore(db.db)
  const commits: string[] = []
  const service = new OutboundService({
    store,
    sessionOf: (_teamId, sessionId) => ({ name: sessionId, clickable: false }),
    spawnLive: () => false,
    onCommit: teamId => commits.push(teamId),
  })
  let seq = 0
  const call = (overrides: Partial<OutboundCallInsert> = {}): OutboundCallInsert => {
    seq += 1
    return {
      id: `obc-${seq}`,
    teamId: team.teamId,
    sessionId: 'chat-1',
    spawnId: 'sp-1',
    tool: 'Bash',
    toolUseId: `tu-${seq}`,
    command: 'gh issue create -R other/repo --title x',
    truncated: false,
    rule: 'gh-write',
    verdict: 'violation',
    destination: 'github:other/repo',
    matches: '[]',
    classifierVersion: 3,
      cwd: path.join(dir, 'repo'),
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }
  return {
    store, service, commits, call,
    human: { kind: 'human' as const, team },
    agent: { kind: 'agent' as const, sessionId: 'chat-1' },
  }
}

describe('acknowledge (D10)', () => {
  test('an agent is refused first, and nothing is written', () => {
    const h = harness()
    h.store.insertCall(h.call())
    const outcome = h.service.acknowledge(h.agent, { callId: 'obc-1', commandId: 'cmd-1' })
    expect(outcome).toMatchObject({ ok: false, reason: 'forbidden' })
    expect(h.store.acknowledgementByCommand(team.teamId, 'cmd-1')).toBeNull()
    expect(h.commits).toEqual([])
  })

  test('the same payload replays; a different payload is refused naming the field', () => {
    const h = harness()
    h.store.insertCall(h.call())
    expect(h.service.acknowledge(h.human, { callId: 'obc-1', commandId: 'cmd-1', note: 'mine' })).toEqual({ ok: true, replayed: false })
    expect(h.service.acknowledge(h.human, { callId: 'obc-1', commandId: 'cmd-1', note: 'mine' })).toEqual({ ok: true, replayed: true })
    const differentNote = h.service.acknowledge(h.human, { callId: 'obc-1', commandId: 'cmd-1', note: 'other' })
    expect(differentNote).toMatchObject({ ok: false, reason: 'payload' })
    expect((differentNote as { message: string }).message).toContain('note')
    // One row stands, the first one's.
    const recorded = h.store.acknowledgementByCommand(team.teamId, 'cmd-1')!
    expect(recorded).toMatchObject({ rule: 'gh-write', destination: 'github:other/repo', note: 'mine' })
    expect(h.store.counts(team.teamId).unacknowledgedViolations).toBe(0)
  })

  test('a different callId under the same command id names callId', () => {
    const h = harness()
    h.store.insertCall(h.call({ id: 'obc-a', createdAt: '2026-01-01T00:00:00.000Z' }))
    h.store.insertCall(h.call({ id: 'obc-b', createdAt: '2026-01-01T00:00:01.000Z' }))
    expect(h.service.acknowledge(h.human, { callId: 'obc-a', commandId: 'cmd-1' })).toEqual({ ok: true, replayed: false })
    const refused = h.service.acknowledge(h.human, { callId: 'obc-b', commandId: 'cmd-1' })
    expect(refused).toMatchObject({ ok: false, reason: 'payload' })
    expect((refused as { message: string }).message).toContain('callId')
  })

  test('coverage runs through the named call and no later call', () => {
    const h = harness()
    h.store.insertCall(h.call({ id: 'obc-old', createdAt: '2026-01-01T00:00:00.000Z' }))
    h.store.insertCall(h.call({ id: 'obc-new', createdAt: '2026-01-02T00:00:00.000Z' }))
    expect(h.service.violationGroups(team.teamId)).toHaveLength(1)
    expect(h.service.acknowledge(h.human, { callId: 'obc-old', commandId: 'cmd-1' })).toEqual({ ok: true, replayed: false })
    // The older violations are covered; the later one raises the item again.
    const groups = h.service.violationGroups(team.teamId)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ count: 1, latestCallId: 'obc-new' })
    // Acknowledging through the newest call clears the group.
    expect(h.service.acknowledge(h.human, { callId: 'obc-new', commandId: 'cmd-2' })).toEqual({ ok: true, replayed: false })
    expect(h.service.violationGroups(team.teamId)).toEqual([])
    // A later violation of the same group is uncovered again (the item returns).
    h.store.insertCall(h.call({ id: 'obc-later', createdAt: '2026-01-03T00:00:00.000Z' }))
    expect(h.service.violationGroups(team.teamId)).toHaveLength(1)
  })

  test('a different group is not covered', () => {
    const h = harness()
    h.store.insertCall(h.call({ id: 'obc-gh', rule: 'gh-write', destination: 'github:other/repo' }))
    h.store.insertCall(h.call({ id: 'obc-mcp', rule: 'mcp-call', destination: 'mcp:docs-search', tool: 'mcp__docs-search__find' }))
    expect(h.service.acknowledge(h.human, { callId: 'obc-gh', commandId: 'cmd-1' })).toEqual({ ok: true, replayed: false })
    const groups = h.service.violationGroups(team.teamId)
    expect(groups.map(group => group.rule)).toEqual(['mcp-call'])
  })

  test('a non-violation is refused', () => {
    const h = harness()
    h.store.insertCall(h.call({ id: 'obc-ok', verdict: 'allowed', destination: 'github:origin', command: 'git push origin main' }))
    h.store.insertCall(h.call({ id: 'obc-unk', verdict: 'unknown-destination', destination: 'unresolved:variable' }))
    for (const id of ['obc-ok', 'obc-unk']) {
      const outcome = h.service.acknowledge(h.human, { callId: id, commandId: `cmd-${id}` })
      expect(outcome).toMatchObject({ ok: false, reason: 'invalid' })
      expect(h.store.acknowledgementByCommand(team.teamId, `cmd-${id}`)).toBeNull()
    }
    expect(h.commits).toEqual([])
  })

  test('another team\'s call reads as not found', () => {
    const h = harness()
    h.store.insertCall(h.call({ id: 'obc-theirs', teamId: other.teamId, sessionId: 'chat-9' }))
    const outcome = h.service.acknowledge(h.human, { callId: 'obc-theirs', commandId: 'cmd-1' })
    expect(outcome).toMatchObject({ ok: false, reason: 'not-found' })
    expect(h.store.acknowledgementByCommand(team.teamId, 'cmd-1')).toBeNull()
  })

  test('one row is written, with the call unchanged', () => {
    const h = harness()
    const original = h.call({ id: 'obc-v' })
    h.store.insertCall(original)
    expect(h.service.acknowledge(h.human, { callId: 'obc-v', commandId: 'cmd-1', note: 'understood' })).toEqual({ ok: true, replayed: false })
    expect(h.store.acknowledgementByCommand(team.teamId, 'cmd-1')).toMatchObject({
      rule: original.rule, destination: original.destination,
      throughCreatedAt: original.createdAt, throughCallId: 'obc-v', note: 'understood',
    })
    expect(h.store.callById('obc-v')).toMatchObject({ verdict: 'violation' })
    // The commit notified exactly once.
    expect(h.commits).toEqual([team.teamId])
  })

  test('an overlong note is refused rather than cut', () => {
    const h = harness()
    h.store.insertCall(h.call())
    const outcome = h.service.acknowledge(h.human, { callId: 'obc-1', commandId: 'cmd-1', note: 'x'.repeat(301) })
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid' })
    expect(h.store.acknowledgementByCommand(team.teamId, 'cmd-1')).toBeNull()
  })
})

describe('the violation groups gate (D10)', () => {
  test('unknown-destination and allowed rows never group; only violations do', () => {
    const h = harness()
    h.store.insertCall(h.call({ id: 'obc-allowed', verdict: 'allowed', destination: 'github:origin', command: 'git push origin main' }))
    h.store.insertCall(h.call({ id: 'obc-unknown', verdict: 'unknown-destination', destination: 'unresolved:variable' }))
    expect(h.service.violationGroups(team.teamId)).toEqual([])
    expect(h.store.counts(team.teamId).unacknowledgedViolations).toBe(0)
    // The verdict is the only gate: a violation of the same rule groups alone.
    h.store.insertCall(h.call({ id: 'obc-violation' }))
    expect(h.service.violationGroups(team.teamId)).toHaveLength(1)
  })
})

describe('the view projection', () => {
  test('a row reads its outcome state and named session; counts ride the range only', () => {
    const h = harness()
    h.store.insertCall(h.call({ id: 'obc-a', verdict: 'allowed', rule: 'git-push', createdAt: '2026-01-01T00:00:00.000Z' }))
    h.store.insertCall(h.call({ id: 'obc-b', verdict: 'violation', sessionId: 'chat-gone', createdAt: '2026-01-02T00:00:00.000Z' }))
    h.store.insertOutcome({ sessionId: 'chat-gone', toolUseId: 'tu-2', outcome: 'completed', createdAt: '2026-01-02T00:00:01.000Z' })
    const page = h.service.page(team.teamId, {})
    expect(page.rows.map(row => row.id)).toEqual(['obc-b', 'obc-a'])
    // obc-b completed; its gone session would name through the directory.
    expect(page.rows[0]).toMatchObject({ outcome: { state: 'completed' }, session: { name: 'chat-gone' } })
    // No live spawn and no outcome? outcome-unknown, never re-run (D7).
    expect(page.rows[1]).toMatchObject({ verdict: 'allowed', outcome: { state: 'outcome-unknown' } })
    expect(page.counts).toMatchObject({ violations: 1, unknown: 0, unacknowledgedViolations: 1, allowedPerRule: { 'git-push': 1 } })
    // The window counts feed the summary bucket (D10).
    expect(h.service.windowCounts(team.teamId, '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z'))
      .toEqual({ allowed: 1, unknown: 0, violations: 1 })
    // The range's end is exclusive, so the violation of 01-02 drops out.
    expect(h.service.windowCounts(team.teamId, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'))
      .toEqual({ allowed: 1, unknown: 0, violations: 0 })
  })
})

describe('violation groups against the real store (B2 mutants)', () => {
  test('five unacknowledged calls to one server group with count 5', () => {
    const h = harness()
    for (let i = 0; i < 5; i++) {
      h.store.insertCall(h.call({ id: `obc-mcp-${i}`, rule: 'mcp-call', destination: 'mcp:docs-search', tool: 'mcp__docs-search__find', createdAt: '2026-01-01T00:00:0' + i + '.000Z' }))
    }
    const groups = h.service.violationGroups(team.teamId)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ rule: 'mcp-call', destination: 'mcp:docs-search', count: 5, latestCallId: 'obc-mcp-4' })
  })

  test("the summary window's bounds: from inclusive, to exclusive", () => {
    const h = harness()
    h.store.insertCall(h.call({ id: 'obc-before', verdict: 'allowed', createdAt: '2026-10-13T11:59:59.999Z' }))
    h.store.insertCall(h.call({ id: 'obc-at-from', verdict: 'violation', createdAt: '2026-10-13T12:00:00.000Z' }))
    h.store.insertCall(h.call({ id: 'obc-at-to', verdict: 'violation', createdAt: '2026-10-14T12:00:00.000Z' }))
    const from = '2026-10-13T12:00:00.000Z'
    const to = '2026-10-14T12:00:00.000Z'
    expect(h.service.windowCounts(team.teamId, from, to)).toEqual({ allowed: 0, unknown: 0, violations: 1 })
    expect(h.service.page(team.teamId, { from, to }).rows.map(row => row.id)).toEqual(['obc-at-from'])
  })

  test('after a restart, a fresh reader reads the same groups and counts', () => {
    const h = harness()
    for (let i = 0; i < 3; i++) {
      h.store.insertCall(h.call({ id: `obc-r-${i}`, destination: 'github:other/repo', createdAt: `2026-01-0${i + 1}T00:00:00.000Z` }))
    }
    h.store.insertOutcome({ sessionId: 'chat-1', toolUseId: 'tu-1', outcome: 'completed', createdAt: '2026-01-01T00:00:01.000Z' })
    const before = { groups: h.service.violationGroups(team.teamId), counts: h.service.windowCounts(team.teamId, '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z') }
    // A restart: a fresh database connection and service, no in-memory state.
    const db2 = initDatabase({ path: dbPath })
    opened.push(db2)
    const fresh = new OutboundService({
      store: new OutboundStore(db2.db),
      sessionOf: (_t, id) => ({ name: id, clickable: false }),
      spawnLive: () => false,
    })
    expect(fresh.violationGroups(team.teamId)).toEqual(before.groups)
    expect(fresh.windowCounts(team.teamId, '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z')).toEqual(before.counts)
    // The completed outcome survives; with no live spawn the other rows read outcome-unknown.
    const page = fresh.page(team.teamId, {})
    expect(page.rows.find(row => row.id === 'obc-r-0')).toMatchObject({ outcome: { state: 'completed' } })
    expect(page.rows.find(row => row.id === 'obc-r-1')).toMatchObject({ outcome: { state: 'outcome-unknown' } })
  })

  test('coverage needs both rule and destination: the same destination under another rule stays unacknowledged', () => {
    const h = harness()
    h.store.insertCall(h.call({ id: 'obc-gh', rule: 'gh-write', destination: 'github:other/repo' }))
    h.store.insertCall(h.call({ id: 'obc-ghapi', rule: 'gh-api-write', destination: 'github:other/repo' }))
    h.store.insertCall(h.call({ id: 'obc-mcp', rule: 'mcp-call', destination: 'mcp:docs-search' }))
    expect(h.service.acknowledge(h.human, { callId: 'obc-gh', commandId: 'cmd-1' })).toEqual({ ok: true, replayed: false })
    const groups = new Map(h.service.violationGroups(team.teamId).map(group => [group.rule, group]))
    // Same destination, different rule: not covered.
    expect(groups.get('gh-api-write')).toMatchObject({ count: 1 })
    // Different rule and destination: not covered.
    expect(groups.get('mcp-call')).toMatchObject({ count: 1 })
  })
})
