// The resolve command's A-rows (revision-control 4.4, A3): every row of
// design.md "Acceptance oracles (4.4-4.5)"'s decision table with resolution
// `adapt`, verbatim as one test.each row, plus the completeness grid over the
// state × kind × row axes. The dispatch arms and the state rows with their
// deep assertions live in pauseResolveAdapt.test.ts; the bench wiring and the
// paused-target worlds live in pauseResolveBench.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { AttemptManifest } from '../../shared/planExecution'
import { REVISION_NOTICE_TAG } from '../team/taskNotices'
import { pauseResolveBench, targetOf, type PauseResolveBench } from './pauseResolveBench'

let wired: PauseResolveBench
let sequence = 0

beforeAll(async () => {
  wired = await pauseResolveBench('pause-resolve-adapt-rows')
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

function noticeMails(taskId: string) {
  return wired.bench.mail.forTask(taskId).filter(message => message.tags.includes(REVISION_NOTICE_TAG))
}

/** The newest revision's request key (the publication's `pause:<commandId>`), null before any publication. */
function publicationKey(taskId: string): string | null {
  const revisions = wired.tasks.store.revisions(taskId)
  if (revisions.length < 2) return null
  const row = wired.bench.db.db.prepare('SELECT request_key FROM team_task_revisions WHERE task_id = ? AND revision = ?').get(taskId, revisions.length) as { request_key: string | null }
  return row.request_key
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

// The decision table's `adapt` rows, verbatim from A3 (design.md, note-cb984944).
const A_ROWS = [
  ['A1r', 'decided', 'adapt', '*', '*', 'refused, naming the standing decision (I1)'],
  ['A2r', 'paused (attempt stage)', 'adapt', '*', '—', 'accepted'],
  ['A3r', 'paused (attempt stage)', 'adapt', '*', 'implement owed', 'accepted; the older owed row never dispatches (H6) (G4\'s caveat as C3\'s)'],
  ['A4r', 'paused (attempt stage)', 'adapt', '*', 'implement out', 'accepted; the held assignment superseded through the stop branch (the A2r shape names it)'],
  ['A5r', 'paused (attempt stage)', 'adapt', '*', 'fix owed', 'accepted (G4\'s caveat as C3\'s)'],
  ['A6r', 'paused (attempt stage)', 'adapt', '*', 'fix out (claimed failed-round fix)', 'accepted; the failed round is NOT superseded (H2: passable rounds only); the held assignment superseded through the stop branch'],
  ['A7r', 'paused (attempt stage)', 'adapt', '*', 'fix answered (plain or rev↗)', 'accepted; every passable round superseded (the ROUND RULE — plain and rev↗ alike)'],
  ['A8r', 'paused·withdrawn (attempt stage)', 'adapt', '*', '*', 'accepted - the withdraw recorded Paused; publishes; the stop-branch supersession is a no-op (the assignment is already superseded), so no live holder is notified'],
  ['A9r', 'pausing·*', 'adapt', '*', '*', 'refused `not-paused`'],
  ['A10r', 'review target', 'adapt', '*', '*', 'refused `review-target`'],
  ['A11r', 'paused·gone (attempt stage)', 'adapt', '*', '*', 'accepted - no holder-gone refusal; the notices to the gone session dead-letter at enqueue (Q-A7)'],
  ['A12r', 'paused (attempt stage)', 'adapt', '*', 'implement answered (plain or rev↗)', 'accepted; every passable round superseded (the ROUND RULE — as A7r)'],
  ['A13r', 'paused (update target: gating, update row out)', 'adapt', '*', 'update out', 'accepted (G1, per O4); the ROUND RULE supersedes the update\'s round (Adapt always supersedes)'],
] as const

describe('the A-rows (A3, verbatim)', () => {
  test.each(A_ROWS)('%s: %s · %s · hold %s · row %s → %s', async (id: string) => {
    if (id === 'A1r') {
      const world = await wired.pausedAttempt()
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
      const again = refusal(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Rework it', rationale: 'the direction moved' }))
      expect(again.reason).toBe('state')
      expect(again.message).toContain('already decided (continue)')
      expect(wired.resolvedEvents(world.planId)).toHaveLength(1)
    } else if (id === 'A2r') {
      const world = await wired.pausedAttempt({ mintAttempt: false })
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Build it wider', rationale: 'scope grew', commandId: `adapt-${++sequence}` }))
      // ONE new fix row, owed (the hold still covers the change), at revision N+1.
      const attempts = wired.executions.attempts(world.executionId, 'api')
      expect(attempts).toHaveLength(1)
      expect(attempts[0].kind).toBe('fix')
      expect(attempts[0].assignmentId).toBeNull()
      expect(attempts[0].manifest.task).toMatchObject({ id: world.taskId, revision: 2 })
      expect(publicationKey(world.taskId)).toMatch(/^pause:adapt-/)
      const target = targetOf(wired, world.pauseId, 'api')
      expect(target.decisionDetail).toMatchObject({ release: 'never', taskRevision: 2 })
    } else if (id === 'A3r' || id === 'A5r') {
      const kind = id === 'A3r' ? 'implement' : 'fix'
      const world = await wired.pausedAttempt()
      wired.mintOwed(world.executionId, 'api', kind)
      openGate(world.planId, world.executionId)
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Build it wider', rationale: 'scope grew' }))
      const attempts = wired.executions.attempts(world.executionId, 'api')
      expect(attempts).toHaveLength(3)
      expect(attempts[1].kind).toBe(kind)
      // H6: the older owed row never dispatches — only the new fix row does.
      expect(attempts[1].assignmentId).toBeNull()
      expect(attempts[2].kind).toBe('fix')
      expect(attempts[2].assignmentId).not.toBeNull()
      expect(wired.bench.assignmentStore.byId(attempts[2].assignmentId!)?.requestKey).toBe(attemptKey(world.executionId, 'api'))
    } else if (id === 'A4r') {
      const world = await wired.pausedAttempt()
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Build it wider', rationale: 'scope grew' }))
      // The held assignment superseded through the stop branch; its claimed
      // instruction untouched (P-I2); the new fix row owed under the hold.
      expect(wired.bench.assignmentStore.byId(world.assignmentId)?.supersededBy).toBe(world.pauseId)
      const held = wired.bench.assignmentStore.byId(world.assignmentId)
      expect(wired.bench.mail.get(held?.messageId ?? '')?.state).toBe('claimed')
      const attempts = wired.executions.attempts(world.executionId, 'api')
      expect(attempts).toHaveLength(2)
      expect(attempts[1].kind).toBe('fix')
      expect(attempts[1].assignmentId).toBeNull()
    } else if (id === 'A6r') {
      const world = await wired.pausedAttempt()
      wired.mintAttempt(world.executionId, 'api', 'fix', 'dev2')
      const roundId = wired.answerNewestRow(world.executionId, 'api', 1)
      wired.executions.decideRound(roundId, 'fail')
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Build it wider', rationale: 'scope grew' }))
      // H2: the failed round is never superseded — it stays `fail`.
      expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBe('fail')
      // The held (implement) assignment still supersedes; one new fix row owed.
      expect(wired.bench.assignmentStore.byId(world.assignmentId)?.supersededBy).toBe(world.pauseId)
      const attempts = wired.executions.attempts(world.executionId, 'api')
      expect(attempts).toHaveLength(3)
      expect(attempts[2].kind).toBe('fix')
      expect(attempts[2].assignmentId).toBeNull()
    } else if (id === 'A7r' || id === 'A12r') {
      const kind = id === 'A7r' ? 'fix' : 'implement'
      for (const variant of [{ label: 'plain', rev: 1, republished: false }, { label: 'rev↗', rev: 2, republished: true }]) {
        const world = await wired.pausedAttempt()
        if (kind === 'fix') wired.mintAttempt(world.executionId, 'api', 'fix', 'dev2')
        if (variant.republished) wired.republish(world.taskId)
        wired.answerNewestRow(world.executionId, 'api', variant.rev)
        ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Build it wider', rationale: 'scope grew' }))
        // The ROUND RULE: every passable round superseded, plain and rev↗ alike.
        expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBe('superseded')
        // The answered round left the change in `gating`; the resolution's
        // state-conditional move (the A13r mechanism) returns it to
        // `implementing` — the only state the new fix row is resumable in.
        const row = wired.executions.change(world.executionId, 'api')!
        expect(row.state).toBe('implementing')
        expect(row.step).toBeNull()
        const attempts = wired.executions.attempts(world.executionId, 'api')
        expect(attempts.at(-1)!.kind).toBe('fix')
        // N+1 counts from the revision in force at the resolve — rev↗ has
        // already published once, so the new row sits one higher.
        expect(attempts.at(-1)!.manifest.task.revision).toBe(variant.rev + 1)
        expect(attempts.at(-1)!.assignmentId).toBeNull()
      }
    } else if (id === 'A8r') {
      const { planId, executionId } = await wired.executionWith(['api'])
      const flight = await wired.inFlight(executionId, 'api', 'dev', 'queued')
      const hold = wired.placeHold(planId, ['api'], `hold-${++sequence}`)
      const pause = ok(wired.pause({ planId, holdId: hold.id, commandId: `pause-${++sequence}` })).pause
      ok(wired.resolve({ planId, pauseId: pause.id, change: 'api', choice: 'adapt', adapt: 'Reworked direction', rationale: 'the lead rethought it' }))
      // The publication stands; nobody is notified — the withdrawn target
      // names no claimant, and the stop branch's writes were no-ops.
      const revisions = wired.tasks.store.revisions(flight.taskId)
      expect(revisions).toHaveLength(2)
      expect(noticeMails(flight.taskId)).toHaveLength(0)
      expect(wired.bench.mail.get(flight.assignmentId === undefined ? '' : (wired.bench.assignmentStore.byId(flight.assignmentId)?.messageId ?? ''))?.state).toBe('cancelled')
      expect(wired.bench.assignmentStore.byId(flight.assignmentId)?.supersededBy).toBe(pause.id)
      const attempts = wired.executions.attempts(executionId, 'api')
      expect(attempts).toHaveLength(2)
      expect(attempts[1].kind).toBe('fix')
      expect(attempts[1].assignmentId).toBeNull()
    } else if (id === 'A9r') {
      const { planId, executionId } = await wired.executionWith(['api'])
      await wired.inFlight(executionId, 'api')
      const hold = wired.placeHold(planId, ['api'], `hold-${++sequence}`)
      const pause = ok(wired.pause({ planId, holdId: hold.id, commandId: `pause-${++sequence}` })).pause
      expect(refusal(wired.resolve({ planId, pauseId: pause.id, change: 'api', choice: 'adapt', adapt: 'Rework', rationale: 'move' })).reason).toBe('not-paused')
      expect(wired.resolvedEvents(planId)).toHaveLength(0)
    } else if (id === 'A10r') {
      const world = await wired.pausedReview()
      expect(refusal(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Rework', rationale: 'move' })).reason).toBe('review-target')
      expect(wired.resolvedEvents(world.planId)).toHaveLength(0)
      expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBeNull()
    } else if (id === 'A11r') {
      const world = await wired.pausedAttempt({ holder: 'ghost' })
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Rework it', rationale: 'the direction moved' }))
      // No holder-gone refusal: the notice dead-letters at enqueue (Q-A7).
      const notices = noticeMails(world.taskId)
      expect(notices).toHaveLength(1)
      expect(notices[0].state).toBe('dead')
      expect(wired.executions.attempts(world.executionId, 'api')).toHaveLength(2)
    } else if (id === 'A13r') {
      const manifest: AttemptManifest = { ...wired.manifest(), update: { base: 'prev-base', files: ['a.ts'] } }
      const world = await wired.pausedUpdate({ manifest })
      ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Build it wider', rationale: 'scope grew' }))
      // The ROUND RULE supersedes the round the update flow left behind.
      expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBe('superseded')
      // The change moved to `implementing` — the fix row's owed state.
      const row = wired.executions.change(world.executionId, 'api')!
      expect(row.state).toBe('implementing')
      expect(row.step).toBeNull()
      // ONE new row: kind fix, copying the update row's `update` at revision N+1.
      const attempts = wired.executions.attempts(world.executionId, 'api')
      expect(attempts).toHaveLength(3)
      expect(attempts[2].kind).toBe('fix')
      expect(attempts[2].manifest.update).toEqual({ base: 'prev-base', files: ['a.ts'] })
      expect(attempts[2].manifest.task.revision).toBe(2)
      expect(attempts[2].assignmentId).toBeNull()
    }
  })
})

// The completeness grid (adapt): every state × kind × row cell maps to
// exactly one A-row or one U-claim. The U-claim is reachability-only: the
// pipeline mints exactly one row kind owed — the fix row (G4's caveat) —
// while an update row mints dispatched or not at all, so an owed update row
// is not producible (mintOwed('update') is a fixture-only state). An update
// row ANSWERED after the pause is producible (the holder's result records
// the round); it resolves exactly as A7r — the ROUND RULE supersedes the
// round — with the H3 copy pulling `update` from the newest row (the A13r
// copy semantics), asserted by the test below the grid.
const ADAPT_GRID = [
  ['decided', '*', '*', 'A1r'],
  ['pausing', '*', '*', 'A9r'],
  ['paused·withdrawn', '*', '*', 'A8r'],
  ['paused·gone', '*', '*', 'A11r'],
  ['paused (review stage)', '*', '*', 'A10r'],
  ['paused (attempt stage)', '—', '—', 'A2r'],
  ['paused (attempt stage)', 'implement', 'owed', 'A3r'],
  ['paused (attempt stage)', 'implement', 'out', 'A4r'],
  ['paused (attempt stage)', 'implement', 'answered (plain)', 'A12r'],
  ['paused (attempt stage)', 'implement', 'answered (rev↗)', 'A12r'],
  ['paused (attempt stage)', 'fix', 'owed', 'A5r'],
  ['paused (attempt stage)', 'fix', 'out', 'A6r'],
  ['paused (attempt stage)', 'fix', 'answered (plain)', 'A7r'],
  ['paused (attempt stage)', 'fix', 'answered (rev↗)', 'A7r'],
  ['paused (attempt stage)', 'update', 'owed', 'U1 (not producible — see the comment above)'],
  ['paused (attempt stage)', 'update', 'answered (plain)', 'A7r'],
  ['paused (attempt stage)', 'update', 'answered (rev↗)', 'A7r'],
  ['paused (update target)', 'update', 'out', 'A13r'],
] as const

describe('the adapt grid (completeness)', () => {
  test('every state × kind × row cell maps to exactly one A-row or U-claim, and every A-row is used', () => {
    const seen = new Set<string>()
    for (const [state, kind, row, mapped] of ADAPT_GRID) {
      const cell = `${state} × ${kind} × ${row}`
      expect(seen.has(cell)).toBe(false) // no overlap
      seen.add(cell)
      const id = mapped === 'U1 (not producible — see the comment above)' ? 'U1' : mapped
      expect(id === 'U1' || A_ROWS.some(candidate => candidate[0] === id)).toBe(true)
    }
    // Every A-row of the table is reached by at least one cell (no gap).
    for (const candidate of A_ROWS) expect(ADAPT_GRID.some(cell => cell[3] === candidate[0])).toBe(true)
    const used = new Set(ADAPT_GRID.map(cell => (cell[3].startsWith('U1') ? 'U1' : cell[3])))
    expect(used.size).toBe(A_ROWS.length + 1) // 13 rows + the one U-claim
  })

  test('the update-answered cells resolve as A7r, copying `update` from the update row (H3)', async () => {
    const world = await wired.pausedAttempt()
    await wired.mintAttempt(world.executionId, 'api', 'update', 'dev3', { ...wired.manifest(), update: { base: 'prev-base', files: ['a.ts'] } })
    wired.answerNewestRow(world.executionId, 'api', 1)
    ok(wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Build it wider', rationale: 'scope grew' }))
    expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBe('superseded')
    const attempts = wired.executions.attempts(world.executionId, 'api')
    expect(attempts.at(-1)!.kind).toBe('fix')
    expect(attempts.at(-1)!.manifest.update).toEqual({ base: 'prev-base', files: ['a.ts'] })
    expect(attempts.at(-1)!.manifest.task.revision).toBe(2)
  })
})
