// Result check storage (independent-verification task 2.1, design D4) over
// schemaDb(): the partial unique index refuses a second pending row for one
// result and the requester reads the standing one instead; a row settles
// exactly once, from pending, by an update that matches status = 'pending';
// coverage maps are append-only — a second map for one session never
// replaces the first; reads: pending per team oldest first, a result's
// checks newest first with the earlier count, and the teams that still hold
// pending rows for the startup run.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { schemaDb } from './schemaDb'
import { ResultCheckStore } from '../verification/resultCheckStore'
import type { Database } from 'bun:sqlite'
import type { PendingCheckInput } from '../verification/resultCheckStore'

const TEAM = '/repo/.git'

let db: Database
let store: ResultCheckStore

beforeEach(() => {
  db = schemaDb()
  store = new ResultCheckStore(db)
})
afterEach(() => { db.close() })

const pending = (resultId: string, extra: Partial<PendingCheckInput> = {}) => store.insertPending({
  teamId: TEAM, taskId: 'task-1', resultId, trigger: 'submit', requestedBy: { kind: 'agent', sessionId: 'dev' }, ...extra,
})

test('the index refuses a second pending row for one result; the requester reads the standing one', () => {
  const first = pending('result-1')
  expect(first.existing).toBe(false)
  const second = pending('result-1', { trigger: 'recheck', requestedBy: { kind: 'human', sessionId: null } })
  expect(second.existing).toBe(true)
  expect(second.check.id).toBe(first.check.id)
  // Exactly one row exists for the result, and it is still the first one.
  expect(store.allForResult('result-1').map(check => check.id)).toEqual([first.check.id])
})

test('a row settles exactly once, from pending; a settled row never changes again', () => {
  const { check } = pending('result-1')
  const facts = JSON.stringify({ version: 1 })
  expect(store.pendingForResult('result-1')?.status).toBe('pending')
  expect(store.settle(check.id, 'unavailable', null, 'git did not answer')).toBe(true)
  expect(store.get(check.id)).toMatchObject({ status: 'unavailable', facts: null, reason: 'git did not answer' })
  expect(store.pendingForResult('result-1')).toBeNull()
  // The once-only rule: the update matched status = 'pending', so a second
  // settle — done, or the same unavailable again — changes nothing.
  expect(store.settle(check.id, 'done', facts, null)).toBe(false)
  expect(store.settle(check.id, 'unavailable', null, 'again')).toBe(false)
  expect(store.get(check.id)).toMatchObject({ status: 'unavailable', reason: 'git did not answer' })
})

test('a done check stores its facts; settling needs a pending row', () => {
  const { check } = pending('result-1')
  expect(() => store.settle(check.id, 'done', null, null)).toThrow(/facts/)
  const facts = JSON.stringify({ version: 1, commit: { sha: 'abc' } })
  expect(store.settle(check.id, 'done', facts, null)).toBe(true)
  expect(store.get(check.id)?.status).toBe('done')
  expect(store.get(check.id)?.facts?.version).toBe(1)
})

test('pending rows run per team oldest first, and teamsWithPending names every team that has one', () => {
  pending('result-1', { teamId: '/a/.git' })
  const second = pending('result-2', { teamId: '/a/.git' })
  pending('result-3', { teamId: '/b/.git' })
  // created_at has millisecond resolution; the rowid breaks the tie in insert order.
  db.prepare("UPDATE team_task_result_checks SET created_at = '2026-10-24T08:00:00.000Z'").run()
  const again = pending('result-4', { teamId: '/a/.git' })
  expect(store.pendingForTeam('/a/.git').map(check => check.resultId)).toEqual(['result-1', 'result-2', 'result-4'])
  expect(again.check.seq).toBe(1)
  expect(store.pendingForTeam('/b/.git').map(check => check.resultId)).toEqual(['result-3'])
  expect([...store.teamsWithPending()].sort()).toEqual(['/a/.git', '/b/.git'])
})

test('a result checks view: the newest check and the earlier count, rechecks appending', () => {
  const first = pending('result-1')
  store.settle(first.check.id, 'done', JSON.stringify({ version: 1 }), null)
  db.prepare("UPDATE team_task_result_checks SET finished_at = '2026-10-24T08:00:01.000Z'").run()
  const recheck = pending('result-1', { trigger: 'recheck' })
  // Recheck made while pending returns the pending row, never a second one (D4).
  expect(pending('result-1', { trigger: 'recheck' }).existing).toBe(true)
  store.settle(recheck.check.id, 'done', JSON.stringify({ version: 1, later: true }), null)
  const view = store.viewForResult('result-1')
  expect(view.earlier).toBe(1)
  expect(view.newest?.seq).toBe(2)
})

test('coverage maps are append-only: a second map for one session never replaces the first', () => {
  store.insertCoverageMap({ teamId: TEAM, taskId: 'task-1', resultId: 'result-1', authorSession: 'rev', coverage: '{"clauses":1}' })
  store.insertCoverageMap({ teamId: TEAM, taskId: 'task-1', resultId: 'result-1', authorSession: 'rev', coverage: '{"clauses":2}' })
  store.insertCoverageMap({ teamId: TEAM, taskId: 'task-1', resultId: 'result-1', authorSession: 'other', coverage: '{"clauses":3}' })
  const maps = store.coverageMapsFor('result-1')
  expect(maps).toHaveLength(3)
  expect(maps[0]).toMatchObject({ authorSession: 'rev', coverage: '{"clauses":1}' })
  expect(maps[1].coverage).toBe('{"clauses":2}')
})
