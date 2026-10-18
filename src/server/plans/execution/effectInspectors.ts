// effectInspectors.ts - Startup recovery and the per-kind inspections
// (plan-execution D14's table): after a restart every `running` effect is
// `unknown`, and an unknown effect is inspected before anything else for
// its change runs. Each inspector is a pure-async read over injected
// adapters — never a write — answering one of: found done (with the facts
// to record), not done (the effect simply runs again), undecidable (the
// read failed; retried under the same backoff, then the change stops as
// effect-unknown), or a stop the finding itself decides (a closed pull
// request). An inspection that cannot run is retried the same way the
// runner retries a transient call.
import type { EffectKind, StopDetail, StopReason } from '../../../shared/planExecution'
import type { EffectRow } from './executionRows'
import type { ExecutionStore } from './executionStore'
import type { PrDetail, PrSummary } from '../landing/github'

export type InspectionVerdict =
  | { found: 'done'; outcome: unknown }
  | { found: 'not-done'; outcome?: unknown }
  | { found: 'undecidable'; error: string }
  | { found: 'stop'; reason: StopReason; detail: StopDetail }

/** The reads the table names, one per adapter call; a rejected promise reads as undecidable. */
export interface InspectorReads {
  /** `git worktree list`: a worktree's existence, and its HEAD (provision's recorded fact). */
  worktree: (repo: string, path: string) => Promise<{ present: boolean; head: string | null }>
  /** `git rev-parse --verify refs/heads/<branch>`: a local branch's head. */
  localBranch: (repo: string, branch: string) => Promise<string | null>
  /** `git ls-remote origin <ref>`: a remote ref's head, null when absent. */
  remoteHead: (cwd: string, ref: string) => Promise<string | null>
  /** `gh pr list --head <change> --base <base> --state all` (D14's open-pr inspection). */
  prList: (repo: string, head: string, base: string) => Promise<PrSummary[]>
  /** `gh pr view`: state, head, and merge commit (update-branch and merge). */
  prView: (repo: string, prNumber: number) => Promise<PrDetail>
  /** A workflow run's attempt number (rerun). */
  runAttempt: (repo: string, runId: number) => Promise<number>
}

const undecidable = (error: unknown): InspectionVerdict =>
  ({ found: 'undecidable', error: error instanceof Error ? error.message : String(error) })

/**
 * One unknown effect's inspection (D14's table). `command` carries what the
 * dispatching stage recorded: repo and cwd, branch or commit, pull request
 * or run — each kind its own fields.
 */
export async function inspectEffect(effect: EffectRow, reads: InspectorReads): Promise<InspectionVerdict> {
  const command = effect.command
  const text = (key: string): string => {
    const value = command[key]
    if (typeof value !== 'string' || value === '') throw new Error(`the effect's command carries no ${key}`)
    return value
  }
  const number = (key: string): number => {
    const value = command[key]
    if (typeof value !== 'number') throw new Error(`the effect's command carries no ${key}`)
    return value
  }
  try {
    switch (effect.kind as EffectKind) {
      case 'provision': {
        // Worktree list, local branch: present records the head, else run again.
        const worktree = await reads.worktree(text('repo'), text('path'))
        if (worktree.present) return { found: 'done', outcome: { head: worktree.head } }
        const branch = await reads.localBranch(text('repo'), text('branch'))
        return branch !== null ? { found: 'done', outcome: { head: branch } } : { found: 'not-done' }
      }
      case 'push': {
        // origin's head contains the commit: done; else run again.
        const head = await reads.remoteHead(text('cwd'), `refs/heads/${text('branch')}`)
        if (head === null) return { found: 'not-done' }
        return head === text('commit') || head.startsWith(text('commit')) ? { found: 'done', outcome: { head } }
          : { found: 'not-done', outcome: { head } }
      }
      case 'open-pr': {
        const pulls = await reads.prList(text('repo'), text('head'), text('base'))
        if (pulls.length === 0) return { found: 'not-done' }
        const open = pulls.find(pull => pull.state === 'OPEN')
        if (open) return { found: 'done', outcome: { number: open.number, url: open.url, head: open.headRefOid } }
        // A closed one stops as pr-closed; Retry opens a new one.
        const closed = pulls[0]!
        return { found: 'stop', reason: 'pr-closed', detail: { message: `Pull request ${closed.number} was closed without merging.`, names: [String(closed.number)] } }
      }
      case 'rerun': {
        // The run's attempt number: above 1 once the rerun landed.
        const attempt = await reads.runAttempt(text('repo'), number('runId'))
        return attempt > 1 ? { found: 'done', outcome: { attempt } } : { found: 'not-done' }
      }
      case 'update-branch': {
        // PR head moved: done either way — the clean-merge check (D13) sorts
        // carried rounds from update attempts on the new head. The outcome
        // keeps the adapter's shape: `head` is the reviewed head it pinned.
        const pull = await reads.prView(text('repo'), number('pr'))
        return { found: 'done', outcome: { requested: true, head: text('head'), newHead: pull.headRefOid, moved: pull.headRefOid !== text('head'), state: pull.state } }
      }
      case 'merge': {
        // PR state and merge commit: a completed merge is the landing fact's input.
        const pull = await reads.prView(text('repo'), number('pr'))
        if (pull.state === 'MERGED' && pull.mergeCommit !== null) {
          return { found: 'done', outcome: { merged: true, mergeCommit: pull.mergeCommit, head: pull.headRefOid } }
        }
        if (pull.state === 'CLOSED' && pull.mergeCommit === null) {
          return { found: 'stop', reason: 'pr-closed', detail: { message: `Pull request ${pull.number} was closed without merging.`, names: [String(pull.number)] } }
        }
        return { found: 'not-done' }
      }
      case 'remove-worktree': {
        const worktree = await reads.worktree(text('repo'), text('path'))
        return worktree.present ? { found: 'not-done' } : { found: 'done', outcome: null }
      }
      default: {
        // Kinds a later mechanism adds (X3) arrive here until it ships its inspector.
        return { found: 'undecidable', error: `no inspector for kind ${String(effect.kind)}` }
      }
    }
  } catch (error) {
    return undecidable(error)
  }
}

/**
 * The recovery pass (D14): inspect every due unknown effect. Found done
 * records the outcome; not done returns the effect to pending to run again;
 * an undecidable inspection retries under the same backoff, and after three
 * tries the effect settles as effect-unknown and the change stops (the
 * caller's stop lands with §13's wiring).
 */
export async function inspectUnknownEffects(deps: {
  store: ExecutionStore
  reads: InspectorReads
  backoffsMs?: readonly [number, number, number]
  now?: () => Date
  onUnknownSettled?: (effect: EffectRow, error: string) => void
  onInspected?: (effect: EffectRow, verdict: InspectionVerdict) => void
}): Promise<void> {
  const backoffs = deps.backoffsMs ?? [30_000, 120_000, 600_000]
  const now = deps.now ?? (() => new Date())
  for (const effect of deps.store.dueUnknownEffects(now().toISOString())) {
    const verdict = await inspectEffect(effect, deps.reads)
    deps.onInspected?.(effect, verdict)
    if (verdict.found === 'done') {
      deps.store.setEffectOutcome(effect.id, { state: 'done', outcome: verdict.outcome })
    } else if (verdict.found === 'not-done') {
      deps.store.resetEffect(effect.id)
    } else if (verdict.found === 'stop') {
      deps.store.setEffectOutcome(effect.id, { state: 'failed', error: `stopped as ${verdict.reason}`, outcome: { stop: verdict.reason, detail: verdict.detail } })
    } else if (effect.tries < backoffs.length) {
      deps.store.scheduleInspectionRetry(effect.id, new Date(now().getTime() + backoffs[effect.tries]!).toISOString(), verdict.error)
    } else {
      deps.store.setEffectOutcome(effect.id, { state: 'failed', error: verdict.error })
      deps.onUnknownSettled?.(deps.store.effect(effect.id)!, verdict.error)
    }
  }
}
