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
import type { ExecutionSnapshot } from './executionSnapshot'

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
  kind: 'result' | 'push' | 'open-pr' | 'ci' | 'review' | 'verdict' | 'revision' | 'landing' | 'post-ci' | 'redispatch' | 'landing-outcome'
  roundId: string | null
  resultId: string | null
  /** A `landing-outcome` stage's settled merge or update-branch effect. */
  effectId?: string
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
    if (execution.finished) {
      // A stopped execution only settles the merge that ran at Stop (D12):
      // landed and accepted if it merged, cancelled with its task otherwise.
      for (const change of execution.changes) {
        const effect = change.landingEffect
        if (change.state === 'landing' && effect !== null && effect.kind === 'merge' && (effect.state === 'done' || effect.state === 'failed')) {
          steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'landing-outcome', roundId: null, resultId: null, effectId: effect.id })
        }
      }
      continue
    }
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
      // Retry of a failed or closed stage (D12): its instruction is sent
      // again before anything reads the old, failed assignment.
      if (change.step === 'redispatch') {
        steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'redispatch', roundId: null, resultId: null })
        continue
      }
      // The implement dispatch: a change without its task, or whose task
      // exists but whose dispatch never committed (a refused one, retried).
      if (change.state === 'implementing' && change.group !== null
        && (change.taskId === null || (change.task !== null && change.task.assignment === null && change.task.results.length === 0))) {
        steps.dispatches.push({ executionId: change.executionId, change: change.change, group: change.group })
      }
      // D13's follow-ons: a settled merge or update-branch effect of a
      // landing change is applied by the tick (merge → landed, or back to
      // up-to-date; update → the clean-merge check, polled until the head
      // moves); a standing one is left to settle. Checked before a human
      // close (D19): like Stop for that one change, the running effect
      // settles and is recorded first, and a completed merge lands.
      const landingEffect = change.landingEffect
      const settling = change.state === 'landing' && (change.step === 'merging' || change.step === 'updating')
      if (settling) {
        if (landingEffect !== null && landingEffect.state === 'done'
          && ((change.step === 'merging' && landingEffect.kind === 'merge') || (change.step === 'updating' && landingEffect.kind === 'update-branch'))) {
          steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'landing-outcome', roundId: null, resultId: null, effectId: landingEffect.id })
        }
        continue
      }
      // A human close of the change's task stops it (D19); Kawai's own closes
      // happen after landing, on a change that no longer runs. Checked before
      // the failed instruction: the close itself dead-letters queued task
      // mail (member release), and the close is the cause.
      if (change.task !== null && (change.task.status === 'done' || change.task.status === 'cancelled')) {
        steps.transitions.push({
          executionId: change.executionId, change: change.change,
          guard: { state: change.state, generation: change.generation },
          patch: { state: 'stopped', stopReason: 'task-closed', step: null, stopDetail: { message: `The task was ${change.task.status} by hand.`, resumeState: change.state, ...(change.taskId !== null ? { taskId: change.taskId } : {}) } },
        })
        continue
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
              resumeState: change.state,
            },
          },
        })
        continue
      }
      if (change.task === null) continue
      // The round pipeline (D9-D11): a result becomes a round, a round is
      // pushed, PR'd, CI-read, reviewed, and decided. A landing change holds
      // the slot for its base merge, so no newer result supersedes its round.
      const newest = change.task.results.at(-1) ?? null
      if (change.state !== 'landing' && newest !== null && (change.round === null || change.round.resultId !== newest.id)) {
        steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'result', roundId: null, resultId: newest.id })
        continue
      }
      const round = change.round
      // D9: a result pinned to an older task revision can never pass — the
      // change returns for a fix attempt naming the revision (a landing
      // change too, releasing the slot), unless its merge started or an
      // update-branch effect is still settling. A round superseded once
      // stays superseded: its fix attempt is already out.
      if (round !== null && round.outcome !== 'superseded' && change.task.results.some(result => result.id === round.resultId && result.taskRevision < change.task!.revision)) {
        steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'revision', roundId: round.id, resultId: null })
        continue
      }
      if ((change.state !== 'gating' && change.state !== 'landing') || round === null) continue
      if (round.outcome === 'pass' && change.passedAt !== null) {
        // D13: a passed change lands — conditions first, then the slot, then
        // up to date and the merge.
        steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'landing', roundId: round.id, resultId: null })
        continue
      }
      if (round.outcome === 'fail') {
        // A failed round returns the change for fixes under the count rule
        // (D12) — a carried round that failed base-merge CI too, leaving the
        // slot; the executor decides stop versus dispatch.
        steps.fixes.push({ executionId: change.executionId, change: change.change, roundId: round.id })
        continue
      }
      if (round.outcome !== null) continue
      // A round's effects are found by the round, never by a key that
      // carries the generation: any transition bumps it, and a round must
      // not lose its push, its PR, or its one rerun to a bump (D10, D14).
      const ofRound = (kind: string) => change.roundEffects.filter(effect => effect.kind === kind).at(-1) ?? null
      const live = (effect: { state: string } | null) => effect !== null && (effect.state === 'pending' || effect.state === 'running' || effect.state === 'unknown')
      const ciStage = () => {
        if (!live(ofRound('rerun'))) steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'ci', roundId: round.id, resultId: null })
      }
      if (round.carriedFrom !== null) {
        // A carried round keeps its review: CI on the new head decides it.
        ciStage()
        continue
      }
      if (round.pushedAt === null) {
        if (!live(ofRound('push'))) steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'push', roundId: round.id, resultId: null })
        continue
      }
      // The change's one pull request: each round re-lists once (reusing an
      // open one, stopping on a closed one — plan-landing); CI and the review
      // wait for it, so no review is dispatched for a round without its PR.
      if (change.branch !== null) {
        const pull = ofRound('open-pr')
        if (pull === null || pull.state === 'failed' || pull.state === 'cancelled') {
          steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'open-pr', roundId: round.id, resultId: null })
          continue
        }
        if (live(pull)) continue
      }
      if (round.reviewAssignmentId !== null) {
        steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'verdict', roundId: round.id, resultId: null })
      } else {
        ciStage()
      }
    }
  }
  return steps
}
