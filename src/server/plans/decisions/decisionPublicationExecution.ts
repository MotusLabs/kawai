import type { Database } from 'bun:sqlite'
import type { Plan } from '../../../shared/plans'
import type { TeamTask } from '../../../shared/teamTasks'
import type { ExecutionStore } from '../execution/executionStore'
import { hashManifest } from '../execution/manifestHash'
import type { ExecutionRevisionStore } from '../revisionControl/executionRevisionStore'
import type { PlanStore } from '../planStore'
import { hashPlanRevision } from '../planHash'
import { DecisionRefusal } from './decisionInputs'

export interface PublicationExecutionReads {
  executions: Pick<ExecutionStore, 'latestAttemptForChange'>
  revisions: Pick<ExecutionRevisionStore, 'newest'>
}

interface ExecutionContextRow {
  executionId: string
  change: string
  changeTeam: string
  generation: number
  stage: string
  step: string | null
  baselineCommit: string | null
  owns: number
  teamId: string | null
  planId: string | null
  revision: number | null
  contentHash: string | null
  baseCommit: string | null
  state: string | null
}

const DECISIONS = new Set(['continue', 'adapt', 'restart', 'cancelled'])
const COMMIT = /^[0-9a-f]{40}$/
export const stalePublication = (reason: string) => new DecisionRefusal('stale', reason)

function pauseHistory(db: Database, plan: Plan, executionId: string, change: string) {
  const rows = db.query<{
    pauseId: string; teamId: string; planId: string; decision: string | null; decisionCommandId: string | null; decidedAt: string | null
  }, [string, string]>(`SELECT p.id AS pauseId, p.team_id AS teamId, p.plan_id AS planId,
    t.decision, t.decision_command_id AS decisionCommandId, t.decided_at AS decidedAt
    FROM plan_pauses p JOIN plan_pause_targets t ON t.pause_id = p.id
    WHERE p.execution_id = ? AND t.change = ? ORDER BY p.id`).all(executionId, change)
  return rows.map(row => {
    if (row.teamId !== plan.teamId || row.planId !== plan.id) throw stalePublication('The affected pause scope is inconsistent.')
    if (row.decision === null) throw stalePublication(`Pause ${row.pauseId} affects this change and is undecided.`)
    if (!DECISIONS.has(row.decision) || !row.decisionCommandId || !row.decidedAt) {
      throw stalePublication(`The decision record for pause ${row.pauseId} is inconsistent.`)
    }
    return { pauseId: row.pauseId, decision: row.decision, decisionCommandId: row.decisionCommandId }
  })
}

/** Validate the pinned plan, execution history, owning change and actual latest attempt independently. */
export function executionContext(db: Database, plans: PlanStore, reads: PublicationExecutionReads, task: TeamTask, plan: Plan, change: string) {
  const rows = db.query<ExecutionContextRow, [string]>(`SELECT c.execution_id AS executionId, c.change, c.team_id AS changeTeam,
    c.generation, c.state AS stage, c.step, c.baseline_commit AS baselineCommit, c.owns, e.team_id AS teamId, e.plan_id AS planId,
    e.revision, e.content_hash AS contentHash, e.base_commit AS baseCommit, e.state
    FROM plan_execution_changes c LEFT JOIN plan_executions e ON e.id = c.execution_id WHERE c.task_id = ? LIMIT 2`).all(task.id)
  if (rows.length === 0 && task.creator.kind !== 'system') {
    const owner = db.query('SELECT 1 FROM plan_execution_changes WHERE team_id = ? AND change = ? AND owns = 1').get(plan.teamId, change)
    if (owner) throw stalePublication('An execution owns this change.')
    return null
  }
  const [row] = rows
  if (rows.length !== 1 || !row || task.creator.kind !== 'system' || row.change !== change ||
      row.changeTeam !== plan.teamId || row.teamId !== plan.teamId || row.planId !== plan.id || row.owns !== 1) {
    throw stalePublication('The task does not have a consistent owning execution for this change.')
  }
  if (row.state !== 'running' || (row.stage !== 'implementing' && row.stage !== 'gating')) {
    throw stalePublication('The execution or change is no longer in a publication stage.')
  }
  const pinned = row.revision === null ? null : plans.revision(plan.id, row.revision)
  const latest = reads.revisions.newest(row.executionId)
  const approvedOrSuperseded = pinned?.status === 'approved' || pinned?.status === 'superseded'
  if (!pinned || !approvedOrSuperseded || !latest || latest.seq < 1 || pinned.revision !== latest.revision ||
      pinned.contentHash !== row.contentHash || latest.contentHash !== row.contentHash ||
      hashPlanRevision(pinned.content, pinned.pin) !== row.contentHash || !pinned.content.changes.some(item => item.change === change)) {
    throw stalePublication('The execution revision pin is missing or inconsistent.')
  }
  const attempt = reads.executions.latestAttemptForChange(row.executionId, change)
  const manifest = attempt?.manifest
  const attemptPin = manifest?.plan ? plans.revision(plan.id, manifest.plan.revision) : null
  if (!row.baselineCommit || !COMMIT.test(row.baselineCommit) || !row.baseCommit || !COMMIT.test(row.baseCommit) ||
      !attempt || !manifest || manifest.version !== 1 || manifest.execution !== row.executionId ||
      manifest.plan?.id !== plan.id || manifest.task?.id !== task.id || !attemptPin || attemptPin.contentHash !== manifest.plan.contentHash ||
      hashManifest(manifest) !== attempt.manifestHash) {
    throw stalePublication('The change baseline or latest attempt manifest is missing or inconsistent.')
  }
  return {
    id: row.executionId, revision: pinned.revision, contentHash: pinned.contentHash, revisionSeq: latest.seq,
    baseCommit: row.baseCommit, changeGeneration: row.generation, stage: row.stage, step: row.step,
    baselineCommit: row.baselineCommit, attemptId: attempt.id, manifestHash: attempt.manifestHash,
    pauses: pauseHistory(db, plan, row.executionId, change),
  }
}
