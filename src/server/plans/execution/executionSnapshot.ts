// The executor's snapshot (plan-execution D5 step 1): everything one tick
// reads of the team's running executions, taken once — change rows joined
// with their plan-content facts (dependencies, group, guidance, acceptance),
// the standing effects, and attempt counts. Pure reads over the stores; the
// planner is pure over the snapshot, so a tick after a restart resumes from
// exactly these rows.
import type { ChangeState, ChangeStep } from '../../../shared/planExecution'
import type { PlanContent } from '../../../shared/plans'
import type { EffectRow, ExecutionRow } from './executionRows'
import type { ExecutionStore } from './executionStore'
import type { PlanStore } from '../planStore'

export interface PlannedChange {
  executionId: string
  change: string
  state: ChangeState
  step: ChangeStep | null
  generation: number
  taskId: string | null
  worktree: string | null
  branch: string | null
  baselineCommit: string | null
  /** The revision's `dependsOn` for this change, in content order. */
  dependsOn: string[]
  /** The implementing group, from the execution's revision. */
  group: string | null
}

export interface PlannedExecution {
  row: ExecutionRow
  changes: PlannedChange[]
}

export interface ExecutionSnapshot {
  teamId: string
  /** The team's main checkout: where provisioning runs worktree add (D6). */
  main: string
  /** Running executions, oldest first, changes in content order. */
  executions: PlannedExecution[]
  /** The standing (not settled) effects of these executions. */
  effects: EffectRow[]
  /** Change attempts so far: `${executionId}:${change}` → count. */
  attempts: Map<string, number>
}

/** Load the team's running-execution snapshot: rows, plan facts, effects, attempt counts. */
export function executionSnapshot(teamId: string, main: string, executions: ExecutionStore, plans: PlanStore): ExecutionSnapshot {
  const running = executions.runningForTeam(teamId)
  const contentOf = new Map<string, PlanContent>()
  const planned: PlannedExecution[] = running.map(execution => {
    let content = contentOf.get(execution.planId)
    if (content === undefined) {
      content = plans.revision(execution.planId, execution.revision)?.content
      if (content) contentOf.set(execution.planId, content)
    }
    const facts = new Map((content?.changes ?? []).map(entry => [entry.change, entry]))
    return {
      row: execution,
      changes: executions.changes(execution.id).map(row => ({
        executionId: row.executionId,
        change: row.change,
        state: row.state,
        step: row.step,
        generation: row.generation,
        taskId: row.taskId,
        worktree: row.worktree,
        branch: row.branch,
        baselineCommit: row.baselineCommit,
        dependsOn: facts.get(row.change)?.dependsOn ?? [],
        group: facts.get(row.change)?.group ?? null,
      })),
    }
  })
  const effects = planned.flatMap(execution => executions.effectsOf(execution.row.id))
    .filter(effect => effect.state === 'pending' || effect.state === 'running' || effect.state === 'unknown')
  const attempts = new Map<string, number>()
  for (const execution of planned) {
    for (const change of execution.changes) {
      attempts.set(`${change.executionId}:${change.change}`, executions.attempts(change.executionId, change.change).length)
    }
  }
  return { teamId, main, executions: planned, effects, attempts }
}
