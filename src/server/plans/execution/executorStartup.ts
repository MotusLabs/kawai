// Startup recovery (plan-execution D14): after a restart every `running`
// effect is `unknown`; each is inspected with real git/gh reads before
// anything else for its change runs. An exhausted inspection stops its
// change as effect-unknown (D12). It never wakes the executor: the runtime
// wakes the running teams once its wakes are installed.
import { runGit } from '../../git/gitCommand'
import { ghPrList, ghPrView, ghRunAttempt } from '../landing/github'
import type { GhCommandOptions } from '../landing/ghCommand'
import { inspectUnknownEffects, type InspectorReads } from './effectInspectors'
import type { ExecutionStore } from './executionStore'
import { gitFetch, isAncestor, lsRemoteHead } from '../landing/gitRemote'
import { applyEffectOutcome, stopWaitingChanges, type OutcomeDeps } from './executorOutcomes'

export async function recoverUnknownEffects(deps: { store: ExecutionStore; outcomes?: OutcomeDeps; ghOptions?: GhCommandOptions; now?: () => Date }): Promise<void> {
  const unknown = deps.store.markRunningEffectsUnknown()
  const teams = new Set(unknown.map(effect => deps.store.execution(effect.executionId)?.teamId ?? ''))
  for (const teamId of teams) {
    if (teamId === '') continue
    const reads: InspectorReads = {
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
        const pulls = await ghPrList(repo, { head, base: '' }, deps.ghOptions)
        return pulls.ok ? pulls.data : []
      },
      prView: async (repo, pr) => {
        const view = await ghPrView(repo, pr, deps.ghOptions)
        return view.ok ? view.data : { number: pr, url: '', state: 'OPEN', headRefOid: '', mergeCommit: null }
      },
      contains: async (cwd, ref, ancestor, descendant) => {
        if (!(await gitFetch(cwd, 'origin', ref)).ok) throw new Error(`the fetch of ${ref} failed`)
        const result = await isAncestor(cwd, ancestor, descendant)
        if (!result.ok) throw new Error(`the ancestry of ${ancestor} could not be read`)
        return result.ancestor
      },
      runAttempt: async (repo, runId) => {
        const attempt = await ghRunAttempt(repo, runId, deps.ghOptions)
        return attempt.ok ? attempt.data : 1
      },
    }
    await inspectUnknownEffects({
      store: deps.store, reads,
      ...(deps.now ? { now: deps.now } : {}),
      // Execution-level effects (X3, integration-candidates D4): a done one is
      // recorded by its mechanism; a stopped or exhausted one stops every
      // change still waiting on it.
      onInspected: (effect, verdict) => {
        if (effect.change !== null) return
        if (verdict.found === 'done' && deps.outcomes) applyEffectOutcome(deps.outcomes, { ...effect, state: 'done', outcome: verdict.outcome })
        if (verdict.found === 'stop') stopWaitingChanges(deps.store, effect.executionId, effect.kind, effect.id, verdict.detail.message ?? `stopped as ${verdict.reason}`)
      },
      onUnknownSettled: effect => {
        if (effect.change === null) return stopWaitingChanges(deps.store, effect.executionId, effect.kind, effect.id, effect.error ?? 'the outcome could not be determined')
        const row = deps.store.change(effect.executionId, effect.change)
        // A stopped execution's merge is settled by its landing-outcome stage.
        if (row === null || row.state === 'stopped' || row.state === 'cancelled' || row.state === 'landed') return
        if (deps.store.execution(effect.executionId)?.state !== 'running') return
        deps.store.transition(effect.executionId, effect.change, row, {
          state: 'stopped', stopReason: 'effect-unknown', step: null, stopDetail: { message: effect.error ?? 'the outcome could not be determined' },
        })
      },
    })
  }
}
