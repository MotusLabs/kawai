// The executor's per-team dependency bundles (plan-execution D5), split out
// of executor.ts to keep the loop under the 500-line floor: the same objects
// the class built inline, now plain module functions over `ExecutorDeps`.
// Behavior-neutral: the class keeps thin wrappers, the repo cache, and
// `mechanismOf`, passed in where the moved bodies read it.
import type { TeamIdentity } from '../../team/teamIdentity'
import { applyEffectFailure, applyEffectOutcome, type OutcomeDeps } from './executorOutcomes'
import { landingAdapters, removeWorktreeAdapter } from './executionLanding'
import type { LandingDeps } from './executionLanding'
import type { LandingMechanism } from '../landing/landingMechanisms'
import { EffectRunner } from './effects'
import { dispatchRevisionAttempt, openPrAdapter, pushAdapter, rerunAdapter, roundAdapters, type RoundDeps } from './executionRounds'
import { dispatchUpdateAttempt, type DispatchDeps } from './executionDispatch'
import type { GhCommandOptions } from '../landing/ghCommand'
import type { ExecutorDeps } from './executor'

/** The round pipeline's deps (D9-D11), over the executor's. */
export function roundDeps(deps: ExecutorDeps, team: TeamIdentity, repo: string, gate?: (change: string) => boolean): RoundDeps {
  return {
    team,
    repo,
    executions: deps.store,
    plans: deps.plans,
    tasks: deps.tasks,
    results: deps.results,
    assignments: deps.assignments,
    adapters: deps.roundAdapters ?? roundAdapters,
    records: deps.records,
    ...(deps.ghOptions ? { ghOptions: deps.ghOptions } : {}),
    releases: deps.releases,
    groupScoped: deps.groupScoped,
    now: () => (deps.now?.() ?? new Date()).toISOString(),
    ...(gate ? { gate } : {}),
    ...(deps.reviewRestart ? { reviewRestart: deps.reviewRestart } : {}),
  }
}

/** The landing deps (D13), with the revision attempt dispatched through the round deps. */
export function landingDeps(deps: ExecutorDeps, team: TeamIdentity, repo: string, rounds: () => RoundDeps, gate?: (change: string) => boolean): LandingDeps {
  return {
    team, repo, executions: deps.store, plans: deps.plans,
    results: deps.results, plansService: deps.plansService, conditionsOf: deps.conditionsOf, records: deps.records,
    ...(deps.ghOptions ? { ghOptions: deps.ghOptions } : {}),
    now: () => (deps.now?.() ?? new Date()).toISOString(),
    revisionAttempt: (changeRow, round, update) => dispatchRevisionAttempt(rounds(), changeRow, round, update),
    updateAttempt: (changeRow, round, update) => dispatchUpdateAttempt(dispatchDeps(deps, team), {
      executionId: changeRow.executionId, change: changeRow.change, round, update,
    }),
    taskStatusOf: taskId => deps.tasks.store.get(taskId)?.status ?? null,
    ...(gate ? { gate } : {}),
  }
}

/** The dispatch deps (D7/D8, D12). */
export function dispatchDeps(deps: ExecutorDeps, team: TeamIdentity): DispatchDeps {
  return { team, executions: deps.store, plans: deps.plans, tasks: deps.tasks, assignments: deps.assignments, results: deps.results }
}

/** The effect outcomes' deps (D14): the store, the live task statuses, the mechanism. */
export function outcomeDeps(deps: ExecutorDeps, mechanismOf: (executionId: string) => LandingMechanism): OutcomeDeps {
  return {
    store: deps.store,
    taskStatusOf: taskId => deps.tasks.store.get(taskId)?.status ?? null,
    mechanismOf: executionId => mechanismOf(executionId),
    now: () => deps.now?.() ?? new Date(),
    ...(deps.checkpoints ? { recordResultCheckpoint: (executionId: string, change: string, roundId: string) => deps.checkpoints!.recordResultCheckpoint(executionId, change, roundId) } : {}),
  }
}

/** The effect runner (D14): the adapters resolved by kind, the outcome follow-ons. */
export function effectRunner(deps: ExecutorDeps, mechanismOf: (executionId: string) => LandingMechanism): EffectRunner {
  return new EffectRunner({
    store: deps.store,
    adapter: {
      call: async effect => {
        const adapters = deps.adapters ?? {}
        const rounds = deps.roundAdapters ?? roundAdapters
        const landing = deps.landingAdapters ?? landingAdapters
        const gh: GhCommandOptions | undefined = deps.ghOptions
        const adapter = adapters[effect.kind]
          ?? (effect.kind === 'push' || effect.kind === 'push-checkpoint' ? pushAdapter(rounds)
            : effect.kind === 'open-pr' ? openPrAdapter(rounds, gh)
              : effect.kind === 'rerun' ? rerunAdapter(rounds, gh)
                : effect.kind === 'remove-worktree' ? removeWorktreeAdapter()
                  : mechanismOf(effect.executionId).effectAdapter(effect.kind, landing, gh))
        if (adapter === undefined) {
          return { ok: false, error: { argv: ['executor', effect.kind], exitCode: 1, stderr: `no adapter for kind ${effect.kind}` } }
        }
        return adapter.call(effect)
      },
    },
    // A done effect's follow-on transition commits with its outcome (D14);
    // merge and update-branch outcomes are applied by the next pass's
    // landing-outcome stage, inside the single-flight tick.
    onDone: effect => applyEffectOutcome(outcomeDeps(deps, mechanismOf), effect),
    onFailed: effect => applyEffectFailure(outcomeDeps(deps, mechanismOf), effect),
    ...(deps.now ? { now: deps.now } : {}),
  })
}
