// The resolve command's C-rows (revision-control 4.4, A3): every row of
// design.md "Acceptance oracles (4.4-4.5)"'s decision table with resolution
// `continue`, verbatim as one test.each row, plus the completeness test over
// the axes. The bench wiring and the row builders live in pauseResolveBench;
// the model-based P-I1 runs in pauseResolveModel.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { pauseResolveBench, targetOf, type PauseResolveBench } from './pauseResolveBench'

let wired: PauseResolveBench
let sequence = 0

beforeAll(async () => {
  wired = await pauseResolveBench('pause-resolve')
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

/** The decision table's `continue` rows, verbatim from A3 (design.md, note-cb984944). */
const C_ROWS = [
  ['C1', 'decided', 'continue', '*', '*', 'refused, naming the standing decision (I1)'],
  ['C2', 'paused', 'continue', '*', '—', 'accepted'],
  ['C3', 'paused', 'continue', '*', 'implement owed', 'accepted; the owed row is untouched (Q-A3, with G4\'s caveat: reachable only through a row minted owed after the pause\'s creation — H7 reads an owed newest row noActiveWork, so the pause never names one; e.g. a round failing CI under the gate mints applyFix\'s row owed)'],
  ['C4', 'paused', 'continue', '*', 'implement out', 'accepted'],
  ['C5', 'paused', 'continue', '*', 'implement answered (plain)', 'accepted; no drop (the round pins the task\'s newest revision, so the ROUND RULE\'s condition fails)'],
  ['C6', 'paused', 'continue', '*', 'fix owed', 'accepted; the owed row is untouched (Q-A3, with G4\'s caveat as C3\'s)'],
  ['C7', 'paused', 'continue', '*', 'fix out', 'accepted'],
  ['C8', 'paused', 'continue', '*', 'fix answered (plain)', 'accepted; no drop (the round pins the task\'s newest revision, so the ROUND RULE\'s condition fails)'],
  ['C9', 'withdrawn (paused·withdrawn or pausing·withdrawn — withdrawn is checked before the state, so the answer stays the same across the tick)', 'continue', '*', '*', 'refused `target-withdrawn`'],
  ['C10', 'pausing·* (every pausing sub-state), not withdrawn', 'continue', '*', '*', 'refused `not-paused`'],
  ['C11', 'paused·gone', 'continue', '*', '*', 'refused `holder-gone`'],
  ['C12', 'review target (gating, reviewing), handoff stands', 'continue', '*', 'answered (plain)', 'accepted'],
  ['C13', 'review target, handoff superseded', 'continue', '*', 'answered(*)', 'refused `review-superseded` (a gone holder reads `holder-gone` first, C11)'],
  ['C14', 'review target, handoff stands, passable round `answered·rev↗` (H5)', 'continue', '*', 'answered·rev↗', 'accepted (H5)'],
  ['C15', 'paused (attempt stage)', 'continue', '*', 'implement answered·rev↗', 'accepted; the passable round superseded (the ROUND RULE)'],
  ['C16', 'paused (attempt stage)', 'continue', '*', 'fix answered·rev↗', 'accepted; the passable round superseded (the ROUND RULE)'],
  ['C17', 'paused (update target: gating, update row out)', 'continue', '*', 'update out', 'accepted (G1: as C2)'],
] as const

describe('the C-rows (A3, verbatim)', () => {
  test.each(C_ROWS)('%s: %s · %s · hold %s · row %s → %s', async (id: string) => {
    if (id === 'C1') {
      const world = await wired.pausedAttempt()
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
      const again = refusal(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
      expect(again.reason).toBe('state')
      expect(again.message).toContain('already decided (continue)')
      expect(wired.resolvedEvents(world.planId)).toHaveLength(1)
    } else if (id === 'C2') {
      const world = await wired.pausedAttempt({ mintAttempt: false })
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
      const target = targetOf(wired, world.pauseId, 'api')
      expect(target.decision).toBe('continue')
      expect(target.decisionDetail).toMatchObject({ holder: 'dev', release: 'never', assignmentId: world.assignmentId })
      expect(wired.executions.attempts(world.executionId, 'api')).toHaveLength(0)
      const resumes = wired.resumeMails(world.taskId)
      expect(resumes).toHaveLength(1)
      expect(resumes[0]).toMatchObject({ toId: 'dev', priority: 'normal', tags: ['plan-resume'] })
      expect(resumes[0].body).toContain('revision 1')
      expect(resumes[0].body).not.toContain('Continue from checkpoint')
      expect(wired.pauses.get(wired.teamId, world.pauseId)!.closedAt).not.toBeNull()
    } else if (id === 'C3' || id === 'C6') {
      const kind = id === 'C3' ? 'implement' : 'fix'
      const world = await wired.pausedAttempt({ mintAttempt: false })
      wired.mintOwed(world.executionId, 'api', kind)
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
      const newest = wired.executions.attempts(world.executionId, 'api').at(-1)!
      expect(newest.kind).toBe(kind)
      expect(newest.assignmentId).toBeNull()
      expect(wired.executions.rounds(world.executionId, 'api')).toHaveLength(0)
      expect(wired.resumeMails(world.taskId)).toHaveLength(1)
    } else if (id === 'C4') {
      const world = await wired.pausedAttempt()
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
      const standing = wired.bench.assignmentStore.listByTask(world.taskId).find(row => row.id === world.assignmentId)!
      expect(standing.supersededBy).toBeNull()
      expect(wired.bench.mail.get(standing.messageId!)!.state).toBe('claimed')
      expect(wired.resumeMails(world.taskId)).toHaveLength(1)
    } else if (id === 'C5' || id === 'C8') {
      const world = await wired.pausedAttempt()
      if (id === 'C8') await wired.mintAttempt(world.executionId, 'api', 'fix')
      // Answered after the pause (the row-answered worlds are unreachable at
      // pause placement — the round insert moves the change to `gating`).
      wired.answerNewestRow(world.executionId, 'api', 1)
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
      const round = wired.executions.rounds(world.executionId, 'api').at(-1)!
      expect(round.outcome).toBeNull()
      expect(wired.resumeMails(world.taskId)).toHaveLength(1)
    } else if (id === 'C7') {
      const { planId, executionId } = await wired.executionWith(['api'])
      const flight = await wired.inFlight(executionId, 'api')
      // The fix row goes out before the pause, while the change still reads
      // `implementing` — the newest row's cell is `fix out`.
      const fix = await wired.mintAttempt(executionId, 'api', 'fix')
      const hold = wired.placeHold(planId, ['api'], `hold-${++sequence}`)
      const pause = ok(wired.pause({ planId, holdId: hold.id, commandId: `pause-${++sequence}` })).pause
      wired.toPaused(pause.id, 'api')
      ok(wired.resolve({ planId, pauseId: pause.id, change: 'api', choice: 'continue' }))
      const fixRow = wired.executions.attempts(executionId, 'api').at(-1)!
      expect(fixRow.kind).toBe('fix')
      expect(wired.bench.assignmentStore.listByTask(flight.taskId).find(row => row.id === fix.assignmentId)!.supersededBy).toBeNull()
      expect(wired.executions.rounds(executionId, 'api')).toHaveLength(0)
      expect(wired.resumeMails(flight.taskId)).toHaveLength(1)
    } else if (id === 'C9') {
      // The withdrawn target arises at pause placement: an unclaimed
      // instruction is cancelled and superseded in the pause command's own
      // transaction, and the withdraw path records Paused at once (D6) — so
      // `pausing·withdrawn` is transient, and both sub-states read the same
      // stored `withdrawn` flag this refusal answers.
      const { planId, executionId } = await wired.executionWith(['api'])
      await wired.inFlight(executionId, 'api', 'dev', 'queued')
      const hold = wired.placeHold(planId, ['api'], `hold-${++sequence}`)
      const pause = ok(wired.pause({ planId, holdId: hold.id, commandId: `pause-${++sequence}` })).pause
      expect(refusal(wired.resolve({ planId, pauseId: pause.id, change: 'api', choice: 'continue' })).reason).toBe('target-withdrawn')
      expect(wired.resolvedEvents(planId)).toHaveLength(0)
    } else if (id === 'C10') {
      const { planId, executionId } = await wired.executionWith(['api'])
      await wired.inFlight(executionId, 'api')
      const hold = wired.placeHold(planId, ['api'], `hold-${++sequence}`)
      const pause = ok(wired.pause({ planId, holdId: hold.id, commandId: `pause-${++sequence}` })).pause
      expect(refusal(wired.resolve({ planId, pauseId: pause.id, change: 'api', choice: 'continue' })).reason).toBe('not-paused')
      expect(wired.resolvedEvents(planId)).toHaveLength(0)
    } else if (id === 'C11') {
      const world = await wired.pausedAttempt({ holder: 'ghost' })
      expect(refusal(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' })).reason).toBe('holder-gone')
      expect(wired.resolvedEvents(world.planId)).toHaveLength(0)
    } else if (id === 'C12') {
      const world = await wired.pausedReview({ notes: true })
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
      const resumes = wired.resumeMails(world.taskId)
      expect(resumes).toHaveLength(1)
      expect(resumes[0].body).toContain('revision 1')
      expect(resumes[0].body).toMatch(/checkpoint-/)
      expect(resumes[0].body).not.toContain('Continue from checkpoint')
      expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBeNull()
    } else if (id === 'C13') {
      const world = await wired.pausedReview({ superseded: true })
      expect(refusal(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' })).reason).toBe('review-superseded')
      expect(wired.resolvedEvents(world.planId)).toHaveLength(0)
    } else if (id === 'C14') {
      const world = await wired.pausedReview({ pending: true })
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
      expect(targetOf(wired, world.pauseId, 'api').decisionDetail).toMatchObject({ revisionPending: 2 })
      expect(wired.resumeMails(world.taskId)).toHaveLength(0)
      expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBeNull()
    } else if (id === 'C15' || id === 'C16') {
      const world = await wired.pausedAttempt()
      if (id === 'C16') await wired.mintAttempt(world.executionId, 'api', 'fix')
      // The round is answered (plain) after the pause, then the task is
      // republished — the passable round now pins an older revision, so the
      // ROUND RULE supersedes it. The change row stays where the round put
      // it (the slot-releasing transition only fires from `landing`).
      wired.answerNewestRow(world.executionId, 'api', 1)
      wired.republish(world.taskId)
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
      expect(wired.executions.rounds(world.executionId, 'api').at(-1)!.outcome).toBe('superseded')
      // N4: the slot-releasing transition is unreachable for every Continue
      // cell — the change stays where insertRound left it; the supersede
      // alone is the drop.
      const row = wired.executions.change(world.executionId, 'api')!
      expect(row.state).toBe('gating')
      expect(row.step).toBeNull()
      expect(wired.resumeMails(world.taskId)).toHaveLength(1)
    } else if (id === 'C17') {
      const world = await wired.pausedUpdate()
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
      const row = wired.executions.change(world.executionId, 'api')!
      expect(row.state).toBe('gating')
      expect(row.step).toBeNull()
      expect(wired.bench.assignmentStore.listByTask(world.taskId).find(entry => entry.id === world.updateAssignmentId)!.supersededBy).toBeNull()
      expect(wired.resumeMails(world.taskId)).toHaveLength(1)
    } else {
      throw new Error(`no fixture for row ${id}`)
    }
  })
})

describe("C2's mail names the newest checkpoint's commit (B1)", () => {
  test('an attempt-stage checkpoint with a commitSha puts `Continue from checkpoint <sha>` in the resume (C2)', async () => {
    const world = await wired.pausedAttempt()
    const attempt = wired.executions.attempts(world.executionId, 'api').at(-1)!
    // The pause flow's own checkpoint row: kind `commit`, the pushed commit
    // in `commit_sha` (D7) — the newest() read the resume body names.
    wired.checkpoints.insert({
      executionId: world.executionId, change: 'api', pauseId: world.pauseId, attemptId: attempt.id, sessionId: 'dev',
      kind: 'commit', commitSha: 'ckptabc123', baselineCommit: null, manifestHash: 'mh', resultId: null,
      summary: 'paused here', unfinished: null, errorsTests: null, nextSteps: 'resume here', effectId: null,
    })
    ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
    const resumes = wired.resumeMails(world.taskId)
    expect(resumes).toHaveLength(1)
    expect(resumes[0].body).toContain('Continue from checkpoint ckptabc123')
  })
})

describe("O4's redispatch clear (B2)", () => {
  test('a paused attempt target with a pending `redispatch` step clears it; one resume goes out and nothing re-sends under :retry: (C2)', async () => {
    const world = await wired.pausedAttempt()
    // Retry under the hold left the redispatch step due (H′ A3's path): the
    // change row carries `step: 'redispatch'` at resolve time.
    const row = wired.executions.change(world.executionId, 'api')!
    expect(wired.executions.transition(world.executionId, 'api', row, { step: 'redispatch' })).not.toBeNull()
    ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
    expect(wired.executions.change(world.executionId, 'api')!.step).toBeNull()
    expect(wired.resumeMails(world.taskId)).toHaveLength(1)
    // The redispatch stage is the only :retry: sender (its trigger is the
    // step at executionPlanner.ts:151); with the step cleared, no assignment
    // of the task carries a retry key.
    for (const assignment of wired.bench.assignmentStore.listByTask(world.taskId)) {
      expect(assignment.requestKey).not.toContain(':retry:')
    }
  })
})

describe('completeness (every axis combination maps to exactly one row or one U-claim)', () => {
  // The axes at this step: the continue states, every attempt kind (implement,
  // fix, update) over owed/out/answered, and `answered` split plain vs rev↗
  // (G2/G3/Q-A6). The hold axis is `*` for every C-row — the mapping ignores
  // it; releaseHold composes through the H-overlay (H1r-H4r, the release
  // step). The pausing sub-states collapse into `pausing` (C10's `*`), and
  // U3-U6/U8 are state-level unreachables the state axis never produces.
  const KINDS = ['implement', 'fix', 'update'] as const
  const CELLS = ['owed', 'out', 'answered (plain)', 'answered·rev↗'] as const
  const STATES = ['decided', 'withdrawn', 'pausing', 'paused·gone', 'paused', 'review stands', 'review superseded'] as const

  // The table's check order, as the resolve implements it: decided (I1),
  // withdrawn before the state (C9), not-paused (C10), holder-gone (C11),
  // then the stage branch. First match wins; the unreachable list takes what
  // no row claims.
  function rowFor(state: string, kind: string | null, cell: string | null): string {
    if (state === 'decided') return 'C1'
    if (state === 'withdrawn') return 'C9'
    if (state === 'pausing') return 'C10'
    if (state === 'paused·gone') return 'C11'
    if (state === 'review stands') {
      if (cell === null) return 'U2'
      if (cell === 'answered (plain)') return 'C12'
      if (cell === 'answered·rev↗') return 'C14'
      return 'U2'
    }
    if (state === 'review superseded') return cell !== null && cell.startsWith('answered') ? 'C13' : 'U2'
    if (cell === null) return 'C2'
    if (kind === 'update') {
      if (cell === 'owed') return 'U1'
      if (cell === 'out') return 'C17'
      return 'U7'
    }
    const implementRow = kind === 'implement'
    if (cell === 'owed') return implementRow ? 'C3' : 'C6'
    if (cell === 'out') return implementRow ? 'C4' : 'C7'
    if (cell === 'answered (plain)') return implementRow ? 'C5' : 'C8'
    return implementRow ? 'C15' : 'C16'
  }

  test('every state × kind × cell combination resolves to exactly one id, with no gap and no overlap', () => {
    const hit: Record<string, number> = {}
    for (const state of STATES) {
      const rowAxes: Array<[string | null, string | null]> = [[null, null], ...KINDS.flatMap(kind => CELLS.map(cell => [kind, cell] as [string, string]))]
      for (const [kind, cell] of rowAxes) {
        const mapped = rowFor(state, kind, cell)
        expect(mapped).toMatch(/^(C\d+|U\d+)$/)
        hit[mapped] = (hit[mapped] ?? 0) + 1
      }
    }
    // Every C-row and every U-claim this step's axes produce is hit, and the
    // update kind's out cell hits the update target alone.
    for (const id of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17', 'U1', 'U2', 'U7']) {
      expect(hit[id]).toBeGreaterThan(0)
    }
    expect(hit['C17']).toBe(1)
    expect(hit['C15']).toBe(1)
    expect(hit['C16']).toBe(1)
    expect(hit['C12']).toBe(3)
    expect(hit['C14']).toBe(3)
  })

  test("on the attempt stage the update kind is unreachable owed and answered (U1, U7); a review target's kind axis collapses to answered(*) (U2)", () => {
    expect(rowFor('paused', 'update', 'owed')).toBe('U1')
    expect(rowFor('paused', 'update', 'answered (plain)')).toBe('U7')
    expect(rowFor('paused', 'update', 'answered·rev↗')).toBe('U7')
    // The review stage reads no kind: `agentHeldStage` returns `review` from
    // `gating`+`reviewing` before the newest row is consulted, so the update
    // kind's answered cells land on the review rows, never on U7 (B3).
    expect(rowFor('review stands', 'update', 'answered (plain)')).toBe('C12')
    expect(rowFor('review superseded', 'update', 'answered·rev↗')).toBe('C13')
    expect(rowFor('review stands', 'implement', 'owed')).toBe('U2')
    expect(rowFor('review stands', null, null)).toBe('U2')
    expect(rowFor('review superseded', 'fix', 'answered (plain)')).toBe('C13')
  })
})


