// The resolve command's R-rows (revision-control 4.4-4.5, rev4 §10 step 5):
// every row of design.md "Acceptance oracles (4.4-4.5)"'s decision table with
// resolution `restart`, verbatim as one test.each row — R1-R21r plus the L4
// twins R22r/R23r (the update-target-answered cell, from R21r + the ROUND
// RULE). The dispatch arms, the release bookkeeping, K7, and the review
// shapes with their deep assertions live in pauseResolveRestart.test.ts; the
// completeness grid joins in the next commit, derived from the shared
// pauseCells table; the bench wiring and the paused-target worlds live in
// pauseResolveBench.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { AttemptManifest } from '../../shared/planExecution'
import { pauseResolveBench, targetOf, type PauseResolveBench } from './pauseResolveBench'
import { PAUSE_U_CLAIMS, pauseCells, type PauseCell } from './pauseCells'

let wired: PauseResolveBench
let sequence = 0

beforeAll(async () => {
  wired = await pauseResolveBench('pause-resolve-restart-rows')
})

afterAll(() => {
  wired.close()
})

function ok<T>(outcome: { ok: boolean; result?: T; message?: string }): T {
  if (!outcome.ok || outcome.result === undefined) throw new Error(outcome.ok ? 'the command wrote nothing' : (outcome.message ?? 'refused'))
  return outcome.result
}

function refusal(outcome: { ok: boolean; reason?: string; message?: string }): { reason: string; message: string } {
  if (outcome.ok) throw new Error('expected a refusal')
  return { reason: outcome.reason ?? '', message: outcome.message ?? '' }
}

/** The inline-dispatch precondition the bench's fixtures skip: a baseline commit, then the hold released so the gate reads open. */
function openGate(planId: string, executionId: string): void {
  const row = wired.executions.change(executionId, 'api')!
  expect(wired.executions.transition(executionId, 'api', row, { baselineCommit: 'base' })).not.toBeNull()
  const released = wired.holds.release({ teamId: wired.teamId, holdId: wired.holds.forPlan(wired.teamId, planId)[0].id, changes: ['api'], reason: 'the dispatch may go', commandId: `release-${++sequence}` })
  expect(released.written).toBe(true)
}

/** A dispatch key on the change's newest attempt row. */
function attemptKey(executionId: string, change: string): string {
  const generation = wired.executions.change(executionId, change)!.generation
  const number = wired.executions.attempts(executionId, change).at(-1)!.number
  return `exec:${executionId}:${change}:attempt:${number}:${generation}`
}

const updateManifest = (): AttemptManifest => ({ ...wired.manifest(), update: { base: 'prev-base', files: ['a.ts'] } })

// The decision table's `restart` rows, verbatim from D9 (design.md) — R1-R21r
// plus the L4 twins R22r/R23r.
const R_ROWS = [
  ['R1', 'decided', 'restart', '*', '*', 'refused, naming the standing decision (I1)'],
  ['R2', 'paused (attempt stage)', 'restart', '*', '—', 'accepted'],
  ['R3', 'paused (attempt stage)', 'restart', '*', 'implement owed', 'accepted; the older owed row never dispatches (H6) (G4\'s caveat as C3\'s)'],
  ['R4', 'paused (attempt stage)', 'restart', '*', 'implement out', 'accepted'],
  ['R5', 'paused (attempt stage)', 'restart', '*', 'implement answered (plain)', 'accepted; no drop (the round pins the task\'s newest revision, so the ROUND RULE\'s condition fails)'],
  ['R6', 'paused (attempt stage)', 'restart', '*', 'fix owed', 'accepted; the older owed row never dispatches (H6) (G4\'s caveat as C3\'s)'],
  ['R7', 'paused (attempt stage)', 'restart', '*', 'fix out', 'accepted'],
  ['R8', 'paused (attempt stage)', 'restart', '*', 'fix answered (plain)', 'accepted; no drop (the round pins the task\'s newest revision, so the ROUND RULE\'s condition fails)'],
  ['R9', 'paused·withdrawn', 'restart', '*', '*', 'accepted'],
  ['R10', 'pausing·no-checkpoint', 'restart', '*', '*', 'accepted; nothing on origin - the may-predates note in dialog and instruction'],
  ['R11', 'pausing·checkpoint-pushing', 'restart', '*', '*', 'accepted; the containment read decides checkpoint vs may-predates'],
  ['R12', 'pausing·checkpoint-push-failed', 'restart', '*', '*', 'accepted; a failed/unknown push is not on origin - may-predates'],
  ['R13', 'pausing·holder-killed', 'restart', '*', '*', 'accepted; the start point is always origin\'s branch head + the may-predates note - a holder-killed cause never left a checkpoint on origin (D8:297-298), so the containment read\'s checkpoint branch is unreachable here (U8)'],
  ['R14', 'pausing·other', 'restart', '*', '*', 'accepted; a busy spawned holder is marked pending release'],
  ['R15', 'pausing·withdrawn', 'restart', '*', '*', 'accepted (rev4 extends D9\'s allowed-from)'],
  ['R16', 'paused·gone', 'restart', '*', '*', 'accepted'],
  ['R17', 'review target, `answered·rev↗` (H5 exception)', 'restart', '*', 'answered·rev↗', 'accepted; H5 exception - steps 1-4 only'],
  ['R18r', 'review target', 'restart', '*', 'answered(*)', 'accepted; steps 1-4 as R2 (the handoff-standing condition does not restrict it, Q-A2); D9\'s steps 6-7 (start point, manifest) apply to attempts only, so no attempt row and no new manifest (D4, H3\'s scope)'],
  ['R19r', 'paused (attempt stage)', 'restart', '*', 'implement answered·rev↗', 'accepted; the passable round superseded (the ROUND RULE)'],
  ['R20r', 'paused (attempt stage)', 'restart', '*', 'fix answered·rev↗', 'accepted; the passable round superseded (the ROUND RULE)'],
  ['R21r', 'paused (update target: gating, update row out)', 'restart', '*', 'update out', 'accepted (G1, per O4)'],
  ['R22r', 'paused (update target, answered after the pause — L4)', 'restart', '*', 'update answered (plain)', 'accepted; no drop (the round pins the task\'s newest revision, so the ROUND RULE\'s condition fails - as C18)'],
  ['R23r', 'paused (update target, answered after the pause — L4)', 'restart', '*', 'update answered·rev↗', 'accepted; the passable round superseded (the ROUND RULE - as C19)'],
] as const

describe('the R-rows (D9, verbatim)', () => {
  test.each(R_ROWS)('%s: %s · %s · hold %s · row %s → %s', async (id: string) => {
    if (id === 'R1') {
      const world = await wired.pausedAttempt()
      ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
      const again = refusal(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
      expect(again.reason).toBe('state')
      expect(again.message).toContain('already decided (continue)')
      expect(wired.resolvedEvents(world.planId)).toHaveLength(1)
    } else if (id === 'R2') {
      const world = await wired.pausedAttempt({ mintAttempt: false })
      ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
      const target = targetOf(wired, world.pauseId, 'api')
      expect(target.decision).toBe('restart')
      expect(target.decisionDetail).toMatchObject({ holder: 'dev', release: 'never', assignmentId: world.assignmentId })
      // ONE new attempt row, kind implement (the stage's kind), at the task's
      // newest revision, owed (the hold still covers the change).
      const attempts = wired.executions.attempts(world.executionId, 'api')
      expect(attempts).toHaveLength(1)
      expect(attempts[0].kind).toBe('implement')
      expect(attempts[0].assignmentId).toBeNull()
      expect(attempts[0].manifest.task).toMatchObject({ id: world.taskId, revision: 1 })
      expect(wired.resumeMails(world.taskId)).toHaveLength(0)
    } else if (id === 'R3' || id === 'R6') {
      const kind = id === 'R3' ? 'implement' : 'fix'
      const world = await wired.pausedAttempt()
      wired.mintOwed(world.executionId, 'api', kind)
      openGate(world.planId, world.executionId)
      ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
      const attempts = wired.executions.attempts(world.executionId, 'api')
      expect(attempts).toHaveLength(3)
      expect(attempts[1].kind).toBe(kind)
      // H6: the older owed row never dispatches — only the new row does.
      expect(attempts[1].assignmentId).toBeNull()
      expect(attempts[2].kind).toBe(kind)
      expect(attempts[2].assignmentId).not.toBeNull()
      expect(wired.bench.assignmentStore.byId(attempts[2].assignmentId!)?.requestKey).toBe(attemptKey(world.executionId, 'api'))
    } else if (id === 'R4' || id === 'R7') {
      const kind = id === 'R4' ? 'implement' : 'fix'
      const world = await wired.pausedAttempt()
      if (kind === 'fix') wired.mintAttempt(world.executionId, 'api', 'fix', 'dev2')
      ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
      const attempts = wired.executions.attempts(world.executionId, 'api')
      expect(attempts.at(-1)!.kind).toBe(kind)
      expect(attempts.at(-1)!.assignmentId).toBeNull()
    } else if (id === 'R5' || id === 'R8') {
      const world = await wired.pausedAttempt()
      if (id === 'R8') wired.mintAttempt(world.executionId, 'api', 'fix', 'dev2')
      wired.answerNewestRow(world.executionId, 'api', 1)
      ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
      // No drop: the round pins the newest revision, so the ROUND RULE's
      // condition fails.
      expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBeNull()
    } else if (id === 'R9') {
      const world = await wired.pausing({ queued: true, withdrawn: true })
      ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
      expect(targetOf(wired, world.pauseId, 'api').decision).toBe('restart')
      expect(wired.executions.attempts(world.executionId, 'api').at(-1)!.assignmentId).toBeNull()
    } else if (id === 'R10' || id === 'R11' || id === 'R12' || id === 'R13') {
      const checkpoint = id === 'R10' ? undefined
        : id === 'R11' ? { kind: 'commit' as const, effectState: 'running' as const }
        : id === 'R12' ? { kind: 'commit' as const, effectState: 'failed' as const }
        : undefined
      const world = await wired.pausing({ ...(id === 'R13' ? { holder: 'ghost' } : {}), ...(checkpoint !== undefined ? { checkpoint } : {}) })
      openGate(world.planId, world.executionId)
      ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
      // A running or failed push is not on origin (R11/R12), and a killed
      // holder never left one (R13): the start point is origin's branch head
      // with the may-predates note.
      const newest = wired.executions.attempts(world.executionId, 'api').at(-1)!
      expect(newest.manifest.startCommit).toBe('adapt-head-sha')
      expect(newest.manifest.checkpoint).toBeUndefined()
      const assignment = wired.bench.assignmentStore.byId(newest.assignmentId!)
      expect(wired.bench.mail.get(assignment?.messageId ?? '')?.body).toContain('may predate')
    } else if (id === 'R14') {
      const world = await wired.pausing({})
      wired.spawnRecord('dev', world.taskId)
      wired.useReleaseSeams({ spawned: true, archived: false, ready: false, reason: 'mid-turn' })
      try {
        ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
        expect(targetOf(wired, world.pauseId, 'api').decisionDetail).toMatchObject({ release: 'pending' })
      } finally {
        wired.useReleaseSeams(null)
      }
    } else if (id === 'R15') {
      const world = await wired.pausing({ withdrawn: true })
      ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
      expect(targetOf(wired, world.pauseId, 'api').decision).toBe('restart')
    } else if (id === 'R16') {
      const world = await wired.pausedAttempt({ holder: 'ghost', mintAttempt: false })
      ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
      expect(targetOf(wired, world.pauseId, 'api').decision).toBe('restart')
    } else if (id === 'R17') {
      const world = await wired.pausedReview({ pending: true })
      ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
      expect(targetOf(wired, world.pauseId, 'api').decisionDetail).toMatchObject({ revisionPending: 2 })
      // NO new attempt row; the round stands for H2's fix flow.
      expect(wired.executions.attempts(world.executionId, 'api')).toHaveLength(1)
      expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBeNull()
    } else if (id === 'R18r') {
      const world = await wired.pausedReview({ notes: true })
      openGate(world.planId, world.executionId)
      ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
      // No attempt row; ONE new review handoff of the same round, its own
      // fresh request key, the round pointing at it.
      expect(wired.executions.attempts(world.executionId, 'api')).toHaveLength(1)
      const round = wired.executions.rounds(world.executionId, 'api')[0]
      expect(round.reviewAssignmentId).not.toBeNull()
      const handoff = wired.bench.assignmentStore.byId(round.reviewAssignmentId!)
      expect(handoff?.requestKey).toBe(`exec:${world.executionId}:api:round:1:review:${wired.executions.change(world.executionId, 'api')!.generation}:restart`)
      expect(wired.bench.mail.get(handoff?.messageId ?? '')?.body).toContain('restarted by the owner')
    } else if (id === 'R19r' || id === 'R20r') {
      const world = await wired.pausedAttempt()
      if (id === 'R20r') wired.mintAttempt(world.executionId, 'api', 'fix', 'dev2')
      // answered·rev↗: the round pins the revision in force at the answer;
      // the publication comes after, so the ROUND RULE's condition holds.
      wired.answerNewestRow(world.executionId, 'api', 1)
      wired.republish(world.taskId)
      ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
      expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBe('superseded')
      expect(wired.executions.attempts(world.executionId, 'api').at(-1)!.kind).toBe(id === 'R19r' ? 'implement' : 'fix')
    } else if (id === 'R21r') {
      const world = await wired.pausedUpdate({ manifest: updateManifest() })
      ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
      // The new row is kind update (re-minted, so the update re-runs),
      // copying the update row's `update`; the change stays `gating` with
      // step null and passedAt null; the round is not superseded (its pins
      // equal the newest revision — the ROUND RULE's condition fails).
      const attempts = wired.executions.attempts(world.executionId, 'api')
      expect(attempts).toHaveLength(3)
      expect(attempts[2].kind).toBe('update')
      expect(attempts[2].manifest.update).toEqual({ base: 'prev-base', files: ['a.ts'] })
      expect(attempts[2].assignmentId).toBeNull()
      const row = wired.executions.change(world.executionId, 'api')!
      expect(row.state).toBe('gating')
      expect(row.step).toBeNull()
      expect(row.passedAt).toBeNull()
      expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBeNull()
    } else if (id === 'R22r' || id === 'R23r') {
      // L4's answered-after-pause route: the update target paused with its
      // row out, then the holder's result recorded through the production
      // round stage while the hold is still active.
      const world = await wired.pausedUpdate({ manifest: updateManifest() })
      await wired.answerNewestRowViaStage(world.executionId, 'api', 1)
      if (id === 'R23r') wired.republish(world.taskId)
      ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
      expect(wired.executions.rounds(world.executionId, 'api').at(-1)!.outcome).toBe(id === 'R23r' ? 'superseded' : null)
      const attempts = wired.executions.attempts(world.executionId, 'api')
      expect(attempts).toHaveLength(3)
      expect(attempts[2].kind).toBe('update')
      expect(attempts[2].manifest.update).toEqual({ base: 'prev-base', files: ['a.ts'] })
      expect(attempts[2].manifest.task.revision).toBe(id === 'R23r' ? 2 : 1)
      expect(attempts[2].assignmentId).toBeNull()
    }
  })
})

// The completeness grid (restart, lead ruling L5): the cells and their
// reachability come from the shared pauseCells table — one reading for every
// resolution — and this mapping sends each reachable cell to its R-row.
// Restart's state rows fan out where the design table does: the shared
// `pausing` cell rows as R10-R14 by its cause, and the shared `withdrawn`
// cell rows as R9 (paused) and R15 (pausing) — the two presentations the
// withdrawn stamp composes with. The unreachable cells carry their U-claims
// from PAUSE_U_CLAIMS.
describe('the restart grid (completeness, derived from the shared cell table)', () => {
  function restartRowFor(cell: PauseCell): string[] {
    if (cell.state === 'decided') return ['R1']
    if (cell.state === 'withdrawn') return ['R9', 'R15']
    if (cell.state === 'pausing') return ['R10', 'R11', 'R12', 'R13', 'R14']
    if (cell.state === 'paused·gone') return ['R16']
    if (cell.state === 'paused (review target)' || cell.state === 'paused (review target, handoff superseded)') {
      // The kind axis collapses to answered(*): plain rows as R18r, and the
      // rev↗ cell takes the H5 exception (R17).
      return cell.status === 'answered·rev↗' ? ['R17'] : ['R18r']
    }
    if (cell.state === 'paused (attempt stage)') {
      if (cell.status === '—') return ['R2']
      if (cell.kind === 'implement') {
        if (cell.status === 'owed') return ['R3']
        if (cell.status === 'out') return ['R4']
        if (cell.status === 'answered (plain)') return ['R5']
        return ['R19r']
      }
      if (cell.status === 'owed') return ['R6']
      if (cell.status === 'out') return ['R7']
      if (cell.status === 'answered (plain)') return ['R8']
      return ['R20r']
    }
    // The update-target states: out at placement (R21r), answered after the
    // pause (R22r/R23r — L4's route, forced through the production round
    // stage).
    if (cell.status === 'out') return ['R21r']
    return cell.status === 'answered·rev↗' ? ['R23r'] : ['R22r']
  }

  test('every shared cell maps to R-rows or U-claims, and every R-row is used', () => {
    const hit: Record<string, number> = {}
    for (const cell of pauseCells()) {
      const verdict = cell.verdict
      let mapped: string[]
      if (!verdict.unreachable) {
        mapped = restartRowFor(cell)
        for (const row of mapped) expect(row).toMatch(/^R\d+r?$/)
      } else {
        expect(PAUSE_U_CLAIMS[verdict.uId]).toBeDefined()
        mapped = [verdict.uId]
      }
      for (const row of mapped) hit[row] = (hit[row] ?? 0) + 1
    }
    // Every R-row of the table is reached by at least one cell (no gap).
    for (const candidate of R_ROWS) expect(hit[candidate[0]]).toBeGreaterThan(0)
    // The unreachable cells are exactly the U-claim cells.
    expect(hit['U1']).toBe(4) // attempt-stage update owed + out; both update-target states' owed
    expect(hit['U2']).toBe(6) // both review states' absent, owed, and out
    expect(hit['U7']).toBe(4) // attempt-stage update answered plain + rev↗; the update-out target's answered at placement
    expect(hit['U3']).toBe(1) // the answered-after state's out cross
  })
})
