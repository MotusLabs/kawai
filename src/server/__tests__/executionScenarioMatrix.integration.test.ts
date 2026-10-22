// The remaining spec scenarios of plan-execution §12.1, §12.5, §13.1–13.3,
// and §14.1 over the matrix harness's bare origin and scripted GitHub: a
// direction change while implementing, what the review handoff names, an
// author's own pass, extra checks with and without a CI job, a passing round
// resetting the fix count, a worktree vanishing under queued mail, Retry
// after ci-timeout and after a reopened task, and every stop releasing the
// landing slot.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { STOP_REASONS, type CiCheck } from '../../shared/planExecution'
import {
  createMatrixBench, createMatrixWorld, greenChecks, passedChange, pushCommit, removeMatrixWorld, review, startedExecution, submitWork,
  type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'
import { CI_TIMEOUT_MS } from '../../shared/planExecutionGates'

let matrix: MatrixWorld
let h: MatrixBench

beforeAll(async () => { matrix = await createMatrixWorld('kawai-scenario-matrix-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix) })
afterEach(() => { h.executor.close(); h.bench.db.close() })

const teamId = () => matrix.world.team.teamId
const row = (executionId: string, change: string) => h.executions.change(executionId, change)!
const assignmentsOf = (executionId: string, change: string) => h.tasks.store.assignmentsOf(row(executionId, change).taskId!)
const handoffs = (executionId: string, change: string, kind: string) => assignmentsOf(executionId, change).filter(entry => entry.handoffKind === kind)
const bodyOf = (assignment: { messageId: string | null }) => h.mail.get(assignment.messageId!)!.body
const bundleSize = { name: 'bundle-size', description: 'The bundle stays under 2 MiB', command: 'bun run size' }
const a11y = { name: 'a11y', description: 'A screen reader announces the new row', command: null }
const withBundle = (): CiCheck[] => [
  ...greenChecks(),
  { name: 'bundle-size', source: 'status', conclusion: 'success', link: null, startedAt: null, completedAt: null },
]

describe('direction changed while implementing (12.1)', () => {
  test('no attempt is dispatched, the implementer gets the notice, and its next result pins the new revision', async () => {
    const executionId = await startedExecution(h, [{ change: 'dc-a' }])
    await h.tick()
    const instruction = assignmentsOf(executionId, 'dc-a')[0]!
    h.mail.claim(instruction.messageId!, 'dev')
    h.mail.markPushed(instruction.messageId!)
    h.mail.markDelivered(instruction.messageId!)
    await h.tasks.amend(h.bench.human, row(executionId, 'dc-a').taskId!, { direction: 'Narrow the scope', rationale: 'scope changed', notify: true })
    await h.tick()
    await h.tick()
    // No round is gating: nothing supersedes, no fix attempt goes out.
    expect(assignmentsOf(executionId, 'dc-a')).toHaveLength(1)
    expect(row(executionId, 'dc-a')).toMatchObject({ state: 'implementing', stopReason: null })
    const notices = h.mail.forTask(row(executionId, 'dc-a').taskId!).filter(message => message.toKind === 'session' && message.toId === 'dev' && message.tags.includes('task-revision'))
    expect(notices).toHaveLength(1)
    await submitWork(h, executionId, 'dc-a', 'src/dc.ts', 'dc\n')
    await h.tick()
    const round = h.executions.rounds(executionId, 'dc-a').at(-1)!
    expect(h.tasks.store.results.get(round.resultId)!.taskRevision).toBe(2)
  })
})

describe('the review and extra checks (12.5)', () => {
  test('the review names the result, commit, PR, acceptance rules, and only the checks to attest; the verdict labels each', async () => {
    const executionId = await startedExecution(h, [{ change: 'rv-n', acceptance: ['Rows render in order'], extraChecks: [bundleSize, a11y] }], { acceptanceRules: ['No new dependency'] })
    await h.tick()
    h.gh.defaultChecks = withBundle()
    const commit = await submitWork(h, executionId, 'rv-n', 'src/rv.ts', 'rv\n')
    await h.tick()
    const round = h.executions.rounds(executionId, 'rv-n').at(-1)!
    const body = bodyOf(handoffs(executionId, 'rv-n', 'review')[0]!)
    expect(body).toContain(round.resultId)
    expect(body).toContain(commit)
    expect(body).toContain(row(executionId, 'rv-n').prUrl!)
    expect(body).toContain('- Rows render in order')
    expect(body).toContain('- No new dependency')
    const attest = body.slice(body.indexOf('Extra checks to attest:'))
    expect(body).toContain('Extra checks to attest:')
    expect(attest).toContain('- a11y: A screen reader announces the new row')
    // bundle-size is CI's: reported green, never listed to attest.
    expect(attest.split('\n\n')[0]).not.toContain('bundle-size')

    await review(h, executionId, 'rv-n', 'pass')
    await h.tick()
    const decided = h.executions.rounds(executionId, 'rv-n').at(-1)!
    expect(decided.outcome).toBe('pass')
    expect(decided.extra).toEqual([
      { name: 'bundle-size', description: bundleSize.description, command: 'bun run size', by: 'ci', outcome: 'success' },
      { name: 'a11y', description: a11y.description, command: null, by: 'reviewer', outcome: 'attested' },
    ])
  })

  test('without a CI job the extra check is attested by the reviewer and listed to attest', async () => {
    const executionId = await startedExecution(h, [{ change: 'rv-x', extraChecks: [bundleSize] }])
    await h.tick()
    await submitWork(h, executionId, 'rv-x', 'src/rx.ts', 'rx\n')
    await h.tick()
    expect(bodyOf(handoffs(executionId, 'rv-x', 'review')[0]!)).toContain('- bundle-size: The bundle stays under 2 MiB (command: bun run size)')
    await review(h, executionId, 'rv-x', 'pass')
    await h.tick()
    expect(h.executions.rounds(executionId, 'rv-x').at(-1)!.extra).toEqual([
      { name: 'bundle-size', description: bundleSize.description, command: 'bun run size', by: 'reviewer', outcome: 'attested' },
    ])
  })

  test('an author who is not the claimant passes its own work: recorded, and the round still waits', async () => {
    const executionId = await startedExecution(h, [{ change: 'au-a' }])
    await h.tick()
    await submitWork(h, executionId, 'au-a', 'src/au.ts', 'au\n')
    await h.tick()
    const round = h.executions.rounds(executionId, 'au-a').at(-1)!
    const assignment = handoffs(executionId, 'au-a', 'review')[0]!
    h.mail.claim(assignment.messageId!, 'rev1')
    await h.results.submitFindings(h.bench.agent('dev'), row(executionId, 'au-a').taskId!, { resultId: round.resultId, kind: 'review', verdict: 'pass', findings: 'looks fine to me' })
    await h.tick()
    expect(h.tasks.store.results.findingsFor(round.resultId)).toHaveLength(1)
    expect(h.executions.rounds(executionId, 'au-a').at(-1)!.outcome).toBeNull()
    expect(row(executionId, 'au-a')).toMatchObject({ state: 'gating', step: 'reviewing', passedAt: null })
    // The claimant's verdict decides.
    await review(h, executionId, 'au-a', 'pass')
    await h.tick()
    expect(h.executions.rounds(executionId, 'au-a').at(-1)!.outcome).toBe('pass')
  })
})

describe('the fix count (13.1)', () => {
  test('a passing round resets the count: a failed update round afterwards shows one of three and gets another fix', async () => {
    const executionId = await startedExecution(h, [{ change: 'fc-a' }])
    await h.tick()
    // Implement fails; two fix rounds fail; the third fix passes.
    for (const [index, content] of ['1', '2', '3'].entries()) {
      await submitWork(h, executionId, 'fc-a', 'seed.txt', `branch ${content}\n`)
      await h.tick()
      await review(h, executionId, 'fc-a', 'fail', 'rev1', `round ${index + 1} needs work`)
      await h.tick()
    }
    expect(row(executionId, 'fc-a')).toMatchObject({ state: 'implementing', fixRounds: 2 })
    await submitWork(h, executionId, 'fc-a', 'seed.txt', 'branch 4\n')
    await h.tick()
    // The base conflicts before the passing verdict: the landing returns an update attempt.
    pushCommit(matrix, 'master', 'seed.txt', 'base side fc-a\n')
    await review(h, executionId, 'fc-a', 'pass')
    await h.tick()
    expect(h.executions.rounds(executionId, 'fc-a').at(-1)!.outcome).toBe('pass')
    expect(row(executionId, 'fc-a').fixRounds).toBe(0)
    const fixesBefore = handoffs(executionId, 'fc-a', 'fix').length
    // The update attempt's round fails its review.
    await submitWork(h, executionId, 'fc-a', 'seed.txt', 'branch 5\n')
    await h.tick()
    await review(h, executionId, 'fc-a', 'fail', 'rev1', 'the merge lost a line')
    await h.tick()
    // One failed fix round of three: the next instruction is the second.
    expect(row(executionId, 'fc-a')).toMatchObject({ state: 'implementing', fixRounds: 1, stopReason: null })
    expect(handoffs(executionId, 'fc-a', 'fix').length).toBe(fixesBefore + 1)
    expect(bodyOf(handoffs(executionId, 'fc-a', 'fix').at(-1)!)).toContain('This is fix round 2 of 3.')
  })
})

describe('a vanished worktree and Retry (13.2, 13.3)', () => {
  test('the worktree disappears under the queued fix instruction: stopped instruction-failed naming worktree-missing', async () => {
    const executionId = await startedExecution(h, [{ change: 'wm-a' }])
    await h.tick()
    await submitWork(h, executionId, 'wm-a', 'src/wm.ts', 'wm\n')
    await h.tick()
    await review(h, executionId, 'wm-a', 'fail')
    await h.tick()
    const fix = handoffs(executionId, 'wm-a', 'fix')[0]!
    expect(h.mail.get(fix.messageId!)!.state).toBe('queued')
    // The dispatcher's sweep: queued task mail whose worktree is gone.
    const worktree = row(executionId, 'wm-a').worktree!
    h.mail.deadLetter(fix.messageId!, `worktree-missing: ${worktree}`)
    await h.tick()
    const stopped = row(executionId, 'wm-a')
    expect(stopped).toMatchObject({ state: 'stopped', stopReason: 'instruction-failed' })
    expect(stopped.stopDetail?.message).toContain(`worktree-missing: ${worktree}`)
  })

  test('ci-timeout: Retry reopens the window and the round goes on to review', async () => {
    const executionId = await startedExecution(h, [{ change: 'ct-a' }])
    await h.tick()
    const commit = await submitWork(h, executionId, 'ct-a', 'src/ct.ts', 'ct\n')
    h.gh.checks.set(commit, [{ name: 'ci', source: 'actions', conclusion: 'queued', link: null, runId: 61, startedAt: '2026-10-17T00:00:00.000Z', completedAt: null }])
    await h.tick()
    h.clock.now += CI_TIMEOUT_MS + 1000
    await h.tick()
    expect(row(executionId, 'ct-a')).toMatchObject({ state: 'stopped', stopReason: 'ci-timeout' })
    expect(await h.service.retry(h.bench.human, { executionId, change: 'ct-a', commandId: 'retry-ct' })).toMatchObject({ ok: true })
    h.clock.now = Date.now()
    h.gh.checks.set(commit, greenChecks())
    await h.tick()
    await h.tick()
    expect(row(executionId, 'ct-a')).toMatchObject({ state: 'gating', step: 'reviewing', stopReason: null })
    expect(handoffs(executionId, 'ct-a', 'review')).toHaveLength(1)
  })

  test('task-closed: Retry is refused while cancelled and dispatches again after a reopen', async () => {
    const executionId = await startedExecution(h, [{ change: 'tc-a' }])
    await h.tick()
    const taskId = row(executionId, 'tc-a').taskId!
    // The implementer has the instruction when the human cancels the task.
    const first = assignmentsOf(executionId, 'tc-a')[0]!
    h.mail.claim(first.messageId!, 'dev')
    h.mail.markPushed(first.messageId!)
    h.mail.markDelivered(first.messageId!)
    await h.tasks.setStatus(h.bench.human, taskId, 'cancelled')
    await h.tick()
    expect(row(executionId, 'tc-a')).toMatchObject({ state: 'stopped', stopReason: 'task-closed' })
    const refused = await h.service.retry(h.bench.human, { executionId, change: 'tc-a', commandId: 'retry-tc-1' })
    expect(refused).toMatchObject({ ok: false })
    await h.tasks.setStatus(h.bench.human, taskId, 'open')
    expect(await h.service.retry(h.bench.human, { executionId, change: 'tc-a', commandId: 'retry-tc-2' })).toMatchObject({ ok: true })
    await h.tick()
    expect(row(executionId, 'tc-a')).toMatchObject({ state: 'implementing', stopReason: null })
    const assignments = assignmentsOf(executionId, 'tc-a')
    expect(assignments).toHaveLength(2)
    expect(h.mail.get(assignments.at(-1)!.messageId!)!.state).toBe('queued')
    // The delivered instruction is superseded, never cancelled.
    expect(assignments[0]!.supersededBy).toBe(assignments[1]!.id)
    expect(h.mail.get(first.messageId!)!.state).toBe('delivered')
  })
})

describe('every stop releases the slot (14.1)', () => {
  test('a landing change stopped for any reason frees the team\'s slot', async () => {
    const executionId = await startedExecution(h, [{ change: 'ss-a' }])
    await passedChange(h, executionId, 'ss-a')
    pushCommit(matrix, 'master', 'other-ss-a.txt', 'a\n')
    // GitHub's update never comes through: ss-a holds the slot while updating.
    h.gh.update = () => {}
    await h.tick()
    expect(row(executionId, 'ss-a').state).toBe('landing')
    for (const reason of STOP_REASONS) {
      const landing = row(executionId, 'ss-a')
      expect(landing.state).toBe('landing')
      expect(h.executions.slot(teamId())?.holderId).toContain(':ss-a')
      h.executions.transition(executionId, 'ss-a', landing, { state: 'stopped', stopReason: reason, stopDetail: { message: reason }, step: null })
      expect(h.executions.slot(teamId())).toBeNull()
      // Back into landing for the next reason.
      h.executions.transition(executionId, 'ss-a', row(executionId, 'ss-a'), { state: 'landing', stopReason: null, stopDetail: null, step: 'updating' })
    }
  })

  test('a human close during the update stops the change and frees the slot', async () => {
    const executionId = await startedExecution(h, [{ change: 'ss-b' }])
    await passedChange(h, executionId, 'ss-b')
    pushCommit(matrix, 'master', 'other-ss-b.txt', 'b\n')
    h.gh.update = () => {}
    await h.tick()
    expect(h.executions.slot(teamId())?.holderId).toContain(':ss-b')
    await h.tasks.setStatus(h.bench.human, row(executionId, 'ss-b').taskId!, 'cancelled')
    await h.tick()
    await h.tick()
    expect(row(executionId, 'ss-b')).toMatchObject({ state: 'stopped', stopReason: 'task-closed' })
    expect(h.executions.slot(teamId())).toBeNull()
    expect(h.executions.effectsOf(executionId).filter(effect => effect.kind === 'merge')).toEqual([])
  })

  test('a human close during an update GitHub refuses as a conflict: stopped, slot free, no update attempt', async () => {
    const executionId = await startedExecution(h, [{ change: 'ss-c' }])
    await passedChange(h, executionId, 'ss-c')
    pushCommit(matrix, 'master', 'other-ss-c.txt', 'c\n')
    h.gh.update = async () => {
      h.gh.update = null
      await h.tasks.setStatus(h.bench.human, row(executionId, 'ss-c').taskId!, 'cancelled')
      return 'conflict' as const
    }
    await h.tick()
    await h.tick()
    await h.tick()
    expect(row(executionId, 'ss-c')).toMatchObject({ state: 'stopped', stopReason: 'task-closed' })
    expect(h.executions.slot(teamId())).toBeNull()
    expect(handoffs(executionId, 'ss-c', 'fix')).toEqual([])
    expect(h.gh.merges).toEqual([])
  })
})
