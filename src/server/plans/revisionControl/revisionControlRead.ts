// The revision-control read model (revision-control design D14, D15; the
// remainder's DV1–DV2): one plan's holds and pauses as `team-plan-detail`,
// `plan_get`, supervision's causes (D13), and the attention sources read
// them. One reader for every consumer, so the detail, a cause, and an item
// never disagree on a target's state ("readers disagreeing on derived
// state", docs/oracle-hazards.md). A target's state is the pure
// `pauseTargetState` over its stored rows and the holder's live facts, the
// same derivation the executor's tick records from: Paused only from a
// recorded `paused_at`, never derived (I2). Nothing here writes. Another
// team's plan reads as empty: every store read is scoped by the team id.
import type { CheckpointView, HoldView, PauseTargetView, PauseView, PlanCheckpoint, PlanHold } from '../../../shared/planRevisionControl'
import type { ExecutionStore } from '../execution/executionStore'
import type { CheckpointStore } from './checkpointStore'
import type { HoldStore } from './holdStore'
import type { PauseStore } from './pauseStore'
import { pauseSideLists } from './pauseService'
import { derivePauseTarget, type PauseTickDeps } from './pauseTick'

export interface RevisionControlReads {
  holds: HoldStore
  pauses: PauseStore
  checkpoints: CheckpointStore
  executions: ExecutionStore
  /** The tick's facts for a target's derived state; absent without team services, where no pause exists. */
  tick?: PauseTickDeps
}

/** The plan's holds and pauses, as every revision-control consumer reads them. */
export interface RevisionControlDetail {
  /** Active holds first, oldest first within each group (DV1). */
  holds: HoldView[]
  /** Every pause of the plan, oldest first (DV2). */
  pauses: PauseView[]
}

export function holdView(hold: PlanHold, releasedChanges: string[]): HoldView {
  return {
    id: hold.id, scope: hold.scope, rationale: hold.rationale, deadline: hold.deadline, cites: hold.cites,
    createdAt: hold.createdAt, releasedAt: hold.releasedAt, releaseReason: hold.releaseReason,
    changes: hold.changes, releasedChanges,
  }
}

function checkpointView(checkpoint: PlanCheckpoint): CheckpointView {
  return {
    id: checkpoint.id, kind: checkpoint.kind, commitSha: checkpoint.commitSha, summary: checkpoint.summary,
    nextSteps: checkpoint.nextSteps, createdAt: checkpoint.createdAt, supersededBy: checkpoint.supersededBy,
    unfinished: checkpoint.unfinished, errorsTests: checkpoint.errorsTests,
  }
}

/** One plan's holds and pauses; empty for another team's or an unknown plan (DV4). */
export function readRevisionControl(reads: RevisionControlReads, teamId: string, planId: string, now: Date = new Date()): RevisionControlDetail {
  const holds = reads.holds.forPlan(teamId, planId).map(hold => holdView(hold, reads.holds.releasedChangesOf(hold.id)))
  if (reads.tick === undefined) return { holds, pauses: [] }
  const tick = reads.tick
  const pauses = reads.pauses.forPlan(teamId, planId).map((pause): PauseView => {
    const execution = reads.executions.execution(pause.executionId)
    const finished = execution !== null && execution.state !== 'running'
    const targets = reads.pauses.targets(pause.id)
    const views = targets.map((target): PauseTargetView => {
      const { state } = derivePauseTarget(tick, pause, target, finished, now)
      // The store lists newest first; the view lists oldest first, the newest standing as `checkpoint`.
      const checkpoints = reads.checkpoints.forTarget(pause.id, target.change).map(checkpointView).reverse()
      const newest = reads.checkpoints.newest(pause.id, target.change)
      return {
        change: target.change, stage: target.stage, holderSession: target.holderSession, withdrawn: target.withdrawn,
        state, pausedAt: target.pausedAt,
        checkpoint: newest === null ? null : checkpointView(newest),
        checkpoints,
        decision: state.state === 'decided' ? state.decision : null, decidedAt: target.decidedAt,
      }
    })
    const hold = reads.holds.get(teamId, pause.holdId)
    const rows = reads.executions.changes(pause.executionId)
    // PauseService.sides' rule, so the command's lists and the view's agree.
    const covered = new Set(hold !== null && hold.scope === 'changes' ? hold.changes : rows.map(row => row.change))
    const sides = pauseSideLists(rows, covered, targets)
    return {
      id: pause.id, holdId: pause.holdId, executionId: pause.executionId, deadline: pause.deadline, note: pause.note,
      createdAt: pause.createdAt, closedAt: pause.closedAt, deadlinePassed: Date.parse(pause.deadline) <= now.getTime(),
      targets: views, noActiveWork: sides.noActiveWork, landingInProgress: sides.landingInProgress,
    }
  })
  return { holds, pauses }
}
