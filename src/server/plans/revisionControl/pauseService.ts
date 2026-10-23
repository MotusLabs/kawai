// Pause service (revision-control design D6, D3): the owner's pause of a
// hold's covered changes. The command is the human's — a non-human caller is
// refused before anything else — and follows D3's shape: reads that write
// nothing, then one transaction through `PlanService.recordRevisionControlEvent`
// (the only `plan_events` writer) whose `within` inserts the pause and its
// targets and, per held change of the running execution:
//   - an instruction or review handoff claimed or delivered becomes a target
//     whose holder is the claimant, following a forward chain to the successor
//     (`forwardEnd`), and takes one urgent direct system mail enqueued through
//     `MailboxStore` inside this same transaction — the enqueue path has no
//     cooldown or parking refusal, so a parked or cooling holder's mail waits
//     for its resume instead of failing (D6);
//   - a `queued` or `awaiting-request` instruction is withdrawn through
//     reassignment's stop branch — the mail cancelled through the store, the
//     assignment superseded — and recorded Paused at once, with no checkpoint;
//     the assignment derives `superseded`, never `instruction-failed`;
//   - a `spawning` instruction becomes a target with no holder yet; the pass
//     (`deliverOwed`) sends its mail once a claim is recorded;
//   - Kawai-held steps and `waiting` changes are not targets — the pause lists
//     them as having no active work — and a started update or merge effect as
//     landing in progress, left to settle.
// `runPlanCommand` replays before calling `within`, so a replayed pause sends
// nothing and supersedes nothing twice; the target's `message_id` is the
// durable once-marker for its mail. After the commit the executor wake fires.
import type { PauseStage, PlanPause, PlanPauseTarget } from '../../../shared/planRevisionControl'
import type { ChangeRow } from '../execution/executionRows'
import { agentHeldStage, attemptStatus } from '../execution/attemptStatus'
import type { ExecutionStore } from '../execution/executionStore'
import { outstandingOf, type AssignmentStore } from '../../team/assignmentStore'
import type { AssignmentService } from '../../team/AssignmentService'
import { forwardEnd } from '../../team/forwardChain'
import type { MailboxStore } from '../../team/mailboxStore'
import { PlanRefusal, type PlanCommandOutcome } from '../planCommands'
import type { PlanStore } from '../planStore'
import type { ExecutionEventOutcome, PlanCaller, PlanService } from '../PlanService'
import { HoldStore } from './holdStore'
import { PauseStore } from './pauseStore'
import { resolvePause, type AdaptHeadFacts, type PauseResolveOutcome, type ResolveInput } from './pauseResolve'
import type { CheckpointStore } from './checkpointStore'
import type { TaskService } from '../../team/TaskService'

/** The tag every pause mail carries (D6). */
export const PLAN_PAUSE_TAG = 'plan-pause'

export interface PauseInput {
  planId: string
  /** The active hold whose covered changes the pause targets. */
  holdId: string
  deadline: string
  note?: string
  commandId: string
}

export interface PauseServiceDeps {
  pauses: PauseStore
  holds: HoldStore
  plans: PlanStore
  planService: PlanService
  executions: ExecutionStore
  assignments: AssignmentStore
  /** The team's mailbox: the pause mail and the withdrawal's cancel, inside the pause transaction (D6). */
  mailbox: MailboxStore
  /** Whether a session record still exists; a killed holder's mail dead-letters at enqueue. */
  sessionExists: (sessionId: string) => boolean
  /** A session record's profile (LC3): the inline restarted review's author-profile tags. Optional so a bench can omit it; the production composition wires the session directory. */
  sessionProfile?: (sessionId: string) => string | null
  /** The task service (D9): the resolve's H5 drop reads the task's current
   *  revision and the round result's pinned one, and the resume names the
   *  newest revision. Optional so a unit bench can omit it; the production
   *  composition wires it. */
  tasks?: TaskService
  /** The shared checkpoint store (D7): an attempt target's resume names the newest checkpoint's commit. */
  checkpoints?: CheckpointStore
  /** The dispatch path of the resolve's inline fix (A2r): the production
   *  composition wires the team's AssignmentService; a bench may omit it,
   *  leaving every adapt row owed. */
  assignmentService?: Pick<AssignmentService, 'dispatchWithin'>
  /**
   * Adapt's git facts (rev4 §2: the resolution's git reads run BEFORE the
   * transaction; only their results enter it — L3 (A3.2): the entry reads
   * it before `recordRevisionControlEvent`, after the replay short-circuit,
   * and the manifest consumes the gathered facts inside. `{ ok: false }` is
   * a failed read, refused `head-unreadable` (K7); null or absent falls
   * back to the newest attempt's start commit, else the baseline.
   */
  adaptHead?: (executionId: string, change: string) => Promise<AdaptHeadFacts | null>
  /**
   * R2's release bookkeeping (rev4 §4): `readiness` decides the decision
   * detail's release for a spawned holder, `releaseNow` archives a ready one
   * after the resolve's commit, and `markPending` records a busy one durably
   * inside the resolve's transaction. Optional; unwired (or the holder
   * record missing below), the detail reads release 'never' — fail-closed.
   * The production composition wires the team's MemberRelease.
   */
  releases?: {
    readiness: (sessionId: string) => { ready: boolean; reason?: string | null }
    releaseNow: (sessionId: string, detail: string) => unknown
    markPending: (sessionId: string, reason: string) => boolean
  }
  /** The holder's session-record facts (R2: spawned, archivedAt); null when the session is gone (R16). */
  holderRecord?: (sessionId: string) => { spawned: boolean; archivedAt: string | null } | null
  /** The executor wake, called after a committed command only. */
  wake?: (teamId: string) => unknown
  now?: () => Date
}

/** One committed pause command's result; `result` is undefined on a replay (D3). */
export type PauseOutcome = ExecutionEventOutcome<{ pause: PlanPause }>

/** The pause's held changes that are not targets (D6). */
export interface PauseSideLists {
  noActiveWork: string[]
  landingInProgress: string[]
}

type Failure = { state?: boolean; text: string }

/**
 * Whether the change's merge or fast-forward effect has started (D6): the
 * landing steps that run effects. The slot and up-to-date steps wait —
 * Kawai-held, "no active work".
 */
export function landingStarted(row: Pick<ChangeRow, 'state' | 'step'>): boolean {
  return row.state === 'landing' && (row.step === 'updating' || row.step === 'merging')
}

/** The held changes of the pause that are not targets, split per D6. */
export function pauseSideLists(rows: Pick<ChangeRow, 'change' | 'state' | 'step'>[], covered: ReadonlySet<string>,
  targets: ReadonlyArray<{ change: string }>): PauseSideLists {
  const targeted = new Set(targets.map(target => target.change))
  const sides: PauseSideLists = { noActiveWork: [], landingInProgress: [] }
  for (const row of rows) {
    if (!covered.has(row.change) || targeted.has(row.change)) continue
    if (landingStarted(row)) sides.landingInProgress.push(row.change)
    else sides.noActiveWork.push(row.change)
  }
  return sides
}

function forbidden(action: string): PlanCommandOutcome & { result: undefined } {
  return { ok: false, reason: 'forbidden', result: undefined, message: `Only the plan's owner may ${action}, from the Plans view; no agent tool can.` }
}

/** The pause mail's body (D6): the hold, the deadline, the safe-point asks, and the reply guidance. */
export function pauseBody(plan: { id: string; title: string }, hold: { id: string; rationale: string }, deadline: string,
  target: { change: string; stage: PauseStage; taskId: string | null; branch: string | null }): string {
  const lines = [
    `Kawai: the owner paused change ${target.change} of plan "${plan.title}" (${plan.id}) while it is yours to work on.`,
    `Hold ${hold.id}: ${hold.rationale}`,
    `The pause deadline is ${deadline}.`,
    '',
    'Stop at a safe point now.',
  ]
  if (target.stage === 'attempt') {
    lines.push(
      `- Commit all work in progress on the change branch${target.branch ? ` (${target.branch})` : ''}; leave git status clean.`,
      ...(target.taskId ? [`- Call task_checkpoint(task_id: ${target.taskId}, commit: <that commit>, summary, unfinished?, errors_tests?, next_steps). Kawai pushes the checkpoint.`] : []),
    )
  } else {
    lines.push('- Submit nothing further for this review, and stop.')
  }
  lines.push('Wait for the owner\'s decision. Replies to this message are refused.')
  return lines.join('\n')
}

/** A derived target plus the instruction facts its withdrawal and mail need, read before the pause id exists. */
type DerivedTarget = PlanPauseTarget & {
  instructionTaskId: string | null
  instructionMessageId: string | null
  branch: string | null
}

export class PauseService {
  private readonly now: () => Date

  constructor(readonly deps: PauseServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** D6: pause a hold's covered changes of the running execution. */
  pause(caller: PlanCaller, input: PauseInput): PauseOutcome {
    if (caller.kind !== 'human') return forbidden('pause the changes')
    const plan = this.deps.plans.forTeam(caller.team.teamId, input.planId)
    if (!plan) return { ok: false, reason: 'not-found', result: undefined, message: `Plan not found in this team: ${input.planId}` }
    const outcome = this.deps.planService.recordRevisionControlEvent(plan.id, {
      kind: 'pause-requested', commandId: input.commandId, holdId: input.holdId,
      deadline: input.deadline, note: input.note ?? '',
    }, () => this.pauseWithin(caller.team.teamId, caller.team.groupsRoot, plan.id, input))
    if (outcome.ok && !outcome.replayed) this.deps.wake?.(plan.teamId)
    return outcome
  }

  /** D9: the owner's decision on one pause target (pauseResolve.ts); async for L3's pre-transaction head read. */
  resolve(caller: PlanCaller, input: ResolveInput): Promise<PauseResolveOutcome> {
    return resolvePause(this.deps, caller, input)
  }

  /** The pause's held changes that are not targets, split per D6 (read model for 4.1's tests and the view). */
  sides(teamId: string, pauseId: string): PauseSideLists | null {
    const pause = this.deps.pauses.get(teamId, pauseId)
    if (!pause) return null
    const rows = this.deps.executions.changes(pause.executionId)
    const hold = this.deps.holds.get(teamId, pause.holdId)
    const covered = new Set(hold !== null && hold.scope === 'changes' ? hold.changes : rows.map(row => row.change))
    return pauseSideLists(rows, covered, this.deps.pauses.targets(pauseId))
  }

  /**
   * The owed pause mail for targets whose holder appeared after the insert —
   * a spawn's claim, or a forward successor's (D6). Each target's
   * `message_id` is the once-marker: exactly one mail per target, whatever
   * restarts and repeated passes happen in between. One transaction, so the
   * holder write, the mail, and the marker commit together or not at all.
   * Returns the changes mailed now.
   */
  deliverOwed(teamId: string, groupsRoot: string, pauseId: string): string[] {
    const pause = this.deps.pauses.get(teamId, pauseId)
    if (!pause) return []
    return this.deps.pauses.db.transaction(() => {
      const mailed: string[] = []
      for (const target of this.deps.pauses.targets(pauseId)) {
        if (target.messageId !== null || target.withdrawn || target.decision !== null) continue
        const row = this.deps.executions.change(pause.executionId, target.change)
        const holder = this.holderOf(row?.taskId ?? null, target.assignmentId)
        if (holder === null) continue
        const plan = this.deps.plans.get(pause.planId)
        const hold = this.deps.holds.get(teamId, pause.holdId)
        if (!plan || !hold) continue
        this.deps.pauses.setHolder(pauseId, target.change, holder)
        this.mailHolder(teamId, groupsRoot, plan, hold, pause.deadline, pauseId, target, holder, row?.taskId ?? null, row?.branch ?? null)
        mailed.push(target.change)
      }
      return mailed
    })()
  }

  /** The current holder of a target's assignment: the claimant at the forward chain's end, else null. */
  private holderOf(taskId: string | null, assignmentId: string): string | null {
    if (taskId === null) return null
    const assignment = this.deps.assignments.listByTask(taskId).find(row => row.id === assignmentId)
    if (!assignment?.messageId) return null
    const message = this.deps.mailbox.get(assignment.messageId)
    if (message !== null && (message.state === 'queued' || message.state === 'awaiting-request' || message.state === 'spawning')) return null
    const end = forwardEnd(this.deps.mailbox, this.deps.pauses.db, assignment.messageId)
    return end?.claimedBy ?? null
  }

  private pauseWithin(teamId: string, groupsRoot: string, planId: string, input: PauseInput): { pause: PlanPause } {
    const hold = this.deps.holds.get(teamId, input.holdId)
    if (!hold || hold.planId !== planId) throw new PlanRefusal('not-found', `Hold not found on this plan: ${input.holdId}`)
    const failures: Failure[] = []
    if (hold.releasedAt !== null) failures.push({ state: true, text: `the hold ${hold.id} is released; place or extend a hold instead` })
    // The compared-payload builder has already refused an unparsable deadline.
    const deadline = new Date(input.deadline)
    if (deadline.getTime() <= this.now().getTime()) failures.push({ text: `the pause deadline ${deadline.toISOString()} is not in the future` })
    const execution = this.deps.executions.running(planId)
    if (!execution) failures.push({ state: true, text: 'the plan has no running execution to pause' })
    // Independent of the execution check (D3 names every failure): a finished
    // execution can still leave the hold's pause open.
    if (this.deps.pauses.forPlan(teamId, planId, true).some(pause => pause.holdId === hold.id)) {
      failures.push({ state: true, text: `an open pause already covers the hold ${hold.id}` })
    }
    this.refuse(failures, 'The pause was refused')
    const plan = this.deps.plans.get(planId)!

    const rows = this.deps.executions.changes(execution!.id)
    const covered = new Set(hold.scope === 'changes' ? hold.changes : rows.map(row => row.change))
    const derived = rows.filter(row => covered.has(row.change)).map(row => this.deriveTarget(row))
    const targets = derived.filter((entry): entry is { target: DerivedTarget } => 'target' in entry).map(entry => entry.target)
    const pause = this.deps.pauses.insert({
      teamId, planId, executionId: execution!.id, holdId: hold.id, deadline: deadline.toISOString(),
      note: input.note?.trim() || null, commandId: input.commandId.trim(),
    }, targets.map(target => ({
      change: target.change, stage: target.stage, attemptId: target.attemptId, assignmentId: target.assignmentId,
      holderSession: target.withdrawn ? null : target.holderSession, ...(target.withdrawn ? { withdrawn: true } : {}),
    })))
    // The per-target writes need the pause id, so they follow the insert —
    // inside the same transaction `recordRevisionControlEvent` opened.
    for (const target of targets) {
      if (target.withdrawn) this.withdraw(pause.id, target)
      else if (target.holderSession !== null) {
        this.mailHolder(teamId, groupsRoot, plan, hold, deadline.toISOString(), pause.id, target, target.holderSession, target.instructionTaskId, target.branch)
      }
    }
    return { pause: this.deps.pauses.get(teamId, pause.id)! }
  }

  /**
   * One held change's target derivation (D6's table), read inside the
   * command's transaction. The holder is the instruction's claimant at the
   * forward chain's end — null while a spawn has not claimed or a forward's
   * successor is unclaimed; `deliverOwed` mails those when a claim appears.
   */
  private deriveTarget(row: ChangeRow): { target: DerivedTarget } | { noActiveWork: true } | { landingInProgress: true } {
    // O3′ (revision-control PR E): the shared agent-held predicate decides
    // the stage. An owed newest attempt names no holder (H7, H″ O1) — the
    // outstanding assignment is the previous stage's (the reviewer's), never
    // the attempt's, so the change holds no live work to pause, whatever
    // its state. A linked row (its dispatch went out) still derives its
    // claimant.
    const newest = this.deps.executions.attempts(row.executionId, row.change).at(-1) ?? null
    const held = agentHeldStage(row, newest === null || row.taskId === null ? null : {
      kind: newest.kind,
      status: attemptStatus(newest, this.deps.assignments.listByTask(row.taskId), this.deps.executions.rounds(row.executionId, row.change)),
    })
    const stage: PauseStage | null = held === null ? null : held === 'review' ? 'review' : 'attempt'
    if (stage === null) return landingStarted(row) ? { landingInProgress: true } : { noActiveWork: true }
    if (row.taskId === null) return { noActiveWork: true }
    const attemptId = newest?.id ?? null
    const base = {
      pauseId: '', change: row.change, stage, attemptId, assignmentId: '', holderSession: null as string | null,
      messageId: null as string | null, withdrawn: false, pausedAt: null as string | null, checkpointId: null as string | null,
      decision: null, decisionDetail: null, decidedAt: null as string | null, decisionCommandId: null as string | null,
      instructionTaskId: row.taskId, instructionMessageId: null as string | null, branch: row.branch,
    }
    const outstanding = outstandingOf(this.deps.assignments.listByTask(row.taskId))
    if (!outstanding?.messageId) return { noActiveWork: true }
    const message = this.deps.mailbox.get(outstanding.messageId)
    if (message !== null && (message.state === 'queued' || message.state === 'awaiting-request')) {
      return { target: { ...base, assignmentId: outstanding.id, withdrawn: true, instructionMessageId: outstanding.messageId } }
    }
    const holder = message !== null && message.state === 'spawning'
      ? null
      : forwardEnd(this.deps.mailbox, this.deps.pauses.db, outstanding.messageId)?.claimedBy ?? null
    return { target: { ...base, assignmentId: outstanding.id, holderSession: holder, instructionMessageId: outstanding.messageId } }
  }

  /**
   * The stop branch (D6): the unclaimed instruction's mail is cancelled
   * through the store — `team_message_events` records it — and the assignment
   * superseded, so it derives `superseded`, never `instruction-failed`. Both
   * writes are guarded: only a queued or awaiting-request mail cancels, and
   * only an unsuperseded row supersedes.
   */
  private withdraw(pauseId: string, target: DerivedTarget): void {
    if (target.instructionMessageId !== null) {
      const message = this.deps.mailbox.get(target.instructionMessageId)
      if (message !== null && (message.state === 'queued' || message.state === 'awaiting-request')) {
        this.deps.mailbox.cancel(target.instructionMessageId, { kind: 'system' }, `the pause ${pauseId} withdrew the unclaimed instruction`)
      }
    }
    this.deps.assignments.supersede(target.assignmentId, pauseId)
    // Recorded Paused at once: nothing is owed to a withdrawn target (D6).
    this.deps.pauses.recordPaused(pauseId, target.change, null)
  }

  /** One urgent direct system mail per holder (D6), inside the caller's transaction. */
  private mailHolder(teamId: string, groupsRoot: string, plan: { id: string; title: string }, hold: { id: string; rationale: string },
    deadline: string, pauseId: string, target: Pick<PlanPauseTarget, 'change' | 'stage'>, holder: string,
    taskId: string | null, branch: string | null): void {
    const message = this.deps.mailbox.enqueue({
      teamId, toKind: 'session', toId: holder, fromKind: 'system', fromSession: null, fromGroup: null,
      originPath: groupsRoot, priority: 'urgent', tags: [PLAN_PAUSE_TAG],
      body: pauseBody(plan, hold, deadline, { change: target.change, stage: target.stage, taskId, branch }),
      taskId, actor: 'system',
    })
    if (!this.deps.sessionExists(holder)) this.deps.mailbox.deadLetter(message.id, 'killed-recipient')
    this.deps.pauses.setMail(pauseId, target.change, message.id)
  }

  /** Refuse with every failure listed, nothing written (D3). */
  private refuse(failures: Failure[], what: string): void {
    if (failures.length === 0) return
    const reason = failures.some(failure => failure.state) ? 'state' : 'invalid'
    throw new PlanRefusal(reason, `${what}: ${failures.map(failure => failure.text).join('; ')}. Nothing was written.`)
  }
}
