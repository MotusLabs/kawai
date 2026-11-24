// Routing equivalence across an Apply (plan-revision-apply A3/CH3 and A7/P4,
// invariant AL2; review round 4, F7). For every attempt stamped while the
// test runs, the durable assignment's group and its mail's allowedProfiles
// are what the attempt manifest's plan revision assigns the change's route,
// the manifest's role profiles are those same profiles, and the instruction
// names that revision. The cases cross the owner's choice (Continue, Adapt,
// Restart), the field the revision changes (guidance, the role's profiles,
// the change's group), the send path (a fix after a failed round, an update
// after a failed branch update), and the git read the mint is paused at
// (`rev-parse HEAD`, `ls-tree`); each runs the real dispatch, the real Apply,
// and two real executor ticks, and asserts liveness: exactly one assignment
// goes out after the Apply and it stamps the change's newest row.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import type { PlanContent } from '../../shared/plans'
import * as git from '../git/gitCommand'
import { dispatchFixAttempt, dispatchUpdateAttempt, type DispatchDeps } from '../plans/execution/executionDispatch'
import { TaskResultService } from '../team/TaskResultService'
import { TaskService } from '../team/TaskService'
import { applyBench, type ApplyBench } from './applyBench'
import { writeGroup } from './planHarness'

let wired: ApplyBench
beforeAll(async () => { wired = await applyBench('apply-route-equivalence') })
afterAll(() => wired.close())

/** Real task, assignment, and result services over the bench stores, as the server composes them for Kawai. */
const deps = (): DispatchDeps => ({
  team: wired.world.team, executions: wired.executions, plans: wired.bench.plans,
  tasks: new TaskService(wired.bench.tasks, { getSession: id => wired.bench.records.get(id), plans: wired.bench.plans }),
  assignments: wired.assignments,
  results: new TaskResultService(wired.tasks, { getSession: id => wired.bench.records.get(id), assignments: wired.assignments }),
  showFile: async () => ({ ok: false as const, missing: true }),
})

type Pause = 'rev-parse' | 'ls-tree'
/** A latch on the mint's first git read of `at`: resolves `entered` there and waits for `release`. */
function pauseAt(at: Pause): { entered: Promise<void>; release: () => void; restore: () => void } {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const original = git.runGitAsync
  let paused = false
  const spy = spyOn(git, 'runGitAsync').mockImplementation(async (args, options) => {
    if (!paused && args[0] === at) {
      paused = true
      entered.resolve()
      await released.promise
    }
    return original(args, options)
  })
  return { entered: entered.promise, release: () => released.resolve(), restore: () => spy.mockRestore() }
}

type Choice = 'continue' | 'adapt' | 'restart'
type Field = 'guidance' | 'profiles' | 'group'
type Path = 'fix' | 'update'

const edits: Record<Field, (content: PlanContent) => PlanContent> = {
  guidance: content => ({ ...content, changes: content.changes.map(entry => (entry.change === 'ui' ? { ...entry, guidance: 'Reworded.' } : entry)) }),
  profiles: content => ({ ...content, roles: content.roles.map(role => (role.group === 'middle-devs' ? { ...role, profiles: ['opus'] } : role)) }),
  group: content => ({ ...content, changes: content.changes.map(entry => (entry.change === 'ui' ? { ...entry, group: 'senior-devs' } : entry)) }),
}

/** The route the revision assigns the change: its group (no override here) and that role's profiles. */
function routeAt(planId: string, revision: number): { group: string; profiles: string[] } {
  const content = wired.bench.plans.revision(planId, revision)!.content
  const group = content.changes.find(entry => entry.change === 'ui')!.group!
  return { group, profiles: content.roles.find(role => role.group === group)?.profiles ?? [] }
}

async function routeCase(choice: Choice, field: Field, path: Path, pause: Pause): Promise<void> {
  writeGroup(wired.world, 'middle-devs', '---\nprofiles: [default, opus]\n---\nBuild.')
  writeGroup(wired.world, 'senior-devs', '---\nprofiles: [default, opus]\n---\nBuild hard things.')
  const { planId, executionId } = await wired.running({ roles: [
    { group: 'middle-devs', profiles: ['default'] }, { group: 'senior-devs', profiles: ['opus'] }, { group: 'reviewers', profiles: [] },
  ] })
  const { taskId } = await wired.inFlightByKawai(executionId, 'ui', 'dev')
  const start = wired.executions.change(executionId, 'ui')!
  expect(wired.executions.transition(executionId, 'ui', start, { state: 'implementing', baselineCommit: 'base-sha' })).not.toBeNull()
  const roundId = wired.answerNewestRow(executionId, 'ui', 1)
  const round = wired.executions.round(roundId)!
  const now = wired.executions.change(executionId, 'ui')!
  wired.bench.db.db.prepare('UPDATE plan_execution_rounds SET outcome = ? WHERE id = ?').run(path === 'fix' ? 'fail' : 'pass', roundId)
  // A fix: the failed round, the change implementing. An update: the landing's conflict path, gating with no step.
  expect(wired.executions.transition(executionId, 'ui', now, path === 'fix'
    ? { state: 'implementing', step: null } : { state: 'gating', step: null, passedAt: null })).not.toBeNull()
  const next = await wired.approveNext(planId, edits[field])
  const rowsBefore = new Set(wired.executions.attempts(executionId, 'ui').map(entry => entry.id))
  const before = wired.tasks.store.assignmentsOf(taskId).length
  const latch = pauseAt(pause)
  const mint = path === 'fix'
    ? dispatchFixAttempt(deps(), {
      executionId, change: 'ui', group: 'middle-devs', failingChecks: [{ name: 'lint', conclusion: 'failure', link: null }], findingsIds: [],
      findings: { blocking: [], blockingText: '', others: 0, legacyTexts: [] }, continueFrom: 'round-commit', fixRounds: 1,
    })
    : dispatchUpdateAttempt(deps(), { executionId, change: 'ui', round, update: { base: 'base-head', files: ['a.ts'] } })
  try {
    await Promise.race([latch.entered, mint])
    expect(await wired.applyAs({ executionId, choices: { ui: choice } })).toMatchObject({ ok: true })
    expect(wired.executions.execution(executionId)!.revision).toBe(next.revision)
  } finally {
    latch.release()
    try { await mint } finally { latch.restore() }
  }
  const executor = wired.executor()
  await executor.tick(wired.teamId)
  await executor.tick(wired.teamId)

  const stamped = wired.executions.attempts(executionId, 'ui').filter(entry => !rowsBefore.has(entry.id) && entry.assignmentId !== null)
  expect(stamped.length).toBeGreaterThan(0)
  for (const attempt of stamped) {
    const route = routeAt(planId, attempt.manifest.plan.revision)
    const assignment = wired.tasks.store.assignmentsOf(taskId).find(entry => entry.id === attempt.assignmentId)!
    const mail = wired.bench.mail.get(assignment.messageId!)!
    expect({
      revision: attempt.manifest.plan.revision, roleProfiles: attempt.manifest.roleProfiles,
      target: `${assignment.targetKind}:${assignment.targetId}`, allowedProfiles: mail.allowedProfiles ?? [],
      namesRevision: new RegExp(`\\(revision ${attempt.manifest.plan.revision}\\)|plan revision ${attempt.manifest.plan.revision} `).test(assignment.instruction),
    }).toEqual({
      revision: next.revision, roleProfiles: route.profiles,
      target: `group:${route.group}`, allowedProfiles: route.profiles,
      namesRevision: true,
    })
  }
  // Liveness: exactly one assignment goes out after the Apply, and it is the newest row's stamp.
  const newest = wired.executions.attempts(executionId, 'ui').at(-1)!
  expect(newest.assignmentId).not.toBeNull()
  expect(wired.tasks.store.assignmentsOf(taskId).slice(before).map(entry => entry.id)).toEqual([newest.assignmentId!])
}

const CHOICES: Choice[] = ['continue', 'adapt', 'restart']
const FIELDS: Field[] = ['guidance', 'profiles', 'group']
const PATHS: Path[] = ['fix', 'update']
const PAUSES: Pause[] = ['rev-parse', 'ls-tree']

describe('every stamped attempt routes as its manifest revision assigns (F7, AL2)', () => {
  for (const choice of CHOICES) for (const field of FIELDS) for (const path of PATHS) for (const pause of PAUSES) {
    // @covers: plan-revision-apply › The execution keeps its revision history › Manifests keep their revision
    test(`AL2 ${choice} x ${field} x ${path} paused at ${pause}: group, allowedProfiles, manifest profiles and instruction name the manifest revision`, () =>
      routeCase(choice, field, path, pause))
  }
})
