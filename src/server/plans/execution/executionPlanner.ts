// The pure planner (plan-execution D5 step 2): `planSteps(snapshot, now)`
// returns the transitions and effects one tick owes — nothing here reads a
// store, so the executor stays a thin loop and tests drive scenarios as
// data. Scheduling (D6/D11): a change waits until every change it dependsOn
// in its revision has landed, under the execution's parallel limit, picked
// in content order; a stopped dependency holds its dependents while
// independent work continues; landed work is never redone. A `provisioning`
// change without a standing provision effect gets one (D6); an
// `implementing` change without a task gets its task and first dispatch
// (D7/D8), performed by the executor, not an effect row.
import type { ChangeState } from '../../../shared/planExecution'
import type { ChangePatch } from './executionStore'
import type { ExecutionSnapshot, PlannedChange } from './executionSnapshot'

export interface PlannedTransition {
  executionId: string
  change: string
  guard: { state: ChangeState; generation: number }
  patch: ChangePatch
}

export interface PlannedEffect {
  executionId: string
  change: string
  kind: 'provision'
  effectKey: string
  command: Record<string, unknown>
}

/** The task-creation and dispatch step (D7/D8): performed, never an effect row. */
export interface PlannedDispatch {
  executionId: string
  change: string
  group: string
}

export interface PlanSteps {
  transitions: PlannedTransition[]
  effects: PlannedEffect[]
  dispatches: PlannedDispatch[]
}

/** The states that occupy the execution's parallel-limit slots. */
const IN_PROGRESS: ReadonlySet<ChangeState> = new Set(['provisioning', 'implementing', 'gating', 'landing'])

export function planSteps(snapshot: ExecutionSnapshot, _now: string): PlanSteps {
  const steps: PlanSteps = { transitions: [], effects: [], dispatches: [] }
  const standing = new Set(snapshot.effects.map(effect => effect.effectKey))
  for (const execution of snapshot.executions) {
    const states = new Map(execution.changes.map(change => [change.change, change.state]))
    let inProgress = execution.changes.filter(change => IN_PROGRESS.has(change.state)).length
    for (const change of execution.changes) {
      if (change.state === 'landed' || change.state === 'stopped' || change.state === 'cancelled') continue
      if (change.state === 'waiting') {
        // A dependency that has not landed holds the change — stopped ones
        // included; independent changes elsewhere in the plan continue.
        const held = change.dependsOn.some(dependency => states.get(dependency) !== 'landed')
        if (held || inProgress >= execution.row.maxParallel) continue
        steps.transitions.push({
          executionId: change.executionId, change: change.change,
          guard: { state: change.state, generation: change.generation },
          patch: { state: 'provisioning' },
        })
        states.set(change.change, 'provisioning')
        inProgress += 1
        continue
      }
      if (change.state === 'provisioning') {
        const attempt = (snapshot.attempts.get(`${change.executionId}:${change.change}`) ?? 0) + 1
        const effectKey = `${change.executionId}:${change.change}:provision:${attempt}:${change.generation}`
        if (standing.has(effectKey)) continue
        steps.effects.push({
          executionId: change.executionId, change: change.change, kind: 'provision', effectKey,
          command: {
            repo: snapshot.main,
            path: `${snapshot.main}/.worktrees/${change.change}`,
            branch: change.change,
            base: execution.row.baseCommit,
            baseBranch: execution.row.baseBranch,
            planId: execution.row.planId,
          },
        })
        continue
      }
      if (change.state === 'implementing' && change.taskId === null && change.group !== null) {
        steps.dispatches.push({ executionId: change.executionId, change: change.change, group: change.group })
      }
    }
  }
  return steps
}
