// Process report storage (team-process-metrics 8.2): a report and its
// proposals commit together or not at all; a proposal takes one decision; the
// current link is the latest link event unless it unlinks; the command
// protocol replays a key's stored outcome (even after a later unlink), refuses
// a reused key with another payload naming the field, and everything persists
// across a reopen.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db'
import { ReportStore, firstDifferingField, type ProposalInsert, type ReportInsert } from '../metrics/reportStore'
import type { ProcessMetrics } from '../../shared/processMetrics'
import { schemaDb } from './schemaDb'

const TEAM = '/repo/.git'
const human = { kind: 'human' as const, sessionId: null }
const snapshot = { teamId: TEAM, window: '7d', metrics: [] } as unknown as ProcessMetrics
const proposal = (extra: Partial<ProposalInsert> = {}): ProposalInsert => ({
  kind: 'change', targetKind: 'group', target: 'reviewers', edit: 'Ask for tests first.', rationale: 'Fail rate rose.',
  expected: [{ metric: 'finding_fail_rate', direction: 'down' }], revertToHash: null, ...extra,
})
const report = (proposals: ProposalInsert[] = [proposal()]): ReportInsert => ({
  teamId: TEAM, authorSession: 'chat-lead', window: '7d', periodStart: '2026-10-09T12:00:00.000Z',
  periodEnd: '2026-10-16T12:00:00.000Z', summary: 'Weekly.', snapshot, proposals,
})

let dir: string | null = null
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null })

test('a report inserts with its proposals in order, or not at all', () => {
  const store = new ReportStore(schemaDb())
  const stored = store.insertReport(report([proposal(), proposal({ kind: 'revert', revertToHash: 'h-a' })]), '2026-10-16T12:00:00.000Z')
  expect(stored.proposals.map(p => [p.kind, p.revertToHash, p.decision, p.link])).toEqual([['change', null, null, null], ['revert', 'h-a', null, null]])
  expect(stored.snapshot).toEqual(snapshot)
  expect(() => store.insertReport(report([proposal(), proposal({ target: null as unknown as string })]))).toThrow()
  expect(store.reports(TEAM).map(r => r.id)).toEqual([stored.id])
  expect(store.reports('/other/.git')).toEqual([])
})

test('a proposal takes one decision; a second is refused', () => {
  const store = new ReportStore(schemaDb())
  const [p] = store.insertReport(report()).proposals
  store.decide(TEAM, p!.id, { decision: 'accepted', reason: null, targetHashAtDecision: 'h-a', decidedAt: '2026-10-16T13:00:00.000Z' })
  expect(() => store.decide(TEAM, p!.id, { decision: 'rejected', reason: 'no', targetHashAtDecision: 'h-a', decidedAt: '2026-10-16T14:00:00.000Z' }))
    .toThrow('already accepted')
  expect(store.proposal(TEAM, p!.id)!.decision).toEqual({ decision: 'accepted', reason: null, targetHashAtDecision: 'h-a', decidedAt: '2026-10-16T13:00:00.000Z' })
})

test('the current link is the latest link event unless it is an unlink', () => {
  const store = new ReportStore(schemaDb())
  const id = store.insertReport(report()).proposals[0]!.id
  store.appendLink(TEAM, id, 'link', { startId: 's-1', hash: 'h-b', at: 't1' }, { kind: 'agent', sessionId: 'chat-lead' }, 'a1')
  store.appendLink(TEAM, id, 'replace', { startId: 's-2', hash: 'h-c', at: 't2' }, human, 'a2')
  expect(store.proposal(TEAM, id)!.link).toEqual({ changeStartId: 's-2', changeHash: 'h-c', changeAt: 't2', actor: human, at: 'a2' })
  store.appendLink(TEAM, id, 'unlink', null, human, 'a3')
  const after = store.proposal(TEAM, id)!
  expect(after.link).toBeNull()
  expect(after.linkHistory.map(event => [event.action, event.changeStartId, event.actor.kind])).toEqual([
    ['link', 's-1', 'agent'], ['replace', 's-2', 'human'], ['unlink', null, 'human'],
  ])
})

test('a link key replayed after an unlink returns its stored outcome and the proposal stays unlinked', () => {
  const store = new ReportStore(schemaDb())
  const id = store.insertReport(report()).proposals[0]!.id
  const link = () => store.command(TEAM, 'K1', 'link', { proposal: id, 'version change': 's-1' },
    () => store.appendLink(TEAM, id, 'link', { startId: 's-1', hash: 'h-b', at: 't1' }, human, 'a1'))
  expect(link().replay).toBe(false)
  store.command(TEAM, 'K2', 'link', { proposal: id, 'version change': null }, () => store.appendLink(TEAM, id, 'unlink', null, human, 'a2'))
  const replay = link()
  expect(replay).toEqual({ replay: true, outcome: { action: 'link', changeStartId: 's-1', changeHash: 'h-b', changeAt: 't1', actor: human, at: 'a1' } })
  expect(store.proposal(TEAM, id)!.link).toBeNull()
  expect(store.proposal(TEAM, id)!.linkHistory).toHaveLength(2)
})

test('a reused key with another payload is refused naming the field, writing nothing', () => {
  const store = new ReportStore(schemaDb())
  const id = store.insertReport(report()).proposals[0]!.id
  store.command(TEAM, 'K1', 'link', { proposal: id, 'version change': 's-1' }, () => store.appendLink(TEAM, id, 'link', { startId: 's-1', hash: 'h', at: 't' }, human))
  let applied = false
  expect(() => store.command(TEAM, 'K1', 'link', { proposal: id, 'version change': 's-2' }, () => { applied = true }))
    .toThrow('Command key K1 was already used with a different version change.')
  expect(() => store.command(TEAM, 'K1', 'decide', { proposal: id }, () => { applied = true })).toThrow('different kind')
  expect(applied).toBe(false)
  // Keys are per team.
  expect(store.command('/other/.git', 'K1', 'decide', { proposal: id }, () => 'ok')).toEqual({ replay: false, outcome: 'ok' })
  expect(firstDifferingField({ a: '1', b: null }, { a: '1' })).toBeNull()
  expect(firstDifferingField({ a: '1', reason: 'x' }, { a: '1', reason: 'y' })).toBe('reason')
})

test('a throwing command writes neither its effect nor its key', () => {
  const store = new ReportStore(schemaDb())
  const id = store.insertReport(report()).proposals[0]!.id
  expect(() => store.command(TEAM, 'K1', 'link', { proposal: id }, () => {
    store.appendLink(TEAM, id, 'link', { startId: 's-1', hash: 'h', at: 't' }, human)
    throw new Error('refused')
  })).toThrow('refused')
  expect(store.proposal(TEAM, id)!.linkHistory).toEqual([])
  expect(store.command(TEAM, 'K1', 'link', { proposal: id }, () => 'later').replay).toBe(false)
})

test('reports, decisions, links, and commands persist across a reopen', () => {
  dir = mkdtempSync(join(tmpdir(), 'report-store-'))
  const path = join(dir, 'db.sqlite')
  const first = initDatabase({ path })
  const store = new ReportStore(first.db)
  const id = store.insertReport(report()).proposals[0]!.id
  store.command(TEAM, 'D1', 'decide', { proposal: id, decision: 'accepted' },
    () => store.decide(TEAM, id, { decision: 'accepted', reason: null, targetHashAtDecision: 'h-a', decidedAt: 'd' }))
  store.appendLink(TEAM, id, 'link', { startId: 's-1', hash: 'h-b', at: 't1' }, human, 'a1')
  first.close()
  const second = initDatabase({ path })
  const reopened = new ReportStore(second.db)
  const p = reopened.proposal(TEAM, id)!
  expect([p.decision?.decision, p.link?.changeStartId]).toEqual(['accepted', 's-1'])
  expect(reopened.command(TEAM, 'D1', 'decide', { proposal: id, decision: 'accepted' }, () => { throw new Error('not again') }).replay).toBe(true)
  second.close()
})
