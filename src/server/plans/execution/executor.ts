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
import type { ChatSessionRecord } from '../../db'
import type { TaskService } from '../../team/TaskService'
import type { TaskResultService } from '../../team/TaskResultService'
import type { AssignmentService } from '../../team/AssignmentService'
import { runGit } from '../../git/gitCommand'
import { assignmentState } from '../../team/assignmentStore'
import type { MailboxStore } from '../../team/mailboxStore'
import { githubRepoOf } from '../landing/landingProbe'
import { lsRemoteHead } from '../landing/gitRemote'
import { ghCheckRuns, ghPrList, ghPrView, ghRunAttempt, ghStatuses } from '../landing/github'
import { inspectUnknownEffects } from './effectInspectors'
import { applyLanding, applyLandingOutcome, landingAdapters, mergeAdapter, removeWorktreeAdapter, updateBranchAdapter } from './executionLanding'
import type { CiCheck } from '../../../shared/planExecution'
import type { GhCommandOptions } from '../landing/ghCommand'
import { executionSnapshot } from './executionSnapshot'
import { planSteps } from './executionPlanner'
import { EffectRunner, type EffectAdapter } from './effects'
import type { ExecutionStore } from './executionStore'
import type { PlanStore } from '../planStore'
import { dispatchFixAttempt, dispatchImplementAttempt } from './executionDispatch'
import { fixRoundOutcome } from '../../../shared/planExecutionProgress'
import { applyRoundStage, openPrAdapter, pushAdapter, recordPull, rerunAdapter, roundAdapters } from './executionRounds'

/** D5's polling interval while a team has a running execution. */
export const EXECUTOR_TICK_MS = 60_000

export interface ExecutorDeps {
  store: ExecutionStore
  plans: PlanStore
  tasks: TaskService
  assignments: AssignmentService
  /** Review handoffs dispatch through the result service (D11). */
  results?: TaskResultService
  /** Every live session record (author profiles for review tags). */
  records?: () => Iterable<ChatSessionRecord>
  /** The team's mailbox (assignment states derive from instruction mail). */
  mailbox?: MailboxStore
  /** D11's release step, wired to member-release by the composition. */
  releases?: { readiness: (sessionId: string) => { ready: boolean; reason: string | null }; release: (sessionId: string) => void }
  /** The plan service, for the system completion when everything landed (D19). */
  plansService?: import('../PlanService').PlanService
  /** D13's live condition read: unresolved acceptance-gated conditions per change. */
  conditionsOf?: (change: string) => string[]
  /** The landing adapters (defaults to the real git/gh). */
  landingAdapters?: import('./executionLanding').LandingAdapters
  /** Whether a group's current file is worktree-scoped (default true). */
  groupScoped?: (teamId: string, groupId: string) => boolean
  /** The team's identity; without it (unknown team) a tick does nothing. */
  teamOf: (teamId: string) => TeamIdentity | undefined
  /** Effect adapters by kind; a kind without one fails its effect. */
  adapters?: Partial<Record<string, EffectAdapter>>
  /** Round-pipeline adapters (push, PRs, CI, rerun); defaults to the real gh/git. */
  roundAdapters?: typeof roundAdapters
  /** Passed to every gh call (tests stub gh on a private PATH). */
  ghOptions?: GhCommandOptions
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

  /**
   * Startup recovery (D14): every `running` effect becomes `unknown` and is
   * inspected before anything else for its change runs; the teams that hold
   * running executions are woken. An exhausted inspection stops its change
   * as effect-unknown (D12).
   */
  async startup(inspect?: (deps: Parameters<typeof import('./effectInspectors').inspectUnknownEffects>[0]) => void): Promise<void> {
    const unknown = this.deps.store.markRunningEffectsUnknown()
    const teams = new Set(unknown.map(effect => this.deps.store.execution(effect.executionId)?.teamId ?? ''))
    for (const teamId of teams) {
      if (teamId === '') continue
      const reads: import('./effectInspectors').InspectorReads = {
        worktree: async (repo, wt) => {
          const listed = await runGit(['worktree', 'list', '--porcelain'], { cwd: repo })
          const present = listed.ok && listed.stdout.split('\n').some(line => line.startsWith('worktree ') && line.slice(8) === wt)
          if (!present) return { present: false, head: null }
          const head = await runGit(['rev-parse', 'HEAD'], { cwd: wt })
          return { present: true, head: head.ok ? head.stdout.trim() : null }
        },
        localBranch: async (repo, branch) => {
          const result = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo })
          return result.ok ? result.stdout.trim() : null
        },
        remoteHead: async (cwd, ref) => {
          const result = await lsRemoteHead(cwd, ref)
          return result.ok ? result.sha : null
        },
        prList: async (repo, head) => {
          const pulls = await ghPrList(repo, { head, base: '' }, this.deps.ghOptions)
          return pulls.ok ? pulls.data : []
        },
        prView: async (repo, pr) => {
          const view = await ghPrView(repo, pr, this.deps.ghOptions)
          return view.ok ? view.data : { number: pr, url: '', state: 'OPEN', headRefOid: '', mergeCommit: null }
        },
        runAttempt: async (repo, runId) => {
          const attempt = await ghRunAttempt(repo, runId, this.deps.ghOptions)
          return attempt.ok ? attempt.data : 1
        },
      }
      await inspectUnknownEffects({
        store: this.deps.store, reads,
        ...(this.deps.now ? { now: this.deps.now } : {}),
        onUnknownSettled: effect => {
          if (effect.change === null) return
          const row = this.deps.store.change(effect.executionId, effect.change)
          if (row === null || row.state === 'stopped') return
          this.deps.store.transition(effect.executionId, effect.change, row, {
            state: 'stopped', stopReason: 'effect-unknown', step: null, stopDetail: { message: effect.error ?? 'the outcome could not be determined' },
          })
        },
      })
      this.wake(teamId)
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
      const snapshot = executionSnapshot(teamId, team.groupsRoot, this.deps.store, this.deps.plans,
        taskId => this.deps.tasks.store.results.listByTask(taskId)
          .map(result => ({ id: result.id, commit: result.commit, taskRevision: result.taskRevision, submittedBySession: result.submittedBy.kind === 'agent' ? result.submittedBy.sessionId : null }))
          .reverse(),
        taskId => this.deps.tasks.store.get(taskId)?.revision ?? 1,
        taskId => this.deps.tasks.store.get(taskId)?.status ?? 'active',
        taskId => {
          // Without a mailbox wired there is no instruction fact to read.
          if (this.deps.mailbox === undefined) return null
          const outstanding = this.deps.tasks.store.assignmentsOf(taskId).find(row => row.supersededBy === null)
          if (outstanding === undefined) return null
          const state = assignmentState(outstanding, outstanding.messageId !== null ? this.deps.mailbox.get(outstanding.messageId) : null)
          return { id: outstanding.id, state: state.state, reason: state.reason }
        })
      if (snapshot.executions.length === 0) return
      const steps = planSteps(snapshot, this.deps.now?.().toISOString() ?? new Date().toISOString())
      if (steps.transitions.length === 0 && steps.effects.length === 0 && steps.dispatches.length === 0 && steps.stages.length === 0 && steps.fixes.length === 0) return

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
          { team, executions: this.deps.store, plans: this.deps.plans, tasks: this.deps.tasks, assignments: this.deps.assignments,
        ...(this.deps.results ? { results: this.deps.results } : {}) },
          step,
        )
      }
      for (const stage of steps.stages) {
        const row = this.deps.store.change(stage.executionId, stage.change)
        if (row === null) continue
        if (stage.kind === 'landing' || stage.kind === 'post-ci') {
          await this.applyLandingStage(team, row, stage)
          continue
        }
        await applyRoundStage(this.roundDeps(team), row, stage)
      }
      for (const fix of steps.fixes) {
        await this.applyFix(team, fix)
      }
      if (steps.effects.length > 0 || steps.fixes.length > 0 || steps.stages.length > 0) {
        // A done effect's follow-on transition lands with its outcome (D14),
        // so the next pass sees the state it implies.
        await this.runner(teamId).runDue(teamId)
      }
    }
  }

  private roundDeps(team: TeamIdentity): import('./executionRounds').RoundDeps {
    return {
      team,
      repo: this.repoOf(team),
      executions: this.deps.store,
      plans: this.deps.plans,
      tasks: this.deps.tasks,
      results: this.deps.results as TaskResultService,
      assignments: this.deps.assignments,
      adapters: this.deps.roundAdapters ?? roundAdapters,
      ...(this.deps.records ? { records: this.deps.records } : {}),
      ...(this.deps.ghOptions ? { ghOptions: this.deps.ghOptions } : {}),
      ...(this.deps.releases ? { releases: this.deps.releases } : {}),
      groupScoped: (teamId, groupId) => this.deps.groupScoped?.(teamId, groupId) ?? true,
      now: () => (this.deps.now?.() ?? new Date()).toISOString(),
    }
  }

  /** origin as owner/repo, read once from the main checkout's remote (the probe's fact). */
  private repoCache = new Map<string, string>()
  private repoOf(team: TeamIdentity): string {
    const cached = this.repoCache.get(team.teamId)
    if (cached !== undefined) return cached
    const remote = runGit(['config', '--get', 'remote.origin.url'], { cwd: team.groupsRoot })
    const repo = remote.ok ? githubRepoOf(remote.stdout) ?? '' : ''
    this.repoCache.set(team.teamId, repo)
    return repo
  }

  private runner(teamId: string): EffectRunner {
    return new EffectRunner({
      store: this.deps.store,
      adapter: {
        call: async effect => {
          const adapters = this.deps.adapters ?? {}
          const rounds = this.deps.roundAdapters ?? roundAdapters
          const landing = this.deps.landingAdapters ?? landingAdapters
          const adapter = adapters[effect.kind]
            ?? (effect.kind === 'push' ? pushAdapter(rounds)
              : effect.kind === 'open-pr' ? openPrAdapter(rounds, this.deps.ghOptions)
                : effect.kind === 'rerun' ? rerunAdapter(rounds, this.deps.ghOptions)
                  : effect.kind === 'update-branch' ? updateBranchAdapter(landing, this.deps.ghOptions)
                    : effect.kind === 'merge' ? mergeAdapter(landing, this.deps.ghOptions)
                    : effect.kind === 'remove-worktree' ? removeWorktreeAdapter()
                      : undefined)
          if (adapter === undefined) {
            return { ok: false, error: { argv: ['executor', effect.kind], exitCode: 1, stderr: `no adapter for kind ${effect.kind}` } }
          }
          return adapter.call(effect)
        },
      },
      onDone: effect => {
        this.applyEffectOutcome(effect)
        if (effect.kind === 'merge' || effect.kind === 'update-branch') {
          const execution = this.deps.store.execution(effect.executionId)
          const team = execution === null ? undefined : this.deps.teamOf(execution.teamId)
          if (team !== undefined && effect.change !== null) {
            void applyLandingOutcome({
              team,
              repo: this.repoOf(team),
              executions: this.deps.store,
              plans: this.deps.plans,
              ...(this.deps.results ? { results: this.deps.results } : {}),
              ...(this.deps.plansService ? { plansService: this.deps.plansService } : {}),
              ...(this.deps.ghOptions ? { ghOptions: this.deps.ghOptions } : {}),
              ...(this.deps.records ? { records: this.deps.records } : {}),
              now: () => (this.deps.now?.() ?? new Date()).toISOString(),
            }, effect).then(() => this.wake(team.teamId)).catch(() => undefined)
          }
        }
      },
      onFailed: effect => this.applyEffectFailure(effect),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    })
  }

  /** The landing stages (D13): a passed change lands; a landed change's base CI lands as evidence. */
  private async applyLandingStage(team: import('../../team/teamIdentity').TeamIdentity, row: import('./executionRows').ChangeRow, stage: { kind: string; roundId: string | null }): Promise<void> {
    if (stage.kind === 'landing' && stage.roundId !== null) {
      const round = this.deps.store.round(stage.roundId)
      if (row.branch === null || round === null) return
      await applyLanding({
        team,
        repo: this.repoOf(team),
        executions: this.deps.store,
        plans: this.deps.plans,
        ...(this.deps.results ? { results: this.deps.results } : {}),
        ...(this.deps.plansService ? { plansService: this.deps.plansService } : {}),
        ...(this.deps.ghOptions ? { ghOptions: this.deps.ghOptions } : {}),
        ...(this.deps.conditionsOf ? { conditionsOf: this.deps.conditionsOf } : {}),
        ...(this.deps.records ? { records: this.deps.records } : {}),
        now: () => (this.deps.now?.() ?? new Date()).toISOString(),
      }, this.deps.landingAdapters ?? landingAdapters, row, round)
      return
    }
    if (stage.kind === 'post-ci') {
      // D13 step 6: base-branch CI on the merge commit, polled until done.
      const execution = this.deps.store.execution(row.executionId)
      const fact = execution === null ? null : this.deps.store.landings(execution.planId).find(entry => entry.change === row.change)
      if (execution === null || fact === null || fact === undefined) return
      const runs = await ghCheckRuns(this.repoOf(team), fact.mergeSha, this.deps.ghOptions)
      const statuses = await ghStatuses(this.repoOf(team), fact.mergeSha, this.deps.ghOptions)
      if (!runs.ok || !statuses.ok) return
      const checks: CiCheck[] = [...runs.data, ...statuses.data]
      const pending = checks.some(check => ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(check.conclusion.toLowerCase()))
      if (!pending) this.deps.store.setLandingPostCi(execution.planId, row.change, checks)
    }
  }

  /**
   * D12's fix step: the count rule decides — three consecutive failed fix
   * rounds stop the change, anything else returns it to implementing and
   * dispatches the fix attempt naming the failing checks, findings, count,
   * and the commit to continue from.
   */
  private async applyFix(team: import('../../team/teamIdentity').TeamIdentity, fix: { executionId: string; change: string; roundId: string }): Promise<void> {
    const store = this.deps.store
    const round = store.round(fix.roundId)
    const row = store.change(fix.executionId, fix.change)
    if (round === null || row === null || row.state !== 'gating') return
    const outcome = fixRoundOutcome(row.fixRounds, { fixRound: round.fixRound, outcome: 'fail' })
    if (outcome.stop) {
      store.transition(fix.executionId, fix.change, row, {
        state: 'stopped', stopReason: 'round-limit', step: null,
        stopDetail: { message: `Three consecutive failed fix rounds.`, checks: (round.ci ?? []).filter(check => check.conclusion === 'failure').map(check => check.name) },
      })
      return
    }
    const moved = store.transition(fix.executionId, fix.change, row, { state: 'implementing', step: null, fixRounds: outcome.count })
    if (moved === null) return
    const revision = this.deps.plans.revision(store.execution(fix.executionId)!.planId, store.execution(fix.executionId)!.revision)
    const group = revision?.content.changes.find(entry => entry.change === fix.change)?.group
    if (group === null || group === undefined) return
    const failing = (round.ci ?? []).filter(check => check.conclusion.toLowerCase() === 'failure')
      .map(check => ({ name: check.name, conclusion: check.conclusion, link: check.link }))
    const all = row.taskId === null ? [] : this.deps.tasks.store.results.findingsFor(round.resultId)
    const findings = round.verdictFindingsId !== null ? all.filter(entry => entry.id === round.verdictFindingsId) : all
    await dispatchFixAttempt(
      { team, executions: store, plans: this.deps.plans, tasks: this.deps.tasks, assignments: this.deps.assignments,
        ...(this.deps.results ? { results: this.deps.results } : {}) },
      {
        executionId: fix.executionId, change: fix.change, group,
        failingChecks: failing,
        findingsIds: findings.map(row => row.id),
        findingsTexts: findings.map(row => row.findings),
        continueFrom: round.commitSha,
        fixRounds: outcome.count,
      },
    )
  }

  /** A failed effect stops its change (D14): effect-failed, or pr-closed when the PR was closed. */
  private applyEffectFailure(effect: { id: string; kind: string; change: string | null; executionId: string; error: string | null }): void {
    if (effect.change === null) return
    const row = this.deps.store.change(effect.executionId, effect.change)
    if (row === null || row.state === 'stopped') return
    const error = effect.error ?? ''
    const reason = error.includes('pr-closed') ? 'pr-closed'
      : error.includes('name-taken') ? 'name-taken' : 'effect-failed'
    this.deps.store.transition(effect.executionId, effect.change, row, {
      state: 'stopped',
      stopReason: reason,
      stopDetail: { message: effect.error ?? 'the effect failed' },
      step: null,
    })
  }

  /** A settled effect's follow-on transition (D14: the outcome commits with it). */
  private applyEffectOutcome(effect: { id: string; kind: string; change: string | null; roundId?: string | null; executionId: string; state: string; outcome: unknown }): void {
    if (effect.kind === 'push' && effect.change !== null && typeof effect.roundId === 'string') {
      this.deps.store.markRoundPushed(effect.roundId, (this.deps.now?.() ?? new Date()).toISOString())
      return
    }
    if (effect.kind === 'open-pr' && effect.change !== null) {
      const outcome = effect.outcome as { number?: unknown; url?: unknown; openedByKawai?: unknown } | null
      if (typeof outcome?.number === 'number' && typeof outcome.url === 'string') {
        recordPull(this.deps.store, effect.executionId, effect.change, {
          number: outcome.number, url: outcome.url, openedByKawai: outcome.openedByKawai === true,
        })
      }
      return
    }
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
