// Promotion effects (integration-candidates D10): the adapters that perform
// each recorded promotion step, and their inspections before a repeat.
// Every kind but two reuses the execution adapter of the same name — open-pr,
// update-branch, rerun, merge (always `--merge`, with its pre-merge re-read),
// and the integration fast-forward — because a promotion effect row has the
// same command shape. The two of its own:
// - `create-promotion-branch`: the promotion branch at `from_sha` as a new
//   ref; a 422 is read back, and only a ref already at the requested commit
//   is ours (Kawai never adopts a branch it did not create);
// - `close-pr`: closes a failed or cancelled promotion's pull request with
//   its outcome as the comment, once it is still open.
// Inspection (D14, review L1) maps each kind onto the execution inspector's
// table; `close-pr` reads the pull request's state.
import type { EffectAdapter, EffectCallResult } from '../../execution/effects'
import type { EffectRow } from '../../execution/executionRows'
import { inspectEffect, type InspectionVerdict, type InspectorReads } from '../../execution/effectInspectors'
import { landingAdapters, mergeAdapter, updateBranchAdapter, type LandingAdapters } from '../../execution/executionLanding'
import { openPrAdapter, rerunAdapter, roundAdapters, type RoundAdapters } from '../../execution/executionRounds'
import type { GhCommandOptions } from '../ghCommand'
import { ghPrClose } from '../github'
import { fastForwardAdapter, integrationAdapters, type IntegrationAdapters } from './integrationEffects'
import type { PromotionEffectRow } from './promotionEffectStore'

export interface PromotionAdapters {
  landing: LandingAdapters
  rounds: RoundAdapters
  refs: IntegrationAdapters
  prClose: typeof ghPrClose
}

export const promotionAdapters: PromotionAdapters = { landing: landingAdapters, rounds: roundAdapters, refs: integrationAdapters, prClose: ghPrClose }

const is422 = (error: { httpStatus?: number | null }) => 'httpStatus' in error && error.httpStatus === 422
/** The execution adapters read only `command`; a promotion row carries the same shape. */
const asExecutionRow = (effect: PromotionEffectRow): EffectRow => effect as unknown as EffectRow

export function promotionEffectAdapter(adapters: PromotionAdapters, ghOptions?: GhCommandOptions): EffectAdapter<PromotionEffectRow> {
  return {
    async call(effect: PromotionEffectRow): Promise<EffectCallResult> {
      const command = effect.command
      switch (effect.kind) {
        case 'create-promotion-branch': {
          const repo = String(command.repo ?? '')
          const branch = String(command.branch ?? '')
          const sha = String(command.sha ?? '')
          const created = await adapters.refs.createRef(repo, branch, sha, ghOptions)
          if (created.ok) return { ok: true, outcome: { created: true, sha } }
          if (!is422(created.error)) return { ok: false, error: created.error }
          const head = await adapters.refs.lsRemoteHead(String(command.cwd ?? ''), `refs/heads/${branch}`)
          if (!head.ok) return { ok: false, error: head.error }
          if (head.sha === sha) return { ok: true, outcome: { created: true, sha } }
          return { ok: false, error: { argv: ['gh', 'api', 'git/refs'], exitCode: 1, stderr: `foreign-branch: ${branch} already exists on origin at ${head.sha ?? 'an unreadable head'}; Kawai never adopts a branch it did not create.` } }
        }
        case 'open-pr': return openPrAdapter(adapters.rounds, ghOptions).call(asExecutionRow(effect))
        case 'update-branch': return updateBranchAdapter(adapters.landing, ghOptions).call(asExecutionRow(effect))
        case 'rerun': return rerunAdapter(adapters.rounds, ghOptions).call(asExecutionRow(effect))
        case 'merge': return mergeAdapter(adapters.landing, ghOptions).call(asExecutionRow(effect))
        case 'fast-forward': return fastForwardAdapter(adapters.refs, ghOptions).call(asExecutionRow(effect))
        case 'close-pr': {
          const repo = String(command.repo ?? '')
          const pr = Number(command.pr ?? 0)
          const view = await adapters.landing.prView(repo, pr, ghOptions)
          if (!view.ok) return { ok: false, error: view.error }
          if (view.data.state !== 'OPEN') return { ok: true, outcome: { closed: false, state: view.data.state } }
          const closed = await adapters.prClose(repo, pr, String(command.comment ?? 'Kawai closed this promotion.'), ghOptions)
          return closed.ok ? { ok: true, outcome: { closed: true } } : { ok: false, error: closed.error }
        }
        default:
          return { ok: false, error: { argv: ['promotion', String(effect.kind)], exitCode: 1, stderr: `no adapter for promotion effect ${String(effect.kind)}` } }
      }
    },
  }
}

/** One unknown promotion effect's inspection: done, not done, a stop, or undecidable (D14). */
export async function inspectPromotionEffect(effect: PromotionEffectRow, reads: InspectorReads): Promise<InspectionVerdict> {
  if (effect.kind === 'close-pr') {
    try {
      const pull = await reads.prView(String(effect.command.repo ?? ''), Number(effect.command.pr ?? 0))
      return pull.state === 'OPEN' ? { found: 'not-done' } : { found: 'done', outcome: { closed: pull.state === 'CLOSED', state: pull.state } }
    } catch (error) {
      return { found: 'undecidable', error: error instanceof Error ? error.message : String(error) }
    }
  }
  // A promotion branch is created like the integration branch: at the commit is done, missing runs again, elsewhere is foreign.
  const kind = effect.kind === 'create-promotion-branch' ? 'create-integration' : effect.kind
  return inspectEffect({ ...asExecutionRow(effect), kind } as EffectRow, reads)
}
