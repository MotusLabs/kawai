// The executor (plan-execution D5): a stored-state loop, single-flight per
// team. `wake(teamId)` schedules one tick; a team never has two at once.
// A tick loads the snapshot, asks the pure `planSteps` for the due
// transitions and effects, applies each transition in its own guarded
// transaction, inserts the effect rows, performs the task-creation and
// dispatch steps, then runs the due effects through the runner — a done
// provision commits its follow-on transition in the same step — and wakes
// again, because a step settled is a step due. While the team has a running
// execution a 60-second timer keeps the loop alive for CI polling, backoffs,
// and timeouts. Everything a tick reads is stored, so a restart resumes
// from the rows alone.
import type { TeamIdentity } from '../../team/teamIdentity'
import type { TaskService } from '../../team/TaskService'
import type { AssignmentService } from '../../team/AssignmentService'
import { executionSnapshot } from './executionSnapshot'
import { planSteps } from './executionPlanner'
import { EffectRunner, type EffectAdapter } from './effects'
import type { ExecutionStore } from './executionStore'
import type { PlanStore } from '../planStore'
import { dispatchImplementAttempt } from './executionDispatch'

/** D5's polling interval while a team has a running execution. */
export const EXECUTOR_TICK_MS = 60_000

export interface ExecutorDeps {
  store: ExecutionStore
  plans: PlanStore
  tasks: TaskService
  assignments: AssignmentService
  /** The team's identity; without it (unknown team) a tick does nothing. */
  teamOf: (teamId: string) => TeamIdentity | undefined
  /** Effect adapters by kind; a kind without one fails its effect. */
  adapters: Partial<Record<string, EffectAdapter>>
  now?: () => Date
}

export class ExecutionExecutor {
  private readonly ticking = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: ExecutorDeps) {}

  /** Schedule one tick for the team; concurrent wakes share it (D5). */
  wake(teamId: string): void {
    if (this.ticking.has(teamId)) return
    this.ticking.add(teamId)
    void this.tick(teamId).finally(() => {
      this.ticking.delete(teamId)
      this.scheduleTimer(teamId)
    })
  }

  /** The in-flight tick, for callers and tests that need to await it. */
  async idle(): Promise<void> {
    while (this.ticking.size > 0) {
      await new Promise(resolve => setImmediate(resolve))
    }
  }

  /** Stop the timers (tests, shutdown). */
  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** One tick; exposed for tests, production goes through `wake`. */
  async tick(teamId: string): Promise<void> {
    const team = this.deps.teamOf(teamId)
    if (team === undefined) return
    // A settled step makes the next due: the tick loops until a pass owes
    // nothing, bounded so a pathological loop cannot spin forever.
    for (let pass = 0; pass < 10; pass++) {
      const snapshot = executionSnapshot(teamId, team.groupsRoot, this.deps.store, this.deps.plans)
      if (snapshot.executions.length === 0) return
      const steps = planSteps(snapshot, this.deps.now?.().toISOString() ?? new Date().toISOString())
      if (steps.transitions.length === 0 && steps.effects.length === 0 && steps.dispatches.length === 0) return

      for (const step of steps.transitions) {
        this.deps.store.transition(step.executionId, step.change, step.guard, step.patch)
      }
      for (const step of steps.effects) {
        this.deps.store.insertEffect({
          executionId: step.executionId, change: step.change, roundId: null,
          kind: step.kind, effectKey: step.effectKey, command: step.command,
        })
      }
      for (const step of steps.dispatches) {
        await dispatchImplementAttempt(
          { team, executions: this.deps.store, plans: this.deps.plans, tasks: this.deps.tasks, assignments: this.deps.assignments },
          step,
        )
      }
      if (steps.effects.length > 0) {
        // A done effect's follow-on transition lands with its outcome (D14),
        // so the next pass sees the state it implies.
        await this.runner(teamId).runDue(teamId)
      }
    }
  }

  private runner(teamId: string): EffectRunner {
    return new EffectRunner({
      store: this.deps.store,
      adapter: {
        call: async effect => {
          const adapter = this.deps.adapters[effect.kind]
          if (adapter === undefined) {
            return { ok: false, error: { argv: ['executor', effect.kind], exitCode: 1, stderr: `no adapter for kind ${effect.kind}` } }
          }
          return adapter.call(effect)
        },
      },
      onDone: effect => this.applyEffectOutcome(effect),
      onFailed: effect => this.applyEffectOutcome(effect),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    })
  }

  /** A settled effect's follow-on transition (D14: the outcome commits with it). */
  private applyEffectOutcome(effect: { id: string; kind: string; change: string | null; executionId: string; state: string; outcome: unknown }): void {
    if (effect.kind === 'provision' && effect.change !== null && effect.state === 'done') {
      const outcome = effect.outcome as { path?: unknown; branch?: unknown; baseline?: unknown }
      const row = this.deps.store.change(effect.executionId, effect.change)
      if (row === null || row.state !== 'provisioning') return
      this.deps.store.transition(effect.executionId, effect.change, row, {
        state: 'implementing',
        worktree: typeof outcome.path === 'string' ? outcome.path : null,
        branch: typeof outcome.branch === 'string' ? outcome.branch : null,
        baselineCommit: typeof outcome.baseline === 'string' ? outcome.baseline : null,
      })
    }
  }

  /** While the team runs an execution, the 60-second timer keeps the loop alive (D5). */
  private scheduleTimer(teamId: string): void {
    clearTimeout(this.timers.get(teamId))
    this.timers.delete(teamId)
    if (this.deps.store.runningForTeam(teamId).length === 0) return
    this.timers.set(teamId, setTimeout(() => {
      this.timers.delete(teamId)
      this.wake(teamId)
    }, EXECUTOR_TICK_MS))
  }
}
