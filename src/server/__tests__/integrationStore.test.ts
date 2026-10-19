// integration-candidates task 2.2: the integration store is the only writer
// of the four tables. These tests cover:
// - the branch record and a creation again;
// - candidates under the next `seq`, with their transitions;
// - promotions under the next `number`, with their step, moves, and finish;
// - the database races mapped to named conflicts.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import { applyIntegrationSchema } from '../plans/landing/integration/integrationSchema'
import { IntegrationConflict, IntegrationStore, type NewCandidate } from '../plans/landing/integration/integrationStore'

const TEAM = '/repo/.git'
let clock = Date.parse('2026-10-18T10:00:00.000Z')
const now = () => new Date(clock)

function store(db = schemaDb()): IntegrationStore {
  applyIntegrationSchema(db)
  return new IntegrationStore(db, now)
}

const increment = (extra: Partial<NewCandidate> = {}): NewCandidate => ({
  teamId: TEAM, branch: 'wave/int', kind: 'increment', executionId: 'exec-1', change: 'alpha',
  baselineSha: 'base', commitSha: 'c1', treeSha: 't1', state: 'passed', ...extra,
})

const promotionInput = { teamId: TEAM, planId: 'plan-1', branch: 'wave/int', commandId: 'cmd-1', fromSha: 'head', throughSeq: 2, targetBranch: 'master', floor: { version: 1 } }

function conflictOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    if (error instanceof IntegrationConflict) return error.kind
    throw error
  }
}

describe('the branch record', () => {
  test('a first creation inserts; a creation again keeps the row and updates its creation fields', () => {
    const s = store()
    const first = s.recordCreation({ teamId: TEAM, branch: 'wave/int', planId: 'plan-1', targetBranch: 'master', executionId: 'exec-1', sha: 'a1' })
    expect(first).toMatchObject({ planId: 'plan-1', targetBranch: 'master', createdBy: 'exec-1', createdSha: 'a1' })
    clock += 60_000
    const again = s.recordCreation({ teamId: TEAM, branch: 'wave/int', planId: 'plan-other', targetBranch: 'main', executionId: 'exec-2', sha: 'b2' })
    expect(again).toMatchObject({ planId: 'plan-1', targetBranch: 'master', createdBy: 'exec-2', createdSha: 'b2' })
    expect(again.createdAt > first.createdAt).toBe(true)
    expect(s.branchesOfPlan('plan-1')).toHaveLength(1)
  })
})

describe('candidates', () => {
  test('take the next seq per branch, with passed candidates decided at insert', () => {
    const s = store()
    const one = s.insertCandidate(increment())
    const two = s.insertCandidate(increment({ change: 'beta', state: 'verifying' }))
    const other = s.insertCandidate(increment({ branch: 'other/int' }))
    expect([one.seq, two.seq, other.seq]).toEqual([1, 2, 1])
    expect(one.decidedAt).not.toBeNull()
    expect(two.decidedAt).toBeNull()
    expect(s.candidateOf('exec-1', 'beta')?.id).toBe(two.id)
  })

  test('UNIQUE (team_id, branch, seq) holds under two concurrent inserts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-integration-store-'))
    tmp.push(dir)
    const file = path.join(dir, 'db.sqlite')
    store(schemaDb(file)).db.close()
    const a = new IntegrationStore(new Database(file), now)
    const b = new IntegrationStore(new Database(file), now)
    try {
      // a's insert is in flight, inside its own write transaction.
      a.db.exec('BEGIN IMMEDIATE')
      const first = a.insertCandidate(increment({ commitSha: 'ca' }))
      // b's insert cannot read a stale next seq: its IMMEDIATE transaction
      // waits for the write lock, and is refused busy, writing nothing.
      expect(() => b.insertCandidate(increment({ commitSha: 'cb' }))).toThrow(/locked|busy/i)
      a.db.exec('COMMIT')
      // Once a commits, b takes the next seq.
      const second = b.insertCandidate(increment({ commitSha: 'cb' }))
      expect([first.seq, second.seq]).toEqual([1, 2])
      // A writer that computed the seq before the other committed is refused, named.
      expect(conflictOf(() => b.insertCandidateAt('cand-stale', 2, increment({ commitSha: 'cc' })))).toBe('seq-taken')
      expect(b.candidates(TEAM, 'wave/int').map(row => row.commitSha)).toEqual(['ca', 'cb'])
    } finally {
      a.db.close()
      b.db.close()
    }
  })

  test('legal transitions move; illegal ones are refused and write nothing', () => {
    const s = store()
    const verifying = s.insertCandidate(increment({ state: 'verifying' }))
    expect(s.transitionCandidate(verifying.id, 'passed').state).toBe('passed')
    expect(s.transitionCandidate(verifying.id, 'landed').state).toBe('landed')
    expect(conflictOf(() => s.transitionCandidate(verifying.id, 'failed'))).toBe('illegal-transition')
    const failed = s.insertCandidate(increment({ state: 'verifying', change: 'beta' }))
    s.transitionCandidate(failed.id, 'failed')
    expect(conflictOf(() => s.transitionCandidate(failed.id, 'passed'))).toBe('illegal-transition')
    const superseded = s.insertCandidate(increment({ change: 'gamma' }))
    s.transitionCandidate(superseded.id, 'superseded')
    expect(conflictOf(() => s.transitionCandidate(superseded.id, 'landed'))).toBe('illegal-transition')
    expect(s.candidate(verifying.id)!.state).toBe('landed')
    expect(s.candidate(failed.id)!.state).toBe('failed')
  })
})

describe('promotions', () => {
  test('take the next number and the promotion branch name', () => {
    const s = store()
    const first = s.insertPromotion(promotionInput)
    expect(first).toMatchObject({ number: 1, promotionBranch: 'wave/int--promote-1', state: 'running', step: 'branch', moves: 0 })
    s.finishPromotion(first.id, 'failed:ci-failed', { checks: ['ci'] })
    const second = s.insertPromotion({ ...promotionInput, commandId: 'cmd-2' })
    expect(second).toMatchObject({ number: 2, promotionBranch: 'wave/int--promote-2' })
  })

  test('the partial index maps to the no-promotion refusal, and a command id replay to promotion-replay', () => {
    const s = store()
    s.insertPromotion(promotionInput)
    expect(conflictOf(() => s.insertPromotion({ ...promotionInput, commandId: 'cmd-2' }))).toBe('no-promotion')
    s.finishPromotion(s.runningPromotion('plan-1')!.id, 'cancelled')
    expect(conflictOf(() => s.insertPromotion(promotionInput))).toBe('promotion-replay')
    expect(s.promotionsOf('plan-1')).toHaveLength(1)
  })

  test('step, moves, and finish write a running promotion only', () => {
    const s = store()
    const promotion = s.insertPromotion(promotionInput)
    expect(s.patchPromotion(promotion.id, { step: 'ci', prNumber: 7, prUrl: 'u', ci: [{ name: 'ci' }], treeVerified: true })).toBe(true)
    expect(s.countMove(promotion.id)).toBe(1)
    expect(s.countMove(promotion.id)).toBe(2)
    expect(s.promotion(promotion.id)).toMatchObject({ step: 'ci', prNumber: 7, moves: 2, treeVerified: true, ci: [{ name: 'ci' }] })
    expect(s.finishPromotion(promotion.id, 'merged')).toBe(true)
    expect(s.finishPromotion(promotion.id, 'cancelled')).toBe(false)
    expect(s.patchPromotion(promotion.id, { step: 'merge' })).toBe(false)
    expect(s.promotion(promotion.id)).toMatchObject({ state: 'finished', outcome: 'merged', step: null })
    expect(s.runningPromotion('plan-1')).toBeNull()
  })
})

let tmp: string[] = []
beforeEach(() => { tmp = [] })
afterEach(() => { for (const dir of tmp) fs.rmSync(dir, { recursive: true, force: true }) })
