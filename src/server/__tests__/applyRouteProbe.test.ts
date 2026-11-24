// The reviewer's F7 probe (plan-revision-apply A3/CH3, invariant AL2;
// review round 4): Continue changes middle-devs' role profiles while an
// update's (or, as the control, a fix's) git reads are pending. The late row's
// manifest and its durable mail must both carry the applied profiles. Kept as
// the reviewer wrote it (sha256 b55ccf10), with only its unused reads dropped;
// applyRouteEquivalence.test.ts generalizes it.
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import * as git from '../git/gitCommand'
import { dispatchFixAttempt, dispatchUpdateAttempt, type DispatchDeps } from '../plans/execution/executionDispatch'
import { TaskResultService } from '../team/TaskResultService'
import { TaskService } from '../team/TaskService'
import { applyBench, type ApplyBench } from './applyBench'
import { writeGroup } from './planHarness'

let wired: ApplyBench
beforeAll(async () => { wired = await applyBench('apply-mint-race') })
afterAll(() => wired.close())

/** Real task, assignment, and result services over the bench stores, as the server composes them for Kawai. */
const deps = (): DispatchDeps => ({
  team: wired.world.team, executions: wired.executions, plans: wired.bench.plans,
  tasks: new TaskService(wired.bench.tasks, { getSession: id => wired.bench.records.get(id), plans: wired.bench.plans }),
  assignments: wired.assignments,
  results: new TaskResultService(wired.tasks, { getSession: id => wired.bench.records.get(id), assignments: wired.assignments }),
  showFile: async () => ({ ok: false as const, missing: true }),
})

/** A latch on the first `rev-parse HEAD`: resolves `entered` there and waits for `release`. */
function pauseAtHead(): { entered: Promise<void>; release: () => void; restore: () => void } {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const original = git.runGitAsync
  let paused = false
  const spy = spyOn(git, 'runGitAsync').mockImplementation(async (args, options) => {
    if (!paused && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      paused = true
      entered.resolve()
      await released.promise
    }
    return original(args, options)
  })
  return { entered: entered.promise, release: () => released.resolve(), restore: () => spy.mockRestore() }
}

type Choice = 'continue' | 'adapt' | 'restart'
interface Row {
  kind: 'fix' | 'update'
  choice: Choice
  /** The row the Apply's own transaction appends; null when it appends none. */
  applyMints: 'implement' | 'fix' | null
  /** The kind of the one row that goes out after the Apply. */
  sends: 'implement' | 'fix' | 'update'
  /** Whether the late mint's own dispatch sends it, before any executor tick. */
  sentByMint: boolean
}

async function mintMeetsApply(row: Row): Promise<void> {
  writeGroup(wired.world, 'middle-devs', '---\nprofiles: [default, opus]\n---\nBuild.')
  const { planId, executionId } = await wired.running({ roles: [{ group: 'middle-devs', profiles: ['default'] }, { group: 'reviewers', profiles: [] }] })
  const flight = await wired.inFlightByKawai(executionId, 'ui', 'dev')
  const taskId = flight.taskId
  const start = wired.executions.change(executionId, 'ui')!
  expect(wired.executions.transition(executionId, 'ui', start, { state: 'implementing', baselineCommit: 'base-sha' })).not.toBeNull()
  const roundId = wired.answerNewestRow(executionId, 'ui', 1)
  const round = wired.executions.round(roundId)!
  if (row.kind === 'fix') {
    wired.bench.db.db.prepare("UPDATE plan_execution_rounds SET outcome = 'fail' WHERE id = ?").run(roundId)
    const now = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', now, { state: 'implementing', step: null })).not.toBeNull()
  } else {
    // The landing's conflict path (executionLanding.ts): a passed round, the change back in gating with no step, passedAt cleared.
    wired.bench.db.db.prepare("UPDATE plan_execution_rounds SET outcome = 'pass' WHERE id = ?").run(roundId)
    const now = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', now, { state: 'gating', step: null, passedAt: null })).not.toBeNull()
  }
  const next = await wired.approveNext(planId, content => ({ ...content, roles: content.roles.map(role => role.group === 'middle-devs' ? { ...role, profiles: ['opus'] } : role) }))
  const rowsBefore = wired.executions.attempts(executionId, 'ui').map(entry => entry.id)
  const before = wired.tasks.store.assignmentsOf(taskId).length
  const latch = pauseAtHead()
  const mint = row.kind === 'fix'
    ? dispatchFixAttempt(deps(), {
      executionId, change: 'ui', group: 'middle-devs', failingChecks: [{ name: 'lint', conclusion: 'failure', link: null }], findingsIds: [],
      findings: { blocking: [], blockingText: '', others: 0, legacyTexts: [] }, continueFrom: 'round-commit', fixRounds: 1,
    })
    : dispatchUpdateAttempt(deps(), { executionId, change: 'ui', round, update: { base: 'base-head', files: ['a.ts'] } })
  let applied: string | null = null
  try {
    await Promise.race([latch.entered, mint])
    expect(await wired.applyAs({ executionId, choices: { ui: row.choice } })).toMatchObject({ ok: true })
    expect(wired.executions.execution(executionId)!.revision).toBe(next.revision)
    const minted = wired.executions.attempts(executionId, 'ui').filter(entry => !rowsBefore.includes(entry.id))
    expect(minted.map(entry => ({ kind: entry.kind, revision: entry.manifest.plan.revision, assignmentId: entry.assignmentId })))
      .toEqual(row.applyMints === null ? [] : [{ kind: row.applyMints, revision: next.revision, assignmentId: null }])
    applied = minted[0]?.id ?? null
  } finally {
    latch.release()
    try { await mint } finally { latch.restore() }
  }
  expect(wired.tasks.store.assignmentsOf(taskId).length - before).toBe(row.sentByMint ? 1 : 0)
  if (applied !== null) expect(wired.executions.attempts(executionId, 'ui').at(-1)!.id).toBe(applied)
  const executor = wired.executor()
  await executor.tick(wired.teamId)
  await executor.tick(wired.teamId)
  const rows = wired.executions.attempts(executionId, 'ui')
  const added = rows.filter(entry => !rowsBefore.includes(entry.id))
  // No row minted after the Apply names the old revision.
  expect(added.map(entry => entry.manifest.plan.revision)).toEqual(added.map(() => next.revision))
  const newest = rows.at(-1)!
  expect({ kind: newest.kind, revision: newest.manifest.plan.revision, isApplyRow: applied === null || newest.id === applied })
    .toEqual({ kind: row.sends, revision: next.revision, isApplyRow: true })
  // Liveness: exactly one assignment goes out after the Apply, and it is the newest row's stamp.
  expect(newest.assignmentId).not.toBeNull()
  const [assignment] = wired.tasks.store.assignmentsOf(taskId).slice(before)
  expect(assignment?.id).toBe(newest.assignmentId!)
  expect(newest.manifest.roleProfiles).toEqual(['opus'])
  expect(wired.bench.mail.get(assignment!.messageId!)?.allowedProfiles).toEqual(['opus'])
}

// @covers: plan-revision-apply › The execution keeps its revision history › Manifests keep their revision
test('Continue changing role profiles during a pending update must use the applied profile for the manifest and routed assignment', () =>
  mintMeetsApply({ kind: 'update', choice: 'continue', applyMints: null, sends: 'update', sentByMint: true }))

// @covers: plan-revision-apply › The execution keeps its revision history › Manifests keep their revision
test('control: Continue changing role profiles during a pending fix uses the applied profiles for the manifest and routed assignment', () =>
  mintMeetsApply({ kind: 'fix', choice: 'continue', applyMints: null, sends: 'fix', sentByMint: true }))
