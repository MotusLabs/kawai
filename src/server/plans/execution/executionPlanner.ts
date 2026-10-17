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

/** One round-pipeline stage (D9-D11), performed by the executor in order. */
export interface PlannedStage {
  executionId: string
  change: string
  kind: 'result' | 'push' | 'open-pr' | 'ci' | 'review' | 'verdict' | 'revision' | 'landing' | 'post-ci'
  roundId: string | null
  resultId: string | null
}

export interface PlanSteps {
  transitions: PlannedTransition[]
  effects: PlannedEffect[]
  dispatches: PlannedDispatch[]
  stages: PlannedStage[]
  fixes: PlannedFix[]
}

/** D12's fix step after a failed round; the executor applies the count rule. */
export interface PlannedFix {
  executionId: string
  change: string
  roundId: string
}

/** The states that occupy the execution's parallel-limit slots. */
const IN_PROGRESS: ReadonlySet<ChangeState> = new Set(['provisioning', 'implementing', 'gating', 'landing'])

export function planSteps(snapshot: ExecutionSnapshot, _now: string): PlanSteps {
  const steps: PlanSteps = { transitions: [], effects: [], dispatches: [], stages: [], fixes: [] }
  const standing = new Set(snapshot.effects.map(effect => effect.effectKey))
  for (const execution of snapshot.executions) {
    const states = new Map(execution.changes.map(change => [change.change, change.state]))
    let inProgress = execution.changes.filter(change => IN_PROGRESS.has(change.state)).length
    for (const change of execution.changes) {
      if (change.state === 'landed') {
        // D13 step 6: base-branch CI on the merge commit is polled until it
        // finishes and lands as the landing fact's evidence.
        if (change.landing !== null && change.landing.postCi === null) {
          steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'post-ci', roundId: null, resultId: null })
        }
        continue
      }
      if (change.state === 'stopped' || change.state === 'cancelled') continue
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
      // A stage instruction that failed stops the change (D12): its
      // assignment derives failed — the mail settled dead, cancelled, or
      // discarded. Only the current stage can fail it; a superseded
      // assignment derives superseded and never stops anything.
      if (change.task?.assignment?.state === 'failed') {
        steps.transitions.push({
          executionId: change.executionId, change: change.change,
          guard: { state: change.state, generation: change.generation },
          patch: {
            state: 'stopped', stopReason: 'instruction-failed', step: null,
            stopDetail: {
              message: `The stage instruction failed to deliver (${change.task.assignment.reason ?? 'the mail settled'}).`,
              assignmentId: change.task.assignment.id,
            },
          },
        })
        continue
      }
      // A human close of the change's task stops it (D19); Kawai's own closes
      // happen after landing, on a change that no longer runs.
      if (change.task !== null && (change.task.status === 'done' || change.task.status === 'cancelled')) {
        steps.transitions.push({
          executionId: change.executionId, change: change.change,
          guard: { state: change.state, generation: change.generation },
          patch: { state: 'stopped', stopReason: 'task-closed', step: null, stopDetail: { message: `The task was ${change.task.status} by hand.`, ...(change.taskId !== null ? { taskId: change.taskId } : {}) } },
        })
        continue
      }
      // The round pipeline (D9-D11): a result becomes a round, a round is
      // pushed, PR'd, CI-read, reviewed, and decided. A landing change's
      // merge has started, so no newer result supersedes its round.
      if (change.task === null || change.state === 'landing') continue
      const newest = change.task.results.at(-1) ?? null
      if (newest !== null && (change.round === null || change.round.resultId !== newest.id)) {
        steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'result', roundId: null, resultId: newest.id })
        continue
      }
      const round = change.round
      // D9: a result pinned to an older task revision can never pass — the
      // change returns for a fix attempt naming the revision, unless its
      // merge started or an update-branch effect is still settling.
      if (change.task !== null && round !== null && change.task.results.some(result => result.id === round.resultId && result.taskRevision < change.task!.revision)) {
        const updating = snapshot.effects.some(effect => effect.change === change.change && effect.kind === 'update-branch')
        if (!updating) steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'revision', roundId: round.id, resultId: null })
        continue
      }
      if (change.state !== 'gating' || round === null) continue
      if (round.outcome === 'pass' && change.passedAt !== null) {
        // D13: a passed change lands — conditions first, then the slot.
        steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'landing', roundId: round.id, resultId: null })
        continue
      }
      if (round.outcome === 'fail') {
        // A failed round returns the change for fixes under the count rule
        // (D12); the executor decides stop versus dispatch.
        steps.fixes.push({ executionId: change.executionId, change: change.change, roundId: round.id })
        continue
      }
      if (round.outcome !== null) continue
      const pushKey = `${change.executionId}:${change.change}:push:${round.number}:${change.generation}`
      if (round.pushedAt === null) {
        if (!standing.has(pushKey)) steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'push', roundId: round.id, resultId: null })
        continue
      }
      // The change's one pull request: each round re-lists (reusing an open
      // one, stopping on a closed one — plan-landing); the per-round effect
      // key bounds it to once per round.
      const prKey = `${change.executionId}:${change.change}:open-pr:${round.number}:${change.generation}`
      if (change.branch !== null && !standing.has(prKey)) {
        steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'open-pr', roundId: round.id, resultId: null })
      }
      if (round.reviewAssignmentId !== null) {
        steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'verdict', roundId: round.id, resultId: null })
      } else {
        const rerunKey = `${change.executionId}:${change.change}:rerun:${round.number}:${change.generation}`
        if (!standing.has(rerunKey)) steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'ci', roundId: round.id, resultId: null })
      }
    }
  }
  return steps
}
