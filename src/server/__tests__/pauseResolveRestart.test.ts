// The resolve command's restart arms (revision-control 4.4-4.5, design D9's
// R-rows, rev4 §10 step 5): the dispatch arms, the decision detail, D5's
// containment read and the may-predates note, R2's release bookkeeping, K7,
// and the R17/R18r review shapes here; the row-variant table and the
// completeness grid live in pauseResolveRestartRows.test.ts, and the bench
// wiring and the paused-target worlds live in pauseResolveBench.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { AttemptManifest } from '../../shared/planExecution'
import { manifestHashInput } from '../../shared/planExecution'
import { REVISION_NOTICE_TAG } from '../team/taskNotices'
import { pauseResolveBench, targetOf, type PauseResolveBench } from './pauseResolveBench'
import { writeGroup } from './planHarness'

let wired: PauseResolveBench
let sequence = 0

beforeAll(async () => {
  wired = await pauseResolveBench('pause-resolve-restart')
  // The fixture plan's review group, for R18r's handoff dispatch — the
  // harness defines only the implement groups.
  writeGroup(wired.world, 'reviewers', 'Review work.')
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

// R2 | paused (attempt stage) | restart | * | — | accepted — the owed arm:
// the decision records the release bookkeeping, ONE new implement row mints
// at the task's newest revision (restart publishes nothing), the held
// assignment is superseded through the stop branch, and no resume rides the
// decision — the attempt's instruction rides its dispatch.
test('R2: the restart decides {release never}, mints one owed implement row, and sends no resume', async () => {
  const world = await wired.pausedAttempt({ mintAttempt: false })
  const before = wired.resolvedEvents(world.planId).length
  const mails = wired.bench.mail.forTask(world.taskId).length
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  const target = targetOf(wired, world.pauseId, 'api')
  expect(target.decision).toBe('restart')
  expect(target.decisionDetail).toMatchObject({ holder: 'dev', release: 'never', assignmentId: world.assignmentId })
  // ONE new attempt row, kind implement (the stage's kind — no newest row),
  // at the newest revision, owed (the hold still covers the change).
  const attempts = wired.executions.attempts(world.executionId, 'api')
  expect(attempts).toHaveLength(1)
  expect(attempts[0].kind).toBe('implement')
  expect(attempts[0].assignmentId).toBeNull()
  expect(attempts[0].manifest.task).toMatchObject({ id: world.taskId, revision: 1 })
  expect(attempts[0].manifest.checkpoint).toBeUndefined()
  // The stop branch superseded the held assignment; its claimed mail stands.
  expect(wired.bench.assignmentStore.byId(world.assignmentId)?.supersededBy).toBe(world.pauseId)
  const held = wired.bench.assignmentStore.byId(world.assignmentId)
  expect(wired.bench.mail.get(held?.messageId ?? '')?.state).toBe('claimed')
  // No resume, no notices, one event.
  expect(wired.resumeMails(world.taskId)).toHaveLength(0)
  expect(noticeMails(world.taskId)).toHaveLength(0)
  expect(wired.bench.mail.forTask(world.taskId)).toHaveLength(mails)
  expect(wired.resolvedEvents(world.planId)).toHaveLength(before + 1)
})

// R2's inline arm: with the hold released before the resolve, the gate —
// read after the decision — is open, and the new row dispatches in the
// resolve's own transaction under its attempt key, with D5's may-predates
// note in the instruction (nothing of this pause on origin).
test('R2: with the gate open the new row dispatches inline with the may-predates note', async () => {
  const world = await wired.pausedAttempt()
  openGate(world.planId, world.executionId)
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  const attempts = wired.executions.attempts(world.executionId, 'api')
  expect(attempts).toHaveLength(2)
  expect(attempts[1].assignmentId).not.toBeNull()
  const assignment = wired.bench.assignmentStore.byId(attempts[1].assignmentId!)
  expect(assignment?.requestKey).toBe(attemptKey(world.executionId, 'api'))
  const instruction = wired.bench.mail.get(assignment?.messageId ?? '')
  expect(instruction?.toKind).toBe('group')
  expect(instruction?.fromKind).toBe('system')
  expect(instruction?.body).toContain('Kawai restarted this work')
  expect(instruction?.body).toContain('may predate')
  expect(instruction?.body).not.toContain('checkpoint')
})

// D5's containment read (F4): this pause target's own newest checkpoint with
// a done push names the start commit and rides the manifest; the may-predates
// note does not.
test('R2: a checkpoint this pause pushed to origin names the start commit and rides the manifest', async () => {
  const world = await wired.pausing({ checkpoint: { kind: 'commit', effectState: 'done' } })
  wired.toPaused(world.pauseId, 'api')
  openGate(world.planId, world.executionId)
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  // The pausing world mints the in-flight implement row before the pause, so
  // the restart's new row is the newest.
  const attempts = wired.executions.attempts(world.executionId, 'api')
  expect(attempts).toHaveLength(2)
  expect(attempts.at(-1)!.manifest.startCommit).toBe('checkpoint-sha')
  const checkpoint = wired.checkpoints.newest(world.pauseId, 'api')
  expect(checkpoint).not.toBeNull()
  expect(attempts.at(-1)!.manifest.checkpoint).toEqual({ id: checkpoint!.id, commit: 'checkpoint-sha' })
  const assignment = wired.bench.assignmentStore.byId(attempts.at(-1)!.assignmentId!)
  expect(wired.bench.mail.get(assignment?.messageId ?? '')?.body).toContain('checkpoint')
  expect(wired.bench.mail.get(assignment?.messageId ?? '')?.body).toContain('checkpoint-sha')
  expect(wired.bench.mail.get(assignment?.messageId ?? '')?.body).not.toContain('may predate')
})

// §4's manifest fact: the checkpoint field is omitted when absent — never
// null — and a manifest with one hashes differently from one without.
test('the checkpoint manifest fact is omitted-when-absent and changes the hash', () => {
  const plain = wired.manifest()
  expect(JSON.stringify(plain)).not.toContain('"checkpoint"')
  const withCheckpoint: AttemptManifest = { ...wired.manifest(), checkpoint: { id: 'cp-1', commit: 'checkpoint-sha' } }
  expect(JSON.stringify(withCheckpoint)).not.toContain('"checkpoint":null')
  expect(manifestHashInput(plain)).not.toBe(manifestHashInput(withCheckpoint))
})

// K7 covers restart (L3): a failed pre-transaction head read refuses inside
// the transaction — after every earlier refusal — and writes nothing.
test('K7: a restart over an unreadable origin head refuses head-unreadable and writes nothing', async () => {
  const world = await wired.pausedAttempt({ mintAttempt: false })
  wired.useAdaptHead(() => Promise.resolve({ ok: false as const }))
  try {
    const outcome = refusal(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
    expect(outcome.reason).toBe('head-unreadable')
    expect(outcome.message).toContain('nothing was written')
    expect(wired.executions.attempts(world.executionId, 'api')).toHaveLength(0)
    expect(targetOf(wired, world.pauseId, 'api').decision).toBeNull()
    expect(wired.resolvedEvents(world.planId)).toHaveLength(0)
  } finally {
    wired.useAdaptHead(() => Promise.resolve({ ok: true as const, startCommit: 'adapt-head-sha', artifacts: {} }))
  }
})

// The read is a gather: with a contained checkpoint the start commit does
// not come from the head, so a failed read beside one does not block the
// resolution (the checkpoint supplies the start commit itself).
test('K7: a failed head read beside a contained checkpoint still restarts from the checkpoint', async () => {
  const world = await wired.pausing({ checkpoint: { kind: 'commit', effectState: 'done' } })
  wired.toPaused(world.pauseId, 'api')
  openGate(world.planId, world.executionId)
  wired.useAdaptHead(() => Promise.resolve({ ok: false as const }))
  try {
    ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
    const attempts = wired.executions.attempts(world.executionId, 'api')
    expect(attempts.at(-1)!.manifest.startCommit).toBe('checkpoint-sha')
    expect(attempts.at(-1)!.manifest.checkpoint?.commit).toBe('checkpoint-sha')
  } finally {
    wired.useAdaptHead(() => Promise.resolve({ ok: true as const, startCommit: 'adapt-head-sha', artifacts: {} }))
  }
})

// R17 (H5's exception): a restart over a review target whose passable round
// pins an older revision records `revisionPending N`, dispatches nothing,
// and mints no attempt row — D9's own revision flow sends the round's fix.
test('R17: a restart over a stale review records revisionPending and dispatches nothing', async () => {
  const world = await wired.pausedReview({ pending: true })
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  const target = targetOf(wired, world.pauseId, 'api')
  expect(target.decision).toBe('restart')
  expect(target.decisionDetail).toMatchObject({ revisionPending: 2, release: 'never' })
  expect(wired.executions.attempts(world.executionId, 'api')).toHaveLength(1)
  // The round stands (no supersede — the round pins the stale revision and
  // H2's fix flow owns it), no new review handoff, no attempt dispatch.
  expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBeNull()
  expect(wired.bench.mail.forTask(world.taskId).filter(message => message.body.includes('restarted by the owner'))).toHaveLength(0)
})

// R18r, the inline arm: a restart over an answered review under an open
// gate mints NO attempt row and sends exactly ONE new review handoff — same
// round, same result — under its own fresh `…:restart` request key, with the
// paused reviewer's recorded notes' id in the instruction, and the round
// points at the new handoff.
test('R18r: the restart re-dispatches the same round under a fresh review key with the notes id', async () => {
  const world = await wired.pausedReview({ notes: true })
  openGate(world.planId, world.executionId)
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  expect(wired.executions.attempts(world.executionId, 'api')).toHaveLength(1)
  const round = wired.executions.rounds(world.executionId, 'api')[0]
  expect(round.outcome).toBeNull()
  expect(round.reviewAssignmentId).not.toBeNull()
  const handoff = wired.bench.assignmentStore.byId(round.reviewAssignmentId!)
  expect(handoff?.requestKey).toBe(`exec:${world.executionId}:api:round:1:review:${wired.executions.change(world.executionId, 'api')!.generation}:restart`)
  const instruction = wired.bench.mail.get(handoff?.messageId ?? '')
  expect(instruction?.toKind).toBe('group')
  expect(instruction?.body).toContain('restarted by the owner')
  expect(instruction?.body).toContain(wired.checkpoints.newest(world.pauseId, 'api')!.id)
  // The round moved off the superseded held assignment onto the new handoff.
  expect(handoff?.id).not.toBe(targetOf(wired, world.pauseId, 'api').assignmentId)
})

// R18r, the held arm: the gate still closed means the decision and the stop
// branch stand but nothing dispatches — the round pointer is unchanged.
// (A held restart's later re-dispatch path is the planner's, not the
// resolve's; see the CHECKPOINT note on this arm.)
test('R18r: a restart under a still-held change decides and dispatches nothing', async () => {
  const world = await wired.pausedReview({ notes: true })
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  const round = wired.executions.rounds(world.executionId, 'api')[0]
  expect(round.reviewAssignmentId).toBeNull()
  expect(wired.bench.mail.forTask(world.taskId).filter(message => message.body.includes('restarted by the owner'))).toHaveLength(0)
})

// R18r with a superseded handoff: the handoff-standing refusal has no
// restart twin (Q-A2) — the resolution is accepted.
test('R18r: a restart over a superseded review handoff is accepted (no C13 twin)', async () => {
  const world = await wired.pausedReview({ superseded: true })
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  expect(targetOf(wired, world.pauseId, 'api').decision).toBe('restart')
})

// The ROUND RULE's restart twin, the no-drop side: an answered round pinning
// the task's newest revision survives a restart (the condition fails — as
// C18's plain answer), and the new row keeps the newest row's kind.
test('a restart over an answered round at the newest revision does not supersede it', async () => {
  const world = await wired.pausedUpdate()
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBeNull()
  const attempts = wired.executions.attempts(world.executionId, 'api')
  expect(attempts.at(-1)?.kind).toBe('update')
  // An update target stays gating with step null and passedAt null (R21r):
  // restart moves no state except the ROUND RULE's own.
  const row = wired.executions.change(world.executionId, 'api')!
  expect(row.state).toBe('gating')
  expect(row.step).toBeNull()
  expect(row.passedAt).toBeNull()
})

// The ROUND RULE's restart twin, the supersede side: the answered round pins
// an older revision, so the restart supersedes it and cancels its live
// effects (as C19's answered·rev↗).
test('a restart over an answered round pinning an older revision supersedes it', async () => {
  const world = await wired.pausedUpdate()
  wired.republish(world.taskId)
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBe('superseded')
  const attempts = wired.executions.attempts(world.executionId, 'api')
  expect(attempts.at(-1)?.manifest.task.revision).toBe(2)
})

// R2's release bookkeeping: a spawned, ready holder is released after the
// commit — one releaseNow, no pending mark — and the decision says 'now'.
// The recorders are suite-global, so every assertion here is a delta over a
// before-snapshot.
test('a restarted spawned ready holder releases now (after the commit)', async () => {
  const world = await wired.pausedAttempt({ mintAttempt: false })
  wired.spawnRecord('dev', world.taskId)
  wired.useReleaseSeams({ spawned: true, archived: false, ready: true })
  const releasesBefore = wired.releaseCalls().length
  const marksBefore = wired.pendingMarks().length
  try {
    ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
    expect(targetOf(wired, world.pauseId, 'api').decisionDetail).toMatchObject({ release: 'now', holder: 'dev' })
    expect(wired.releaseCalls()).toHaveLength(releasesBefore + 1)
    expect(wired.releaseCalls().at(-1)).toEqual({ sessionId: 'dev', detail: expect.stringContaining('restarted') })
    expect(wired.pendingMarks()).toHaveLength(marksBefore)
  } finally {
    wired.useReleaseSeams(null)
  }
})

// A spawned but busy holder is marked pending release inside the
// transaction; nothing releases after the commit.
test('a restarted busy spawned holder is marked pending release', async () => {
  const world = await wired.pausedAttempt({ mintAttempt: false })
  wired.spawnRecord('dev', world.taskId)
  wired.useReleaseSeams({ spawned: true, archived: false, ready: false, reason: 'mid-turn' })
  const releasesBefore = wired.releaseCalls().length
  const marksBefore = wired.pendingMarks().length
  try {
    ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
    expect(targetOf(wired, world.pauseId, 'api').decisionDetail).toMatchObject({ release: 'pending' })
    expect(wired.pendingMarks()).toHaveLength(marksBefore + 1)
    expect(wired.pendingMarks().at(-1)).toEqual({ sessionId: 'dev', reason: expect.stringContaining('mid-turn'), wrote: true })
    expect(wired.releaseCalls()).toHaveLength(releasesBefore)
  } finally {
    wired.useReleaseSeams(null)
  }
})

// A human-created holder, an archived one, a gone one, and an unwired seam
// release never — the fail-closed arm (R14, R16, and the default).
test('non-spawned, archived, gone, and unwired holders release never', async () => {
  const releasesBefore = wired.releaseCalls().length
  const marksBefore = wired.pendingMarks().length
  // Human-created: the record reads spawned false.
  const human = await wired.pausedAttempt({ holder: 'dev2' })
  wired.useReleaseSeams({ spawned: false, archived: false, ready: true })
  ok(await wired.resolve({ planId: human.planId, pauseId: human.pauseId, change: 'api', choice: 'restart' }))
  expect(targetOf(wired, human.pauseId, 'api').decisionDetail).toMatchObject({ release: 'never' })
  // Archived spawned holder.
  const archived = await wired.pausedAttempt({ holder: 'dev3' })
  wired.spawnRecord('dev3', archived.taskId)
  wired.useReleaseSeams({ spawned: true, archived: true, ready: true })
  ok(await wired.resolve({ planId: archived.planId, pauseId: archived.pauseId, change: 'api', choice: 'restart' }))
  expect(targetOf(wired, archived.pauseId, 'api').decisionDetail).toMatchObject({ release: 'never' })
  // Gone holder (R16): the record reads null — accepted, never released.
  const gone = await wired.pausedAttempt({ holder: 'ghost', mintAttempt: false })
  wired.useReleaseSeams({ spawned: true, archived: false, ready: true })
  ok(await wired.resolve({ planId: gone.planId, pauseId: gone.pauseId, change: 'api', choice: 'restart' }))
  expect(targetOf(wired, gone.pauseId, 'api').decisionDetail).toMatchObject({ release: 'never' })
  // Unwired seam: the default — never, and no calls made.
  wired.useReleaseSeams(null)
  const unwired = await wired.pausedAttempt({ mintAttempt: false })
  ok(await wired.resolve({ planId: unwired.planId, pauseId: unwired.pauseId, change: 'api', choice: 'restart' }))
  expect(targetOf(wired, unwired.pauseId, 'api').decisionDetail).toMatchObject({ release: 'never' })
  expect(wired.releaseCalls()).toHaveLength(releasesBefore)
  expect(wired.pendingMarks()).toHaveLength(marksBefore)
})

// R14: a restart over a still-pausing target releases its busy holder
// pending — the bookkeeping does not wait for the tick's Paused record.
test('R14: a restart over a pausing target marks its busy holder pending', async () => {
  const world = await wired.pausing({})
  wired.spawnRecord('dev', world.taskId)
  wired.useReleaseSeams({ spawned: true, archived: false, ready: false, reason: 'mid-turn' })
  try {
    ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
    expect(targetOf(wired, world.pauseId, 'api').decisionDetail).toMatchObject({ release: 'pending' })
  } finally {
    wired.useReleaseSeams(null)
  }
})

// R9: a withdrawn-and-paused target's restart is accepted — no publication,
// no notices, ONE new implement row owed. The queued-instruction world is
// already Paused: pause() withdraws an unclaimed instruction and records
// Paused at once (D6 — nothing is owed to a withdrawn target).
test('R9: a restart over a withdrawn-and-paused target mints its new row owed', async () => {
  const world = await wired.pausing({ queued: true, withdrawn: true })
  expect(targetOf(wired, world.pauseId, 'api').pausedAt).not.toBeNull()
  const mails = wired.bench.mail.forTask(world.taskId).length
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  expect(targetOf(wired, world.pauseId, 'api').decision).toBe('restart')
  expect(noticeMails(world.taskId)).toHaveLength(0)
  expect(wired.bench.mail.forTask(world.taskId)).toHaveLength(mails)
  const attempts = wired.executions.attempts(world.executionId, 'api')
  expect(attempts).toHaveLength(2)
  expect(attempts.at(-1)!.assignmentId).toBeNull()
})

// R15: the same acceptance with the target still pausing (rev4 extends the
// allowed-from set; the tick never ran).
test('R15: a restart over a withdrawn-and-pausing target is accepted', async () => {
  const world = await wired.pausing({ withdrawn: true })
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  expect(targetOf(wired, world.pauseId, 'api').decision).toBe('restart')
})

// R10/R11/R12's inline shape: a pausing target with the gate open restarts
// from the head the pre-transaction read returned — the may-predates note,
// no checkpoint fact (nothing of this pause is on origin).
test('R10-R12: a pausing target restarts from the read head with the may-predates note', async () => {
  const world = await wired.pausing({})
  openGate(world.planId, world.executionId)
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  const attempts = wired.executions.attempts(world.executionId, 'api')
  expect(attempts.at(-1)!.manifest.startCommit).toBe('adapt-head-sha')
  expect(attempts.at(-1)!.manifest.checkpoint).toBeUndefined()
  const assignment = wired.bench.assignmentStore.byId(attempts.at(-1)!.assignmentId!)
  const body = wired.bench.mail.get(assignment?.messageId ?? '')?.body ?? ''
  expect(body).toContain('may predate')
})

// R13's shape: a killed holder's pausing target restarts the same way — the
// holder is never released and the instruction goes to the group.
test("R13: a killed holder's pausing target restarts from the read head", async () => {
  const world = await wired.pausing({ holder: 'ghost' })
  openGate(world.planId, world.executionId)
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  const attempts = wired.executions.attempts(world.executionId, 'api')
  expect(attempts.at(-1)!.assignmentId).not.toBeNull()
  expect(attempts.at(-1)!.manifest.startCommit).toBe('adapt-head-sha')
  expect(targetOf(wired, world.pauseId, 'api').decisionDetail).toMatchObject({ release: 'never' })
})

// O4: a pending `redispatch` step clears in the resolution's transaction —
// the restart supersedes the holder's instruction, so no :retry: re-send
// follows it, and the new row mints beside the clear.
test('O4: a restart clears a pending redispatch step and mints its new row', async () => {
  const world = await wired.pausedAttempt({ mintAttempt: false })
  const row = wired.executions.change(world.executionId, 'api')!
  expect(wired.executions.transition(world.executionId, 'api', row, { step: 'redispatch' })).not.toBeNull()
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  expect(wired.executions.change(world.executionId, 'api')?.step).toBeNull()
  expect(wired.executions.attempts(world.executionId, 'api')).toHaveLength(1)
  expect(wired.bench.mail.forTask(world.taskId).filter(message => message.body.includes(':retry:'))).toHaveLength(0)
})
