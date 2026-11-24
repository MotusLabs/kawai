// The settled conflict across D9's revision fix (plan-revision-apply A3/CH4
// using plan-execution D9, invariant AL3; review round 5, F8, and the Lead's
// disposition of its design challenge). A revision applied once a failed
// branch update settled owes one fix naming the task's new revision AND the
// base head and conflicting files, which no row re-derives: D9 mints the fix
// row with the conflict in its manifest in the same transaction that
// supersedes the round, and every send renders the row. Each case runs the
// real D9 dispatch, the real Apply, and real executor ticks: the mint paused
// at a git read while an Apply (Continue x field) lands; the immediate send;
// a hold's release; a second Adapt replacing the owed row (it carries the
// conflict); a Restart replacing it (fresh work, the conflict left in the
// predecessor's history, decision-9192a3d0); an Adapt before the mint; a
// crash before the mint (the round stays open and D9 re-fires); and a Retry
// (the stored instruction re-sent).
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import type { PlanContent } from '../../shared/plans'
import * as git from '../git/gitCommand'
import { dispatchUpdateAttempt, redispatchStage } from '../plans/execution/executionDispatch'
import { dispatchRevisionAttempt, roundAdapters, type RoundDeps } from '../plans/execution/executionRounds'
import { TaskResultService } from '../team/TaskResultService'
import { applyBench, type ApplyBench } from './applyBench'
import { writeGroup } from './planHarness'

let wired: ApplyBench
beforeAll(async () => { wired = await applyBench('apply-conflict-carry-table') })
afterAll(() => wired.close())

type Pause = 'rev-parse' | 'ls-tree'
type Field = 'guidance' | 'profiles' | 'group'

const edits: Record<Field, (content: PlanContent) => PlanContent> = {
  guidance: content => ({ ...content, changes: content.changes.map(entry => (entry.change === 'ui' ? { ...entry, guidance: 'Latest guidance.' } : entry)) }),
  profiles: content => ({ ...content, roles: content.roles.map(role => (role.group === 'middle-devs' ? { ...role, profiles: ['opus'] } : role)) }),
  group: content => ({ ...content, changes: content.changes.map(entry => (entry.change === 'ui' ? { ...entry, group: 'senior-devs' } : entry)) }),
}

const CONFLICT = { base: 'conflict-base-head', files: ['src/conflicted-a.ts', 'src/conflicted-b.ts'] }

/** Which conflict facts an instruction names. */
const factsOf = (instruction: string) => ({
  base: instruction.includes(`base head ${CONFLICT.base}`),
  files: instruction.includes(`conflicting files: ${CONFLICT.files.join(', ')}`),
  merge: instruction.includes('Merge the base branch as part of this attempt.'),
})
const ALL = { base: true, files: true, merge: true }
const NONE = { base: false, files: false, merge: false }

/** A passed round back in gating after its branch update failed (D13), and revision 2 Adapted so D9's revision is pending. */
async function pending() {
  writeGroup(wired.world, 'middle-devs', '---\nprofiles: [default, opus]\n---\nBuild.')
  writeGroup(wired.world, 'senior-devs', '---\nprofiles: [default, opus]\n---\nBuild hard things.')
  const { planId, executionId } = await wired.running({ roles: [
    { group: 'middle-devs', profiles: ['default'] }, { group: 'senior-devs', profiles: ['opus'] }, { group: 'reviewers', profiles: [] },
  ] })
  const { taskId } = await wired.inFlightByKawai(executionId, 'ui', 'dev')
  const start = wired.executions.change(executionId, 'ui')!
  expect(wired.executions.transition(executionId, 'ui', start, { state: 'implementing', baselineCommit: 'base-sha' })).not.toBeNull()
  const roundId = wired.answerNewestRow(executionId, 'ui', 1)
  const now = wired.executions.change(executionId, 'ui')!
  wired.bench.db.db.prepare('UPDATE plan_execution_rounds SET outcome = ? WHERE id = ?').run('pass', roundId)
  expect(wired.executions.transition(executionId, 'ui', now, { state: 'gating', step: null, passedAt: null })).not.toBeNull()
  await wired.approveNext(planId, content => ({ ...content, changes: content.changes.map(entry => (entry.change === 'ui' ? { ...entry, guidance: 'Adapt scope.' } : entry)) }))
  expect(await wired.applyAs({ executionId, choices: { ui: 'adapt' } })).toMatchObject({ ok: true })
  expect(wired.tasks.store.get(taskId)!.revision).toBe(2)
  const deps: RoundDeps = {
    team: wired.world.team, executions: wired.executions, plans: wired.bench.plans, tasks: wired.tasks,
    assignments: wired.assignments,
    results: new TaskResultService(wired.tasks, { getSession: id => wired.bench.records.get(id), assignments: wired.assignments }),
    repo: 'test-only', adapters: roundAdapters, now: () => wired.now().toISOString(),
    records: () => wired.bench.records.values(), groupScoped: () => false,
    releases: { readiness: () => ({ ready: true, reason: null }), release: () => ({ ok: true }), pendingSpawns: () => [] },
  }
  const assignmentsBefore = wired.tasks.store.assignmentsOf(taskId).length
  const rowsBefore = new Set(wired.executions.attempts(executionId, 'ui').map(entry => entry.id))
  return {
    planId, executionId, taskId, deps, round: wired.executions.round(roundId)!,
    mint: (gate = false) => dispatchRevisionAttempt(gate ? { ...deps, gate: () => true } : deps, wired.executions.change(executionId, 'ui')!, wired.executions.round(roundId)!, CONFLICT),
    sent: () => wired.tasks.store.assignmentsOf(taskId).slice(assignmentsBefore),
    minted: () => wired.executions.attempts(executionId, 'ui').filter(entry => !rowsBefore.has(entry.id)),
    ticks: async () => { const executor = wired.executor(); await executor.tick(wired.teamId); await executor.tick(wired.teamId) },
  }
}

/** Pause the mint's first git read of `at` (or fail it, a crash before the mint's transaction). */
function latch(at: Pause, fail = false) {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const original = git.runGitAsync
  let paused = false
  const spy = spyOn(git, 'runGitAsync').mockImplementation(async (args, options) => {
    if (!paused && args[0] === at) {
      paused = true
      if (fail) throw new Error('the server stopped at the git read')
      entered.resolve()
      await released.promise
    }
    return original(args, options)
  })
  return { entered: entered.promise, release: () => released.resolve(), restore: () => spy.mockRestore() }
}

/** The one sent fix: its route as the applied revision assigns it, both revisions, the conflict facts, and the row it stamps. */
function sentFix(c: Awaited<ReturnType<typeof pending>>, revision: number) {
  const sent = c.sent()
  expect(sent).toHaveLength(1)
  const stamped = wired.executions.attempts(c.executionId, 'ui').find(entry => entry.assignmentId === sent[0]!.id)!
  const content = wired.bench.plans.revision(c.planId, revision)!.content
  const group = content.changes.find(entry => entry.change === 'ui')!.group!
  const profiles = content.roles.find(role => role.group === group)?.profiles ?? []
  const taskRevision = wired.tasks.store.get(c.taskId)!.revision
  const instruction = sent[0]!.instruction
  expect({
    kind: stamped.kind, planRevision: stamped.manifest.plan.revision, taskRevision: stamped.manifest.task.revision, roleProfiles: stamped.manifest.roleProfiles,
    target: `${sent[0]!.targetKind}:${sent[0]!.targetId}`, allowedProfiles: wired.bench.mail.get(sent[0]!.messageId!)!.allowedProfiles ?? [],
    namesPlanRevision: instruction.includes(`(revision ${revision})`), namesTaskRevision: instruction.includes(`revision ${taskRevision}`),
  }).toEqual({
    kind: 'fix', planRevision: revision, taskRevision, roleProfiles: profiles,
    target: `group:${group}`, allowedProfiles: profiles, namesPlanRevision: true, namesTaskRevision: true,
  })
  return { stamped, instruction, facts: factsOf(instruction) }
}

describe('a revision fix answering a settled update conflict names it however its send is routed (F8, AL3)', () => {
  for (const field of ['guidance', 'profiles', 'group'] as Field[]) for (const pause of ['rev-parse', 'ls-tree'] as Pause[]) {
    // @covers: plan-execution › A new task revision returns the change for re-evaluation › Direction changed while Kawai updates the branch
    test(`AL3 continue x ${field} paused at ${pause}: one fix, routed as applied, naming both revisions and the conflict`, async () => {
      const c = await pending()
      const next = await wired.approveNext(c.planId, edits[field])
      const gate = latch(pause)
      const mint = c.mint()
      try {
        await Promise.race([gate.entered, mint.then(() => { throw new Error('The mint bypassed its git pause') })])
        expect(await wired.applyAs({ executionId: c.executionId, choices: { ui: 'continue' } })).toMatchObject({ ok: true })
      } finally {
        gate.release()
        try { await mint } finally { gate.restore() }
      }
      await c.ticks()
      const { stamped, facts } = sentFix(c, next.revision)
      expect({ update: stamped.manifest.update, facts }).toEqual({ update: CONFLICT, facts: ALL })
    })
  }
})

describe('the conflict across the D9 fix row\'s replacements (F8 challenge witnesses)', () => {
  // @covers: plan-execution › A new task revision returns the change for re-evaluation › Direction changed while Kawai updates the branch
  test('the immediate send and a Retry of it both name the conflict; the round is superseded with the mint', async () => {
    const c = await pending()
    await c.mint()
    const { stamped, facts } = sentFix(c, 2)
    expect({ update: stamped.manifest.update, facts, round: wired.executions.round(c.round.id)!.outcome }).toEqual({ update: CONFLICT, facts: ALL, round: 'superseded' })
    // Retry re-sends the stored instruction under a new key (its facts kept, the envelope re-keyed).
    await redispatchStage({ ...c.deps, showFile: async () => ({ ok: false as const, missing: true as const }) }, wired.executions.change(c.executionId, 'ui')!)
    const retried = wired.tasks.store.assignmentsOf(c.taskId).at(-1)!
    expect({ retry: retried.requestKey.includes(':retry:'), facts: factsOf(retried.instruction) }).toEqual({ retry: true, facts: ALL })
  })

  test('an update attempt whose first send was refused re-sends the conflict its row records, not the re-run caller\'s', async () => {
    const c = await pending()
    const deps = { ...c.deps, showFile: async () => ({ ok: false as const, missing: true as const }) }
    // A re-run of the failed update (the same round) reuses the row; the send renders the row.
    const update = (base: string) => dispatchUpdateAttempt(deps, { executionId: c.executionId, change: 'ui', round: c.round, update: { base, files: ['src/other.ts'] } })
    const refuse = spyOn(wired.assignments, 'dispatchWithin').mockImplementationOnce(() => { throw new Error('refused once') })
    try { await expect(update(CONFLICT.base)).rejects.toThrow('refused once') } finally { refuse.mockRestore() }
    expect(c.sent()).toHaveLength(0)
    await update('a-later-base-head')
    const sent = c.sent()
    const row = c.minted().at(-1)!
    expect({ rows: c.minted().length, sent: sent.length, names: sent[0]!.instruction.includes(CONFLICT.base), later: sent[0]!.instruction.includes('a-later-base-head'), hash: sent[0]!.instruction.includes(row.manifestHash) })
      .toEqual({ rows: 1, sent: 1, names: true, later: false, hash: true })
  })

  test('a hold\'s release sends the owed row with the conflict', async () => {
    const c = await pending()
    await c.mint(true)
    expect({ sent: c.sent().length, owed: c.minted().map(entry => entry.manifest.update) }).toEqual({ sent: 0, owed: [CONFLICT] })
    await c.ticks()
    expect(sentFix(c, 2).facts).toEqual(ALL)
  })

  // @covers: plan-revision-apply › Each choice publishes or dispatches as recorded › Adapt notifies the developer
  test('a second Adapt replacing the owed D9 row carries its answers and the conflict; the replaced row is never sent', async () => {
    const c = await pending()
    await c.mint(true)
    const owed = c.minted()
    const next = await wired.approveNext(c.planId, content => ({ ...content, changes: content.changes.map(entry => (entry.change === 'ui' ? { ...entry, guidance: 'Adapt again.' } : entry)) }))
    expect(await wired.applyAs({ executionId: c.executionId, choices: { ui: 'adapt' } })).toMatchObject({ ok: true })
    const carried = c.minted().at(-1)!
    expect({ answers: carried.manifest.answers, update: carried.manifest.update, task: carried.manifest.task.revision }).toEqual({ answers: owed[0]!.manifest.answers, update: CONFLICT, task: 3 })
    await c.ticks()
    const { stamped, facts } = sentFix(c, next.revision)
    expect({ facts, replacedSent: owed[0]!.id === stamped.id || wired.executions.attempts(c.executionId, 'ui').find(entry => entry.id === owed[0]!.id)!.assignmentId !== null }).toEqual({ facts: ALL, replacedSent: false })
  })

  test('a Restart replacing the owed D9 row starts fresh: the sent fix names no conflict, which stays on the predecessor row (decision-9192a3d0)', async () => {
    const c = await pending()
    await c.mint(true)
    const owed = c.minted()[0]!
    const next = await wired.approveNext(c.planId, content => ({ ...content, changes: content.changes.map(entry => (entry.change === 'ui' ? { ...entry, guidance: 'Start over.' } : entry)) }))
    expect(await wired.applyAs({ executionId: c.executionId, choices: { ui: 'restart' } })).toMatchObject({ ok: true })
    await c.ticks()
    const { stamped, facts } = sentFix(c, next.revision)
    expect({ update: stamped.manifest.update, facts, predecessor: wired.executions.attempts(c.executionId, 'ui').find(entry => entry.id === owed.id)!.manifest.update })
      .toEqual({ update: undefined, facts: NONE, predecessor: CONFLICT })
  })

  test('an Adapt during the mint\'s git reads: the one fix names the task\'s newest revision and the conflict', async () => {
    const c = await pending()
    const next = await wired.approveNext(c.planId, content => ({ ...content, changes: content.changes.map(entry => (entry.change === 'ui' ? { ...entry, guidance: 'Adapt mid-mint.' } : entry)) }))
    const gate = latch('rev-parse')
    const mint = c.mint()
    try {
      await gate.entered
      expect(await wired.applyAs({ executionId: c.executionId, choices: { ui: 'adapt' } })).toMatchObject({ ok: true })
    } finally {
      gate.release()
      try { await mint } finally { gate.restore() }
    }
    await c.ticks()
    const { stamped, facts } = sentFix(c, next.revision)
    expect({ task: stamped.manifest.task.revision, update: stamped.manifest.update, facts }).toEqual({ task: 3, update: CONFLICT, facts: ALL })
  })

  test('a crash at the mint\'s git read writes nothing: the round stays open, and D9 re-fires to one fix', async () => {
    const c = await pending()
    const gate = latch('rev-parse', true)
    try { await expect(c.mint()).rejects.toThrow('the server stopped') } finally { gate.restore() }
    expect({ round: wired.executions.round(c.round.id)!.outcome, rows: c.minted().length, sent: c.sent().length, state: wired.executions.change(c.executionId, 'ui')!.state })
      .toEqual({ round: 'pass', rows: 0, sent: 0, state: 'gating' })
    await c.ticks()
    // The planner's revision stage re-fires; its conflict is re-derived by the next landing's update.
    sentFix(c, 2)
    expect(wired.executions.round(c.round.id)!.outcome).toBe('superseded')
  })
})
