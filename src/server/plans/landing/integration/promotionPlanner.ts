// The promotion steps (integration-candidates D10) as one pure decision:
// `planPromotionStep(input)` reads the promotion row, its effects, the
// landing slot, and — when the step needs them — the reads the runner
// gathered (up-to-date ancestry and conflicts, the clean-merge check, CI,
// the target re-read, the merge's trees), and answers the one thing to do
// next. It never performs I/O: the runner (promotionRunner.ts) applies the
// decision and gathers reads when asked, so every transition is testable
// without git or GitHub. Effect keys are `promo:<id>:<kind>[:<moves>]`, so a
// return to the up-to-date step after the target moved runs new ones.
import { evaluateCi } from '../../../../shared/planExecutionGates'
import type { CiCheck, FloorMap } from '../../../../shared/planExecution'
import type { PromotionEffectKind, PromotionFailure } from '../../../../shared/planIntegration'
import type { PromotionPatch, PromotionRow } from './integrationStore'
import type { PromotionEffectRow } from './promotionEffectStore'

/** The reads a step asked for; each field null when it could not be read. */
export type PromotionReadsFor =
  | { step: 'up-to-date'; promotionHead: string | null; targetHead: string | null; contains: boolean | null; conflicts: string[] | null }
  | { step: 'clean'; clean: boolean | null; head: string | null }
  | { step: 'ci'; head: string | null; checks: CiCheck[] | null }
  | { step: 're-read'; targetHead: string | null; contains: boolean | null }
  | { step: 'record'; mergeTree: string | null; headTree: string | null }

export interface PromotionStepInput {
  promotion: PromotionRow
  effects: readonly PromotionEffectRow[]
  slot: { holderKind: string; holderId: string; label: string } | null
  /** The plan's carried changes an active hold covers (revision-control D5); empty when none. */
  heldChanges: readonly string[]
  now: string
  repo: string
  /** The team's main checkout: the cwd of every git read and ref effect. */
  main: string
  reads?: PromotionReadsFor
}

export type PromotionDecision =
  | { kind: 'read'; step: PromotionReadsFor['step'] }
  | { kind: 'wait'; reason: string; patch?: PromotionPatch }
  | { kind: 'held' }
  | { kind: 'effect'; effect: { kind: PromotionEffectKind; effectKey: string; command: Record<string, unknown> } }
  | { kind: 'patch'; patch: PromotionPatch }
  | { kind: 'take-slot' }
  | { kind: 'move' }
  | { kind: 'fail'; failure: PromotionFailure; detail: Record<string, unknown> }
  | { kind: 'record'; mergeSha: string; treeVerified: boolean; headTree: string }
  | { kind: 'fast-forwarded'; fastForwarded: boolean; note: string | null }
  | { kind: 'finish'; outcome: 'merged' | 'cancelled'; detail: Record<string, unknown> | null }

const TOO_LATE = 'The cancellation came too late: the merge had already completed, so the promotion finished as merged.'

export const promotionEffectKey = (promotion: Pick<PromotionRow, 'id'>, kind: PromotionEffectKind, moves?: number): string =>
  moves === undefined ? `promo:${promotion.id}:${kind}` : `promo:${promotion.id}:${kind}:${moves}`

type EffectState = 'none' | 'waiting' | 'done' | 'failed' | 'cancelled'

function stateOf(effect: PromotionEffectRow | undefined): EffectState {
  if (effect === undefined) return 'none'
  if (effect.state === 'done') return 'done'
  if (effect.state === 'failed') return 'failed'
  if (effect.state === 'cancelled') return 'cancelled'
  return 'waiting'
}

/** A failed effect's promotion failure: an inspector's stop, an exhausted inspection, or the effect's own failure. */
function failureOf(effect: PromotionEffectRow): { kind: 'fail'; failure: PromotionFailure; detail: Record<string, unknown> } {
  const outcome = (effect.outcome ?? {}) as { stop?: string; unknown?: boolean; detail?: { message?: string } }
  const failure: PromotionFailure = outcome.stop === 'pr-closed' ? 'pr-closed' : outcome.unknown === true ? 'effect-unknown' : 'effect-failed'
  return { kind: 'fail', failure, detail: { effect: effect.kind, message: outcome.detail?.message ?? effect.error ?? `the ${effect.kind} effect failed` } }
}

const outcomeOf = <T>(effect: PromotionEffectRow | undefined): Partial<T> => (effect?.outcome ?? {}) as Partial<T>

/** The one next thing to do for a running promotion (D10). */
export function planPromotionStep(input: PromotionStepInput): PromotionDecision {
  const { promotion: p, now } = input
  const byKey = new Map(input.effects.map(effect => [effect.effectKey, effect]))
  const effect = (kind: PromotionEffectKind, moves?: number) => byKey.get(promotionEffectKey(p, kind, moves))
  const ask = (kind: PromotionEffectKind, command: Record<string, unknown>, moves?: number): PromotionDecision =>
    ({ kind: 'effect', effect: { kind, effectKey: promotionEffectKey(p, kind, moves), command } })
  const merge = effect('merge', p.moves)

  // A Cancel stops every step before the merge; a merge in flight settles first (D9).
  if (p.cancelReason !== null && p.mergeSha === null) {
    const state = stateOf(merge)
    if (state === 'waiting') return { kind: 'wait', reason: 'the merge settles before the cancellation applies' }
    const merged = state === 'done' && outcomeOf<{ merged: boolean }>(merge).merged === true
    if (!merged) return { kind: 'finish', outcome: 'cancelled', detail: { message: `Cancelled by the owner: ${p.cancelReason}` } }
  }

  // A hold on a carried change stops every step before the merge (revision-control
  // D5): branch and pull-request wait (the slot is not involved yet), slot through
  // re-read wait at `held` without the slot, and a merge not yet created waits at
  // `held` too. A running merge settles — the hold applies from the next step — and
  // steps past the merge (record, fast-forward, finish) are ungated.
  if (input.heldChanges.length > 0) {
    const reason = `the hold on ${input.heldChanges.join(', ')} covers this promotion's carried changes`
    switch (p.step) {
      case 'branch':
      case 'pull-request':
        return { kind: 'wait', reason }
      case 'slot':
      case 'up-to-date':
      case 'ci':
      case 're-read':
        return { kind: 'held' }
      case 'merge':
        if (stateOf(merge) === 'none') return { kind: 'held' }
        break
    }
  }

  switch (p.step) {
    case 'branch': {
      const created = effect('create-promotion-branch')
      const state = stateOf(created)
      if (state === 'none') return ask('create-promotion-branch', { repo: input.repo, branch: p.promotionBranch, sha: p.fromSha, cwd: input.main })
      if (state === 'done') return { kind: 'patch', patch: { step: 'pull-request' } }
      if (state === 'failed') return failureOf(created!)
      return { kind: 'wait', reason: `creating ${p.promotionBranch}` }
    }
    case 'pull-request': {
      const opened = effect('open-pr')
      const state = stateOf(opened)
      if (state === 'none') {
        return ask('open-pr', {
          repo: input.repo, head: p.promotionBranch, base: p.targetBranch,
          title: `Promote ${p.branch} to ${p.targetBranch} (promotion ${p.number})`,
          body: `Kawai promotes the integration branch ${p.branch} of plan ${p.planId} at ${p.fromSha} into ${p.targetBranch}, carrying its landed candidates through #${p.throughSeq}. Kawai merges this pull request itself with a merge commit once CI passes on its exact head.`,
        })
      }
      if (state === 'done') {
        const pull = outcomeOf<{ number: number; url: string }>(opened)
        return { kind: 'patch', patch: { prNumber: pull.number ?? null, prUrl: pull.url ?? null, step: 'slot' } }
      }
      if (state === 'failed') return failureOf(opened!)
      return { kind: 'wait', reason: 'opening the pull request' }
    }
    case 'slot': {
      if (input.slot === null) return { kind: 'take-slot' }
      if (input.slot.holderKind === 'promotion' && input.slot.holderId === p.id) return { kind: 'patch', patch: { step: 'up-to-date' } }
      return { kind: 'wait', reason: `waits for the landing slot, held by ${input.slot.label}` }
    }
    case 'held': {
      // Waiting at the hold step; this runs when the hold still covers a carried
      // change (the gate above kept steps before `held`), or after release while
      // another holder has the slot. Release re-enters here and re-runs
      // `up-to-date` once the promotion has its slot again (revision-control D5).
      if (input.heldChanges.length > 0) return { kind: 'wait', reason: `the hold on ${input.heldChanges.join(', ')} covers this promotion's carried changes` }
      if (input.slot === null) return { kind: 'take-slot' }
      if (input.slot.holderKind === 'promotion' && input.slot.holderId === p.id) return { kind: 'patch', patch: { step: 'up-to-date' } }
      return { kind: 'wait', reason: `waits for the landing slot, held by ${input.slot.label}` }
    }
    case 'up-to-date': {
      const update = effect('update-branch', p.moves)
      const state = stateOf(update)
      if (state === 'waiting') return { kind: 'wait', reason: `bringing ${p.promotionBranch} up to date with ${p.targetBranch}` }
      if (state === 'failed') return failureOf(update!)
      if (state === 'done') {
        const result = outcomeOf<{ conflict: boolean; message: string }>(update)
        if (result.conflict === true) return { kind: 'fail', failure: 'promotion-conflict', detail: { message: `GitHub refused to update ${p.promotionBranch} from ${p.targetBranch}: ${result.message ?? 'a conflict'}.` } }
        if (input.reads?.step !== 'clean') return { kind: 'read', step: 'clean' }
        if (input.reads.clean === null) return { kind: 'wait', reason: `waiting for ${p.promotionBranch}'s updated head to check it` }
        if (!input.reads.clean) return { kind: 'fail', failure: 'effect-failed', detail: { message: `${p.promotionBranch}'s updated head ${input.reads.head ?? ''} failed the clean-merge check; nobody else should write a promotion branch.` } }
        return { kind: 'patch', patch: { step: 'ci', ciWindowFrom: now, ci: null } }
      }
      if (input.reads?.step !== 'up-to-date') return { kind: 'read', step: 'up-to-date' }
      const reads = input.reads
      if (reads.promotionHead === null || reads.targetHead === null || reads.contains === null) return { kind: 'wait', reason: 'origin could not be read' }
      if (reads.contains) return { kind: 'patch', patch: { step: 'ci', ciWindowFrom: p.ciWindowFrom ?? now } }
      if (reads.conflicts === null) return { kind: 'wait', reason: 'the merge could not be predicted' }
      if (reads.conflicts.length > 0) {
        return { kind: 'fail', failure: 'promotion-conflict', detail: { message: `${p.branch} conflicts with ${p.targetBranch} in ${reads.conflicts.join(', ')}.`, files: reads.conflicts } }
      }
      if (p.prNumber === null) return { kind: 'fail', failure: 'effect-failed', detail: { message: 'The promotion has no pull request to update.' } }
      return ask('update-branch', { repo: input.repo, pr: p.prNumber, head: reads.promotionHead }, p.moves)
    }
    case 'ci': {
      const rerun = effect('rerun', p.moves)
      if (stateOf(rerun) === 'waiting') return { kind: 'wait', reason: 'requesting the rerun' }
      if (stateOf(rerun) === 'failed') return failureOf(rerun!)
      if (input.reads?.step !== 'ci') return { kind: 'read', step: 'ci' }
      const { head, checks } = input.reads
      if (head === null || checks === null) return { kind: 'wait', reason: 'CI could not be read' }
      const done = outcomeOf<{ at: string; runIds: number[] }>(rerun)
      const floor = ((p.floor ?? {}) as { map?: FloorMap }).map ?? ({} as FloorMap)
      const evaluation = evaluateCi(checks, floor, {
        windowFrom: p.ciWindowFrom ?? p.startedAt, now,
        rerun: stateOf(rerun) === 'done' && done.at !== undefined ? { at: done.at, runIds: done.runIds ?? [] } : null,
      })
      if (evaluation.kind === 'pending') return { kind: 'wait', reason: `CI runs on ${head}`, patch: { ci: checks } }
      if (evaluation.kind === 'rerun') return ask('rerun', { repo: input.repo, runIds: evaluation.runIds }, p.moves)
      if (evaluation.kind === 'fail') {
        const names = [...new Set(evaluation.checks.map(check => check.name))]
        return { kind: 'fail', failure: 'ci-failed', detail: { message: `CI failed on ${head}: ${names.join(', ')}.`, checks: names, head } }
      }
      if (evaluation.kind === 'stop') return { kind: 'fail', failure: evaluation.reason, detail: { ...evaluation.detail, head } }
      return { kind: 'patch', patch: { ci: checks, headSha: head, step: 're-read' } }
    }
    case 're-read': {
      if (input.reads?.step !== 're-read') return { kind: 'read', step: 're-read' }
      if (input.reads.targetHead === null || input.reads.contains === null) return { kind: 'wait', reason: `${p.targetBranch} could not be read` }
      return input.reads.contains ? { kind: 'patch', patch: { step: 'merge' } } : { kind: 'move' }
    }
    case 'merge': {
      const state = stateOf(merge)
      if (state === 'none') return ask('merge', { repo: input.repo, pr: p.prNumber, head: p.headSha, cwd: input.main, baseBranch: p.targetBranch, method: 'merge' }, p.moves)
      if (state === 'waiting') return { kind: 'wait', reason: `merging pull request ${p.prNumber ?? ''}` }
      if (state === 'failed') return failureOf(merge!)
      const result = outcomeOf<{ merged: boolean; baseMoved: boolean; mergeCommit: string }>(merge)
      if (result.merged === true) return { kind: 'patch', patch: { step: 'record' } }
      if (result.baseMoved === true) return { kind: 'move' }
      return { kind: 'fail', failure: 'effect-failed', detail: { message: `GitHub did not merge pull request ${p.prNumber ?? ''}.` } }
    }
    case 'record': {
      const mergeSha = outcomeOf<{ mergeCommit: string }>(merge).mergeCommit
      if (mergeSha === undefined) return { kind: 'fail', failure: 'effect-failed', detail: { message: 'The merge left no merge commit to record.' } }
      if (input.reads?.step !== 'record') return { kind: 'read', step: 'record' }
      if (input.reads.mergeTree === null || input.reads.headTree === null) return { kind: 'wait', reason: 'the merge commit could not be read' }
      return { kind: 'record', mergeSha, treeVerified: input.reads.mergeTree === input.reads.headTree, headTree: input.reads.headTree }
    }
    case 'fast-forward': {
      const forward = effect('fast-forward')
      const state = stateOf(forward)
      if (state === 'none') return ask('fast-forward', { repo: input.repo, branch: p.branch, sha: p.headSha, cwd: input.main })
      if (state === 'waiting' || state === 'cancelled') return { kind: 'wait', reason: `fast-forwarding ${p.branch}` }
      if (state === 'failed') return { kind: 'fast-forwarded', fastForwarded: false, note: `The fast-forward of ${p.branch} to ${p.headSha ?? ''} failed: ${forward!.error ?? 'unknown error'}; the branch was left as it is.` }
      const result = outcomeOf<{ fastForwarded: boolean; head: string | null }>(forward)
      if (result.fastForwarded === true) return { kind: 'fast-forwarded', fastForwarded: true, note: null }
      return {
        kind: 'fast-forwarded', fastForwarded: false,
        note: result.head === null || result.head === undefined
          ? `${p.branch} is missing on origin, so it was not fast-forwarded to ${p.headSha ?? ''}.`
          : `${p.branch} moved to ${result.head} during the promotion, which ${p.headSha ?? ''} does not contain, so it was left as it is.`,
      }
    }
    case 'finish':
      return { kind: 'finish', outcome: 'merged', detail: p.cancelReason !== null ? { note: TOO_LATE, cancelReason: p.cancelReason } : null }
    default:
      return { kind: 'wait', reason: 'finishing' }
  }
}
