// ExecutionService (plan-execution D4): the human Start and preview
// commands. It refuses agent callers first — no agent tool can start an
// execution, and this service is the only place that mints the system
// caller (D2). Start runs the pre-reads (validation standing, group files,
// the settings snapshot, the landing probe, the changes-on-base blob
// comparison), then one transaction through PlanService.recordExecutionEvent
// that replays by command id, evaluates every START_PRECONDITIONS entry, and
// inserts the execution, its change rows, and the `execution-started` event;
// the executor is woken only after a real commit. The probe's findings can
// age between the read and the commit; provisioning's own name check and the
// push and PR effects cover that gap, so the probe is not repeated inside
// the transaction.
import type { ChatSessionRecord } from '../../db'
import type { TeamIdentity } from '../../team/teamIdentity'
import { loadGroupCatalog } from '../../team/groupCatalog'
import type { PlanRevision } from '../../../shared/plans'
import type { ImpactGate } from '../../../shared/strategyImpact'
import { FLOOR_VERSION } from '../../../shared/planExecution'
import type { EffectKind } from '../../../shared/planExecution'
import type { ChangeRow, ExecutionRow } from './executionRows'
import { logger } from '../../logger'
import { StaleTaskStatus, type PreparedTaskStatus } from '../../team/taskStatusPrepared'
import { ExecutionConflict } from './executionStore'
import type { ExecutionStore } from './executionStore'
import { PlanRefusal, type PlanCommandOutcome, type PlanRefusalReason } from '../planCommands'
import type { PlanService } from '../PlanService'
import type { PlanStore } from '../planStore'
import type { ValidationStanding } from '../validation/validationStanding'
import { compareWithOriginTree, probeLanding, validatedFilesOf, type ProbeResult } from '../landing/landingProbe'
import type { LandingMechanisms } from '../landing/landingMechanisms'
import { DIRECT_MECHANISMS, directMechanism } from '../landing/directMechanism'
import { ghTreeEntries } from '../landing/github'
import type { GhCommandOptions } from '../landing/ghCommand'
import type { PlanExecutionSettings } from '../../team/teamCaps'
import { evaluateStartPreconditions, type StartCheckContext, type StartRoleFact } from './startPreconditions'
import { readIntegrationStartFacts } from '../landing/integration/integrationStart'

export type ExecutionCaller = { kind: 'human'; team: TeamIdentity } | { kind: 'agent'; sessionId: string }

export interface StartInput {
  planId: string
  revision: number
  contentHash: string
  commandId: string
}

export type StartOutcome =
  | { ok: true; replayed: boolean; execution: ExecutionRow }
  | { ok: false; reason: PlanRefusalReason; message: string; failures?: Array<{ name: string; message: string }> }

/** What Start and preview read before any write (D4 step 1). */
export interface StartGather {
  probe: ProbeResult
  baseDiffs: Array<{ change: string; files: string[] }>
  roles: StartRoleFact[]
  landed: ReadonlySet<string>
  settings: PlanExecutionSettings
  /** integration-candidates D8: landing facts the base head lacks. */
  offBaseLandings: StartCheckContext['offBaseLandings']
}

/**
 * A2 (effect lifecycle): the landing kinds a Retry resumes at their own step
 * inside `landing` — the stage the change stopped in, past the slot and
 * up-to-date steps it already passed. The re-opened row is inspected first,
 * so the resumed stage issues nothing until its verdict decides.
 */
const RESUME_AT_STEP: Partial<Record<EffectKind, 'merging' | 'updating'>> = {
  merge: 'merging', 'fast-forward': 'merging', 'update-branch': 'updating',
}

export class ExecutionService {
  constructor(private readonly deps: {
    store: ExecutionStore
    plansStore: PlanStore
    plans: PlanService
    validation: {
      prepareStanding: (planId: string, revision: number) => Promise<unknown> | null
      standing: (prepared: unknown) => unknown
    }
    impact: { gate: (planId: string, revision: number) => ImpactGate | null }
    settings: { planExecution: (teamId: string) => Promise<PlanExecutionSettings> }
    getSession: (id: string) => ChatSessionRecord | null | undefined
    /** The registered landing mechanism modes (D13's registry; the wiring arrives with the landing sections). */
    landingModes: () => ReadonlySet<string>
    /** The landing probe (D13); tests stub it, else the plan's mechanism probes. */
    probe?: typeof probeLanding
    /** The registered landing mechanisms, by mode (the composition's; direct only by default). */
    mechanisms?: LandingMechanisms
    /** integration-candidates D8: the plan's running promotion (promotion-idle). */
    promotions: { runningPromotion: (planId: string) => StartCheckContext['runningPromotion'] }
    /** integration-candidates D8's landings-on-base pre-read; tests stub it. */
    startFacts?: typeof readIntegrationStartFacts
    /** Kawai cancels its tasks on Stop through the task service (D12). */
    tasks?: import('../../team/TaskService').TaskService
    /** The team's identity for Kawai's own stop (D19's plan-close hook). */
    identityOf: (teamId: string) => TeamIdentity
    /** Woken after a Start commits (the executor, D5); never on a replay or refusal. */
    wake?: (teamId: string) => void
    homeDir?: string
    /** Passed to every gh call (tests put a stub gh on a private PATH). */
    ghOptions?: GhCommandOptions
  }) {}

  /** Start an execution of the plan's revision (human only, D4). */
  async start(caller: ExecutionCaller, input: StartInput): Promise<StartOutcome> {
    if (caller.kind !== 'human') {
      return { ok: false, reason: 'forbidden', message: 'Only the human can start an execution, from the Plans view. No agent tool can.' }
    }
    const plan = this.deps.plansStore.forTeam(caller.team.teamId, input.planId)
    if (!plan) return { ok: false, reason: 'not-found', message: `Plan not found in this team: ${input.planId}` }
    const revisionRow = this.deps.plansStore.revision(plan.id, input.revision)
    const gather = await this.gather(caller.team, plan.id, revisionRow)
    const prepared = await this.deps.validation.prepareStanding(plan.id, input.revision)
    const commandId = input.commandId.trim()
    if (!commandId) return { ok: false, reason: 'invalid', message: 'Start needs a stable command id so a resend replays instead of repeating.' }

    const outcome = this.deps.plans.recordExecutionEvent<{ executionId: string } | null>(plan.id, {
      kind: 'execution-started', commandId, revision: input.revision, contentHash: input.contentHash,
    }, () => {
      const ctx = this.context(caller.team, { ...input, commandId }, gather, prepared)
      const failures = evaluateStartPreconditions(ctx)
      if (failures.length > 0) {
        throw new PlanRefusal('precondition', `Start refused: ${failures.map(failure => `${failure.name}: ${failure.message}`).join(' ')}`, failures)
      }
      const settings = gather.settings
      const execution = this.deps.store.insertExecution({
        teamId: caller.team.teamId, planId: plan.id, revision: input.revision, contentHash: input.contentHash,
        reportId: ctx.reportId!, inputHash: ctx.inputHash!,
        landingMode: ctx.landingMode, baseBranch: gather.probe.base!.branch, baseCommit: gather.probe.base!.head,
        floor: { version: FLOOR_VERSION, map: settings.floorChecks! },
        maxParallel: settings.maxParallelChanges, mergeMethod: settings.mergeMethod,
        changes: ctx.changes.map(change => ({ change, landed: gather.landed.has(change) })),
      })
      // The mechanism's execution-level effects commit with the execution (integration-candidates D4).
      const mechanism = (this.deps.mechanisms ?? DIRECT_MECHANISMS).get(ctx.landingMode)
      for (const effect of mechanism?.startEffects?.({ execution, probe: gather.probe, main: caller.team.groupsRoot }) ?? []) {
        this.deps.store.insertEffect({ executionId: execution.id, change: null, roundId: null, ...effect })
      }
      return { executionId: execution.id }
    })
    if (!outcome.ok) return outcome
    if (!outcome.replayed) this.deps.wake?.(caller.team.teamId)
    return { ok: true, replayed: outcome.replayed, execution: outcome.result?.executionId !== undefined
      ? this.deps.store.execution(outcome.result.executionId)!
      : this.priorExecution(plan.id, input) }
  }

  /** The standing the Start dialog reads when it opens (D4: the same reads, no write). */
  async preview(caller: ExecutionCaller, input: { planId: string; revision: number }): Promise<
    | { ok: true; failures: Array<{ name: string; message: string }>; probe: ProbeResult }
    | { ok: false; reason: 'forbidden' | 'not-found'; message: string }
  > {
    if (caller.kind !== 'human') {
      return { ok: false, reason: 'forbidden', message: 'Only the human can preview an execution, from the Plans view. No agent tool can.' }
    }
    const plan = this.deps.plansStore.forTeam(caller.team.teamId, input.planId)
    if (!plan) return { ok: false, reason: 'not-found', message: `Plan not found in this team: ${input.planId}` }
    const revisionRow = this.deps.plansStore.revision(plan.id, input.revision)
    const gather = await this.gather(caller.team, plan.id, revisionRow)
    const prepared = await this.deps.validation.prepareStanding(plan.id, input.revision)
    const ctx = this.context(caller.team, { planId: plan.id, revision: input.revision, contentHash: revisionRow?.contentHash ?? '', commandId: 'preview' }, gather, prepared)
    return { ok: true, failures: evaluateStartPreconditions(ctx), probe: gather.probe }
  }

  /** The D4 step-1 reads: settings, group files, the probe, and the changes-on-base comparison. */
  private async gather(team: TeamIdentity, planId: string, revisionRow: PlanRevision | null): Promise<StartGather> {
    const changes = revisionRow?.content.changes ?? []
    const names = changes.map(entry => entry.change)
    const settings = await this.deps.settings.planExecution(team.teamId)
    const catalog = loadGroupCatalog({ groupsRoot: team.groupsRoot, ...(this.deps.homeDir ? { homeDir: this.deps.homeDir } : {}) })
    const roles: StartRoleFact[] = changes.map(entry => {
      const found = entry.group === null ? undefined : catalog.groups.get(entry.group)
      const groupProfiles = found ? (found.group.profiles.length > 0 ? found.group.profiles.map(profile => profile.profileId) : ['default']) : []
      const roleProfiles = revisionRow?.content.roles.find(role => role.group === entry.group)?.profiles ?? []
      return {
        change: entry.change,
        group: entry.group,
        groupKnown: found !== undefined,
        worktreeScoped: found?.group.worktreeScoped ?? true,
        sharedProfiles: roleProfiles.length > 0 ? roleProfiles.filter(profile => groupProfiles.includes(profile)) : groupProfiles,
      }
    })
    const landings = this.deps.store.landings(planId)
    const landed = new Set(landings.map(landing => landing.change))
    const probeInput = { main: team.groupsRoot, floorChecks: settings.floorChecks, changes: names, provisioned: landed }
    const landing = revisionRow?.content.landing ?? { mode: 'direct' as const }
    // An unregistered mode is refused by landing-mode-supported; direct's checks still report the repository.
    const mechanism = (this.deps.mechanisms ?? DIRECT_MECHANISMS).get(landing.mode) ?? directMechanism
    const probe = this.deps.probe !== undefined
      ? await this.deps.probe(probeInput, this.deps.ghOptions ?? {})
      : await mechanism.probe({ ...probeInput, teamId: team.teamId, planId, landing }, this.deps.ghOptions ?? {})
    let baseDiffs: Array<{ change: string; files: string[] }> = []
    if (probe.base !== null && probe.repo !== null) {
      const tree = await ghTreeEntries(probe.repo, probe.base.tree, this.deps.ghOptions ?? {})
      if (tree.ok) {
        const originTree = new Map(tree.data.map(entry => [entry.path, entry.sha]))
        const perChange = names.map(change => ({ change, files: validatedFilesOf(team.groupsRoot, change) }))
        baseDiffs = await compareWithOriginTree(team.groupsRoot, originTree, perChange)
      }
    }
    const facts = await (this.deps.startFacts ?? readIntegrationStartFacts)({
      main: team.groupsRoot, probe, landings, runningPromotion: null,
      baseBranchOf: executionId => this.deps.store.execution(executionId)?.baseBranch ?? null,
    })
    const checked = facts.error === undefined ? probe : { ...probe, findings: [...probe.findings, { code: 'base-branch' as const, message: facts.error }] }
    return { probe: checked, baseDiffs, roles, landed, settings, offBaseLandings: facts.offBaseLandings }
  }

  /** The precondition context, inside Start's transaction or in preview, plus the commit's own reads. */
  private context(team: TeamIdentity, request: { planId: string; revision: number; contentHash: string; commandId: string }, gather: StartGather, prepared: unknown): StartCheckContext & {
    reportId: string | null
    inputHash: string | null
    changes: string[]
  } {
    const plan = this.deps.plansStore.get(request.planId)!
    const revisionRow = this.deps.plansStore.revision(request.planId, request.revision)
    const standingRaw = prepared !== null && prepared !== undefined ? this.deps.validation.standing(prepared) : null
    const standing = standingRaw as ValidationStanding | null
    const report = standing !== null && 'report' in standing ? standing.report : null
    const content = revisionRow?.content
    const names = content?.changes.map(entry => entry.change) ?? []
    return {
      plan, revision: revisionRow, request,
      validation: standing,
      impactGate: this.deps.impact.gate(request.planId, request.revision),
      runningExecution: this.deps.store.running(request.planId),
      claimedChanges: this.deps.store.ownedChanges(team.teamId)
        .filter(row => names.includes(row.change))
        .map(row => ({ change: row.change, executionId: row.executionId })),
      baseDiffs: gather.baseDiffs,
      roles: gather.roles,
      probeFindings: gather.probe.findings,
      landingMode: content?.landing.mode ?? 'direct',
      supportedLandingModes: this.deps.landingModes(),
      runningPromotion: this.deps.promotions.runningPromotion(request.planId),
      offBaseLandings: gather.offBaseLandings,
      baseBranch: gather.probe.base?.branch ?? null,
      reportId: report?.id ?? null,
      inputHash: report?.inputHash ?? null,
      changes: names,
    }
  }

  /** The execution a replayed Start recorded (D4): the plan's newest at this revision and hash. */
  private priorExecution(planId: string, input: StartInput): ExecutionRow {
    const prior = this.deps.store.executionsOf(planId).find(execution => execution.revision === input.revision && execution.contentHash === input.contentHash)
    if (!prior) throw new Error(`The recorded start of ${input.commandId} left no execution`)
    return prior
  }

  /**
   * plan-execution D12: the owner retries a stopped change. One command per
   * attempt, replayed by its id; the payload compares the execution and the
   * change. The generation bumps, so every request key and effect key of
   * the change is new. Retry is refused while the change's task is closed.
   */
  async retry(caller: ExecutionCaller, input: { executionId: string; change: string; commandId: string }): Promise<PlanCommandOutcome> {
    if (caller.kind !== 'human') {
      return { ok: false, reason: 'forbidden', message: 'Only the human can retry a change, from the Plans view. No agent tool can.' }
    }
    const execution = this.deps.store.execution(input.executionId)
    if (execution === null || execution.teamId !== caller.team.teamId) {
      return { ok: false, reason: 'not-found', message: `Execution not found in this team: ${input.executionId}` }
    }
    const outcome = this.deps.plans.recordExecutionEvent(execution.planId, {
      kind: 'change-retried', commandId: input.commandId, executionId: input.executionId, change: input.change,
    }, () => {
      const row = this.deps.store.change(input.executionId, input.change)
      if (row === null) throw new PlanRefusal('not-found', `Change not found on the execution: ${input.change}`)
      if (row.state !== 'stopped') throw new PlanRefusal('state', `The change is ${row.state}, not stopped; nothing to retry.`)
      if (row.taskId !== null && this.deps.tasks !== undefined) {
        const task = this.deps.tasks.store.get(row.taskId) ?? null
        if (task !== null && (task.status === 'done' || task.status === 'cancelled')) {
          throw new PlanRefusal('state', `The change's task is ${task.status}; reopen it before retrying.`)
        }
      }
      // The state each reason resumes in (D12), with the fix count reset:
      // round-limit returns to its failed round, whose fix step dispatches
      // the fix attempt; a failed or closed stage resumes the state it
      // stopped in and sends its instruction again (`redispatch`) — a
      // refused step needs no resend, its stage simply runs again; a
      // name-taken change re-provisions; the rest return to gating.
      // A landing change resumes at gating: its passed round re-enters the
      // landing stage, which takes the slot only when it is free — except an
      // effect-unknown stop naming a landing effect, which resumes at that
      // effect's own step (A2, below).
      const stored = row.stopDetail?.resumeState ?? 'implementing'
      const resume = stored === 'landing' ? 'gating' : stored
      const to: Parameters<ExecutionStore['transition']>[3] = { state: 'gating', step: null, stopReason: null, stopDetail: null, fixRounds: 0 }
      if (row.stopReason === 'instruction-failed' || row.stopReason === 'task-closed') {
        to.state = resume
        if (row.stopDetail?.stage === undefined) to.step = 'redispatch'
      }
      if (row.stopReason === 'name-taken') to.state = 'provisioning'
      // A change an execution-level effect stopped while it waited (integration-candidates D4)
      // waits again, and the planner issues the effect anew; integration-rewritten resumes at
      // gating, where its passed round re-enters landing and the rewritten check runs again (D6).
      if (row.stopDetail?.resumeState === 'waiting') to.state = 'waiting'
      // A2: a landing effect the stop names resumes at its own step inside
      // `landing`, so the stage never re-runs the steps it already passed —
      // and never re-derives the effect while the re-opened row is live (I-A).
      const namedId = row.stopDetail?.effectId
      const stopped = row.stopReason === 'effect-unknown' && namedId !== undefined
        ? this.deps.store.effect(namedId)
        : null
      if (stopped !== null && stopped.change === input.change) {
        const step = RESUME_AT_STEP[stopped.kind]
        if (step !== undefined) {
          to.state = 'landing'
          to.step = step
        }
      }
      let moved: ChangeRow | null
      try {
        moved = this.deps.store.transition(input.executionId, input.change, row, to)
      } catch (error) {
        // The slot was taken while the retry was open: like applyLanding's
        // step 2, the change waits at gating, and the re-opened effect's
        // verdict still decides (the planner's resumed landing window).
        if (!(error instanceof ExecutionConflict) || error.kind !== 'slot-taken') throw error
        moved = this.deps.store.transition(input.executionId, input.change, row,
          { state: 'gating', step: 'awaiting-slot', stopReason: null, stopDetail: null, fixRounds: 0 })
      }
      if (moved === null) throw new PlanRefusal('state', 'The change moved while the retry was open; reload and retry again.')
      const round = this.deps.store.rounds(input.executionId, input.change).at(-1) ?? null
      if (row.stopReason === 'review-unavailable' && round !== null) this.deps.store.clearRoundReview(round.id)
      if ((row.stopReason === 'ci-missing' || row.stopReason === 'ci-timeout') && round !== null) {
        this.deps.store.reopenRoundWindow(round.id, new Date().toISOString())
      }
      if (row.stopReason === 'effect-unknown') {
        // The stop names its effect (D14's recovery): Retry re-opens that
        // one, into `unknown` — inspected before it ever runs again, with a
        // fresh inspection budget (A3). Stops written before the stop
        // carried the id fall back to the change's oldest failed effect.
        const failed = stopped !== null && stopped.state === 'failed' && stopped.change === input.change
          ? stopped
          : this.deps.store.effectsOf(input.executionId)
            .find(effect => effect.change === input.change && effect.state === 'failed'
              && (namedId === undefined || effect.id === namedId))
        if (failed !== undefined) this.deps.store.retryFailedEffect(failed.id)
      }
      return { change: input.change }
    })
    if (outcome.ok && !outcome.replayed) this.deps.wake?.(caller.team.teamId)
    return outcome
  }

  /**
   * plan-execution D12: the owner stops the execution. Every unlanded change
   * is cancelled together with its open task (as Kawai), pending effects
   * cancel, and the execution finishes as stopped — one transaction. The
   * task cancels are prepared first (the close hook is async) and committed
   * inside it; a task whose status moved meanwhile rolls the whole stop back
   * and it is prepared again, up to STOP_ATTEMPTS times, then refused. A
   * change whose merge effect is running stays `landing`: the executor
   * settles only that merge (landed if it merged, else cancelled with its
   * task).
   */
  async stop(caller: ExecutionCaller, input: { executionId: string; reason: string; commandId: string }): Promise<PlanCommandOutcome> {
    if (caller.kind !== 'human') {
      return { ok: false, reason: 'forbidden', message: 'Only the human can stop an execution, from the Plans view. No agent tool can.' }
    }
    return this.stopAs(caller.team, input, 'human')
  }

  /**
   * plan-execution D19: the plan-close hook. Kawai — not the human — stops
   * the plan's running executions with the reason `plan-closed`, under
   * deterministic command ids so a retried close replays. Awaited by the
   * close; it never throws: a failed stop is logged.
   */
  async stopForPlan(teamId: string, planId: string): Promise<void> {
    for (const execution of this.deps.store.runningForTeam(teamId)) {
      if (execution.planId !== planId) continue
      try {
        const team = this.deps.identityOf(teamId)
        const outcome = await this.stopAs(team, {
          executionId: execution.id, reason: 'plan-closed', commandId: `exec:${execution.id}:stop-for-plan`,
        }, 'system')
        if (!outcome.ok) logger.warn('plan_execution_stop_for_plan_failed', { teamId, planId, executionId: execution.id, error: outcome.message })
      } catch (error) {
        logger.error('plan_execution_stop_for_plan_failed', { teamId, planId, executionId: execution.id, error: String(error) })
      }
    }
  }

  private async stopAs(team: TeamIdentity, input: { executionId: string; reason: string; commandId: string }, actor: 'human' | 'system'): Promise<PlanCommandOutcome> {
    const execution = this.deps.store.execution(input.executionId)
    if (execution === null || execution.teamId !== team.teamId) {
      return { ok: false, reason: 'not-found', message: `Execution not found in this team: ${input.executionId}` }
    }
    const trimmed = input.reason.trim()
    const system = { kind: 'system' as const, team, executionId: input.executionId }
    for (let attempt = 1; attempt <= STOP_ATTEMPTS; attempt++) {
      // Phase 1: prepare the cancel of every open task the stop will close.
      const prepared = new Map<string, PreparedTaskStatus>()
      const tasks = this.deps.tasks
      if (tasks !== undefined && execution.state === 'running') {
        for (const row of this.stoppable(input.executionId)) {
          if (row.taskId === null || closedTask(tasks.store.get(row.taskId)?.status)) continue
          try {
            prepared.set(row.taskId, await tasks.prepareStatus(system, row.taskId, 'cancelled', `Execution stopped: ${trimmed}`))
          } catch (error) {
            return { ok: false, reason: 'state', message: `The task ${row.taskId} of ${row.change} cannot be cancelled: ${String(error instanceof Error ? error.message : error)}` }
          }
        }
      }
      // Phase 2: one transaction — task cancels, change transitions, effect cancels, finish.
      try {
        const outcome = this.deps.plans.recordExecutionEvent(execution.planId, {
          kind: 'execution-stopped', commandId: input.commandId, executionId: input.executionId, reason: trimmed,
        }, () => {
          const current = this.deps.store.execution(input.executionId)
          if (current === null || current.state !== 'running') {
            throw new PlanRefusal('state', `The execution is ${current?.state ?? 'gone'}; nothing to stop.`)
          }
          if (trimmed === '') throw new PlanRefusal('invalid', 'Stopping an execution needs a reason.')
          this.deps.store.cancelEffects(input.executionId)
          for (const row of this.stoppable(input.executionId)) {
            const cancel = () => { this.deps.store.transition(input.executionId, row.change, row, { state: 'cancelled', step: null }) }
            const status = row.taskId === null || tasks === undefined ? undefined : tasks.store.get(row.taskId)?.status
            if (row.taskId === null || status === undefined || closedTask(status)) { cancel(); continue }
            const task = prepared.get(row.taskId)
            // An open task this attempt did not prepare: it reopened meanwhile.
            if (task === undefined) throw new StaleTaskStatus(row.taskId, status)
            task.commit(cancel)
          }
          this.deps.store.finishExecution(input.executionId, 'stopped', trimmed)
          return { executionId: input.executionId }
        }, actor)
        if (outcome.ok && !outcome.replayed) this.deps.wake?.(team.teamId)
        return outcome
      } catch (error) {
        if (!(error instanceof StaleTaskStatus)) throw error
      }
    }
    return { ok: false, reason: 'state', message: `The execution's tasks kept changing status while the stop was prepared (${STOP_ATTEMPTS} attempts); nothing changed. Try again.` }
  }

  /** The changes a stop cancels: unlanded, uncancelled, and not mid-merge. */
  private stoppable(executionId: string): ChangeRow[] {
    const effects = this.deps.store.effectsOf(executionId)
    return this.deps.store.changes(executionId).filter(row => {
      if (row.state === 'landed' || row.state === 'cancelled') return false
      return !(row.state === 'landing' && effects.some(effect => effect.change === row.change && effect.kind === 'merge' && effect.state === 'running'))
    })
  }
}

const STOP_ATTEMPTS = 3

function closedTask(status: string | undefined): boolean {
  return status === 'done' || status === 'cancelled'
}
