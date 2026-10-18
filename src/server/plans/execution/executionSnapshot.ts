// The executor's snapshot (plan-execution D5 step 1): everything one tick
// reads of the team's running executions, taken once — change rows joined
// with their plan-content facts (dependencies, group, guidance, acceptance),
// the standing effects, and attempt counts. Pure reads over the stores; the
// planner is pure over the snapshot, so a tick after a restart resumes from
// exactly these rows.
import type { ChangeState, ChangeStep } from '../../../shared/planExecution'
import type { PlanContent } from '../../../shared/plans'
import type { EffectRow, ExecutionRow, RoundRow } from './executionRows'
import type { ExecutionStore } from './executionStore'
import type { PlanStore } from '../planStore'

/** What the round pipeline reads of one result of a change's task. */
export interface ResultFact {
  id: string
  commit: string | null
  taskRevision: number
  submittedBySession: string | null
}

/** The outstanding stage assignment's derived state (D12's instruction-failed). */
export interface AssignmentFact {
  id: string
  state: string
  reason: string | null
}

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
  /** The change's one pull request, once recorded (reused across rounds). */
  prNumber: number | null
  /** When the change's round passed (D13's landing readiness). */
  passedAt: string | null
  /** The revision's `dependsOn` for this change, in content order. */
  dependsOn: string[]
  /** The implementing group, from the execution's revision. */
  group: string | null
  /** The change's task, when created: its status, revision, results, and outstanding assignment. */
  task: { status: string; revision: number; results: ResultFact[]; assignment: AssignmentFact | null } | null
  /** The change's newest round, decided or open. */
  round: RoundRow | null
  /** The change's landing fact, once it landed (D13). */
  landing: { mergeSha: string; postCi: unknown } | null
  /** The change's newest merge or update-branch effect, any state (D13's follow-ons). */
  landingEffect: EffectRow | null
  /** Every effect of the newest round, any state, oldest first: its push, PR, and rerun. */
  roundEffects: EffectRow[]
}

export interface PlannedExecution {
  row: ExecutionRow
  changes: PlannedChange[]
  /** A finished (stopped) execution loaded only to settle a merge running at Stop (D12). */
  finished: boolean
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
export function executionSnapshot(teamId: string, main: string, executions: ExecutionStore, plans: PlanStore,
  resultsOf: (taskId: string) => ResultFact[] = () => [], taskRevisionOf: (taskId: string) => number = () => 1,
  taskStatusOf: (taskId: string) => string = () => 'active', assignmentOf: (taskId: string) => AssignmentFact | null = () => null): ExecutionSnapshot {
  const running = [...executions.runningForTeam(teamId), ...executions.settlingForTeam(teamId)]
  const contentOf = new Map<string, PlanContent>()
  const planned: PlannedExecution[] = running.map(execution => {
    let content = contentOf.get(execution.planId)
    if (content === undefined) {
      content = plans.revision(execution.planId, execution.revision)?.content
      if (content) contentOf.set(execution.planId, content)
    }
    const facts = new Map((content?.changes ?? []).map(entry => [entry.change, entry]))
    const effects = executions.effectsOf(execution.id)
    return {
      row: execution,
      finished: execution.state !== 'running',
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
        prNumber: row.prNumber,
        passedAt: row.passedAt,
        dependsOn: facts.get(row.change)?.dependsOn ?? [],
        group: facts.get(row.change)?.group ?? null,
        task: row.taskId === null ? null : { status: taskStatusOf(row.taskId), revision: taskRevisionOf(row.taskId), results: resultsOf(row.taskId), assignment: assignmentOf(row.taskId) },
        ...(() => {
          const round = executions.rounds(row.executionId, row.change).at(-1) ?? null
          return { round, roundEffects: round === null ? [] : effects.filter(effect => effect.roundId === round.id) }
        })(),
        landing: (() => {
          const fact = executions.landings(execution.planId).find(entry => entry.change === row.change)
          return fact ? { mergeSha: fact.mergeSha, postCi: fact.postCi as unknown } : null
        })(),
        landingEffect: effects.filter(effect => effect.change === row.change && (effect.kind === 'merge' || effect.kind === 'update-branch')).at(-1) ?? null,
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
