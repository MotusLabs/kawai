// PromotionService (integration-candidates D9): the human preview, Promote,
// and Cancel. It refuses agent callers first — no agent tool promotes or
// cancels (D12). Promote reads before it writes, like Start: ls-remote for
// the integration and promotion branches, the target's ancestry, the
// repository's `allow_merge_commit`, and the landing probe's repository and
// floor-map checks. One transaction through
// `PlanService.recordPromotionEvent` then replays by command id, evaluates
// every PROMOTE_PRECONDITIONS entry, inserts the promotion, and records
// `promotion-started`; the executor is woken only after a real commit. Plan
// state is never read or written. Cancel records `promotion-cancelled`, and
// finishes the promotion at once unless its merge is in flight, which then
// settles first (the runner finishes it).
import { FLOOR_VERSION } from '../../../../shared/planExecution'
import { candidateChain, promotedThrough, type IntegrationCandidate, type OutsideCommit } from '../../../../shared/planIntegration'
import type { TeamIdentity } from '../../../team/teamIdentity'
import type { PlanExecutionSettings } from '../../../team/teamCaps'
import { PlanRefusal, type PlanRefusalReason } from '../../planCommands'
import { PlanCommandRaceError, type PlanStore } from '../../planStore'
import { ghRepo } from '../github'
import type { GhCommandOptions } from '../ghCommand'
import { gitFetch, isAncestor, lsRemoteHead } from '../gitRemote'
import { probeLanding, type ProbeResult } from '../landingProbe'
import { IntegrationConflict, type PromotionRow } from './integrationStore'
import { finishPromotion, type PromotionCore } from './promotionFinish'
import { evaluatePromotePreconditions, type PromoteCheckContext, type PromoteRequest } from './promotionPreconditions'

export type PromotionCaller = { kind: 'human'; team: TeamIdentity } | { kind: 'agent'; sessionId: string }

type Refusal = { ok: false; reason: PlanRefusalReason; message: string; failures?: Array<{ name: string; message: string }> }

export type PromoteOutcome = { ok: true; replayed: boolean; promotion: PromotionRow } | Refusal
export type CancelOutcome = { ok: true; replayed: boolean; promotion: PromotionRow } | Refusal

/** What the Promote dialog shows (D9, D13): the standing, the pinned head, what it carries, and the outside commits. */
export interface PromotionPreview {
  branch: string
  targetBranch: string | null
  /** The head Promote would pin: the branch's head on origin. */
  head: string | null
  failures: Array<{ name: string; message: string }>
  /** The last landed candidate the head contains. */
  throughSeq: number
  /** Landed candidates not yet promoted and contained in the head, newest first. */
  carried: IntegrationCandidate[]
  outside: OutsideCommit[]
}

/** The git and gh reads Promote and the preview make; each answers null for "could not be read". */
export interface PromotionReads {
  remoteHead(main: string, branch: string): Promise<string | null | undefined>
  /** Whether `descendant` contains `ancestor` after fetching both branches; null when unreadable. */
  contains(main: string, branches: string[], ancestor: string, descendant: string): Promise<boolean | null>
  allowMergeCommit(repo: string): Promise<boolean | null>
}

export function realPromotionReads(options: GhCommandOptions = {}): PromotionReads {
  return {
    // undefined: the read failed; null: the branch is missing.
    remoteHead: async (main, branch) => {
      const head = await lsRemoteHead(main, `refs/heads/${branch}`)
      return head.ok ? head.sha : undefined
    },
    contains: async (main, branches, ancestor, descendant) => {
      for (const branch of branches) {
        if (!(await gitFetch(main, 'origin', `refs/heads/${branch}`)).ok) return null
      }
      const result = await isAncestor(main, ancestor, descendant)
      return result.ok ? result.ancestor : null
    },
    allowMergeCommit: async repo => {
      const repository = await ghRepo(repo, options)
      return repository.ok ? repository.data.allowMergeCommit : null
    },
  }
}

interface PromoteGather {
  ctx: Omit<PromoteCheckContext, 'runningExecution' | 'runningPromotion' | 'nextPromotionBranch'>
  preview: PromotionPreview
  floor: PlanExecutionSettings['floorChecks']
}

export class PromotionService {
  constructor(private readonly deps: PromotionCore & {
    plansStore: PlanStore
    settings: { planExecution: (teamId: string) => Promise<PlanExecutionSettings> }
    /** Woken after a Promote or a Cancel commits; never on a replay or refusal. */
    wake?: (teamId: string) => void
    probe?: typeof probeLanding
    reads?: PromotionReads
    ghOptions?: GhCommandOptions
  }) {}

  async preview(caller: PromotionCaller, input: { planId: string; branch: string }): Promise<{ ok: true; preview: PromotionPreview } | Refusal> {
    if (caller.kind !== 'human') return forbidden('preview a promotion')
    const plan = this.deps.plansStore.forTeam(caller.team.teamId, input.planId)
    if (!plan) return { ok: false, reason: 'not-found', message: `Plan not found in this team: ${input.planId}` }
    const gather = await this.gather(caller.team, plan.id, input.branch, null)
    const failures = evaluatePromotePreconditions(this.context(gather, { planId: plan.id, branch: input.branch, fromSha: gather.preview.head ?? '', commandId: 'preview' }))
    return { ok: true, preview: { ...gather.preview, failures } }
  }

  /** Promote the plan's integration branch at `fromSha` (human only, D9). */
  async promote(caller: PromotionCaller, input: PromoteRequest): Promise<PromoteOutcome> {
    if (caller.kind !== 'human') return forbidden('promote an integration branch')
    const plan = this.deps.plansStore.forTeam(caller.team.teamId, input.planId)
    if (!plan) return { ok: false, reason: 'not-found', message: `Plan not found in this team: ${input.planId}` }
    const commandId = input.commandId.trim()
    if (!commandId) return { ok: false, reason: 'invalid', message: 'Promote needs a stable command id so a resend replays instead of repeating.' }
    const request = { ...input, planId: plan.id, commandId }
    const gather = await this.gather(caller.team, plan.id, input.branch, input.fromSha)
    const outcome = this.deps.plans.recordPromotionEvent<string>(plan.id, { kind: 'promotion-started', commandId, branch: input.branch, fromSha: input.fromSha }, () => {
      const failures = evaluatePromotePreconditions(this.context(gather, request))
      if (failures.length > 0) {
        throw new PlanRefusal('precondition', `Promote refused: ${failures.map(failure => `${failure.name}: ${failure.message}`).join(' ')}`, failures)
      }
      try {
        return this.deps.integration.insertPromotion({
          teamId: caller.team.teamId, planId: plan.id, branch: input.branch, commandId, fromSha: input.fromSha,
          throughSeq: gather.preview.throughSeq, targetBranch: gather.ctx.branchRecord!.targetBranch,
          floor: { version: FLOOR_VERSION, map: gather.floor },
        }).id
      } catch (error) {
        // The plan_promotions pair is unique like plan_events': a same-key racer resolves as the replay.
        if (error instanceof IntegrationConflict && error.kind === 'promotion-replay') throw new PlanCommandRaceError(commandId)
        if (error instanceof IntegrationConflict && error.kind === 'no-promotion') {
          throw new PlanRefusal('precondition', 'Promote refused: no-promotion: the plan already has a running promotion.', [{ name: 'no-promotion', message: 'The plan already has a running promotion.' }])
        }
        throw error
      }
    })
    if (!outcome.ok) return outcome
    if (!outcome.replayed) this.deps.wake?.(caller.team.teamId)
    const promotion = this.deps.integration.promotionByCommand(plan.id, commandId)
    if (promotion === null) throw new Error(`The recorded promote ${commandId} left no promotion`)
    return { ok: true, replayed: outcome.replayed, promotion }
  }

  /**
   * Cancel a running promotion (human only, D9). Refused once its merge is
   * recorded, naming the merge. A merge effect still in flight settles
   * first: the runner then finishes the promotion as merged, noting the
   * cancellation came too late, or as cancelled.
   */
  async cancel(caller: PromotionCaller, input: { promotionId: string; reason: string; commandId: string }): Promise<CancelOutcome> {
    if (caller.kind !== 'human') return forbidden('cancel a promotion')
    const promotion = this.deps.integration.promotion(input.promotionId)
    if (promotion === null || promotion.teamId !== caller.team.teamId) return { ok: false, reason: 'not-found', message: `Promotion not found in this team: ${input.promotionId}` }
    const reason = input.reason.trim()
    if (!reason) return { ok: false, reason: 'invalid', message: 'Cancel needs a reason; it is recorded with the promotion.' }
    let finishNow = false
    const outcome = this.deps.plans.recordPromotionEvent(promotion.planId, { kind: 'promotion-cancelled', commandId: input.commandId, promotionId: promotion.id, reason }, () => {
      const fresh = this.deps.integration.promotion(promotion.id)!
      if (fresh.mergeSha !== null) throw new PlanRefusal('state', `Promotion ${fresh.number} cannot be cancelled: its merge ${fresh.mergeSha} is recorded.`)
      if (fresh.state !== 'running') throw new PlanRefusal('state', `Promotion ${fresh.number} has already finished as ${fresh.outcome ?? 'unknown'}.`)
      this.deps.integration.patchPromotion(fresh.id, { cancelReason: reason })
      const running = this.deps.integration.runningEffect(fresh.id)
      const unknownMerge = this.deps.integration.promotionEffects(fresh.id).some(effect => effect.kind === 'merge' && effect.state === 'unknown')
      // A merge in flight (running, or awaiting its inspection) settles first.
      if (running?.kind === 'merge' || unknownMerge) return
      this.deps.integration.cancelPromotionEffects(fresh.id)
      finishNow = true
    })
    if (!outcome.ok) return outcome
    if (!outcome.replayed && finishNow) {
      finishPromotion(this.deps, this.deps.integration.promotion(promotion.id)!, 'cancelled', { message: `Cancelled by the owner: ${reason}` })
    }
    if (!outcome.replayed) this.deps.wake?.(caller.team.teamId)
    return { ok: true, replayed: outcome.replayed, promotion: this.deps.integration.promotion(promotion.id)! }
  }

  /** D9's reads, before any write. `fromSha` null: the preview pins the head it reads. */
  private async gather(team: TeamIdentity, planId: string, branch: string, fromSha: string | null): Promise<PromoteGather> {
    const reads = this.deps.reads ?? realPromotionReads(this.deps.ghOptions ?? {})
    const main = team.groupsRoot
    const settings = await this.deps.settings.planExecution(team.teamId)
    const record = this.deps.integration.branch(team.teamId, branch)
    const branchRecord = record !== null && record.planId === planId ? record : null
    const headRead = await reads.remoteHead(main, branch)
    const originHead = headRead ?? null
    const pinned = fromSha ?? originHead
    const target = branchRecord?.targetBranch ?? null
    let targetContains: boolean | null = null
    if (target !== null && pinned !== null) {
      const targetHead = await reads.remoteHead(main, target)
      targetContains = targetHead === undefined || targetHead === null ? null : await reads.contains(main, [branch, target], pinned, targetHead)
    }
    const probe: ProbeResult = await (this.deps.probe ?? probeLanding)({ main, floorChecks: settings.floorChecks, changes: [], provisioned: new Set() }, this.deps.ghOptions ?? {})
    const allowMergeCommit = probe.repo !== null ? await reads.allowMergeCommit(probe.repo) : null
    const promotionBranch = `${branch}--promote-${this.deps.integration.nextPromotionNumber(planId)}`
    const promotionHead = await reads.remoteHead(main, promotionBranch)
    // The carried candidates: landed, not yet promoted, and contained in the pinned head.
    const through = promotedThrough(this.deps.integration.promotionsOf(planId)).get(branch) ?? 0
    const landed = candidateChain(this.deps.integration.candidates(team.teamId, branch)).filter(candidate => candidate.state === 'landed')
    let throughSeq = 0
    for (const candidate of landed) {
      if (pinned === null) break
      if (candidate.commitSha === pinned || await reads.contains(main, [], candidate.commitSha, pinned)) {
        throughSeq = candidate.seq
        break
      }
    }
    const carried = landed.filter(candidate => candidate.seq > through && candidate.seq <= throughSeq)
    return {
      ctx: {
        request: { planId, branch, fromSha: pinned ?? '', commandId: '' },
        branchRecord, originHead, targetContains, allowMergeCommit,
        probeFindings: probe.findings, promotionBranch,
        promotionBranchExists: promotionHead === undefined ? null : promotionHead !== null,
      },
      preview: {
        branch, targetBranch: target, head: originHead, failures: [], throughSeq, carried,
        outside: carried.flatMap(candidate => candidate.outside ?? []),
      },
      floor: settings.floorChecks,
    }
  }

  /** The precondition context inside the transaction: the pre-reads plus fresh rows. */
  private context(gather: PromoteGather, request: PromoteRequest): PromoteCheckContext {
    const running = this.deps.integration.runningPromotion(request.planId)
    const execution = this.deps.executions.running(request.planId)
    return {
      ...gather.ctx,
      request,
      runningExecution: execution === null ? null : { id: execution.id },
      runningPromotion: running === null ? null : { id: running.id, number: running.number, step: running.step },
      nextPromotionBranch: `${request.branch}--promote-${this.deps.integration.nextPromotionNumber(request.planId)}`,
    }
  }
}

function forbidden(verb: string): Refusal {
  return { ok: false, reason: 'forbidden', message: `Only the human can ${verb}, from the Plans view. No agent tool can.` }
}
