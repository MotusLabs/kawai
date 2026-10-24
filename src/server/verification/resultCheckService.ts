// The check service (independent-verification design D1, task 2.3): pending
// checks run one at a time per team, only after the result's own transaction
// has committed, and never block, gate, or delay anything — a check that
// cannot finish is recorded unavailable, with its reason, and the flight is
// released so the next check runs. Startup (D1): every team holding a
// pending row runs its checks again through the same single flight; the
// caller never awaits it.
import fs from 'node:fs'
import path from 'node:path'
import {
  CheckUnavailable, RESULT_CHECK_BUDGET_MS, computeResultFacts, makeCheckGit,
  type CheckGit, type OtherTaskHead, type ResultCheckInput,
} from './resultChecks'
import { serializeFacts } from './serializeFacts'
import { readTreeTestList } from './treeTestList'
import type { ResultCheckStore } from './resultCheckStore'
import type { CoverageMap } from '../../shared/coverageMaps'
import type { TaskResultCheck } from '../../shared/teamTasks'

/** What the service reads about results and tasks, prepared by the
 * composition (sessionMailbox): the store rows name ids; the facts' inputs
 * come from the task and result stores. */
export interface ResultCheckSources {
  /** The result to check: its commit text, pinned worktree, and coverage map. */
  result: (id: string) => { commit: string | null; worktree: string | null; coverage: CoverageMap | null } | null
  /** Every open, active, or blocked task of the team, with creation times. */
  openTasks: (teamId: string) => Array<{ id: string; worktree: string | null; createdAt: string }>
  /** The team's listed worktree roots (task worktrees are validated against these). */
  listedWorktrees: (teamId: string) => Promise<string[]>
}

const REASON_MAX = 300

function reasonOf(error: unknown): string {
  const text = error instanceof CheckUnavailable
    ? error.message
    : error instanceof Error ? error.message : String(error)
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text
}

/** The team's main checkout: the git common dir's parent directory. */
export function repoRootOf(teamId: string): string | null {
  const root = path.dirname(teamId)
  return fs.existsSync(root) ? root : null
}

export class ResultCheckService {
  private readonly flights = new Map<string, Promise<void>>()

  constructor(private readonly options: {
    store: ResultCheckStore
    sources: ResultCheckSources
    budgetMs?: number
    /** Test seam: one CheckGit per check, over the injected budget default. */
    runner?: () => CheckGit
    repoRootOf?: (teamId: string) => string | null
    /** A check settled (independent-verification D12): the composition refreshes the team's readers. */
    onSettled?: (teamId: string) => void
  }) {}

  /**
   * Run the team's pending checks when no flight is running (D1: one at a
   * time per team). Returns at once; a check never blocks, delays, or fails
   * a caller. Pending rows that appear while the flight runs are picked up
   * before it ends, and a row that lands between the last re-read and the
   * release re-wakes the flight.
   */
  wake(teamId: string): void {
    if (this.flights.has(teamId)) return
    const flight = (async (): Promise<'drained' | 'stuck'> => {
      for (;;) {
        const pending = this.options.store.pendingForTeam(teamId)
        if (pending.length === 0) return 'drained'
        let progressed = false
        for (const check of pending) {
          progressed = await this.runOne(check) || progressed
        }
        // A store failure settled nothing; leave the rows for the next wake
        // instead of spinning on them.
        if (!progressed) return 'stuck'
      }
    })()
    const tracked = flight.then(ended => {
      this.flights.delete(teamId)
      // A row that landed between the last re-read and the release re-wakes
      // the flight; a stuck store waits for the next external wake.
      if (ended === 'drained' && this.options.store.pendingForTeam(teamId).length > 0) this.wake(teamId)
    }, () => {
      // The store itself failed: the rows stay pending and the next wake
      // (a submit, a recheck, startup) retries.
      this.flights.delete(teamId)
    })
    this.flights.set(teamId, tracked)
  }

  /** Startup (D1): every team holding a pending check runs it again. */
  start(): void {
    for (const teamId of this.options.store.teamsWithPending()) this.wake(teamId)
  }

  /** Resolves when no flight is running; tests and shutdown await it. */
  async quiesce(): Promise<void> {
    while (this.flights.size > 0) {
      await Promise.all([...this.flights.values()])
    }
  }

  /** Settle one check exactly once: its facts when the check ran, else
   * unavailable with the reason (D1). Returns whether the row changed;
   * never throws — a store failure leaves the row pending. */
  private async runOne(check: TaskResultCheck): Promise<boolean> {
    const settled = await this.settleOne(check)
    // The readers' view derives at read time (D12): a settled row is what
    // changed it, so the composition learns here and never inside a gate.
    if (settled) this.options.onSettled?.(check.teamId)
    return settled
  }

  private async settleOne(check: TaskResultCheck): Promise<boolean> {
    try {
      const repoRoot = (this.options.repoRootOf ?? repoRootOf)(check.teamId)
      if (repoRoot === null) {
        return this.options.store.settle(check.id, 'unavailable', null, 'the team repository is missing')
      }
      const result = this.options.sources.result(check.resultId)
      if (result === null) {
        return this.options.store.settle(check.id, 'unavailable', null, `result ${check.resultId} is gone`)
      }
      const input = await this.buildInput(check, result, repoRoot)
      const git = this.options.runner?.() ?? makeCheckGit(this.options.budgetMs ?? RESULT_CHECK_BUDGET_MS)
      const facts = await computeResultFacts(input, git)
      return this.options.store.settle(check.id, 'done', serializeFacts(facts), null)
    } catch (error) {
      return this.options.store.settle(check.id, 'unavailable', null, reasonOf(error))
    }
  }

  /** The check's input (D2): the result's commit and worktree, and every
   * other open task's listed worktree, newest task first. */
  private async buildInput(
    check: TaskResultCheck,
    result: { commit: string | null; worktree: string | null; coverage: CoverageMap | null },
    repoRoot: string,
  ): Promise<ResultCheckInput> {
    const listed = new Set(await this.options.sources.listedWorktrees(check.teamId))
    const others: OtherTaskHead[] = this.options.sources.openTasks(check.teamId)
      .filter(task => task.id !== check.taskId && task.worktree !== null && listed.has(task.worktree))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(task => ({ taskId: task.id, worktree: task.worktree as string }))
    return {
      given: result.commit,
      worktree: result.worktree,
      coverage: result.coverage,
      repoRoot,
      others,
      host: { platform: process.platform, arch: process.arch },
      // The real reader (D7, task 4.3): the tree's newest usable recorded
      // list answers the citations; without one they read run-unknown.
      testList: (treeId) => readTreeTestList(repoRoot, treeId),
    }
  }
}
