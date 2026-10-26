// The round pipeline end to end (plan-execution §12, D9-D11) over the plan
// bench, a bare origin, and a stub gh: a submitted result becomes the
// change's round, its commit is pushed for real and given the change's one
// pull request, a passing CI releases nothing (unscoped reviewers) and
// dispatches the review handoff with the role's profiles and author tags,
// and an independent claimant's pass decides the round. A newer result
// supersedes the open round; a closed pull request stops as pr-closed; a
// failing CI asks for the round's one rerun; an author claiming the review
// stops it as review-unavailable.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  approvedExecution, bench, closeExecutor, commitAll, deliverToReviewer, executor, executions, ghStub, git,
  implementStage, mail, origin, passCi, results, setupBench, setupWorld, tasks, teardownWorld, world,
} from './executionRoundsFixture'

beforeAll(setupWorld)
afterAll(teardownWorld)
beforeEach(setupBench)
afterEach(closeExecutor)

describe('the round pipeline (§12)', () => {
  test('a result becomes a decided round: push, PR, CI, review, independent pass', async () => {
    const executionId = await approvedExecution('flow-a')
    const { commit } = await implementStage(executionId, 'flow-a', 'export const a = 1\n')
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()

    const change = executions.change(executionId, 'flow-a')!
    // The push landed on origin for real; the PR was created via the stub.
    expect(git(['rev-parse', `refs/heads/flow-a`], origin).trim()).toBe(commit)
    expect(change).toMatchObject({ prNumber: 7, prUrl: 'https://example.internal/pr/7', prOpenedByKawai: true, state: 'gating', step: 'reviewing' })
    const round = executions.rounds(executionId, 'flow-a').at(-1)!
    expect(round).toMatchObject({ number: 1, commitSha: commit, fixRound: false, pushedAt: expect.any(String) })
    expect(round.reviewAssignmentId).not.toBeNull()

    // An independent reviewer claims and passes it.
    const assignment = tasks.store.assignmentsOf(change.taskId!).find(a => a.id === round.reviewAssignmentId)!
    deliverToReviewer(assignment.messageId!, 'rev1')
    await results.submitFindings(bench.agent('rev1'), change.taskId!, { resultId: round.resultId, kind: 'review', verdict: 'pass', findings: 'clean' })
    executor.wake(world.team.teamId)
    await executor.idle()

    const decided = executions.rounds(executionId, 'flow-a').at(-1)!
    expect(decided).toMatchObject({ outcome: 'pass', verdictFindingsId: expect.any(String), decidedAt: expect.any(String) })
    expect(executions.change(executionId, 'flow-a')!.passedAt).not.toBeNull()
    // The review mail carried the author's profile tag and no role narrowing (reviewers has no role entry).
    const reviewMail = mail.get(assignment.messageId!)!
    expect(reviewMail.tags).toContain('author-profile:glm')
    expect([reviewMail.allowedProfiles, reviewMail.workerChoice ?? null, assignment.workerChoice ?? null]).toEqual([null, null, null])
  })

  test('a newer result supersedes the open round; a merge started holds it', async () => {
    const executionId = await approvedExecution('flow-b')
    await implementStage(executionId, 'flow-b', 'v1')
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()
    const change = executions.change(executionId, 'flow-b')!
    expect(change.state).toBe('gating')

    // A second result on the same attempt supersedes round 1 (back to gating, round 2).
    const worktree = change.worktree!
    fs.writeFileSync(path.join(worktree, 'src', 'flow-b.ts'), 'export const b = 2\n')
    commitAll(worktree, 'revise')
    await results.submit(bench.agent('dev'), change.taskId!, { summary: 'revised', commit: git(['rev-parse', 'HEAD'], worktree).trim() })
    executor.wake(world.team.teamId)
    await executor.idle()
    const rounds = executions.rounds(executionId, 'flow-b')
    expect(rounds.map(round => [round.number, round.outcome])).toEqual([[1, 'superseded'], [2, null]])

    // A landing change (its merge started) takes no new round.
    const row = executions.change(executionId, 'flow-b')!
    for (const state of ['provisioning', 'implementing', 'gating', 'landing'] as const) {
      const current = executions.change(executionId, 'flow-b')!
      executions.transition(executionId, 'flow-b', current, { state })
    }
    await results.submit(bench.agent('dev'), row.taskId!, { summary: 'during merge', commit: git(['rev-parse', 'HEAD'], worktree).trim() })
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.rounds(executionId, 'flow-b')).toHaveLength(2)
  })

  test('a failing rerunnable CI asks for the one rerun; a closed PR stops as pr-closed', async () => {
    const executionId = await approvedExecution('flow-c')
    await implementStage(executionId, 'flow-c', 'x')
    ghStub.pulls = '[]'
    ghStub.checkRuns = JSON.stringify([
      { id: 't', name: 'ci', source: 'actions', conclusion: 'failure', link: 'https://example.internal/runs/21/at', runId: 21, startedAt: '2026-10-17T00:00:00.000Z', completedAt: '2026-10-17T00:01:00.000Z' },
      { id: 'e', name: 'e2e', source: 'status', conclusion: 'success', link: null, startedAt: null, completedAt: null },
    ])
    executor.wake(world.team.teamId)
    await executor.idle()
    // The rerun effect ran through the stub adapter: the round's one rerun,
    // never repeated however the change's generation moves (D10).
    expect(ghStub.reruns).toEqual([21])
    const rerunEffect = executions.effectsOf(executionId).find(effect => effect.kind === 'rerun')!
    expect(rerunEffect.state).toBe('done')

    // A closed pull request on the next round stops the change.
    ghStub.pulls = JSON.stringify([{ number: 3, url: 'https://example.internal/pr/3', state: 'CLOSED', headRefOid: 'x' }])
    const change = executions.change(executionId, 'flow-c')!
    const worktree = change.worktree!
    fs.writeFileSync(path.join(worktree, 'src', 'flow-c.ts'), 'y')
    commitAll(worktree, 'again')
    await results.submit(bench.agent('dev'), change.taskId!, { summary: 'fixed', commit: git(['rev-parse', 'HEAD'], worktree).trim() })
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(executionId, 'flow-c')).toMatchObject({ state: 'stopped', stopReason: 'pr-closed' })
  })

  test('a failed review returns the change for a fix attempt naming what it answers', async () => {
    const executionId = await approvedExecution('fix-a')
    await implementStage(executionId, 'fix-a', 'x')
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()
    const change = executions.change(executionId, 'fix-a')!
    const round = executions.rounds(executionId, 'fix-a').at(-1)!
    const assignment = tasks.store.assignmentsOf(change.taskId!).find(a => a.id === round.reviewAssignmentId)!
    deliverToReviewer(assignment.messageId!, 'rev1')
    ghStub.checkRuns = JSON.stringify([
      { id: 't', name: 'ci', source: 'actions', conclusion: 'success', link: 'l', runId: 11, startedAt: '2026-10-17T00:00:00.000Z', completedAt: '2026-10-17T00:01:00.000Z' },
      { id: 'e', name: 'e2e', source: 'status', conclusion: 'failure', link: null, startedAt: null, completedAt: null },
    ])
    await results.submitFindings(bench.agent('rev1'), change.taskId!, { resultId: round.resultId, kind: 'review', verdict: 'fail', findings: 'the e2e test fails on the settings page' })
    executor.wake(world.team.teamId)
    await executor.idle()

    expect(executions.rounds(executionId, 'fix-a').at(-1)).toMatchObject({ outcome: 'fail' })
    const row = executions.change(executionId, 'fix-a')!
    expect(row).toMatchObject({ state: 'implementing', fixRounds: 0 })
    const fixAttempt = executions.attempts(executionId, 'fix-a').at(-1)!
    expect(fixAttempt.kind).toBe('fix')
    expect(fixAttempt.manifest.answers?.resultId).toBe(round.resultId)
    expect(fixAttempt.manifest.answers?.findingsIds).toHaveLength(1)
    const fixAssignment = tasks.store.assignmentsOf(change.taskId!).at(-1)!
    const fixMail = mail.get(fixAssignment.messageId!)!
    expect(fixMail.body).toContain('fix round 1 of 3')
    expect(fixMail.body).toContain('the e2e test fails on the settings page')
    expect(fixMail.body).toContain(round.commitSha)
  })

  test('the third failed fix round stops the change as round-limit', async () => {
    const executionId = await approvedExecution('fix-b')
    await implementStage(executionId, 'fix-b', 'x')
    const row = executions.change(executionId, 'fix-b')!
    // Two failed fix rounds already counted: the next failure is the third.
    executions.transition(executionId, 'fix-b', row, { fixRounds: 2 })
    ghStub.pulls = '[]'
    ghStub.checkRuns = '[]'
    ghStub.statuses = JSON.stringify([{ name: 'e2e', source: 'status', conclusion: 'failure', link: null, startedAt: null, completedAt: null }])
    executor.wake(world.team.teamId)
    await executor.idle()
    // The implement round fails on the non-rerunnable status (it never counts);
    // a fix attempt follows, and ITS failed round is the third counted stop.
    const change = executions.change(executionId, 'fix-b')!
    expect(change.state).toBe('implementing')
    const worktree = change.worktree!
    fs.writeFileSync(path.join(worktree, 'src', 'fix-b.ts'), 'fix')
    commitAll(worktree, 'fix attempt')
    await results.submit(bench.agent('dev'), change.taskId!, { summary: 'fixed', commit: git(['rev-parse', 'HEAD'], worktree).trim() })
    executor.wake(world.team.teamId)
    await executor.idle()
    const stopped = executions.change(executionId, 'fix-b')!
    expect(stopped).toMatchObject({ state: 'stopped', stopReason: 'round-limit' })
    expect(stopped.stopDetail?.checks).toContain('e2e')
  })

  test('a failed instruction and a hand-closed task stop the change', async () => {
    const executionId = await approvedExecution('stop-a')
    await implementStage(executionId, 'stop-a', 'x')
    const change = executions.change(executionId, 'stop-a')!
    // The instruction mail dead-letters.
    const assignment = tasks.store.assignmentsOf(change.taskId!)[0]!
    mail.deadLetter(assignment.messageId!, 'killed-recipient')
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(executionId, 'stop-a')).toMatchObject({ state: 'stopped', stopReason: 'instruction-failed' })

    // A hand-closed task stops another change.
    const other = await approvedExecution('stop-b')
    await implementStage(other, 'stop-b', 'x')
    const rowB = executions.change(other, 'stop-b')!
    await tasks.setStatus(bench.human, rowB.taskId!, 'done')
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(other, 'stop-b')).toMatchObject({ state: 'stopped', stopReason: 'task-closed' })
  })

  test('a new task revision supersedes the round and dispatches a fix naming it (12.1)', async () => {
    const executionId = await approvedExecution('rev-a')
    await implementStage(executionId, 'rev-a', 'x')
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()
    const change = executions.change(executionId, 'rev-a')!
    expect(change.state).toBe('gating')

    // The human republishes the task's direction.
    await tasks.amend(bench.human, change.taskId!, { direction: 'Do it differently now', rationale: 'scope changed' })
    executor.wake(world.team.teamId)
    await executor.idle()

    const rounds = executions.rounds(executionId, 'rev-a')
    expect(rounds.map(round => round.outcome)).toEqual(['superseded'])
    const row = executions.change(executionId, 'rev-a')!
    expect(row.state).toBe('implementing')
    const fix = tasks.store.assignmentsOf(change.taskId!).at(-1)!
    const fixMail = mail.get(fix.messageId!)!
    expect(fixMail.body).toContain('revision 2')
    expect(fixMail.body).toContain('scope changed')
    expect(executions.attempts(executionId, 'rev-a').at(-1)!.kind).toBe('fix')
  })

  test('a failed round keeps its fix under a later revision: no stop, no new assignment, the round stays fail (H2)', async () => {
    const executionId = await approvedExecution('rev-e')
    await implementStage(executionId, 'rev-e', 'x')
    // The round fails on a non-rerunnable status: the fix attempt is minted
    // and dispatched, and the developer claims it.
    ghStub.pulls = '[]'
    ghStub.checkRuns = '[]'
    ghStub.statuses = JSON.stringify([{ name: 'e2e', source: 'status', conclusion: 'failure', link: null, startedAt: null, completedAt: null }])
    executor.wake(world.team.teamId)
    await executor.idle()
    const change = executions.change(executionId, 'rev-e')!
    expect(executions.rounds(executionId, 'rev-e').at(-1)).toMatchObject({ outcome: 'fail' })
    expect(executions.attempts(executionId, 'rev-e').at(-1)!.kind).toBe('fix')
    const fixAssignment = tasks.store.assignmentsOf(change.taskId!).at(-1)!
    mail.claim(fixAssignment.messageId!, 'dev')
    const assignmentsBefore = tasks.store.assignmentsOf(change.taskId!).length

    // The revision lands while the fix is claimed. The fix already answers
    // the failed round and carries the newest direction through its notice,
    // so D9 must not gate it again: no supersede, no second dispatch under
    // the attempt's key, no stop.
    await tasks.amend(bench.human, change.taskId!, { direction: 'Do it differently now', rationale: 'scope changed' })
    executor.wake(world.team.teamId)
    await executor.idle()

    expect(executions.rounds(executionId, 'rev-e').at(-1)).toMatchObject({ outcome: 'fail' })
    expect(executions.change(executionId, 'rev-e')).toMatchObject({ state: 'implementing', stopReason: null })
    expect(tasks.store.assignmentsOf(change.taskId!)).toHaveLength(assignmentsBefore)

    // The next result pins the newest revision: it re-enters the round
    // pipeline at the round, never through a revision fix.
    const worktree = executions.change(executionId, 'rev-e')!.worktree!
    fs.writeFileSync(path.join(worktree, 'src', 'rev-e.ts'), 'v2\n')
    commitAll(worktree, 'revise')
    const revised = await results.submit(bench.agent('dev'), change.taskId!, { summary: 'revised', commit: git(['rev-parse', 'HEAD'], worktree).trim() })
    expect(revised.taskRevision).toBe(tasks.store.get(change.taskId!)!.revision)
  })

  test('an author claiming the review stops it as review-unavailable', async () => {
    const executionId = await approvedExecution('flow-d')
    await implementStage(executionId, 'flow-d', 'x')
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()
    const change = executions.change(executionId, 'flow-d')!
    const round = executions.rounds(executionId, 'flow-d').at(-1)!
    // dev authored the result; rev1 passes — but first make dev the claimant.
    const assignment = tasks.store.assignmentsOf(change.taskId!).find(a => a.id === round.reviewAssignmentId)!
    deliverToReviewer(assignment.messageId!, 'dev')
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(executionId, 'flow-d')).toMatchObject({ state: 'stopped', stopReason: 'review-unavailable' })
    expect(executions.change(executionId, 'flow-d')!.stopDetail?.session).toBe('dev')
  })
})
