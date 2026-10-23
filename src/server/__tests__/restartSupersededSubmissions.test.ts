// The old-holder refusal after a Restart (revision-control 4.4 bullet 6,
// design D9, lead ruling L6): the old holder's task_submit_result and
// task_submit_findings on the owned task are refused with
// `restart-superseded`, judged from the pause and assignment rows, in both
// windows — before the new dispatch (services rebuilt over the same
// database) and after it — unless the old holder is now the outstanding
// claimant. The checkpoint half is the shipped no-pause-requested refusal;
// P-I2 is the seeded property over both windows, every submission kind, and
// every holder type, asserting the claimed-mail rule beside them.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { CheckpointTool } from '../plans/revisionControl/checkpointTool'
import { executionOwnership, ownershipRowReads, restartSupersededRefusal } from '../plans/execution/executionOwnership'
import { TaskResultService } from '../team/TaskResultService'
import { pauseResolveBench, type PauseResolveBench } from './pauseResolveBench'
import { sessionRow } from './planHarness'

let wired: PauseResolveBench

beforeAll(async () => {
  wired = await pauseResolveBench('restart-superseded')
})

afterAll(() => {
  wired.close()
})

/** mulberry32: a tiny seeded PRNG, called strictly sequentially (never from two threads). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A git double that accepts every commit and reads no origin head: the submission checks' happy path. */
function permissiveGit(): Parameters<typeof executionOwnership>[1] {
  return {
    isAncestor: (async () => ({ ok: true as const, ancestor: true })) as never,
    lsRemoteHead: (async () => ({ ok: true as const, sha: null })) as never,
  }
}

/**
 * The services rebuilt over the bench's database — a fresh ownership, result
 * service, and checkpoint tool each call, so every refusal and acceptance is
 * judged from the rows alone (ruling L6's rebuild-over-the-same-database
 * window), never from in-memory state.
 */
function rebuilt(): { results: TaskResultService; tool: CheckpointTool } {
  const ownership = executionOwnership(wired.executions, permissiveGit(), () => null, ownershipRowReads(wired.bench.db.db))
  const results = new TaskResultService(wired.tasks, {
    getSession: id => wired.bench.records.get(id) ?? null, assignments: wired.assignments, ownership,
  })
  const tool = new CheckpointTool({ executions: wired.executions, pauses: wired.pauses, checkpoints: wired.checkpoints })
  return { results, tool }
}

type MailState = 'queued' | 'awaiting-request' | 'claimed' | 'delivered'
type HolderType = 'spawned' | 'human' | 'archived'
type Window = 'pre-dispatch' | 'post-dispatch' | 'post-dispatch-same-holder'
type SubmissionKind = 'result' | 'findings' | 'checkpoint'

interface RestartedWorld {
  planId: string
  executionId: string
  taskId: string
  pauseId: string
}

/** One held, paused, recorded-Paused change with its instruction mail in the given state and its holder record of the given type. */
async function heldWorld(mailState: MailState, holder: HolderType): Promise<RestartedWorld> {
  const { planId, executionId } = await wired.executionWith(['api'])
  const flight = await wired.inFlight(executionId, 'api', 'dev', mailState === 'queued' || mailState === 'awaiting-request' ? 'queued' : 'claim')
  if (mailState === 'awaiting-request') expect(wired.bench.mail.holdForRequest(flight.mailId)).toBe(true)
  if (mailState === 'delivered') wired.bench.mail.markDelivered(flight.mailId)
  if (holder === 'spawned') wired.spawnRecord('dev', flight.taskId)
  else if (holder === 'archived') {
    wired.bench.records.set('dev', { ...sessionRow('dev', 'middle-devs', wired.world.feature), archivedAt: '2026-11-01T00:00:00.000Z' })
  } else wired.bench.records.set('dev', sessionRow('dev', 'middle-devs', wired.world.feature))
  const hold = wired.placeHold(planId, ['api'], `hold-${planId}`)
  const pause = wired.expectOk(wired.pause({ planId, holdId: hold.id, commandId: `pause-${planId}` })).pause
  // An unclaimed (queued/awaiting-request) instruction is withdrawn at
  // creation, and the service records Paused for it at once (D6).
  if (wired.pauses.target(pause.id, 'api')!.pausedAt === null) wired.toPaused(pause.id, 'api')
  return { planId, executionId, taskId: flight.taskId, pauseId: pause.id }
}

/** The row fact the whole rule reads: the restart decision naming the old holder. */
function restartTarget(world: RestartedWorld): { decision: string | null; holderSession: string | null } {
  const target = wired.pauses.target(world.pauseId, 'api')
  if (target === null) throw new Error('the pause has no target for api')
  return { decision: target.decision, holderSession: target.holderSession }
}

/** No claimed or delivered mail on the task was cancelled by the Restart (P-I2's first assertion). */
function expectNoClaimedMailCancelled(taskId: string): void {
  for (const message of wired.bench.mail.forTask(taskId)) {
    if (message.state === 'claimed' || message.state === 'delivered') {
      expect(wired.eventKinds(message.id)).not.toContain('cancelled')
    }
  }
}

/** The old holder's submission of the given kind, asserted refused (or accepted through the claimant exception). */
async function submitAsOldHolder(world: RestartedWorld, results: TaskResultService, tool: CheckpointTool, kind: SubmissionKind, accepted: boolean): Promise<void> {
  const resultId = wired.tasks.store.results.listByTask(world.taskId).at(-1)?.id
  if (kind === 'result') {
    const submission = results.submit(wired.bench.agent('dev'), world.taskId, { summary: 'late work', commit: 'late-commit' })
    if (accepted) await submission.then(row => expect(row.commit).toBe('late-commit'))
    else await expect(submission).rejects.toThrow('restart-superseded')
  } else if (kind === 'findings') {
    if (resultId === undefined || resultId === null) throw new Error('the fixture wrote no result to answer')
    const submission = results.submitFindings(wired.bench.agent('dev'), world.taskId, { resultId, kind: 'review', verdict: 'pass', findings: 'late notes' })
    if (accepted) await submission.then(row => expect(row.verdict).toBe('pass'))
    else await expect(submission).rejects.toThrow('restart-superseded')
  } else {
    const outcome = await tool.record(wired.bench.agent('dev'), { task_id: world.taskId, summary: 'late checkpoint', next_steps: 'none' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('no-pause-requested')
  }
}

// The two-window anchor (tasks.md 4.4 bullet 6, ruling L6): Restart, then
// the services rebuilt over the same database — the old holder's result,
// findings, and checkpoint are refused before the new dispatch; after the
// new dispatch is claimed the old holder is refused again and the new
// claimant's result is accepted.
test('after a Restart the old holder\'s result, findings, and checkpoint are refused in both windows — rebuilt over the same database — and the new claimant\'s result is accepted', async () => {
  const world = await heldWorld('claimed', 'human')
  wired.expectOk(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  expect(restartTarget(world)).toMatchObject({ decision: 'restart', holderSession: 'dev' })
  wired.answerNewestRow(world.executionId, 'api', 1)

  // Pre-dispatch window: no outstanding assignment for the new attempt yet.
  let { results, tool } = rebuilt()
  await submitAsOldHolder(world, results, tool, 'result', false)
  await submitAsOldHolder(world, results, tool, 'findings', false)
  await submitAsOldHolder(world, results, tool, 'checkpoint', false)
  expectNoClaimedMailCancelled(world.taskId)

  // Post-dispatch window: the new attempt claimed by another session.
  await wired.mintAttempt(world.executionId, 'api', 'implement', 'dev2')
  ;({ results, tool } = rebuilt())
  await submitAsOldHolder(world, results, tool, 'result', false)
  await submitAsOldHolder(world, results, tool, 'findings', false)
  await submitAsOldHolder(world, results, tool, 'checkpoint', false)
  const claimant = await results.submit(wired.bench.agent('dev2'), world.taskId, { summary: 'the new attempt', commit: 'new-commit' })
  expect(claimant.commit).toBe('new-commit')
  expectNoClaimedMailCancelled(world.taskId)
})

// Ruling L6's exception: the old holder the new dispatch went to again is
// now the outstanding claimant, so its result and findings are accepted —
// the checkpoint stays refused (the decided target accepts none).
test('the old holder re-dispatched as the new claimant submits again (ruling L6\'s exception)', async () => {
  const world = await heldWorld('claimed', 'human')
  wired.expectOk(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
  wired.answerNewestRow(world.executionId, 'api', 1)
  await wired.mintAttempt(world.executionId, 'api', 'implement', 'dev')
  const { results, tool } = rebuilt()
  await submitAsOldHolder(world, results, tool, 'result', true)
  await submitAsOldHolder(world, results, tool, 'findings', true)
  await submitAsOldHolder(world, results, tool, 'checkpoint', false)
})

// The non-Restart rule (the shipped suites stay green): with the row reads
// wired and no restart decision anywhere, the old-holder predicate never
// fires — findings still accept on an owned task, and a decided non-restart
// target (Continue) refuses no one's result.
test('without a Restart the wired row reads refuse nothing — findings still accept on an owned task', async () => {
  const { planId, executionId } = await wired.executionWith(['api'])
  const flight = await wired.inFlight(executionId, 'api', 'dev', 'claim')
  const hold = wired.placeHold(planId, ['api'], `hold-${planId}`)
  const pause = wired.expectOk(wired.pause({ planId, holdId: hold.id, commandId: `pause-${planId}` })).pause
  wired.toPaused(pause.id, 'api')
  wired.expectOk(await wired.resolve({ planId, pauseId: pause.id, change: 'api', choice: 'continue' }))
  const { results } = rebuilt()
  const submitted = await results.submit(wired.bench.agent('dev'), flight.taskId, { summary: 'the work', commit: 'work-commit' })
  const findings = await results.submitFindings(wired.bench.agent('lead2'), flight.taskId, {
    resultId: submitted.id, kind: 'review', verdict: 'pass', findings: 'clean',
  })
  expect(findings.verdict).toBe('pass')
})

// The predicate's truth table, unit-tested: the human (null submitter) and
// a non-holder pass; the old holder is refused naming the Restart; the
// standing claimant passes even when it is the old holder.
test('restartSupersededRefusal: the human, a non-holder, and the standing claimant pass; the old holder is refused naming the Restart', () => {
  expect(restartSupersededRefusal(null, { change: 'api' }, true, null)).toBeNull()
  expect(restartSupersededRefusal('dev', { change: 'api' }, false, null)).toBeNull()
  const refusal = restartSupersededRefusal('dev', { change: 'api' }, true, null)
  expect(refusal).toContain('restart-superseded')
  expect(refusal).toContain('Restart')
  expect(restartSupersededRefusal('dev', { change: 'api' }, true, 'dev')).toBeNull()
  expect(restartSupersededRefusal('dev', { change: 'api' }, true, 'dev2')).toContain('restart-superseded')
})

// P-I2 (design.md :472, ruling L6; seed 20261022, 24 cases): the generator
// varies the instruction mail's state at Restart, the window, the submission
// kind, and the holder type. After every case: no claimed or delivered mail
// was cancelled (the stop branch cancels only queued/awaiting-request), and
// the old holder's submission is refused — or accepted only through the
// claimant exception — judged from the rows by services rebuilt over the
// same database. L2: the explicit 60 s budget is for parallel-load jitter.
test('P-I2: 24 seeded cases — no claimed or delivered mail cancelled, every old-holder submission refused from the rows in both windows', async () => {
  const rand = mulberry32(20261022)
  const MAIL_STATES: MailState[] = ['queued', 'awaiting-request', 'claimed', 'delivered']
  const WINDOWS: Window[] = ['pre-dispatch', 'post-dispatch', 'post-dispatch-same-holder']
  const KINDS: SubmissionKind[] = ['result', 'findings', 'checkpoint']
  const HOLDERS: HolderType[] = ['spawned', 'human', 'archived']
  for (let index = 0; index < 24; index += 1) {
    const mailState = MAIL_STATES[Math.floor(rand() * MAIL_STATES.length)]
    const window = WINDOWS[Math.floor(rand() * WINDOWS.length)]
    const kind = KINDS[Math.floor(rand() * KINDS.length)]
    const holder = HOLDERS[Math.floor(rand() * HOLDERS.length)]
    const world = await heldWorld(mailState, holder)
    wired.expectOk(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'restart' }))
    // A withdrawn target (the unclaimed queued/awaiting-request instruction)
    // names no holder: nobody's work was superseded, so the row fact refuses
    // no one.
    const hasOldHolder = restartTarget(world).holderSession !== null
    expect(restartTarget(world)).toMatchObject({ decision: 'restart', holderSession: hasOldHolder ? 'dev' : null })
    expectNoClaimedMailCancelled(world.taskId)
    wired.answerNewestRow(world.executionId, 'api', 1)
    const postDispatch = window !== 'pre-dispatch'
    const newClaimant = window === 'post-dispatch-same-holder' ? 'dev' : 'dev2'
    if (postDispatch) await wired.mintAttempt(world.executionId, 'api', 'implement', newClaimant)
    const { results, tool } = rebuilt()
    await submitAsOldHolder(world, results, tool, kind, (!hasOldHolder || window === 'post-dispatch-same-holder') && kind !== 'checkpoint')
    if (postDispatch && newClaimant === 'dev2') {
      const claimant = await results.submit(wired.bench.agent('dev2'), world.taskId, { summary: 'the new attempt', commit: 'new-commit' })
      expect(claimant.commit).toBe('new-commit')
    }
    expectNoClaimedMailCancelled(world.taskId)
  }
}, 60000)
