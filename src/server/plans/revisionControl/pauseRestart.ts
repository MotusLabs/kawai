// The resolve's restart choice (revision-control 4.4-4.5, design D9's
// R-rows, rev4 §10 step 5): the owner restarts a target's work from its
// checkpoint when one of THIS pause target's own checkpoints reached origin
// (D5), else from origin's branch head with the may-predates note. Unlike
// 'continue' it accepts a still-pausing target (R10-R15), a withdrawn one
// (R9/R15), and a gone holder (R16); unlike 'adapt' it publishes nothing —
// the new row's manifest names the task's newest revision — and a review
// target takes R17/R18r: the decision and the release bookkeeping, and for
// R18r ONE new review handoff of the same round under its own fresh request
// key (D4). The ROUND RULE's supersede is conditional here, as in Continue:
// the newest passable round only when it pins an older revision than the
// task's newest (R5/R8/R22r no drop; R19r/R20r/R23r supersede).
import { createHash } from 'node:crypto'
import { PlanRefusal } from '../planCommands'
import type { PlanCaller } from '../PlanService'
import type { PlanStore } from '../planStore'
import type { PlanChange, PlanContent } from '../../../shared/plans'
import type { ChangeRow, ExecutionRow } from '../execution/executionRows'
import type { ExecutionStore } from '../execution/executionStore'
import type { AttemptKind, AttemptManifest } from '../../../shared/planExecution'
import { manifestHashInput } from '../../../shared/planExecution'
import { revisionPending, type ReviewRestartSeam } from '../execution/executionRounds'
import { dispatchRestartedAttemptWithin, dispatchRestartedReviewWithin } from '../execution/executionRestartDispatch'
import { handoffInstruction } from '../../team/TaskResultService'
import type { AssignmentService } from '../../team/AssignmentService'
import type { TaskService } from '../../team/TaskService'
import type { MemberRelease } from '../../team/memberRelease'
import { holdGate, type OpenPauseTarget } from './holdGate'
import type { ActiveHold, PlanPause, PlanPauseTarget } from '../../../shared/planRevisionControl'
import type { PauseServiceDeps } from './pauseService'
import type { PauseStore } from './pauseStore'
import type { CheckpointStore } from './checkpointStore'
import { recordResolution, supersedeHeldAssignment, type AdaptHeadFacts, type ResolveInput, ResolveRefusal } from './pauseResolve'

/**
 * The production wiring of R2's release seams (planComposition): the team's
 * MemberRelease behind the structural dep, and the holder's session-record
 * facts from the manager's session lookup. A session the records list no
 * more reads null — the gone holder releases never (R16).
 */
export function restartReleaseSeams(releases: MemberRelease, getSession: (id: string) => { spawned?: boolean; archivedAt?: string | null } | null | undefined): Pick<PauseServiceDeps, 'releases' | 'holderRecord'> {
  return {
    releases: {
      readiness: sessionId => releases.readiness(sessionId),
      releaseNow: (sessionId, detail) => releases.releaseNow(sessionId, detail),
      markPending: (sessionId, reason) => releases.markPending(sessionId, reason),
    },
    holderRecord: id => {
      const record = getSession(id)
      return record === undefined || record === null ? null : { spawned: record.spawned === true, archivedAt: record.archivedAt ?? null }
    },
  }
}

/** The release half of the decision detail (R2), computed before the decision write. */
interface ReleaseBookkeeping { holder: string | null; release: 'now' | 'pending' | 'never' }

/**
 * R2's release bookkeeping (rev4 §4): a spawned holder MemberRelease.readiness
 * calls ready releases after the resolve's commit (releaseRestartedHolder in
 * pauseResolve); a busy one is marked pending release here, inside the
 * transaction; a human-created or archived holder, a gone one, and an
 * unwired seam release never — fail-closed.
 */
function releaseBookkeeping(deps: PauseServiceDeps, target: PlanPauseTarget): ReleaseBookkeeping {
  const holder = target.holderSession
  if (holder === null || deps.releases === undefined || deps.holderRecord === undefined) return { holder, release: 'never' }
  const record = deps.holderRecord(holder)
  if (record === null || record.archivedAt !== null || !record.spawned) return { holder, release: 'never' }
  const readiness = deps.releases.readiness(holder)
  if (readiness.ready) return { holder, release: 'now' }
  deps.releases.markPending(holder, `paused change ${target.change} restarted while the holder was busy (${readiness.reason ?? 'not ready'})`)
  return { holder, release: 'pending' }
}

/** The gate read every dispatch arm shares (R2, R18r): after the decision, so this target no longer closes it. */
function dispatchGateOpen(deps: PauseServiceDeps, caller: PlanCaller & { kind: 'human' }, pause: PlanPause, change: string): boolean {
  if (deps.assignmentService === undefined) return false
  const holds: ActiveHold[] = deps.holds.active(caller.team.teamId, pause.planId)
    .map(hold => ({ id: hold.id, scope: hold.scope, changes: hold.changes }))
  const openTargets: OpenPauseTarget[] = deps.pauses.forPlan(caller.team.teamId, pause.planId, true).flatMap(open =>
    deps.pauses.targets(open.id).map(row => ({ pauseId: open.id, change: row.change, decision: row.decision })))
  return holdGate(holds, openTargets, change) === null
}

/** The plan revision and the change's entry, read for the manifest and the dispatch group (the adapt shape). */
function revisionEntryOf(deps: PauseServiceDeps, pause: PlanPause, execution: ExecutionRow, change: string): { entry: PlanChange; content: PlanContent } {
  const revision = deps.plans.revision(pause.planId, execution.revision)
  const entry = revision?.content.changes.find(candidate => candidate.change === change)
  if (revision === null || revision === undefined || entry === undefined) {
    throw new PlanRefusal('state', `The plan revision of change ${change} is missing; nothing was written.`)
  }
  return { entry, content: revision.content }
}

/**
 * The restart choice's stage branch (D9): the release bookkeeping runs
 * before the decision — the detail records it — then the review branch
 * (R17/R18r) or the attempt branch (R2-R8, R10-R16, R19r-R23r).
 */
export function restartTarget(deps: PauseServiceDeps, caller: PlanCaller & { kind: 'human' }, input: ResolveInput,
  pause: PlanPause, target: PlanPauseTarget, changeRow: ChangeRow, task: { id: string; revision: number },
  head: AdaptHeadFacts | null | undefined): { target: { change: string; decision: string } } {
  const execution = deps.executions.execution(pause.executionId)
  if (execution === null) throw new PlanRefusal('not-found', `The execution of pause ${pause.id} is missing.`)
  const release = releaseBookkeeping(deps, target)
  if (target.stage === 'review') return restartReview(deps, caller, input, pause, target, task, release)
  return restartAttempt(deps, caller, input, pause, target, changeRow, task, execution, head, release)
}

/**
 * R2-R21r: the attempt target's restart, in §4's order — the decision, the
 * ROUND RULE's conditional supersede, the held assignment's stop branch,
 * O4's redispatch clear, then ONE new attempt row and its dispatch per the
 * hold. No publication: the manifest names the task's newest revision. No
 * state move except the ROUND RULE's state-conditional slot release — an
 * update target stays `gating` with step null and passedAt null (R21r).
 */
function restartAttempt(deps: PauseServiceDeps, caller: PlanCaller & { kind: 'human' }, input: ResolveInput,
  pause: PlanPause, target: PlanPauseTarget, changeRow: ChangeRow, task: { id: string; revision: number },
  execution: ExecutionRow, head: AdaptHeadFacts | null | undefined, release: ReleaseBookkeeping): { target: { change: string; decision: string } } {
  const tasks = deps.tasks!
  recordResolution(deps, input, pause, target, 'restart', { holder: release.holder, release: release.release, assignmentId: target.assignmentId })
  const passable = deps.executions.rounds(pause.executionId, target.change)
    .filter(round => round.outcome === null || round.outcome === 'pass').at(-1)
  if (passable !== undefined && revisionPending({ tasks }, task.id, passable)) {
    deps.executions.supersedeRound(passable.id)
    deps.executions.cancelLiveRoundEffects(pause.executionId, passable.id)
    const fresh = deps.executions.change(pause.executionId, target.change)
    if (fresh !== null && fresh.state === 'landing') {
      deps.executions.transition(pause.executionId, target.change, fresh, { state: 'implementing', step: null })
    }
  }
  supersedeHeldAssignment(deps, pause, target)
  // O4: a pending `redispatch` step clears in the resolution's transaction —
  // the restart supersedes the holder's instruction, so no :retry: re-send
  // follows it.
  const after = deps.executions.change(pause.executionId, target.change)
  if (after !== null && after.step === 'redispatch') {
    deps.executions.transition(pause.executionId, target.change, after, { step: null })
  }
  // D5's containment read (F4): THIS pause target's own newest checkpoint —
  // keyed by the pause id, never an earlier pause's — counts as on origin
  // when its kind is `result`, or a `commit` whose push effect settled done
  // (the rule workOnOrigin applies to recording Paused). A failed or unknown
  // push is not on origin (R12); a killed holder never left one (U8, R13).
  const checkpoint = deps.checkpoints!.newest(pause.id, target.change)
  const effect = checkpoint !== null && checkpoint.effectId !== null
    ? deps.executions.effectsOf(pause.executionId).find(entry => entry.id === checkpoint.effectId) ?? null
    : null
  const contained = checkpoint !== null && checkpoint.commitSha !== null
    && (checkpoint.kind === 'result' || (checkpoint.kind === 'commit' && effect?.state === 'done'))
    ? { id: checkpoint.id, commit: checkpoint.commitSha }
    : null
  // K7 (L3, rev4 §10): the pre-transaction head read refuses here — after
  // every earlier refusal — whatever a contained checkpoint supplies. The
  // design's K7 row has no checkpoint exception (LC2): the resolution is
  // not accepted on an origin Kawai could not read.
  const facts = head ?? null
  if (facts !== null && !facts.ok) {
    throw new ResolveRefusal('head-unreadable', `Change ${target.change}'s pre-transaction read of origin's branch head failed; nothing was written. Resolve again once the git read succeeds.`)
  }
  const newest = deps.executions.attempts(pause.executionId, target.change).at(-1) ?? null
  const startCommit = contained !== null ? contained.commit
    : facts !== null && facts.ok ? facts.startCommit
    : newest?.manifest.startCommit ?? changeRow.baselineCommit
  if (startCommit === null) throw new PlanRefusal('state', `Change ${target.change} has no start commit; nothing was written.`)
  const { entry, content } = revisionEntryOf(deps, pause, execution, target.change)
  const kind: AttemptKind = newest?.kind ?? 'implement'
  const manifest: AttemptManifest = {
    version: 1,
    plan: { id: execution.planId, revision: execution.revision, contentHash: execution.contentHash },
    execution: execution.id,
    task: { id: task.id, revision: task.revision },
    validation: { reportId: execution.reportId, inputHash: execution.inputHash },
    baseline: changeRow.baselineCommit ?? '',
    startCommit,
    artifacts: facts !== null && facts.ok ? facts.artifacts : {},
    roleProfiles: content.roles.find(role => role.group === entry.group)?.profiles ?? [],
    ...(newest?.manifest.answers !== undefined ? { answers: newest.manifest.answers } : {}),
    ...(newest?.manifest.update !== undefined ? { update: newest.manifest.update } : {}),
    ...(contained !== null ? { checkpoint: contained } : {}),
  }
  const manifestHash = createHash('sha256').update(manifestHashInput(manifest)).digest('hex')
  const attempt = deps.executions.insertAttempt({
    executionId: pause.executionId, change: target.change, kind, assignmentId: null, manifest, manifestHash,
  })
  if (dispatchGateOpen(deps, caller, pause, target.change)) {
    const afterRow = deps.executions.change(pause.executionId, target.change)
    if (afterRow !== null) {
      dispatchRestartedAttemptWithin({
        team: caller.team, execution, changeRow: afterRow, entry, content,
        planTitle: deps.plans.get(pause.planId)?.title ?? pause.planId,
        taskId: task.id, kind, attempt: { id: attempt.id, number: attempt.number, manifestHash },
        manifest, startCommit, checkpoint: contained,
        executions: deps.executions, assignments: deps.assignmentService!,
      })
    }
  }
  return { target: { change: target.change, decision: 'restart' } }
}

/**
 * R17/R18r: the review target's restart. The handoff-standing condition does
 * not restrict it (Q-A2) — a superseded handoff is exactly the state a
 * stale review's restart re-dispatches, so C13's refusal has no restart
 * twin. R17 (H5 exception): a passable round pending a task revision records
 * `revisionPending N` and dispatches nothing — D9's own revision flow (H2)
 * dispatches the round's fix after the decision. R18r: ONE new review
 * handoff — same round, same result, same head commit — under its own fresh
 * request key (the superseded handoff's key would replay it), the
 * instruction naming the paused reviewer's recorded notes' id when one
 * exists; no attempt row and no manifest (D9's steps 6-7 apply to attempts
 * only, D4). Under a still-closed gate the handoff is owed, not dropped:
 * the round's pointer is cleared and the change's `review-restart` step
 * marks the debt for the planner's release dispatch (LC1).
 */
function restartReview(deps: PauseServiceDeps, caller: PlanCaller & { kind: 'human' }, input: ResolveInput,
  pause: PlanPause, target: PlanPauseTarget, task: { id: string; revision: number }, release: ReleaseBookkeeping): { target: { change: string; decision: string } } {
  const newestRound = deps.executions.rounds(pause.executionId, target.change).at(-1) ?? null
  const pending = newestRound !== null && revisionPending({ tasks: deps.tasks! }, task.id, newestRound)
  const detail: Record<string, unknown> = { holder: release.holder, release: release.release, assignmentId: target.assignmentId }
  if (pending) detail.revisionPending = task.revision
  recordResolution(deps, input, pause, target, 'restart', detail)
  supersedeHeldAssignment(deps, pause, target)
  if (pending || newestRound === null || !dispatchGateOpen(deps, caller, pause, target.change)) {
    // LC1's held arm: the closed gate kept the dispatch from running, so the
    // round's stale pointer is dropped — nothing may wait on the superseded
    // handoff — and the change's step marks the one owed handoff, which the
    // planner dispatches once on release (the `review-restart` stage). A
    // pending round keeps its pointer: the revision flow owns it (R17), and
    // the planner's revision stage preempts this step.
    if (!pending && newestRound !== null) {
      deps.executions.clearRoundReview(newestRound.id)
      const heldRow = deps.executions.change(pause.executionId, target.change)
      if (heldRow !== null && heldRow.step === 'reviewing') {
        deps.executions.transition(pause.executionId, target.change, heldRow, { step: 'review-restart' })
      }
    }
    return { target: { change: target.change, decision: 'restart' } }
  }
  const execution = deps.executions.execution(pause.executionId)
  if (execution === null) throw new PlanRefusal('not-found', `The execution of pause ${pause.id} is missing.`)
  const revision = deps.plans.revision(pause.planId, execution.revision)
  const entry = revision?.content.changes.find(candidate => candidate.change === target.change)
  const reviewGroup = entry?.reviewGroup ?? revision?.content.reviewGroup ?? null
  if (revision === null || revision === undefined || reviewGroup === null) return { target: { change: target.change, decision: 'restart' } }
  const result = deps.tasks!.store.results.get(newestRound.resultId)
  if (result === null) return { target: { change: target.change, decision: 'restart' } }
  const changeRow = deps.executions.change(pause.executionId, target.change)
  const notes = deps.checkpoints!.newest(pause.id, target.change)
  const roleProfiles = revision.content.roles.find(role => role.group === reviewGroup)?.profiles ?? []
  const instruction = handoffInstruction('review', result, reviewRestartInstruction({
    change: target.change, round: newestRound, taskId: task.id, execution,
    prUrl: changeRow?.prUrl ?? null, notesId: notes?.kind === 'notes' ? notes.id : null,
    acceptance: [...entry?.acceptance ?? [], ...revision.content.acceptanceRules],
  }), null)
  // The execution-origin caller is minted in the execution module (D2's
  // boundary); the pause side composes only the instruction and the key.
  const assignmentId = dispatchRestartedReviewWithin({
    team: caller.team, execution, reviewGroup, taskId: task.id, instruction,
    requestKey: `exec:${execution.id}:${target.change}:round:${newestRound.number}:review:${changeRow?.generation ?? 0}:restart`,
    resultId: newestRound.resultId, allowedProfiles: roleProfiles,
    assignments: deps.assignmentService!,
  })
  deps.executions.setRoundReview(newestRound.id, assignmentId)
  return { target: { change: target.change, decision: 'restart' } }
}

/** R18r's handoff text: the same round and result under a fresh handoff, with the recorded notes' id when one exists. */
function reviewRestartInstruction(input: {
  change: string
  round: { number: number; resultId: string; commitSha: string; ci: Array<{ name: string; conclusion: string }> | null }
  taskId: string
  execution: { id: string; planId: string; revision: number }
  prUrl: string | null
  notesId: string | null
  acceptance: string[]
}): string {
  const checks = (input.round.ci ?? []).map(check => `${check.name}: ${check.conclusion}`).join(', ')
  return [
    `Review the result ${input.round.resultId} of change "${input.change}" (round ${input.round.number}, commit ${input.round.commitSha}).`,
    input.prUrl !== null ? `Pull request: ${input.prUrl}` : null,
    `The review was restarted by the owner: the paused reviewer's handoff was superseded; this is the same round and result under a fresh handoff.`,
    `CI: ${checks || 'none reported'}`,
    input.notesId !== null ? `The paused reviewer's recorded notes are checkpoint ${input.notesId}.` : null,
    input.acceptance.length > 0 ? `Acceptance rules:\n${input.acceptance.map(rule => `- ${rule}`).join('\n')}` : null,
    `Submit your verdict with task_submit_findings on task ${input.taskId} for result ${input.round.resultId}: pass or fail, with what you checked.`,
    'You are the independent reviewer: if you authored one of this change\'s results, do not review it — say so in a message to the Lead group instead.',
  ].filter(line => line !== null).join('\n\n') + `\n\nExecution ${input.execution.id} of plan ${input.execution.planId} at revision ${input.execution.revision}.`
}

/**
 * The production wiring of the owed review-restart stage (LC1): the newest
 * restart decision standing for the change names the pause whose recorded
 * notes ride the instruction, and the dispatch goes through the execution
 * module's `dispatchRestartedReviewWithin` — the execution-origin caller is
 * minted there, D2's boundary. `null` (no standing restart decision, or a
 * missing fact) leaves the stage due with the step still marking the debt.
 */
export function reviewRestartSeam(input: {
  pauses: Pick<PauseStore, 'forPlan' | 'targets'>
  checkpoints: CheckpointStore
  executions: Pick<ExecutionStore, 'execution' | 'change'>
  plans: PlanStore
  tasks: TaskService
  assignments: Pick<AssignmentService, 'dispatchWithin'>
}): ReviewRestartSeam {
  return async ({ team, changeRow, round }) => {
    const execution = input.executions.execution(changeRow.executionId)
    if (execution === null) return null
    const restart = input.pauses.forPlan(team.teamId, execution.planId, false)
      .flatMap(pause => input.pauses.targets(pause.id).map(target => ({ pauseId: pause.id, target })))
      .filter(entry => entry.target.change === changeRow.change && entry.target.decision === 'restart')
      .at(-1) ?? null
    if (restart === null) return null
    const notes = input.checkpoints.newest(restart.pauseId, changeRow.change)
    const result = input.tasks.store.results.get(round.resultId)
    if (result === null) return null
    const revision = input.plans.revision(execution.planId, execution.revision)
    const entry = revision?.content.changes.find(candidate => candidate.change === changeRow.change)
    const reviewGroup = entry?.reviewGroup ?? revision?.content.reviewGroup ?? null
    if (revision === null || revision === undefined || reviewGroup === null) return null
    const row = input.executions.change(changeRow.executionId, changeRow.change)
    const instruction = handoffInstruction('review', result, reviewRestartInstruction({
      change: changeRow.change, round, taskId: changeRow.taskId, execution,
      prUrl: row?.prUrl ?? null, notesId: notes?.kind === 'notes' ? notes.id : null,
      acceptance: [...entry?.acceptance ?? [], ...revision.content.acceptanceRules],
    }), null)
    return dispatchRestartedReviewWithin({
      team, execution, reviewGroup, taskId: changeRow.taskId, instruction,
      requestKey: `exec:${execution.id}:${changeRow.change}:round:${round.number}:review:${row?.generation ?? 0}:restart`,
      resultId: round.resultId,
      allowedProfiles: revision.content.roles.find(role => role.group === reviewGroup)?.profiles ?? [],
      assignments: input.assignments,
    })
  }
}
