// The landing matrix (plan-execution §12.1, §13.4, §14.2, §14.3; rev 5 B5)
// over a real bare origin and the scripted GitHub of the matrix harness:
// bringing a branch up to date (a clean update carries the review; a base
// that moves during it; a hand merge, a pushed head, and a real conflict each
// returning the change as an update attempt; failed CI after the update), the
// pinned merge and its landing fact under every merge method, Stop while a
// merge runs, a human close while a merge runs (13.4b), and new task
// revisions published around the landing.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { CiCheck, MergeMethod } from '../../shared/planExecution'
import {
  createMatrixBench, createMatrixWorld, git, onOrigin, originHead, passedChange, pushCommit, removeMatrixWorld, review, startedExecution, submitWork,
  type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench

beforeAll(async () => { matrix = await createMatrixWorld('kawai-landing-matrix-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix) })
afterEach(() => { h.executor.close(); h.bench.db.close() })

const teamId = () => matrix.world.team.teamId
const row = (executionId: string, change: string) => h.executions.change(executionId, change)!
const handoffs = (executionId: string, change: string, kind: string) =>
  h.tasks.store.assignmentsOf(row(executionId, change).taskId!).filter(entry => entry.handoffKind === kind)
const bodyOf = (assignment: { messageId: string | null }) => h.mail.get(assignment.messageId!)!.body
/** A failed commit status: not rerunnable, so it fails the round at once (D10). */
const failing = (): CiCheck[] => [
  { name: 'ci', source: 'actions', conclusion: 'success', link: null, runId: 77, startedAt: '2026-10-17T00:00:00.000Z', completedAt: '2026-10-17T00:01:00.000Z' },
  { name: 'e2e', source: 'status', conclusion: 'failure', link: null, startedAt: null, completedAt: null },
]
const pending = (): CiCheck[] => [{ name: 'ci', source: 'actions', conclusion: 'in_progress', link: null, runId: 78, startedAt: '2026-10-17T00:00:00.000Z', completedAt: null }]

/** GitHub's clean branch update, done on origin: merge the base into the branch. Returns the new head. */
function mergeBaseInto(branch: string, edit?: (clone: string) => void): string {
  onOrigin(matrix, clone => {
    git(['checkout', '-q', branch], clone)
    git(['-c', 'user.email=gh@e', '-c', 'user.name=GitHub', 'merge', '-q', '--no-ff', '-m', 'Merge base into branch', 'origin/master'], clone)
    if (edit !== undefined) {
      edit(clone)
      git(['add', '-A'], clone)
      git(['-c', 'user.email=gh@e', '-c', 'user.name=GitHub', 'commit', '-q', '--amend', '--no-edit'], clone)
    }
    git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], clone)
  })
  return originHead(matrix, branch)!
}

/** Tick until the change reaches a state (the merge and its outcome may take a pass each). */
async function tickUntil(executionId: string, change: string, done: (state: string) => boolean, passes = 4): Promise<void> {
  for (let pass = 0; pass < passes && !done(row(executionId, change).state); pass++) await h.tick()
}

describe('bringing the branch up to date (14.2)', () => {
  test('a clean update carries the review onto the new head; no second review', async () => {
    const executionId = await startedExecution(h, [{ change: 'up-a' }])
    const reviewed = await passedChange(h, executionId, 'up-a')
    pushCommit(matrix, 'master', 'other-a.txt', 'a\n')
    await tickUntil(executionId, 'up-a', state => state === 'landed')
    expect(row(executionId, 'up-a').state).toBe('landed')
    expect(h.gh.updates).toEqual([{ pr: row(executionId, 'up-a').prNumber!, head: reviewed }])
    const rounds = h.executions.rounds(executionId, 'up-a')
    expect(rounds).toHaveLength(2)
    expect(rounds[1]!.carriedFrom).toBe(rounds[0]!.id)
    expect(rounds[1]!.commitSha).not.toBe(reviewed)
    expect(handoffs(executionId, 'up-a', 'review')).toHaveLength(1)
    expect(h.gh.merges.at(-1)!.head).toBe(rounds[1]!.commitSha)
  })

  test('a base that moves during the update still passes the clean check', async () => {
    const executionId = await startedExecution(h, [{ change: 'up-b' }])
    await passedChange(h, executionId, 'up-b')
    pushCommit(matrix, 'master', 'other-b1.txt', '1\n')
    h.gh.update = branch => {
      mergeBaseInto(branch)
      // The base moves on right after GitHub merged it into the branch.
      pushCommit(matrix, 'master', 'other-b2.txt', '2\n')
      h.gh.update = null
    }
    await tickUntil(executionId, 'up-b', state => state === 'landed', 6)
    expect(row(executionId, 'up-b').state).toBe('landed')
    // The first update's head was carried (not refused), then updated again.
    const rounds = h.executions.rounds(executionId, 'up-b')
    expect(rounds.filter(round => round.carriedFrom !== null).length).toBeGreaterThanOrEqual(1)
    expect(handoffs(executionId, 'up-b', 'fix')).toHaveLength(0)
  })

  test('a hand merge with another tree returns an update attempt and releases the slot', async () => {
    const executionId = await startedExecution(h, [{ change: 'up-c' }])
    await passedChange(h, executionId, 'up-c')
    pushCommit(matrix, 'master', 'other-c.txt', 'c\n')
    h.gh.update = branch => { mergeBaseInto(branch, clone => fs.writeFileSync(path.join(clone, 'extra.txt'), 'edited in the merge\n')) }
    await h.tick()
    await h.tick()
    expect(row(executionId, 'up-c')).toMatchObject({ state: 'gating', step: null })
    expect(h.executions.slot(teamId())).toBeNull()
    const fixes = handoffs(executionId, 'up-c', 'fix')
    expect(fixes).toHaveLength(1)
    expect(bodyOf(fixes[0]!)).toContain('did not produce a clean merge')
    expect(h.gh.merges).toHaveLength(0)
  })

  test('a head moved by a push during the update returns an update attempt and releases the slot', async () => {
    const executionId = await startedExecution(h, [{ change: 'up-d' }])
    await passedChange(h, executionId, 'up-d')
    pushCommit(matrix, 'master', 'other-d.txt', 'd\n')
    h.gh.update = branch => { pushCommit(matrix, branch, 'pushed.txt', 'p\n') }
    await h.tick()
    await h.tick()
    expect(row(executionId, 'up-d')).toMatchObject({ state: 'gating', step: null })
    expect(h.executions.slot(teamId())).toBeNull()
    expect(handoffs(executionId, 'up-d', 'fix')).toHaveLength(1)
    expect(h.gh.merges).toHaveLength(0)
  })

  test('a real conflict returns an update attempt naming the file, with no branch update', async () => {
    const executionId = await startedExecution(h, [{ change: 'up-e' }])
    await h.tick()
    await submitWork(h, executionId, 'up-e', 'seed.txt', 'branch side\n')
    await h.tick()
    await review(h, executionId, 'up-e', 'pass')
    const base = pushCommit(matrix, 'master', 'seed.txt', 'base side\n')
    await h.tick()
    expect(row(executionId, 'up-e')).toMatchObject({ state: 'gating', step: null })
    expect(h.executions.slot(teamId())).toBeNull()
    expect(h.gh.updates).toHaveLength(0)
    const fixes = handoffs(executionId, 'up-e', 'fix')
    expect(fixes).toHaveLength(1)
    expect(bodyOf(fixes[0]!)).toContain('seed.txt')
    expect(bodyOf(fixes[0]!)).toContain(base)
  })

  test('failed CI after the update dispatches a fix continuing from the merge commit', async () => {
    const executionId = await startedExecution(h, [{ change: 'up-f' }])
    await passedChange(h, executionId, 'up-f')
    pushCommit(matrix, 'master', 'other-f.txt', 'f\n')
    let merged = ''
    h.gh.update = branch => { merged = mergeBaseInto(branch); h.gh.checks.set(merged, failing()) }
    await h.tick()
    await h.tick()
    const carried = h.executions.rounds(executionId, 'up-f').at(-1)!
    expect(carried.carriedFrom).not.toBeNull()
    expect(carried.commitSha).toBe(merged)
    expect(carried.outcome).toBe('fail')
    expect(row(executionId, 'up-f').state).not.toBe('landing')
    expect(h.executions.slot(teamId())).toBeNull()
    const fixes = handoffs(executionId, 'up-f', 'fix')
    expect(fixes).toHaveLength(1)
    expect(bodyOf(fixes[0]!)).toContain(merged)
  })
})

describe('the pinned merge and the landing fact (14.3)', () => {
  test('a head moved before the merge is refused: nothing merged, the change stopped', async () => {
    const executionId = await startedExecution(h, [{ change: 'mg-a' }])
    await passedChange(h, executionId, 'mg-a')
    const baseBefore = originHead(matrix, 'master')
    h.gh.beforeMerge = () => { pushCommit(matrix, row(executionId, 'mg-a').branch!, 'late.txt', 'late\n'); h.gh.beforeMerge = null }
    await tickUntil(executionId, 'mg-a', state => state === 'stopped')
    expect(row(executionId, 'mg-a')).toMatchObject({ state: 'stopped', stopReason: 'effect-failed' })
    expect(row(executionId, 'mg-a').stopDetail?.message ?? '').toContain('Head branch was modified')
    expect(h.gh.merges).toHaveLength(0)
    expect(originHead(matrix, 'master')).toBe(baseBefore)
    expect(h.executions.landings(h.executions.execution(executionId)!.planId)).toEqual([])
  })

  for (const method of ['merge', 'squash', 'rebase'] as MergeMethod[]) {
    test(`${method}: the landing fact verifies the tree; the task is done and its result accepted by Kawai`, async () => {
      const change = `mg-${method}`
      const executionId = await startedExecution(h, [{ change }], { mergeMethod: method })
      await passedChange(h, executionId, change)
      await tickUntil(executionId, change, state => state === 'landed')
      expect(row(executionId, change).state).toBe('landed')
      expect(h.gh.merges.at(-1)!.method).toBe(method)
      const fact = h.executions.landings(h.executions.execution(executionId)!.planId)[0]!
      expect(fact).toMatchObject({ change, mergeSha: originHead(matrix, 'master'), treeVerified: true })
      const task = h.tasks.store.get(row(executionId, change).taskId!)!
      expect(task.status).toBe('done')
      const result = h.tasks.store.results.get(h.executions.rounds(executionId, change).at(-1)!.resultId)!
      expect(result.acceptedBy?.kind).toBe('system')
    })
  }

  test('a base commit landing during the merge leaves tree_verified false', async () => {
    const executionId = await startedExecution(h, [{ change: 'mg-b' }])
    await passedChange(h, executionId, 'mg-b')
    h.gh.beforeMerge = () => { pushCommit(matrix, 'master', 'race.txt', 'race\n'); h.gh.beforeMerge = null }
    await tickUntil(executionId, 'mg-b', state => state === 'landed')
    const fact = h.executions.landings(h.executions.execution(executionId)!.planId)[0]!
    expect(fact.treeVerified).toBe(false)
    expect(row(executionId, 'mg-b').state).toBe('landed')
  })

  test('a live session keeps the worktree; an unoccupied clean one is removed', async () => {
    const executionId = await startedExecution(h, [{ change: 'mg-c' }, { change: 'mg-d' }])
    await passedChange(h, executionId, 'mg-c')
    const kept = row(executionId, 'mg-c').worktree!
    h.bench.records.set('sitter', { sessionId: 'sitter', groupId: 'middle-devs', projectPath: kept, name: 'sitter', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '' })
    await tickUntil(executionId, 'mg-c', state => state === 'landed')
    await passedChange(h, executionId, 'mg-d')
    const removed = row(executionId, 'mg-d').worktree!
    await tickUntil(executionId, 'mg-d', state => state === 'landed')
    await h.tick()
    const removals = h.executions.effectsOf(executionId).filter(effect => effect.kind === 'remove-worktree')
    expect(removals.map(effect => effect.command.path)).toEqual([removed])
    expect(fs.existsSync(kept)).toBe(true)
    expect(fs.existsSync(removed)).toBe(false)
    h.bench.records.delete('sitter')
   }, 30_000)

  test('failing base-branch CI after landing is evidence only: the change stays landed', async () => {
    const executionId = await startedExecution(h, [{ change: 'mg-e' }, { change: 'mg-f' }])
    await passedChange(h, executionId, 'mg-e')
    // The branch's CI passed; every commit read from here on — the merge
    // commit on the base included — fails.
    h.gh.defaultChecks = failing()
    await tickUntil(executionId, 'mg-e', state => state === 'landed')
    await h.tick()
    const planId = h.executions.execution(executionId)!.planId
    expect(row(executionId, 'mg-e').state).toBe('landed')
    const fact = h.executions.landings(planId).find(entry => entry.change === 'mg-e')!
    expect(fact.postCi?.some(check => check.conclusion === 'failure')).toBe(true)
    expect(h.executions.execution(executionId)!.state).toBe('running')
   }, 30_000)
})

describe('Stop while a merge runs (13.4)', () => {
  test('a merge that completes is recorded: landing fact, accepted task, execution stopped', async () => {
    const executionId = await startedExecution(h, [{ change: 'st-a' }])
    await passedChange(h, executionId, 'st-a')
    h.gh.beforeMerge = async () => {
      h.gh.beforeMerge = null
      const stopped = await h.service.stop(h.bench.human, { executionId, reason: 'enough', commandId: 'stop-st-a' })
      expect(stopped.ok).toBe(true)
    }
    await tickUntil(executionId, 'st-a', state => state === 'landed')
    await h.tick()
    expect(row(executionId, 'st-a').state).toBe('landed')
    expect(h.executions.landings(h.executions.execution(executionId)!.planId)).toHaveLength(1)
    expect(h.tasks.store.get(row(executionId, 'st-a').taskId!)!.status).toBe('done')
    expect(h.executions.execution(executionId)).toMatchObject({ state: 'finished', outcome: 'stopped' })
    // No later effect starts.
    expect(h.executions.effectsOf(executionId).filter(effect => effect.state === 'pending')).toEqual([])
  })

  test('a merge GitHub refuses is settled as cancelled with its task', async () => {
    const executionId = await startedExecution(h, [{ change: 'st-b' }])
    await passedChange(h, executionId, 'st-b')
    h.gh.beforeMerge = async () => {
      h.gh.beforeMerge = null
      const stopped = await h.service.stop(h.bench.human, { executionId, reason: 'enough', commandId: 'stop-st-b' })
      expect(stopped.ok).toBe(true)
      pushCommit(matrix, row(executionId, 'st-b').branch!, 'late.txt', 'late\n')
    }
    await tickUntil(executionId, 'st-b', state => state === 'cancelled')
    await h.tick()
    expect(row(executionId, 'st-b').state).toBe('cancelled')
    expect(h.gh.merges).toHaveLength(0)
    expect(h.executions.landings(h.executions.execution(executionId)!.planId)).toEqual([])
    expect(h.tasks.store.get(row(executionId, 'st-b').taskId!)!.status).toBe('cancelled')
    expect(h.executions.execution(executionId)).toMatchObject({ state: 'finished', outcome: 'stopped' })
  })
})

describe('a human close while a merge runs (13.4b)', () => {
  /** The human closes the change's task from inside the merge call (accept, or cancel). */
  function closeDuringMerge(executionId: string, change: string, close: 'accept' | 'cancel', after?: () => void): void {
    h.gh.beforeMerge = async () => {
      h.gh.beforeMerge = null
      const taskId = row(executionId, change).taskId!
      if (close === 'accept') await h.results.accept(h.bench.human, taskId, h.executions.rounds(executionId, change).at(-1)!.resultId)
      else await h.tasks.setStatus(h.bench.human, taskId, 'cancelled')
      after?.()
    }
  }

  test('(i) accept while the merge completes: one landing fact, landed, only the human acceptance', async () => {
    const executionId = await startedExecution(h, [{ change: 'hc-a' }])
    await passedChange(h, executionId, 'hc-a')
    closeDuringMerge(executionId, 'hc-a', 'accept')
    await tickUntil(executionId, 'hc-a', state => state === 'landed' || state === 'stopped')
    await h.tick()
    expect(row(executionId, 'hc-a').state).toBe('landed')
    expect(h.executions.landings(h.executions.execution(executionId)!.planId)).toHaveLength(1)
    const taskId = row(executionId, 'hc-a').taskId!
    expect(h.tasks.store.get(taskId)!.status).toBe('done')
    const accepted = h.tasks.store.results.listByTask(taskId).filter(result => result.acceptedBy !== null)
    expect(accepted.map(result => result.acceptedBy?.kind)).toEqual(['human'])
    expect(h.tasks.store.journal(taskId).filter(entry => entry.author.kind === 'system' && /accept/i.test(entry.text))).toEqual([])
    expect(h.executions.effectsOf(executionId).filter(effect => effect.kind === 'merge')).toHaveLength(1)
  })

  test('(ii) cancel while the merge completes: one landing fact, landed, the task stays cancelled', async () => {
    const executionId = await startedExecution(h, [{ change: 'hc-b' }])
    await passedChange(h, executionId, 'hc-b')
    closeDuringMerge(executionId, 'hc-b', 'cancel')
    await tickUntil(executionId, 'hc-b', state => state === 'landed' || state === 'stopped')
    await h.tick()
    expect(row(executionId, 'hc-b').state).toBe('landed')
    expect(h.executions.landings(h.executions.execution(executionId)!.planId)).toHaveLength(1)
    const taskId = row(executionId, 'hc-b').taskId!
    expect(h.tasks.store.get(taskId)!.status).toBe('cancelled')
    expect(h.tasks.store.results.listByTask(taskId).filter(result => result.acceptedBy !== null)).toEqual([])
  })

  test('(iii) accept while the merge fails: stopped as task-closed, nothing merged, no later effect', async () => {
    const executionId = await startedExecution(h, [{ change: 'hc-c' }])
    await passedChange(h, executionId, 'hc-c')
    const baseBefore = originHead(matrix, 'master')
    closeDuringMerge(executionId, 'hc-c', 'accept', () => pushCommit(matrix, row(executionId, 'hc-c').branch!, 'late.txt', 'late\n'))
    await tickUntil(executionId, 'hc-c', state => state === 'stopped')
    const effects = h.executions.effectsOf(executionId).length
    await h.tick()
    expect(row(executionId, 'hc-c')).toMatchObject({ state: 'stopped', stopReason: 'task-closed' })
    expect(h.gh.merges).toHaveLength(0)
    expect(originHead(matrix, 'master')).toBe(baseBefore)
    expect(h.executions.landings(h.executions.execution(executionId)!.planId)).toEqual([])
    expect(h.executions.effectsOf(executionId)).toHaveLength(effects)
    expect(h.tasks.store.get(row(executionId, 'hc-c').taskId!)!.status).toBe('done')
  })

  test('(iv) cancel while the branch update runs: the update settles and is recorded, no merge effect, stopped as task-closed', async () => {
    const executionId = await startedExecution(h, [{ change: 'hc-d' }])
    await passedChange(h, executionId, 'hc-d')
    pushCommit(matrix, 'master', 'other-hc-d.txt', 'd\n')
    const baseBefore = originHead(matrix, 'master')
    h.gh.update = async branch => {
      h.gh.update = null
      await h.tasks.setStatus(h.bench.human, row(executionId, 'hc-d').taskId!, 'cancelled')
      mergeBaseInto(branch)
    }
    await tickUntil(executionId, 'hc-d', state => state === 'stopped' || state === 'landed', 6)
    await h.tick()
    expect(row(executionId, 'hc-d')).toMatchObject({ state: 'stopped', stopReason: 'task-closed' })
    const effects = h.executions.effectsOf(executionId)
    expect(effects.filter(effect => effect.kind === 'update-branch').map(effect => effect.state)).toEqual(['done'])
    // The update's outcome was applied: the review carried onto the updated head.
    const rounds = h.executions.rounds(executionId, 'hc-d')
    expect(rounds.at(-1)!.carriedFrom).toBe(rounds[0]!.id)
    expect(effects.filter(effect => effect.kind === 'merge')).toEqual([])
    expect(h.gh.merges).toHaveLength(0)
    expect(originHead(matrix, 'master')).toBe(baseBefore)
    expect(h.executions.landings(h.executions.execution(executionId)!.planId)).toEqual([])
    expect(h.tasks.store.get(row(executionId, 'hc-d').taskId!)!.status).toBe('cancelled')
  })
})

describe('a new task revision around the landing (12.1)', () => {
  const republish = (executionId: string, change: string) =>
    h.tasks.amend(h.bench.human, row(executionId, change).taskId!, { direction: 'Do it differently now', rationale: 'scope changed' })

  test('published while holding the slot for carried-round CI: the change leaves the slot for one fix attempt', async () => {
    const executionId = await startedExecution(h, [{ change: 'rv-a' }])
    await passedChange(h, executionId, 'rv-a')
    pushCommit(matrix, 'master', 'other-rv-a.txt', 'a\n')
    h.gh.update = branch => { h.gh.checks.set(mergeBaseInto(branch), pending()); h.gh.update = null }
    await h.tick()
    await h.tick()
    expect(row(executionId, 'rv-a').state).toBe('landing')
    expect(h.executions.slot(teamId())).not.toBeNull()
    await republish(executionId, 'rv-a')
    await h.tick()
    expect(row(executionId, 'rv-a').state).toBe('implementing')
    expect(h.executions.slot(teamId())).toBeNull()
    const fixes = handoffs(executionId, 'rv-a', 'fix')
    expect(fixes).toHaveLength(1)
    expect(bodyOf(fixes[0]!)).toContain('revision 2')
    expect(h.executions.rounds(executionId, 'rv-a').at(-1)!.outcome).toBe('superseded')
  })

  test('published during an update that conflicts: one fix attempt naming the revision, base head, and files; no update attempt', async () => {
    const executionId = await startedExecution(h, [{ change: 'rv-b' }])
    await h.tick()
    await submitWork(h, executionId, 'rv-b', 'seed.txt', 'branch side rv-b\n')
    await h.tick()
    await review(h, executionId, 'rv-b', 'pass')
    pushCommit(matrix, 'master', 'other-rv-b.txt', 'b\n')
    let base = ''
    h.gh.update = async () => {
      h.gh.update = null
      // GitHub's update races a conflicting base commit; the human republishes meanwhile.
      base = pushCommit(matrix, 'master', 'seed.txt', 'base side rv-b\n')
      await republish(executionId, 'rv-b')
      return 'conflict' as const
    }
    await h.tick()
    await h.tick()
    await h.tick()
    expect(row(executionId, 'rv-b').state).toBe('implementing')
    expect(h.executions.slot(teamId())).toBeNull()
    const fixes = handoffs(executionId, 'rv-b', 'fix')
    expect(fixes).toHaveLength(1)
    const body = bodyOf(fixes[0]!)
    expect(body).toContain('revision 2')
    expect(body).toContain(base)
    expect(body).toContain('seed.txt')
    expect(body).not.toContain('Bring the branch up to date with the base branch.')
  })

  test('published during an update that merges clean: the fix attempt continues from the updated head', async () => {
    const executionId = await startedExecution(h, [{ change: 'rv-c' }])
    await passedChange(h, executionId, 'rv-c')
    pushCommit(matrix, 'master', 'other-rv-c.txt', 'c\n')
    let updated = ''
    h.gh.update = async branch => {
      h.gh.update = null
      updated = mergeBaseInto(branch)
      await republish(executionId, 'rv-c')
    }
    await h.tick()
    await h.tick()
    await h.tick()
    expect(row(executionId, 'rv-c').state).toBe('implementing')
    const fixes = handoffs(executionId, 'rv-c', 'fix')
    expect(fixes).toHaveLength(1)
    expect(bodyOf(fixes[0]!)).toContain(updated)
    expect(bodyOf(fixes[0]!)).toContain('revision 2')
  })

  test('the superseded review instruction never stops the change as instruction-failed', async () => {
    const executionId = await startedExecution(h, [{ change: 'rv-d' }])
    await h.tick()
    await submitWork(h, executionId, 'rv-d', 'src/rv-d.ts', '1\n')
    await h.tick()
    const reviewAssignment = handoffs(executionId, 'rv-d', 'review')[0]!
    expect(h.mail.get(reviewAssignment.messageId!)!.state).toBe('queued')
    await republish(executionId, 'rv-d')
    await h.tick()
    await h.tick()
    expect(row(executionId, 'rv-d')).toMatchObject({ state: 'implementing', stopReason: null })
    expect(h.mail.get(reviewAssignment.messageId!)!.state).toBe('cancelled')
    expect(handoffs(executionId, 'rv-d', 'fix')).toHaveLength(1)
  })
})
