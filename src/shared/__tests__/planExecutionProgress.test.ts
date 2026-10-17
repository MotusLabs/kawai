// plan-execution design D12 and D17: the fix-round count and the progress of
// an executed plan, with every state and waiting reason rendered.
import { describe, expect, test } from 'bun:test'
import { normalizePlanContent } from '../plans'
import {
  CHANGE_STATES,
  STOP_REASONS,
  type ExecutionChangeView,
  type LandingFactView,
  type PlanExecutionView,
  type WaitingReason,
} from '../planExecution'
import { executionProgress, fixRoundOutcome, stopLabel, waitingLabel, type CountedRound } from '../planExecutionProgress'

const fold = (rounds: CountedRound[], start = 0) => rounds.reduce(
  (acc, round) => (acc.stop ? acc : fixRoundOutcome(acc.count, round)),
  { count: start, stop: false },
)
const failFix: CountedRound = { fixRound: true, outcome: 'fail' }

describe('fixRoundOutcome', () => {
  test('the implementation round does not count', () => {
    expect(fold([{ fixRound: false, outcome: 'fail' }])).toEqual({ count: 0, stop: false })
  })

  test('three failed fix rounds stop', () => {
    expect(fold([{ fixRound: false, outcome: 'fail' }, failFix, failFix])).toEqual({ count: 2, stop: false })
    expect(fold([{ fixRound: false, outcome: 'fail' }, failFix, failFix, failFix])).toEqual({ count: 3, stop: true })
  })

  test('a pass resets the count', () => {
    expect(fold([failFix, failFix, { fixRound: true, outcome: 'pass' }, failFix])).toEqual({ count: 1, stop: false })
  })

  test('a carried round counts as the round it carries', () => {
    // A carried round copies its source's fix_round flag.
    expect(fold([failFix, { fixRound: true, outcome: 'fail' }])).toEqual({ count: 2, stop: false })
    expect(fold([{ fixRound: false, outcome: 'fail' }])).toEqual({ count: 0, stop: false })
  })

  test('superseded rounds and CI stops never count', () => {
    expect(fold([failFix, { fixRound: true, outcome: 'superseded' }, { fixRound: true, outcome: 'fail', ciStop: true }]))
      .toEqual({ count: 1, stop: false })
  })
})

const content = normalizePlanContent({
  goal: 'g',
  changes: [
    { change: 'alpha', dependsOn: [], group: 'dev' },
    { change: 'beta', dependsOn: ['alpha'], group: 'dev' },
    { change: 'gamma', dependsOn: [], group: 'dev' },
  ],
})

const row = (change: string, extra: Partial<ExecutionChangeView> = {}): ExecutionChangeView => ({
  change, position: 0, state: 'waiting', step: null, waiting: null, stopReason: null, stopDetail: null,
  taskId: null, worktree: null, branch: null, baselineCommit: null, prNumber: null, prUrl: null,
  fixRounds: 0, generation: 0, passedAt: null, attempts: 0, attempt: null, instruction: null,
  latestRound: null, landing: null, effects: [], ...extra,
})

const execution = (changes: ExecutionChangeView[]): PlanExecutionView => ({
  id: 'e1', planId: 'p1', revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i', landingMode: 'direct',
  baseBranch: 'master', baseCommit: 'b', floor: { version: 1, map: { lint: [], typecheck: [], 'unit-tests': [], 'ci-e2e': [] } },
  maxParallel: 3, mergeMethod: 'merge', state: 'running', outcome: null, stopReason: null, startedAt: 'x', finishedAt: null, changes,
})

const fact = (change: string): LandingFactView => ({
  planId: 'p1', change, executionId: 'e0', mechanism: 'direct', prNumber: 1, prUrl: null, headSha: 'h', baseSha: 'b',
  mergeSha: 'm', landedAt: 'x', treeVerified: true, postCi: null,
})

describe('executionProgress', () => {
  test('landed changes come from facts; a done task or landed row without a fact is not landed', () => {
    const progress = executionProgress(content, [fact('gamma')], execution([
      row('alpha', { state: 'landed' }), row('beta'), row('gamma', { state: 'implementing' }),
    ]))
    expect(progress.map(entry => entry.status)).toEqual(['landing', 'waiting', 'landed'])
    expect(progress[1]!.waiting).toEqual({ kind: 'dependency', changes: ['alpha'] })
    expect(progress[1]!.label).toBe('Waiting — waits on alpha to land')
  })

  test('without an execution row a change is not started', () => {
    expect(executionProgress(content, [], null).map(entry => entry.label)).toEqual(['Not started', 'Not started', 'Not started'])
  })

  test('a stopped change shows its reason, naming the effect', () => {
    const [entry] = executionProgress(content, [], execution([
      row('alpha', { state: 'stopped', stopReason: 'effect-unknown', stopDetail: { effect: 'merge' } }),
    ]))
    expect(entry!.label).toBe("Stopped — stopped as effect-unknown: an external step's outcome is unknown (merge)")
  })

  test('every state renders', () => {
    for (const state of CHANGE_STATES) {
      const [entry] = executionProgress(content, [], execution([row('alpha', { state, step: state === 'gating' ? 'awaiting-ci' : null })]))
      expect(entry!.label.length).toBeGreaterThan(0)
    }
    const [gating] = executionProgress(content, [], execution([row('alpha', { state: 'gating', step: 'awaiting-ci', waiting: { kind: 'ci', pending: ['e2e'] } })]))
    expect(gating!.label).toBe('Gating: waiting for CI — waits for CI: e2e')
  })

  test('every stop reason and waiting reason renders', () => {
    for (const reason of STOP_REASONS) expect(stopLabel(reason, null)).toContain(reason)
    const reasons: WaitingReason[] = [
      { kind: 'dependency', changes: ['a'] },
      { kind: 'parallel-limit', limit: 3 },
      { kind: 'effect', effect: 'push', state: 'pending', nextAt: null },
      { kind: 'effect', effect: 'push', state: 'pending', nextAt: 'soon' },
      { kind: 'instruction', state: 'queued', holder: null },
      { kind: 'ci', pending: [] },
      { kind: 'release', member: 'dev-1', reason: 'awaiting an approval' },
      { kind: 'review', claimant: null },
      { kind: 'review', claimant: 'rev' },
      { kind: 'conditions', conditions: ['docs reviewed'] },
      { kind: 'slot', holder: 'beta' },
      { kind: 'slot', holder: null },
      { kind: 'merge' },
    ]
    const labels = reasons.map(waitingLabel)
    expect(new Set(labels).size).toBe(reasons.length)
    expect(labels.every(label => !/idle/i.test(label))).toBe(true)
  })
})
