// The integration-landing bench (integration-candidates §3-§4) over the
// plan-execution matrix harness: the same real bare origin and scripted
// GitHub, plus the integration tables, the GitHub ref API answered on the
// bare origin (a create is refused with 422 when the ref exists, a
// fast-forward when the branch is not an ancestor of the commit), and an
// executor whose registry holds both landing mechanisms.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { gitFetch, isAncestor, lsRemoteHead } from '../plans/landing/gitRemote'
import { directMechanism } from '../plans/landing/directMechanism'
import type { LandingMechanisms } from '../plans/landing/landingMechanisms'
import { applyIntegrationSchema } from '../plans/landing/integration/integrationSchema'
import { IntegrationStore } from '../plans/landing/integration/integrationStore'
import { integrationMechanism } from '../plans/landing/integration/integrationMechanism'
import type { IntegrationAdapters } from '../plans/landing/integration/integrationEffects'
import { provisionAdapter } from '../plans/execution/executionProvision'
import type { ExecutionExecutor, ExecutorDeps } from '../plans/execution/executor'
import { commitAll, git, originHead, FLOOR, type MatrixBench } from './executionMatrixHarness'

export interface RefScript {
  creates: Array<{ branch: string; sha: string }>
  fastForwards: Array<{ branch: string; sha: string }>
  /** Transient (HTTP 502) answers left before a create goes through. */
  createTransient: number
  /** Runs inside the fast-forward call before GitHub compares (a race: move the branch). */
  beforeFastForward: (() => void) | null
}

export interface IntegrationBench {
  store: IntegrationStore
  refs: RefScript
  /** The GitHub ref API on the bare origin. */
  adapters: IntegrationAdapters
  mechanisms: LandingMechanisms
  makeExecutor: (overrides?: Partial<ExecutorDeps>) => ExecutionExecutor
  executor: ExecutionExecutor
  tick: (executor?: ExecutionExecutor) => Promise<void>
}

const originContains = (h: MatrixBench, ancestor: string, descendant: string): boolean =>
  spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: h.matrix.origin, env: cleanGitEnv() }).status === 0

export function createIntegrationBench(h: MatrixBench): IntegrationBench {
  applyIntegrationSchema(h.bench.db.db)
  const store = new IntegrationStore(h.bench.db.db)
  const refs: RefScript = { creates: [], fastForwards: [], createTransient: 0, beforeFastForward: null }
  const refused = (args: string[], message: string, httpStatus = 422) => ({ ok: false as const, error: { argv: ['gh', ...args], exitCode: 1, httpStatus, message } })
  const adapters: IntegrationAdapters = {
    createRef: async (_repo, branch, sha) => {
      if (refs.createTransient > 0) {
        refs.createTransient -= 1
        return refused(['api', 'git/refs'], 'HTTP 502: Bad Gateway', 502)
      }
      if (originHead(h.matrix, branch) !== null) return refused(['api', 'git/refs'], 'HTTP 422: Reference already exists')
      git(['update-ref', `refs/heads/${branch}`, sha], h.matrix.origin)
      refs.creates.push({ branch, sha })
      return { ok: true, data: null }
    },
    fastForwardRef: async (_repo, branch, sha) => {
      refs.beforeFastForward?.()
      const head = originHead(h.matrix, branch)
      if (head === null || !originContains(h, head, sha)) return refused(['api', 'git/refs/heads'], 'HTTP 422: Update is not a fast forward')
      git(['update-ref', `refs/heads/${branch}`, sha, head], h.matrix.origin)
      refs.fastForwards.push({ branch, sha })
      return { ok: true, data: null }
    },
    lsRemoteHead, fetch: gitFetch, isAncestor,
  }
  const mechanisms: LandingMechanisms = new Map([['direct', directMechanism], ['integration-branch', integrationMechanism(store, adapters)]])
  const makeExecutor = (overrides: Partial<ExecutorDeps> = {}) => h.makeExecutor({
    mechanisms, adapters: { provision: provisionAdapter(h.executions, undefined, mechanisms) }, ...overrides,
  })
  // `tick` drives whichever executor the bench holds now (a test may restart it).
  const bench: IntegrationBench = {
    store, refs, adapters, mechanisms, makeExecutor, executor: makeExecutor(),
    tick: async (target?: ExecutionExecutor) => {
      const executor = target ?? bench.executor
      executor.wake(h.matrix.world.team.teamId)
      await executor.idle()
    },
  }
  return bench
}

/**
 * One approved plan landing on `branch` and its running execution, as
 * ExecutionService.start writes it: the integration branch as base, its
 * head (or the default head while it is missing) as base commit, and the
 * mechanism's Start effects.
 */
export async function startedIntegration(h: MatrixBench, i: IntegrationBench, branch: string, changes: Array<{ change: string; dependsOn?: string[] }>, options: { maxParallel?: number } = {}): Promise<string> {
  const { world } = h.matrix
  git(['pull', '-q', '--ff-only', 'origin', 'master'], world.repo)
  for (const { change } of changes) {
    fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change), { recursive: true })
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  commitAll(world.repo, `changes ${changes.map(entry => entry.change).join(' ')}`)
  git(['push', '-q', 'origin', 'master'], world.repo)
  const { planId, revision, hash } = await h.bench.draftInReview({
    changes: changes.map(entry => ({ change: entry.change, dependsOn: entry.dependsOn ?? [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' })),
    reviewGroup: 'reviewers',
    landing: { mode: 'integration-branch', branch },
  })
  await h.bench.approve(planId, revision)
  const existing = originHead(h.matrix, branch)
  const master = originHead(h.matrix, 'master')!
  return h.executions.atomically(() => {
    const execution = h.executions.insertExecution({
      teamId: world.team.teamId, planId, revision, contentHash: hash, reportId: 'r', inputHash: 'i',
      landingMode: 'integration-branch', baseBranch: branch, baseCommit: existing ?? master, floor: { version: 1, map: FLOOR },
      maxParallel: options.maxParallel ?? 2, mergeMethod: 'merge',
      changes: changes.map(entry => ({ change: entry.change, landed: false })),
    })
    const mechanism = i.mechanisms.get('integration-branch')!
    for (const effect of mechanism.startEffects?.({
      execution, main: world.repo,
      probe: { findings: [], repo: 'o/r', base: { branch, head: existing ?? master, tree: '' }, integration: { branch, target: 'master', exists: existing !== null } },
    }) ?? []) {
      h.executions.insertEffect({ executionId: execution.id, change: null, roundId: null, ...effect })
    }
    return execution.id
  })
}
