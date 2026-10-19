// The "what stopped and why" report (plan-supervision 1.5): blocked
// dependents, partial delivery without a success claim, candidates beside
// their change, the strategy disposition, and the M2/M4 lines.
import { describe, expect, test } from 'bun:test'
import type { FixStatus, PlanDecision } from '../planDecisions'
import type { IntegrationCandidate } from '../planIntegration'
import { normalizePlanContent } from '../plans'
import { blockedDependents, planReport, type PlanReportInput } from '../planReport'
import type { ChangeSupervision, SupervisionOutcome } from '../planSupervision'
import { planInput } from './planFixtures'

const content = normalizePlanContent(planInput({
  changes: ['api', 'ui', 'docs', 'db', 'cli'].map((change, index) => ({
    change,
    group: 'middle-devs',
    dependsOn: [[], ['api'], ['ui'], [], ['db']][index],
  })),
}))

function view(change: string, outcome: SupervisionOutcome): ChangeSupervision {
  const cause: ChangeSupervision['cause'] = outcome === 'stopped'
    ? { kind: 'stopped', reason: 'round-limit', detail: { checks: ['ci / unit-tests'] } }
    : outcome === 'landed' ? { kind: 'landed', treeVerified: true } : { kind: 'not-started' }
  return {
    change, outcome, cause, alsoApplying: [], stage: null, holder: null, progress: null, activity: null, stall: null, landing: null,
    lastRound: outcome === 'stopped'
      ? { id: 'round-3', number: 3, outcome: 'fail', failing: [], flaky: ['ci / e2e'], verdict: 'fail', findingsSummary: '2 findings' }
      : null,
  }
}

function input(outcomes: SupervisionOutcome[], extra: Partial<PlanReportInput> = {}): PlanReportInput {
  return {
    supervision: content.changes.map((change, index) => view(change.change, outcomes[index]!)),
    content,
    decisions: [],
    candidates: [],
    impact: null,
    ...extra,
  }
}

describe('blockedDependents', () => {
  test('the transitive closure over dependsOn, unlanded changes only', () => {
    expect(blockedDependents(content, 'api', new Set())).toEqual(['ui', 'docs'])
    expect(blockedDependents(content, 'api', new Set(['ui']))).toEqual([])
    expect(blockedDependents(content, 'db', new Set())).toEqual(['cli'])
  })
})

describe('planReport', () => {
  test('a stop lists its reason, evidence, blocked dependents, and next action', () => {
    const report = planReport(input(['stopped', 'waiting', 'waiting', 'landed', 'running']))
    expect(report.stops).toEqual([{
      change: 'api',
      reason: 'round-limit',
      label: 'Failed 3 fix rounds',
      detail: { checks: ['ci / unit-tests'] },
      evidence: { id: 'round-3', number: 3, outcome: 'fail', failing: [], flaky: ['ci / e2e'], verdict: 'fail', findingsSummary: '2 findings' },
      blocked: ['ui', 'docs'],
      nextAction: 'Retry or stop execution',
    }])
    expect(report.counts).toEqual({ landed: 1, running: 1, waiting: 2, stalled: 0, stopped: 1, cancelled: 0, 'not-started': 0 })
  })

  test('partial delivery reads Landed N of M with blockers, never claiming success', () => {
    const report = planReport(input(['landed', 'landed', 'landed', 'stopped', 'waiting']))
    expect(report.delivery).toBe('Landed 3 of 5')
    expect(report.blockers).toEqual(['db'])
    expect(JSON.stringify(report)).not.toMatch(/criteria (are )?met|success(ful)?ly delivered/i)
  })

  test('all landed reads All M changes landed, success criteria only listed', () => {
    const report = planReport(input(['landed', 'landed', 'landed', 'landed', 'landed']))
    expect(report.delivery).toBe('All 5 changes landed')
    expect(report.successCriteria).toEqual(content.successCriteria)
  })

  test('failed and superseded candidates sit beside their change, newest first', () => {
    const candidate = (seq: number, change: string, state: IntegrationCandidate['state']): IntegrationCandidate => ({
      id: `c${seq}`, teamId: 't', branch: 'integ', seq, kind: 'increment', executionId: 'e', change, resultId: null, roundId: null,
      promotionId: null, baselineSha: 'b', commitSha: `s${seq}`, treeSha: 't', outside: null, state, createdAt: 'x', decidedAt: null,
    })
    const report = planReport(input(['landed', 'running', 'waiting', 'waiting', 'waiting'], {
      candidates: [candidate(1, 'api', 'failed'), candidate(2, 'api', 'landed'), candidate(3, 'ui', 'superseded'), candidate(4, 'api', 'superseded')],
    }))
    expect(report.candidates.map(entry => [entry.change, entry.candidates.map(found => found.id)])).toEqual([['api', ['c4', 'c1']], ['ui', ['c3']]])
  })

  test('a non-continue disposition is shown with its review; continue is not', () => {
    const impact = { disposition: 'reconsider' as const, reviewId: 'review-2', strategyRevision: 3 }
    expect(planReport(input(['landed', 'landed', 'landed', 'landed', 'landed'], { impact })).disposition).toEqual(impact)
    expect(planReport(input(['landed', 'landed', 'landed', 'landed', 'landed'], { impact: { ...impact, disposition: 'continue' } })).disposition).toBeNull()
  })

  test('the M2 and M4 lines match the decision derivations', () => {
    const decision = (id: string, seq: number, kind: PlanDecision['kind'], createdAt: string): PlanDecision => ({
      id, cardId: 'card', planId: 'p', teamId: 't', seq, kind, choice: 'c', optionIndex: null, rationale: 'r',
      decidedBy: kind === 'override' ? { kind: 'human', session: null, group: null, profile: null } : { kind: 'agent', session: 'l', group: 'lead', profile: null },
      affected: [], commandId: null, replyMessageId: null, createdAt,
    })
    const landed: FixStatus = {
      phase: 'landed', revision: null, executionId: null, outstanding: [],
      landings: [{ change: 'fix', executionId: 'e', mergeSha: 'm', landedAt: '2026-10-02T02:00:00.000Z', treeVerified: false }],
    }
    const report = planReport(input(['landed', 'landed', 'landed', 'landed', 'landed'], {
      decisions: [
        { card: { addressedGroup: 'lead' }, decisions: [decision('d1', 1, 'answer', '2026-09-30T00:00:00.000Z'), decision('o1', 2, 'override', '2026-10-01T00:00:00.000Z')], fixes: [{ decisionId: 'o1', status: landed }] },
        { card: { addressedGroup: 'lead' }, decisions: [decision('d2', 1, 'own-call', '2026-09-30T00:00:00.000Z')], fixes: [] },
      ],
    }))
    expect(report.overrides).toEqual({ overridden: 1, total: 2, line: '1 of 2 Lead decisions overridden' })
    expect(report.fixDurations).toEqual([{ decisionId: 'o1', overriddenAt: '2026-10-01T00:00:00.000Z', landedAt: '2026-10-02T02:00:00.000Z', durationMs: 26 * 3_600_000, unverified: true }])
  })
})
