// The promotion bench (integration-candidates §5–§6) over the integration
// bench: the real bare origin and scripted GitHub (pull requests, updates,
// merges with `--merge`, the ref API), plus the promotion parts composed by
// `composePromotions` as production does — the slot holder kind, the
// PromotionService, and the runner the executor ticks. Its own scripted
// pieces: `gh pr close` (with transient failures), the repository's
// allow_merge_commit, and D14's inspection reads over the same scripted
// GitHub.
import { gitFetch, isAncestor, lsRemoteHead } from '../plans/landing/gitRemote'
import type { InspectorReads } from '../plans/execution/effectInspectors'
import type { ExecutionExecutor } from '../plans/execution/executor'
import { composePromotions } from '../plans/landing/integration/promotionComposition'
import type { PromotionRunner } from '../plans/landing/integration/promotionRunner'
import { realPromotionReads, type PromotionCaller, type PromotionReads, type PromotionService } from '../plans/landing/integration/PromotionService'
import type { ProbeResult } from '../plans/landing/landingProbe'
import { FLOOR, originHead, passedChange, type MatrixBench } from './executionMatrixHarness'
import { startedIntegration, type IntegrationBench } from './integrationMatrixHarness'

export interface PromotionScript {
  closes: Array<{ pr: number; comment: string }>
  /** Transient (HTTP 502) answers left before `gh pr close` goes through. */
  closeTransient: number
  allowMergeCommit: boolean | null
  /** Inspection reads that reject (D14's undecidable), by read name. */
  failingReads: Set<keyof InspectorReads>
}

export interface PromotionBench {
  service: PromotionService
  runner: PromotionRunner
  script: PromotionScript
  executor: ExecutionExecutor
  human: PromotionCaller
  /** D14's inspection reads over the scripted GitHub. */
  inspectorReads: InspectorReads
  tick: (executor?: ExecutionExecutor) => Promise<void>
  /** A fresh executor over the same stores and runner (a restart; call `runner.startup()` through `executor.startup()`). */
  restart: () => ExecutionExecutor
}

/** One read at a time: two racing Promotes' fetches into one checkout would collide on git's ref locks. */
function serialized(reads: PromotionReads): PromotionReads {
  let chain: Promise<unknown> = Promise.resolve()
  const queue = <T>(read: () => Promise<T>): Promise<T> => {
    const next = chain.then(read, read)
    chain = next.catch(() => {})
    return next
  }
  return {
    remoteHead: (main, branch) => queue(() => reads.remoteHead(main, branch)),
    contains: (main, branches, ancestor, descendant) => queue(() => reads.contains(main, branches, ancestor, descendant)),
    allowMergeCommit: repo => queue(() => reads.allowMergeCommit(repo)),
  }
}

export function createPromotionBench(h: MatrixBench, i: IntegrationBench): PromotionBench {
  const { world } = h.matrix
  const script: PromotionScript = { closes: [], closeTransient: 0, allowMergeCommit: true, failingReads: new Set() }
  const pullOf = (pr: number) => h.gh.pulls.find(pull => pull.number === pr)
  const guard = <T>(name: keyof InspectorReads, read: () => Promise<T>): Promise<T> =>
    script.failingReads.has(name) ? Promise.reject(new Error(`${name} could not be read`)) : read()
  const inspectorReads: InspectorReads = {
    worktree: async () => ({ present: false, head: null }),
    localBranch: async () => null,
    remoteHead: (cwd, ref) => guard('remoteHead', async () => {
      const head = await lsRemoteHead(cwd, ref)
      if (!head.ok) throw new Error(head.error.stderr)
      return head.sha
    }),
    prList: (_repo, head) => guard('prList', async () => h.gh.pulls.filter(pull => pull.branch === head)
      .map(pull => ({ number: pull.number, url: `https://example.internal/pr/${pull.number}`, state: pull.state, headRefOid: originHead(h.matrix, pull.branch) ?? '' }))),
    prView: (_repo, pr) => guard('prView', async () => {
      const pull = pullOf(pr)
      if (pull === undefined) throw new Error(`no pull request ${pr}`)
      return { number: pr, url: `https://example.internal/pr/${pr}`, state: pull.state, headRefOid: originHead(h.matrix, pull.branch) ?? '', mergeCommit: pull.mergeCommit }
    }),
    contains: (cwd, ref, ancestor, descendant) => guard('contains', async () => {
      if (!(await gitFetch(cwd, 'origin', ref)).ok) throw new Error(`could not fetch ${ref}`)
      const result = await isAncestor(cwd, ancestor, descendant)
      if (!result.ok) throw new Error(result.error.stderr)
      return result.ancestor
    }),
    runAttempt: () => guard('runAttempt', async () => 2),
  }
  const probe = async (): Promise<ProbeResult> => ({ findings: [], repo: 'o/r', base: null })
  const { service, runner } = composePromotions({
    integration: i.store, executions: h.executions, plans: h.plansService, plansStore: h.bench.plans,
    settings: { planExecution: async () => ({ floorChecks: FLOOR, maxParallelChanges: 2, mergeMethod: 'squash' }) },
    identityOf: () => world.team,
    wake: () => {},
    probe,
    reads: serialized({ ...realPromotionReads(), allowMergeCommit: async () => script.allowMergeCommit }),
    inspectorReads,
    now: () => new Date(h.clock.now),
    repoOf: () => 'o/r',
    adapters: {
      landing: h.landingAdapters, rounds: h.roundAdapters, refs: i.adapters,
      prClose: async (_repo, pr, comment) => {
        if (script.closeTransient > 0) {
          script.closeTransient -= 1
          return { ok: false, error: { argv: ['gh', 'pr', 'close'], exitCode: 1, httpStatus: 502, message: 'HTTP 502: Bad Gateway' } }
        }
        const pull = pullOf(pr)
        if (pull !== undefined) pull.state = 'CLOSED'
        script.closes.push({ pr, comment })
        return { ok: true, data: null }
      },
    },
  })
  const restart = () => i.makeExecutor({ promotions: runner })
  const bench: PromotionBench = {
    service, runner, script, inspectorReads, executor: restart(), restart,
    human: { kind: 'human', team: world.team },
    tick: async (target?: ExecutionExecutor) => {
      const executor = target ?? bench.executor
      executor.wake(world.team.teamId)
      await executor.idle()
    },
  }
  return bench
}

/** Two changes (`a<tag>`, then `b<tag>` depending on it) landed on a fresh integration branch through the bench's executor; the plan id. */
export async function twoLandings(h: MatrixBench, i: IntegrationBench, p: PromotionBench, branch: string, tag: string): Promise<string> {
  const executionId = await startedIntegration(h, i, branch, [{ change: `a${tag}` }, { change: `b${tag}`, dependsOn: [`a${tag}`] }])
  const real = h.tick
  h.tick = () => p.tick()
  try {
    for (const name of [`a${tag}`, `b${tag}`]) {
      await passedChange(h, executionId, name)
      for (let tick = 0; tick < 6 && h.executions.change(executionId, name)!.state !== 'landed'; tick++) await p.tick()
      if (h.executions.change(executionId, name)!.state !== 'landed') throw new Error(`${name} did not land`)
    }
  } finally {
    h.tick = real
  }
  return h.executions.execution(executionId)!.planId
}
