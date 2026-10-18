// plan-execution design D10 and D11: CI evaluation with the floor map and the
// flaky rule, the review verdict, and the extra-check split.
import { describe, expect, test } from 'bun:test'
import type { CiCheck, FloorMap } from '../planExecution'
import { effectiveExtraChecks, evaluateCi, reviewVerdict, splitExtraChecks, type CiTiming, type VerdictFindings } from '../planExecutionGates'

const FLOOR: FloorMap = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }
const T0 = '2026-10-16T10:00:00.000Z'
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString()
const timing = (minutes: number, rerun: CiTiming['rerun'] = null): CiTiming => ({ windowFrom: T0, now: at(minutes), rerun })

const check = (name: string, conclusion: string, started: number, extra: Partial<CiCheck> = {}): CiCheck => ({
  name, conclusion, source: 'actions', runId: name === 'e2e' ? 2 : 1, link: `https://example.invalid/${name}`,
  startedAt: at(started), completedAt: conclusion === 'in_progress' ? null : at(started + 1), ...extra,
})

describe('evaluateCi', () => {
  test('all pass, and pass with neutral and skipped', () => {
    expect(evaluateCi([check('ci', 'success', 1), check('e2e', 'success', 1)], FLOOR, timing(5))).toEqual({ kind: 'pass', flaky: [] })
    expect(evaluateCi([check('ci', 'neutral', 1), check('e2e', 'skipped', 1)], FLOOR, timing(5))).toEqual({ kind: 'pass', flaky: [] })
  })

  test('pending inside the window', () => {
    expect(evaluateCi([], FLOOR, timing(10))).toEqual({ kind: 'pending', pending: [] })
    expect(evaluateCi([check('ci', 'in_progress', 1), check('e2e', 'success', 1)], FLOOR, timing(60)))
      .toEqual({ kind: 'pending', pending: ['ci'] })
  })

  test('ci-missing with no checks after 30 minutes, and with an uncovered floor check once everything finished', () => {
    expect(evaluateCi([], FLOOR, timing(30))).toMatchObject({ kind: 'stop', reason: 'ci-missing' })
    const outcome = evaluateCi([check('ci', 'success', 1)], FLOOR, timing(5))
    expect(outcome.kind === 'stop' && outcome.reason).toBe('ci-missing')
    expect(outcome.kind === 'stop' && outcome.detail.checks).toEqual(['ci-e2e'])
  })

  test('ci-timeout after 3 hours', () => {
    const outcome = evaluateCi([check('ci', 'queued', 1, { startedAt: null, completedAt: null })], FLOOR, timing(180))
    expect(outcome.kind === 'stop' && outcome.reason).toBe('ci-timeout')
    expect(evaluateCi([check('ci', 'queued', 1)], FLOOR, timing(179)).kind).toBe('pending')
  })

  test('a rerun requested once for failed Actions runs, after everything finished', () => {
    const failing = [check('ci', 'failure', 1), check('e2e', 'in_progress', 1)]
    expect(evaluateCi(failing, FLOOR, timing(5)).kind).toBe('pending')
    const done = [check('ci', 'failure', 1), check('e2e', 'failure', 1)]
    expect(evaluateCi(done, FLOOR, timing(5))).toEqual({ kind: 'rerun', runIds: [1, 2] })
    // Requested: the old failed runs await their new runs.
    expect(evaluateCi(done, FLOOR, timing(6, { at: at(5), runIds: [1, 2] })).kind).toBe('pending')
  })

  test('an immediate fail for a status, or a non-Actions check, even while others are pending', () => {
    const status = check('deploy', 'failure', 1, { source: 'status', runId: undefined })
    expect(evaluateCi([status, check('ci', 'in_progress', 1)], FLOOR, timing(5))).toEqual({ kind: 'fail', checks: [status] })
    const app = check('lint-bot', 'failure', 1, { source: 'check-run' })
    expect(evaluateCi([app, check('ci', 'success', 1), check('e2e', 'success', 1)], FLOOR, timing(5)).kind).toBe('fail')
  })

  test('flaky after a passing rerun, and fail after a second failure', () => {
    const rerun = { at: at(5), runIds: [1] }
    const flaky = [check('ci', 'failure', 1), check('ci', 'success', 6), check('e2e', 'success', 1)]
    expect(evaluateCi(flaky, FLOOR, timing(10, rerun))).toEqual({ kind: 'pass', flaky: ['ci'] })
    const twice = [check('ci', 'failure', 1), check('ci', 'failure', 6), check('e2e', 'success', 1)]
    const outcome = evaluateCi(twice, FLOOR, timing(10, rerun))
    expect(outcome.kind).toBe('fail')
    expect(outcome.kind === 'fail' && outcome.checks.map(run => run.startedAt)).toEqual([at(1), at(6)])
  })

  test('the newest run of a name decides, whatever the input order', () => {
    const runs = [check('ci', 'success', 8), check('ci', 'failure', 1), check('e2e', 'success', 1)]
    expect(evaluateCi(runs, FLOOR, timing(10, { at: at(5), runIds: [1] }))).toEqual({ kind: 'pass', flaky: ['ci'] })
    expect(evaluateCi([check('ci', 'failure', 1), check('ci', 'queued', 8, { startedAt: null }), check('e2e', 'success', 1)], FLOOR, timing(10, { at: at(5), runIds: [1] })).kind)
      .toBe('pending')
  })

  test('a non-floor check counts', () => {
    const runs = [check('ci', 'success', 1), check('e2e', 'success', 1), check('bundle-size', 'failure', 1, { runId: 3 })]
    expect(evaluateCi(runs, FLOOR, timing(5))).toEqual({ kind: 'rerun', runIds: [3] })
    const again = [...runs, check('bundle-size', 'failure', 7, { runId: 3 })]
    expect(evaluateCi(again, FLOOR, timing(10, { at: at(5), runIds: [3] })).kind).toBe('fail')
  })
})

describe('reviewVerdict', () => {
  const round = { resultId: 'r1', reviewAssignmentId: 'a-review' }
  const findings = (author: string | null, verdict: 'pass' | 'fail', extra: Partial<VerdictFindings> = {}): VerdictFindings => ({
    id: `f-${author}-${verdict}`, resultId: 'r1', handoffId: 'a-review', author, verdict, createdAt: T0, ...extra,
  })

  test("a claimant's pass counts", () => {
    expect(reviewVerdict(round, [findings('rev', 'pass')], ['rev'], ['dev'])).toEqual({ kind: 'pass', findingsId: 'f-rev-pass', reviewer: 'rev' })
  })

  test("an author's own pass is ignored", () => {
    expect(reviewVerdict(round, [findings('dev', 'pass')], ['rev'], ['dev'])).toEqual({ kind: 'pending' })
  })

  test("a non-claimant's findings are ignored", () => {
    expect(reviewVerdict(round, [findings('other', 'fail')], ['rev'], ['dev'])).toEqual({ kind: 'pending' })
  })

  test('a forwarded claimant counts, the earlier claimant no longer does', () => {
    expect(reviewVerdict(round, [findings('rev2', 'pass')], ['rev', 'rev2'], ['dev']).kind).toBe('pass')
    expect(reviewVerdict(round, [findings('rev', 'pass')], ['rev', 'rev2'], ['dev']).kind).toBe('pending')
  })

  test('a claimant who authored a result, directly or as a forward successor, is author-claimant', () => {
    expect(reviewVerdict(round, [], ['dev'], ['dev'])).toEqual({ kind: 'author-claimant', session: 'dev' })
    expect(reviewVerdict(round, [findings('dev2', 'pass')], ['rev', 'dev2'], ['dev', 'dev2'])).toEqual({ kind: 'author-claimant', session: 'dev2' })
  })

  test('a fail fails, and the newest counted findings decide', () => {
    expect(reviewVerdict(round, [findings('rev', 'fail')], ['rev'], ['dev']).kind).toBe('fail')
    const later = findings('rev', 'pass', { id: 'f2', createdAt: '2026-10-16T11:00:00.000Z' })
    expect(reviewVerdict(round, [later, findings('rev', 'fail')], ['rev'], ['dev']).kind).toBe('pass')
  })

  test('findings on another result, or answering another handoff, are ignored', () => {
    expect(reviewVerdict(round, [findings('rev', 'pass', { resultId: 'r0' })], ['rev'], []).kind).toBe('pending')
    expect(reviewVerdict(round, [findings('rev', 'pass', { handoffId: 'a-old' })], ['rev'], []).kind).toBe('pending')
  })

  test('no claimant yet is pending', () => {
    expect(reviewVerdict(round, [findings('rev', 'pass')], [], [])).toEqual({ kind: 'pending' })
  })
})

describe('splitExtraChecks', () => {
  test('extra checks split by reported names', () => {
    const size = { name: 'bundle-size', description: 'Bundle stays small', command: 'bun run size' }
    const manual = { name: 'a11y', description: 'Screen reader pass', command: null }
    expect(splitExtraChecks([size, manual], ['ci', 'bundle-size'])).toEqual({ ci: [size], attested: [manual] })
  })
})

describe('effectiveExtraChecks', () => {
  test('the plan-wide checks first, then the change\'s own, deduped by name with the first kept', () => {
    const size = { name: 'bundle-size', description: 'Bundle stays small', command: 'bun run size' }
    const manual = { name: 'a11y', description: 'Screen reader pass', command: null }
    const clash = { name: 'bundle-size', description: 'A change-level copy', command: null }
    expect(effectiveExtraChecks({ extraChecks: [size] }, { extraChecks: [manual, clash] })).toEqual([size, manual])
    expect(effectiveExtraChecks({ extraChecks: [size] }, null)).toEqual([size])
    expect(effectiveExtraChecks(null, { extraChecks: [manual] })).toEqual([manual])
    expect(effectiveExtraChecks(undefined, undefined)).toEqual([])
  })
})
