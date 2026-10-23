// The composed pause tick (revision-control 4.3): the executor's `pauses`
// dependency, built by `composePlanServices` from the team services, records
// Paused through the real wiring — the same construction the server runs,
// not a hand-built pass. The facts come from the bench records (a killed
// holder reads gone), readiness from the real `MemberRelease`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { MemberRelease } from '../team/memberRelease'
import { TeamMailbox } from '../team/TeamMailbox'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TeamWorktrees } from '../team/worktreeRoots'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { ImpactService } from '../strategy/ImpactService'
import { ImpactStore } from '../strategy/impactStore'
import { composeExecutionCore, composePlanServices } from '../plans/planComposition'
import { lsRemoteHead } from '../plans/landing/gitRemote'
import { runGitChecked } from '../git/gitCommand'
import { pauseHolderFacts } from '../plans/revisionControl/pauseTick'
import type { ExecutionRuntime } from '../plans/execution/executionRuntime'
import type { ExecutionStore } from '../plans/execution/executionStore'
import type { HoldService } from '../plans/revisionControl/holdService'
import type { PauseService } from '../plans/revisionControl/pauseService'
import { PauseStore } from '../plans/revisionControl/pauseStore'
import { CheckpointStore } from '../plans/revisionControl/checkpointStore'
import type { FloorMap } from '../../shared/planExecution'
import { LEAD_ROLES } from './decisionHarness'
import { sessionRow, writeGroup, createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'

let world: PlanWorld
let bench: PlanBench
let runtime: ExecutionRuntime
let holds: HoldService
let pauses: PauseService
let store: ExecutionStore
/** A reader over the same connection: the composition's own pause rows. */
let pauseRows: PauseStore
/** A reader over the same connection: the checkpoints the resolve's restart reads. */
let checkpointRows: CheckpointStore
let planCounter = 0

const inTwoDays = (): string => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
const manifest = () => ({
  version: 1 as const, plan: { id: 'p', revision: 1, contentHash: 'h' }, execution: 'e', task: { id: 't', revision: 1 },
  validation: { reportId: 'r', inputHash: 'i' }, baseline: 'b', startCommit: 's', artifacts: {}, roleProfiles: [],
})

/** The composed stack over the bench: core, team services, and the runtime. */
async function compose(): Promise<void> {
  const core = composeExecutionCore(bench.db.db)
  const mail = (bench.tasks as unknown as { mail: MailboxStore }).mail
  const tasks = new TaskService(bench.tasks, {
    getSession: id => bench.records.get(id), homeDir: world.home,
    restoreSession: () => undefined, plans: bench.plans, ownership: core.ownership,
  })
  const releases = new MemberRelease(bench.db.db, {
    store: mail, tasks: bench.tasks,
    records: () => bench.records.values(), getRecord: id => bench.records.get(id),
    teamOf: () => world.team,
    definition: async () => undefined, cachedDefinition: () => undefined,
    recipient: () => undefined,
    hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false,
    archive: () => ({ ok: false as const, error: 'no archive in this test' }),
    notify: () => undefined,
  })
  const caps = new TeamCaps({ homeDir: world.home })
  const worktrees = new TeamWorktrees()
  const teamOf = () => world.team
  const staffing = new WorktreeStaffing(bench.db.db, mail, {
    records: () => bench.records.values(), teamOf, caps, worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  const assignments = new AssignmentService(bench.db.db, new AssignmentStore(bench.db.db, mail), bench.tasks, mail, {
    getSession: id => bench.records.get(id), records: () => bench.records.values(), teamOf,
    staffing, caps, worktrees, homeDir: world.home, plans: bench.plans, ownership: core.ownership,
  })
  const results = new TaskResultService(tasks, {
    getSession: id => bench.records.get(id), assignments,
    releases, records: () => bench.records.values(), homeDir: world.home,
    ownership: core.ownership, onWrite: taskId => core.wakes.resultWrite(taskId),
  })
  const impact = new ImpactService(new ImpactStore(bench.db.db), {
    strategies: bench.strategies, plans: bench.plans, mail, getSession: id => bench.records.get(id),
  })
  const teamMailbox = new TeamMailbox(mail, { getSession: id => bench.records.get(id), homeDir: world.home, tasks: bench.tasks })
  const composed = composePlanServices({
    db: bench.db.db, plans: bench.plans, strategies: bench.strategies, impact,
    getSession: id => bench.records.get(id),
    caps: { planExecution: async () => ({ floorChecks: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }, maxParallelChanges: 2, mergeMethod: 'merge' }) },
    executionCore: core,
    executionTeam: {
      tasks, assignments, results, taskStore: bench.tasks, mailbox: mail, teamMailbox, releases,
      pendingSpawns: () => [],
      records: () => bench.records.values(),
      identityOf: id => (id === world.team.teamId ? world.team : undefined),
      teamOfSession: teamOf,
      supervision: { holder: () => null, blocker: () => null },
      // The pause tick's holder facts (revision-control D8): bench records,
      // nothing pending or busy, no provider limit.
      pauseFacts: pauseHolderFacts({
        getRecord: id => bench.records.get(id),
        pendingRequest: () => false, hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false,
        parkedResumes: () => [], cooldownUntil: () => null,
      }),
    },
    executionValidation: {
      prepareStanding: async () => ({}),
      standing: () => ({ state: 'current', report: { id: 'rep-1', inputHash: 'ih-1', readiness: { carriedConditions: [] } } }) as never,
    },
  })
  holds = composed.holds
  pauses = composed.pauses!
  store = composed.executionStore
  pauseRows = new PauseStore(bench.db.db)
  runtime = composed.runtime!
  await runtime.start()
}

beforeAll(async () => {
  world = await createPlanWorld('kawai-pause-comp-')
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\nmax: 1\n---\nLead.')
  // The fixture plans' review group: the review-restart dispatch addresses it.
  writeGroup(world, 'reviewers', 'Review work.')
  bench = createPlanBench(world)
  await compose()
  checkpointRows = new CheckpointStore(bench.db.db)
})

afterAll(() => {
  runtime.stop()
  bench.db.close()
  fs.rmSync(world.root, { recursive: true, force: true })
})

/** An approved plan with a running execution whose change is in flight
 * (`attempt`: implementing without a checkpoint; `review`: gating/reviewing),
 * held by a live, ready holder. */
async function inFlightTarget(holder: string, stage: 'attempt' | 'review'): Promise<{ planId: string; executionId: string; taskId: string }> {
  for (const row of store.ownedChanges(world.team.teamId)) store.finishExecution(row.executionId, 'completed')
  const draft = await bench.draftInReview(LEAD_ROLES)
  const approved = await bench.approve(draft.planId, draft.revision, `approve-pause-comp-${++planCounter}`)
  if (!approved.ok) throw new Error(approved.message)
  const task = bench.tasks.create({ teamId: world.team.teamId, title: 'api work', direction: 'Build it', creator: { kind: 'human', sessionId: null } })
  const message = bench.mail.enqueue({
    teamId: world.team.teamId, toKind: 'session', toId: holder, fromKind: 'human', fromSession: null, fromGroup: null,
    originPath: world.repo, body: 'Build api.', taskId: task.id, actor: 'human',
  })
  const inserted = bench.assignmentStore.insert({
    teamId: world.team.teamId, taskId: task.id, requestKey: `rk-pause-comp-${planCounter}`, targetKind: 'session', targetId: holder,
    role: null, instruction: 'Build api.', creator: { kind: 'human', sessionId: null }, messageId: message.id,
  })
  bench.mail.claim(message.id, holder)
  bench.mail.markPushed(message.id)
  bench.mail.markDelivered(message.id)
  const execution = store.insertExecution({
    teamId: world.team.teamId, planId: draft.planId, revision: draft.revision, contentHash: 'hash-exec', reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'base', floor: { version: 1, map: {} as FloorMap },
    maxParallel: 3, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }],
  })
  store.insertAttempt({ executionId: execution.id, change: 'api', kind: 'implement', assignmentId: inserted.assignment.id, manifest: manifest(), manifestHash: 'mh' })
  const row = store.change(execution.id, 'api')!
  const implementing = store.transition(execution.id, 'api', row, { state: 'implementing', worktree: world.repo, branch: 'api-branch', taskId: task.id })
  if (!implementing) throw new Error('the transition to implementing failed')
  if (stage === 'review' && !store.transition(execution.id, 'api', implementing, { state: 'gating', step: 'reviewing' })) {
    throw new Error('the transition to reviewing failed')
  }
  if (holder !== null) bench.records.set(holder, sessionRow(holder, 'leads', world.feature))
  return { planId: draft.planId, executionId: execution.id, taskId: task.id }
}

/** Settle a message's receipt the transcript would (the push and its acknowledgement). */
function settleReceipt(messageId: string, holder: string): void {
  bench.mail.claim(messageId, holder)
  bench.mail.markPushed(messageId)
  bench.mail.markDelivered(messageId)
}

describe('the composed pause tick (revision-control 4.3)', () => {
  test('the wired executor records Paused for a ready review holder after the wake', async () => {
    const holder = 'comp-dev'
    const { planId, executionId } = await inFlightTarget(holder, 'review')
    const placed = holds.place(bench.human, {
      planId, scope: 'changes', rationale: 'rethink the direction', deadline: inTwoDays(), cites: null,
      commandId: 'pause-comp-hold-1', changes: ['api'],
    })
    if (!placed.ok) throw new Error(placed.message)
    const paused = await pauses.pause(bench.human, { planId, holdId: placed.result!.hold.id, deadline: inTwoDays(), commandId: 'pause-comp-1' })
    if (!paused.ok) throw new Error(paused.message)
    const target = pauseRows.target(paused.result!.pause.id, 'api')!
    expect(target.pausedAt).toBeNull()
    // The pause mail reached its holder: awaiting-delivery and member
    // release's waiting-mail reason both clear.
    settleReceipt(target.messageId!, holder)
    runtime.command(world.team.teamId)
    await runtime.idle()
    expect(pauseRows.target(paused.result!.pause.id, 'api')!.pausedAt).not.toBeNull()
    expect(store.execution(executionId)!.state).toBe('running')
  })

  test('a killed holder with nothing on origin stays Pausing through the wiring', async () => {
    const { planId } = await inFlightTarget('comp-gone', 'attempt')
    bench.records.delete('comp-gone')
    const placed = holds.place(bench.human, {
      planId, scope: 'changes', rationale: 'rethink the direction', deadline: inTwoDays(), cites: null,
      commandId: 'pause-comp-hold-2', changes: ['api'],
    })
    if (!placed.ok) throw new Error(placed.message)
    const paused = await pauses.pause(bench.human, { planId, holdId: placed.result!.hold.id, deadline: inTwoDays(), commandId: 'pause-comp-2' })
    if (!paused.ok) throw new Error(paused.message)
    runtime.command(world.team.teamId)
    await runtime.idle()
    // The facts the composition wires read the bench records: a missing
    // record is killed, its unpushed review work never records Paused.
    expect(pauseRows.target(paused.result!.pause.id, 'api')!.pausedAt).toBeNull()
  })
})

// The composed resolve's head read (revision-control A3.2, lead ruling L3):
// the composition wires `adaptHead` to origin through the executor's own
// adapter (lsRemoteHead) — the adapted fix row starts from origin's true
// head and dispatches inline, and a read that fails is refused
// `head-unreadable` with nothing written (K7). This runs the real wiring —
// the same construction the server runs, not a hand-built seam.
describe('the composed resolve reads origin (L3, A3.2)', () => {
  /** The pause-and-Paused world over one change, holds returned for the release. */
  async function pausedTarget(planIndex: number): Promise<{ planId: string; executionId: string; taskId: string; holdId: string; pauseId: string }> {
    const holder = `comp-adapt-${planIndex}`
    const built = await inFlightTarget(holder, 'attempt')
    const placed = holds.place(bench.human, {
      planId: built.planId, scope: 'changes', rationale: 'rethink the direction', deadline: inTwoDays(), cites: null,
      commandId: `pause-comp-hold-adapt-${planIndex}`, changes: ['api'],
    })
    if (!placed.ok) throw new Error(placed.message)
    const paused = await pauses.pause(bench.human, { planId: built.planId, holdId: placed.result!.hold.id, deadline: inTwoDays(), commandId: `pause-comp-adapt-${planIndex}` })
    if (!paused.ok) throw new Error(paused.message)
    if (!pauseRows.recordPaused(paused.result!.pause.id, 'api', null).written) throw new Error('recording Paused wrote nothing')
    return { ...built, holdId: placed.result!.hold.id, pauseId: paused.result!.pause.id }
  }

  test("the adapted fix row starts from origin's head and dispatches inline through the composition", async () => {
    // A real origin: world.repo (the harness's own repo) gains a bare
    // origin, and the change's branch is pushed so ls-remote reads a head.
    const bare = path.join(world.root, 'origin.git')
    runGitChecked(['init', '--bare', bare])
    fs.writeFileSync(path.join(world.repo, 'seed.txt'), 'seed\n')
    runGitChecked(['add', 'seed.txt'], { cwd: world.repo })
    runGitChecked(['-c', 'user.email=seed@example.test', '-c', 'user.name=Seed', 'commit', '-m', 'seed'], { cwd: world.repo })
    runGitChecked(['remote', 'add', 'origin', bare], { cwd: world.repo })
    runGitChecked(['push', 'origin', 'HEAD:refs/heads/api-branch'], { cwd: world.repo })
    const read = await lsRemoteHead(world.repo, 'refs/heads/api-branch')
    if (!read.ok || read.sha === null) throw new Error('the fixture origin has no head to read')
    const world_ = await pausedTarget(1)
    const row = store.change(world_.executionId, 'api')!
    expect(store.transition(world_.executionId, 'api', row, { baselineCommit: read.sha })).not.toBeNull()
    // The inline arm: the hold releases before the resolve, so the gate —
    // read after the decision — is open.
    const released = holds.release(bench.human, { planId: world_.planId, holdId: world_.holdId, reason: 'the dispatch may go', commandId: 'pause-comp-release-adapt-1' })
    if (!released.ok) throw new Error(released.message)
    const resolved = await pauses.resolve(bench.human, { planId: world_.planId, pauseId: world_.pauseId, change: 'api', choice: 'adapt', adapt: 'Build it wider', rationale: 'scope grew', releaseHold: false, commandId: 'pause-comp-resolve-adapt-1' })
    if (!resolved.ok) throw new Error(resolved.message)
    const attempts = store.attempts(world_.executionId, 'api')
    expect(attempts).toHaveLength(2)
    expect(attempts[1].kind).toBe('fix')
    // L3/B5: the manifest's start commit is origin's head — the wired seam,
    // never the newest attempt's stale one ('s').
    expect(attempts[1].manifest.startCommit).toBe(read.sha)
    // M1: the inline dispatch through the composed AssignmentService.
    expect(attempts[1].assignmentId).not.toBeNull()
    const assignment = bench.assignmentStore.byId(attempts[1].assignmentId!)
    expect(assignment?.requestKey).toBe(`exec:${world_.executionId}:api:attempt:2:${store.change(world_.executionId, 'api')!.generation}`)
  })

  test('an origin the git read cannot reach refuses head-unreadable with nothing written (K7)', async () => {
    // The remote now dangles: the pre-transaction read fails and nothing
    // enters the transaction.
    runGitChecked(['remote', 'set-url', 'origin', path.join(world.root, 'gone.git')], { cwd: world.repo })
    const world_ = await pausedTarget(2)
    const refused = await pauses.resolve(bench.human, { planId: world_.planId, pauseId: world_.pauseId, change: 'api', choice: 'adapt', adapt: 'Build it wider', rationale: 'scope grew', releaseHold: false, commandId: 'pause-comp-resolve-k7-1' })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.reason).toBe('head-unreadable')
      expect(refused.message).toMatch(/origin's branch head/)
    }
    expect(store.attempts(world_.executionId, 'api')).toHaveLength(1)
    expect(bench.tasks.revisions(world_.taskId)).toHaveLength(1)
  })

  test("the restarted attempt row starts from origin's head and dispatches inline through the composition (rev4 §10 step 5)", async () => {
    // The K7 test dangled the remote; point it back at the fixture bare
    // origin and refresh the change's branch head.
    const bare = path.join(world.root, 'origin.git')
    runGitChecked(['remote', 'set-url', 'origin', bare], { cwd: world.repo })
    runGitChecked(['push', 'origin', 'HEAD:refs/heads/api-branch'], { cwd: world.repo })
    const read = await lsRemoteHead(world.repo, 'refs/heads/api-branch')
    if (!read.ok || read.sha === null) throw new Error('the fixture origin has no head to read')
    const world_ = await pausedTarget(3)
    const row = store.change(world_.executionId, 'api')!
    expect(store.transition(world_.executionId, 'api', row, { baselineCommit: read.sha })).not.toBeNull()
    // The inline arm: the hold releases before the resolve, so the gate —
    // read after the decision — is open.
    const released = holds.release(bench.human, { planId: world_.planId, holdId: world_.holdId, reason: 'the dispatch may go', commandId: 'pause-comp-release-restart-1' })
    if (!released.ok) throw new Error(released.message)
    const resolved = await pauses.resolve(bench.human, { planId: world_.planId, pauseId: world_.pauseId, change: 'api', choice: 'restart', rationale: 'rethink', releaseHold: false, commandId: 'pause-comp-resolve-restart-1' })
    if (!resolved.ok) throw new Error(resolved.message)
    const attempts = store.attempts(world_.executionId, 'api')
    expect(attempts).toHaveLength(2)
    expect(attempts[1].kind).toBe('implement')
    // L3's seam serves restart too: the start commit is origin's true head,
    // never the newest attempt's stale one ('s').
    expect(attempts[1].manifest.startCommit).toBe(read.sha)
    expect(attempts[1].manifest.checkpoint).toBeUndefined()
    // M1: the inline dispatch through the composed AssignmentService, with
    // D5's may-predates note (nothing of this pause reached origin).
    expect(attempts[1].assignmentId).not.toBeNull()
    const assignment = bench.assignmentStore.byId(attempts[1].assignmentId!)
    expect(assignment?.requestKey).toBe(`exec:${world_.executionId}:api:attempt:2:${store.change(world_.executionId, 'api')!.generation}`)
    const instruction = bench.mail.get(assignment?.messageId ?? '')
    expect(instruction?.body).toContain('Kawai restarted this work')
    expect(instruction?.body).toContain('may predate')
    // R2's release bookkeeping through the production seams
    // (restartReleaseSeams): the holder's record reads not spawned, so the
    // decision releases never.
    const target = pauseRows.target(world_.pauseId, 'api')!
    expect(target.decision).toBe('restart')
    expect(target.decisionDetail).toMatchObject({ holder: 'comp-adapt-3', release: 'never' })
  })
})

// The released restart's owed review handoff (revision-control 4.5 LC1,
// H1r): the full composition — the resolve marks the debt (`review-restart`
// and the cleared pointer), the hold's release unblocks the planner, and the
// tick dispatches the one fresh handoff through the composed seam. The unit
// suites force the arms piecewise; this runs the production path whole.
describe('the released restart dispatches the owed review handoff (LC1, H1r)', () => {
  /** A paused review cell whose round settled (push, PR done), whose review handoff is out and claimed, and whose reviewer's notes are recorded. */
  async function pausedReviewCell(planIndex: number): Promise<{ planId: string; executionId: string; taskId: string; pauseId: string; holdId: string; roundId: string; handoffId: string }> {
    const holder = `comp-rev-${planIndex}`
    const built = await inFlightTarget(holder, 'review')
    // LC3: the round result's author carries a profile, so the restarted
    // handoff's tags name it.
    bench.records.set(holder, { ...sessionRow(holder, 'leads', world.feature), claudeProfileId: 'glm' })
    const result = bench.tasks.results.insert({
      teamId: world.team.teamId, taskId: built.taskId, summary: 'done', commit: 'round-commit', diff: null, worktree: null,
      tests: [], limitations: null, taskRevision: 1, submittedBy: { kind: 'agent', sessionId: holder },
    })
    const { round } = store.insertRound({ executionId: built.executionId, change: 'api', attemptId: store.attempts(built.executionId, 'api')[0]!.id, resultId: result.id, commitSha: 'round-commit', fixRound: false })
    // insertRound returns the change to `gating` with no step (D9); the
    // review dispatch re-applies `reviewing`, as the production round stage
    // does.
    const gating = store.change(built.executionId, 'api')!
    if (!store.transition(built.executionId, 'api', gating, { state: 'gating', step: 'reviewing' })) throw new Error('the transition to reviewing failed')
    // The round's push and PR settled — their done effects' handlers write
    // these in production; the fixture inserts the settled rows.
    bench.db.db.prepare('UPDATE plan_execution_rounds SET pushed_at = ? WHERE id = ?').run(new Date().toISOString(), round.id)
    const pr = store.insertEffect({ executionId: built.executionId, change: 'api', roundId: round.id, kind: 'open-pr', effectKey: `${built.executionId}:api:open-pr:1:comp-${planIndex}`, command: {} })
    store.setEffectOutcome(pr.id, { state: 'done', outcome: { number: 1, url: 'https://example.test/pr/1', openedByKawai: true }, error: null })
    // The production review cell: the round's handoff is out and claimed by
    // a reviewer session — the assignment the held restart drops.
    bench.records.set('comp-reviewer', sessionRow('comp-reviewer', 'reviewers', world.feature))
    const reviewMail = bench.mail.enqueue({
      teamId: world.team.teamId, toKind: 'group', toId: 'reviewers', fromKind: 'system', fromSession: null, fromGroup: null,
      originPath: world.repo, body: `Review the result ${result.id} of change "api".`, taskId: built.taskId, actor: 'system',
    })
    const reviewAssignment = bench.assignmentStore.insert({
      teamId: world.team.teamId, taskId: built.taskId, requestKey: `exec:${built.executionId}:api:round:1:review:1-comp-${planIndex}`, targetKind: 'group', targetId: 'reviewers',
      role: null, instruction: 'Review.', creator: { kind: 'human', sessionId: null }, messageId: reviewMail.id,
    })
    settleReceipt(reviewMail.id, 'comp-reviewer')
    store.setRoundReview(round.id, reviewAssignment.assignment.id)
    const placed = holds.place(bench.human, {
      planId: built.planId, scope: 'changes', rationale: 'rethink the direction', deadline: inTwoDays(), cites: null,
      commandId: `pause-comp-hold-rev-${planIndex}`, changes: ['api'],
    })
    if (!placed.ok) throw new Error(placed.message)
    const paused = await pauses.pause(bench.human, { planId: built.planId, holdId: placed.result!.hold.id, deadline: inTwoDays(), commandId: `pause-comp-rev-${planIndex}` })
    if (!paused.ok) throw new Error(paused.message)
    checkpointRows.insert({
      executionId: built.executionId, change: 'api', pauseId: paused.result!.pause.id, attemptId: null, sessionId: 'comp-reviewer',
      kind: 'notes', commitSha: null, baselineCommit: null, manifestHash: null, resultId: null,
      summary: 'the review notes', unfinished: null, errorsTests: null, nextSteps: 'none', effectId: null,
    })
    const target = pauseRows.target(paused.result!.pause.id, 'api')!
    settleReceipt(target.messageId!, 'comp-reviewer')
    runtime.command(world.team.teamId)
    await runtime.idle()
    if (pauseRows.target(paused.result!.pause.id, 'api')!.pausedAt === null) throw new Error('the fixture pause never recorded Paused')
    return { ...built, pauseId: paused.result!.pause.id, holdId: placed.result!.hold.id, roundId: round.id, handoffId: reviewAssignment.assignment.id }
  }

  test('the resolve marks the debt; the release dispatches it once through the tick', async () => {
    const built = await pausedReviewCell(4)
    const resolved = await pauses.resolve(bench.human, { planId: built.planId, pauseId: built.pauseId, change: 'api', choice: 'restart', rationale: 'rethink', releaseHold: false, commandId: 'pause-comp-resolve-rev-restart-1' })
    if (!resolved.ok) throw new Error(resolved.message)
    // Held: the round's pointer drops off the superseded handoff and the
    // step marks the owed handoff — the debt is stored state.
    expect(store.round(built.roundId)!.reviewAssignmentId).toBeNull()
    expect(store.change(built.executionId, 'api')!.step).toBe('review-restart')
    expect(bench.assignmentStore.byId(built.handoffId)?.supersededBy).not.toBeNull()
    // The release unblocks the planner; the tick dispatches the debt.
    const released = holds.release(bench.human, { planId: built.planId, holdId: built.holdId, reason: 'the dispatch may go', commandId: 'pause-comp-release-rev-1' })
    if (!released.ok) throw new Error(released.message)
    runtime.command(world.team.teamId)
    await runtime.idle()
    const round = store.round(built.roundId)!
    expect(round.reviewAssignmentId).not.toBeNull()
    expect(round.reviewAssignmentId).not.toBe(built.handoffId)
    const handoff = bench.assignmentStore.byId(round.reviewAssignmentId!)
    expect(handoff?.requestKey).toMatch(/:review:\d+:restart$/)
    expect(store.change(built.executionId, 'api')!.step).toBe('reviewing')
    const instruction = bench.mail.get(handoff?.messageId ?? '')
    expect(instruction?.toKind).toBe('group')
    expect(instruction?.toId).toBe('reviewers')
    expect(instruction?.tags).toContain('author-profile:glm')
    expect(instruction?.body).toContain('restarted by the owner')
    expect(instruction?.body).toContain(checkpointRows.newest(built.pauseId, 'api')!.id)
  })
})
