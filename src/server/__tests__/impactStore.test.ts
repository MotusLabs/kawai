// strategy-revision-impact 2.1/2.2: the impact tables migration 2 creates
// (its upgrade path is strategyImpactMigration.test.ts), the chain index and
// per-strategy command ids as database facts, and every row surviving a
// reopen.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { ImpactStore, ImpactUniqueError, type NewImpactDecision } from '../strategy/impactStore'

describe('ImpactStore', () => {
  let dir: string
  let dbPath: string
  let db: SessionDatabase
  let impact: ImpactStore

  const open = () => {
    db = initDatabase({ path: dbPath })
    impact = new ImpactStore(db.db)
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-impact-'))
    dbPath = path.join(dir, 'impact.db')
    open()
  })
  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const decision = (overrides: Partial<NewImpactDecision> = {}): NewImpactDecision => ({
    strategyId: 'strategy-a', reviewId: 'impact-1', planId: 'plan-1', disposition: 'continue', rationale: 'still fits',
    proposalId: null, supersedesDecisionId: null, planSnapshot: [{ revision: 1, status: 'approved', pin: null }],
    commandId: crypto.randomUUID(), payload: { disposition: 'continue' }, ...overrides,
  })

  test('a fresh database has the three tables and the chain index', () => {
    const names = (db.db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'strategy_impact_%' ORDER BY name`).all() as Array<{ name: string }>)
      .map(row => row.name)
    expect(names).toEqual(expect.arrayContaining([
      'strategy_impact_decisions', 'strategy_impact_decisions_chain', 'strategy_impact_proposals', 'strategy_impact_requests',
    ]))
    expect(impact.decisions('strategy-a')).toEqual([])
  })

  test('the chain index refuses two first decisions for one plan', () => {
    impact.insertDecision(decision())
    expect(() => impact.insertDecision(decision({ disposition: 'adapt' }))).toThrow(ImpactUniqueError)
    expect(impact.decisions('strategy-a')).toHaveLength(1)
    // Another plan, or the same plan in another review, starts its own chain.
    impact.insertDecision(decision({ planId: 'plan-2' }))
    impact.insertDecision(decision({ reviewId: 'impact-2' }))
    expect(impact.decisions('strategy-a')).toHaveLength(3)
  })

  test('the chain index refuses a forked successor; the head follows the chain', () => {
    const first = impact.insertDecision(decision())
    const second = impact.insertDecision(decision({ disposition: 'adapt', supersedesDecisionId: first.id }))
    expect(() => impact.insertDecision(decision({ disposition: 'reconsider', supersedesDecisionId: first.id }))).toThrow(ImpactUniqueError)
    expect(impact.chainHead('impact-1', 'plan-1')?.id).toBe(second.id)
    const third = impact.insertDecision(decision({ disposition: 'reconsider', supersedesDecisionId: second.id }))
    expect(impact.chainHead('impact-1', 'plan-1')?.id).toBe(third.id)
    expect(impact.chainHead('impact-1', 'plan-9')).toBeNull()
  })

  test('a command id is used once per strategy, across reviews, for decisions and requests', () => {
    impact.insertDecision(decision({ commandId: 'cmd-1' }))
    expect(() => impact.insertDecision(decision({ commandId: 'cmd-1', reviewId: 'impact-2' }))).toThrow(ImpactUniqueError)
    impact.insertDecision(decision({ commandId: 'cmd-1', strategyId: 'strategy-b', reviewId: 'impact-b' }))
    const request = { strategyId: 'strategy-a', reviewId: 'impact-1', targetGroup: 'lead', messageId: 'm1', commandId: 'req-1', payload: { group: 'lead' } }
    impact.insertRequest(request)
    expect(() => impact.insertRequest({ ...request, reviewId: 'impact-2', messageId: 'm2' })).toThrow(ImpactUniqueError)
    expect(impact.decisionByCommand('strategy-a', 'cmd-1')?.payload).toEqual({ disposition: 'continue' })
    expect(impact.requestByCommand('strategy-a', 'req-1')?.request.messageId).toBe('m1')
    expect(impact.requestByCommand('strategy-b', 'req-1')).toBeNull()
  })

  test('every row survives a reopen', () => {
    const proposal = impact.insertProposal({ strategyId: 'strategy-a', reviewId: 'impact-1', planId: 'plan-1', disposition: 'adapt', rationale: 'rework', authorSession: 'chat-lead' })
    const first = impact.insertDecision(decision({ proposalId: proposal.id }))
    const second = impact.insertDecision(decision({ disposition: 'adapt', supersedesDecisionId: first.id }))
    const request = impact.insertRequest({ strategyId: 'strategy-a', reviewId: 'impact-1', targetGroup: 'lead', messageId: 'm1', commandId: 'req-1', payload: {} })
    db.close()
    open()
    expect(impact.proposals('strategy-a')).toEqual([proposal])
    expect(impact.decisions('strategy-a')).toEqual([first, second])
    expect(impact.requests('strategy-a')).toEqual([request])
    expect(impact.chainHead('impact-1', 'plan-1')).toEqual(second)
    expect(first.proposalId).toBe(proposal.id)
    expect(first.planSnapshot).toEqual([{ revision: 1, status: 'approved', pin: null }])
    expect(proposal.author).toEqual({ kind: 'agent', sessionId: 'chat-lead' })
  })
})
