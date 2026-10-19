// The promotion runner (integration-candidates D10, D14, review L1): the
// executor's per-team pass over running promotions. Each pass
// 1. inspects the team's due `unknown` promotion effects (D14's table, one
//    inspection per effect, the same backoff; an exhausted one fails with
//    `{ unknown: true }`, so the planner finishes it as `effect-unknown`);
// 2. advances each running promotion with the pure planner until it waits
//    or asks for an effect, gathering the reads a step names;
// 3. runs the team's due promotion effects through an EffectRunner over the
//    promotion effects table, then advances once more so a settled effect's
//    step follows in the same pass.
// Startup marks every effect left `running` as `unknown` (L1) before the
// first pass. Nothing here throws to the executor: a failing step is logged
// and the next pass repeats it.
import { runGit } from '../../../git/gitCommand'
import { logger } from '../../../logger'
import type { TeamIdentity } from '../../../team/teamIdentity'
import type { CiCheck } from '../../../../shared/planExecution'
import type { PromotionFailure } from '../../../../shared/planIntegration'
import { EffectRunner } from '../../execution/effects'
import type { InspectorReads } from '../../execution/effectInspectors'
import { cleanMergeCheck } from '../cleanMerge'
import type { GhCommandOptions } from '../ghCommand'
import type { PromotionRow } from './integrationStore'
import type { PromotionEffectRow } from './promotionEffectStore'
import { inspectPromotionEffect, promotionAdapters, promotionEffectAdapter, type PromotionAdapters } from './promotionEffects'
import { finishPromotion, PROMOTION_HOLDER_KIND, type PromotionCore } from './promotionFinish'
import { planPromotionStep, promotionEffectKey, type PromotionReadsFor } from './promotionPlanner'

/** A promotion fails as `target-moved` when the target moved this many times (D10 step 6). */
export const PROMOTION_MOVE_LIMIT = 3
/** Steps one advance may take before it yields to the effects. */
const STEP_BUDGET = 16

export interface PromotionRunnerDeps extends PromotionCore {
  teamOf: (teamId: string) => TeamIdentity | undefined
  inspectorReads: InspectorReads
  adapters?: PromotionAdapters
  ghOptions?: GhCommandOptions
  backoffsMs?: readonly [number, number, number]
  now?: () => Date
}

export class PromotionRunner {
  private readonly effects: EffectRunner<PromotionEffectRow>
  private readonly adapters: PromotionAdapters

  constructor(private readonly deps: PromotionRunnerDeps) {
    this.adapters = deps.adapters ?? promotionAdapters
    this.effects = new EffectRunner<PromotionEffectRow>({
      store: deps.integration,
      adapter: promotionEffectAdapter(this.adapters, deps.ghOptions),
      ...(deps.backoffsMs ? { backoffsMs: deps.backoffsMs } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      onFailed: (effect, error) => {
        if (effect.kind !== 'close-pr') return
        deps.integration.notePromotion(effect.promotionId, 'closePr', `The pull request is still open: closing it failed (${error.message}).`)
      },
    })
  }

  /** L1: effects a crash left `running` become `unknown`, inspected before any repeat. */
  startup(): void {
    for (const effect of this.deps.integration.markRunningPromotionEffectsUnknown()) {
      logger.warn('promotion_effect_unknown', { effectId: effect.id, kind: effect.kind })
    }
  }

  /** Whether the team still has promotion work: a running promotion, or a pending, unknown, or running effect. */
  active(teamId: string): boolean {
    return this.deps.integration.promotionTeams().includes(teamId)
  }

  /** One pass over the team's promotions; never rejects. */
  async pass(teamId: string): Promise<void> {
    const team = this.deps.teamOf(teamId)
    if (team === undefined) return
    try {
      await this.inspect(teamId)
      await this.advanceAll(team)
      if ((await this.effects.runDue(teamId)) > 0) await this.advanceAll(team)
    } catch (error) {
      logger.error('promotion_pass_failed', { teamId, error: String(error) })
    }
  }

  private iso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString()
  }

  private async inspect(teamId: string): Promise<void> {
    const store = this.deps.integration
    const backoffs = this.deps.backoffsMs ?? [30_000, 120_000, 600_000]
    for (const effect of store.dueUnknownEffects(teamId, this.iso())) {
      const verdict = await inspectPromotionEffect(effect, this.deps.inspectorReads)
      if (verdict.found === 'done') store.setEffectOutcome(effect.id, { state: 'done', outcome: verdict.outcome })
      else if (verdict.found === 'not-done') store.resetEffect(effect.id)
      else if (verdict.found === 'stop') store.setEffectOutcome(effect.id, { state: 'failed', error: `stopped as ${verdict.reason}`, outcome: { stop: verdict.reason, detail: verdict.detail } })
      else if (effect.tries < backoffs.length) {
        store.scheduleInspectionRetry(effect.id, new Date((this.deps.now?.() ?? new Date()).getTime() + backoffs[effect.tries]!).toISOString(), verdict.error)
      } else {
        store.setEffectOutcome(effect.id, { state: 'failed', error: verdict.error, outcome: { unknown: true, detail: { message: verdict.error } } })
      }
    }
  }

  private async advanceAll(team: TeamIdentity): Promise<void> {
    for (const promotion of this.deps.integration.runningPromotionsForTeam(team.teamId)) {
      try {
        await this.advance(team, promotion.id)
      } catch (error) {
        logger.error('promotion_step_failed', { promotionId: promotion.id, error: String(error) })
      }
    }
  }

  private async advance(team: TeamIdentity, promotionId: string): Promise<void> {
    const store = this.deps.integration
    const repo = this.deps.repoOf(team.teamId)
    let reads: PromotionReadsFor | undefined
    for (let steps = 0; steps < STEP_BUDGET; steps++) {
      const p = store.promotion(promotionId)
      if (p === null || p.state !== 'running') return
      const effects = store.promotionEffects(p.id)
      const held = this.deps.executions.slot(p.teamId)
      const slot = held === null ? null : { holderKind: held.holderKind, holderId: held.holderId, label: this.deps.executions.slotHolderLabel(p.teamId) ?? held.holderId }
      const decision = planPromotionStep({ promotion: p, effects, slot, now: this.iso(), repo, main: team.groupsRoot, ...(reads ? { reads } : {}) })
      const asked = reads
      reads = undefined
      switch (decision.kind) {
        case 'read':
          if (asked?.step === decision.step) return // a read just made asks again: wait for the next pass
          reads = await this.read(team, p, decision.step)
          continue
        case 'wait':
          if (decision.patch) store.patchPromotion(p.id, decision.patch)
          return
        case 'effect':
          if (store.effectByKey(decision.effect.effectKey) === null) store.insertEffect({ promotionId: p.id, ...decision.effect })
          return
        case 'patch':
          store.patchPromotion(p.id, decision.patch)
          continue
        case 'take-slot':
          this.deps.executions.takeSlotFor(p.teamId, PROMOTION_HOLDER_KIND, p.id)
          continue
        case 'move': {
          const moves = store.atomically(() => {
            const count = store.countMove(p.id)
            if (count < PROMOTION_MOVE_LIMIT) store.patchPromotion(p.id, { step: 'up-to-date', ciWindowFrom: null, ci: null, headSha: null })
            return count
          })
          if (moves >= PROMOTION_MOVE_LIMIT) {
            this.finish(p, 'target-moved', { message: `${p.targetBranch} moved ${moves} times while the promotion verified its head; promote again.` })
            return
          }
          continue
        }
        case 'fail':
          this.finish(p, decision.failure, decision.detail)
          return
        case 'record':
          store.atomically(() => {
            store.patchPromotion(p.id, { mergeSha: decision.mergeSha, treeVerified: decision.treeVerified, step: 'fast-forward' })
            store.insertCandidate({
              teamId: p.teamId, branch: p.branch, kind: 'promotion', promotionId: p.id,
              baselineSha: p.fromSha, commitSha: p.headSha ?? '', treeSha: decision.headTree, state: 'passed',
            })
            this.deps.executions.releaseSlotFor(p.teamId, PROMOTION_HOLDER_KIND, p.id)
          })
          continue
        case 'fast-forwarded':
          store.atomically(() => {
            const candidate = store.candidates(p.teamId, p.branch).find(row => row.promotionId === p.id && row.state === 'passed')
            if (candidate) store.transitionCandidate(candidate.id, decision.fastForwarded ? 'landed' : 'superseded')
            store.patchPromotion(p.id, { fastForwarded: decision.fastForwarded, fastForwardNote: decision.note, step: 'finish' })
          })
          continue
        case 'finish':
          finishPromotion(this.deps, p, decision.outcome, decision.detail)
          return
      }
    }
  }

  private finish(p: PromotionRow, failure: PromotionFailure, detail: Record<string, unknown>): void {
    finishPromotion(this.deps, p, `failed:${failure}`, detail)
  }

  /** The reads a step named; every field null when it could not be read. */
  private async read(team: TeamIdentity, p: PromotionRow, step: PromotionReadsFor['step']): Promise<PromotionReadsFor> {
    const cwd = team.groupsRoot
    const git = this.adapters.landing
    const head = async (branch: string) => {
      const read = await git.lsRemoteHead(cwd, `refs/heads/${branch}`)
      return read.ok ? read.sha : null
    }
    const fetched = async (...branches: string[]) => {
      for (const branch of branches) if (!(await git.fetch(cwd, 'origin', `refs/heads/${branch}`)).ok) return false
      return true
    }
    const contains = async (ancestor: string, descendant: string) => {
      const result = await git.isAncestor(cwd, ancestor, descendant)
      return result.ok ? result.ancestor : null
    }
    const tree = async (sha: string) => {
      const result = await runGit(['rev-parse', `${sha}^{tree}`], { cwd })
      return result.ok ? result.stdout.trim() : null
    }
    switch (step) {
      case 'up-to-date': {
        const promotionHead = await head(p.promotionBranch)
        const targetHead = await head(p.targetBranch)
        if (promotionHead === null || targetHead === null || !(await fetched(p.targetBranch, p.promotionBranch))) {
          return { step, promotionHead, targetHead, contains: null, conflicts: null }
        }
        const contained = await contains(targetHead, promotionHead)
        if (contained !== false) return { step, promotionHead, targetHead, contains: contained, conflicts: null }
        const predicted = await git.mergeTree(cwd, promotionHead, targetHead)
        return { step, promotionHead, targetHead, contains: false, conflicts: predicted.ok ? predicted.conflicts : null }
      }
      case 'clean': {
        const update = this.deps.integration.effectByKey(promotionEffectKey(p, 'update-branch', p.moves))
        const reviewedHead = String(update?.command.head ?? '')
        const updatedHead = await head(p.promotionBranch)
        // GitHub updates the branch asynchronously: until the head moves, there is nothing to check yet.
        if (updatedHead === null || reviewedHead === '' || updatedHead === reviewedHead) return { step, clean: null, head: updatedHead }
        const check = await cleanMergeCheck(git, { cwd, baseBranch: p.targetBranch, branch: p.promotionBranch, reviewedHead, updatedHead })
        return { step, clean: check === null ? null : check.clean, head: updatedHead }
      }
      case 'ci': {
        const sha = await head(p.promotionBranch)
        if (sha === null) return { step, head: null, checks: null }
        const repo = this.deps.repoOf(team.teamId)
        const runs = await this.adapters.rounds.checkRuns(repo, sha, this.deps.ghOptions)
        const statuses = await this.adapters.rounds.statuses(repo, sha, this.deps.ghOptions)
        const checks: CiCheck[] | null = runs.ok && statuses.ok ? [...runs.data, ...statuses.data] : null
        return { step, head: sha, checks }
      }
      case 're-read': {
        const targetHead = await head(p.targetBranch)
        if (targetHead === null || p.headSha === null || !(await fetched(p.targetBranch))) return { step, targetHead, contains: null }
        return { step, targetHead, contains: await contains(targetHead, p.headSha) }
      }
      case 'record': {
        const merge = this.deps.integration.effectByKey(promotionEffectKey(p, 'merge', p.moves))
        const mergeSha = String((merge?.outcome as { mergeCommit?: string } | null)?.mergeCommit ?? '')
        if (mergeSha === '' || p.headSha === null || !(await fetched(p.targetBranch))) return { step, mergeTree: null, headTree: null }
        return { step, mergeTree: await tree(mergeSha), headTree: await tree(p.headSha) }
      }
    }
  }
}
