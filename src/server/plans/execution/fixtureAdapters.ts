// Deterministic execution adapters for the development fixture
// (plan-execution §17.2): the browser walkthrough runs Start → the composed
// executor → a landing without GitHub or gh. Git stays real — the fixture
// repository carries a local bare origin, so provisioning, pushes, ancestry,
// and the merge-tree check exercise the real code paths — while CI, pull
// requests, the merge, and the landing probe are fixture state: check runs
// answer success for the fixture floor names, a pull request is a registry
// row, and a merge reports the reviewed head as the merge commit (a
// fast-forward landing whose tree check passes against the real head).
// Wired only under the existing fixture switch; every other composition
// uses the real adapters (a test pins that). Pull requests can also be
// closed (`fixturePrClose`), and the last probed main checkout is kept so the
// integration fixture (`fixtureIntegrationAdapters.ts`) finds the bare origin.
import { runGit } from '../../git/gitCommand'
import { lsRemoteHead, pushToRemote } from '../landing/gitRemote'
import type { GithubOutcome, PrDetail, PrSummary } from '../landing/github'
import type { ProbeResult } from '../landing/landingProbe'
import type { CiCheck } from '../../../shared/planExecution'
import type { FloorMap } from '../../../shared/planExecution'
import type { LandingAdapters } from './executionLanding'
import type { RoundAdapters } from './executionRounds'

/** The fixture floor: the four mandatory checks on two deterministic names. */
export const FIXTURE_FLOOR: FloorMap = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

/** One fixture pull request; `mergeCommit` is set when it merges. */
interface FixturePr {
  number: number
  url: string
  /** The origin the pull request belongs to; lookups are repo-scoped like GitHub's. */
  repo: string
  head: string
  base: string
  headRefOid: string
  mergeCommit: string | null
  /** `gh pr close` ran (a cancelled or failed promotion). */
  closed: boolean
}

/** The fixture's pull-request registry: one server process, every walkthrough
 * team in it (CI runs the walkthrough specs in one server, so rows are
 * repo-scoped — two teams may each carry a PR for the same head branch). */
const registry: FixturePr[] = []
let nextNumber = 1
/** The main checkout the last probe read: the fixture's ref writes find its bare origin through it. */
let fixtureMain: string | null = null

/** The fixture repository's main checkout, once a probe has read it. */
export function fixtureMainCheckout(): string | null {
  return fixtureMain
}

/** The registry row of a fixture pull request (mutable: the promotion merge records on it), null when unknown. Numbers are unique per process, so no repo is needed. */
export function fixturePullRequest(prNumber: number): FixturePr | null {
  return registry.find(entry => entry.number === prNumber) ?? null
}

const prState = (pr: FixturePr): 'OPEN' | 'MERGED' | 'CLOSED' => pr.mergeCommit !== null ? 'MERGED' : pr.closed ? 'CLOSED' : 'OPEN'

/** `gh pr close` on the fixture: the registry row reads CLOSED. */
export async function fixturePrClose(repo: string, prNumber: number): Promise<GithubOutcome<null>> {
  const pr = registry.find(entry => entry.repo === repo && entry.number === prNumber) ?? null
  if (pr === null) return { ok: false, error: { argv: ['gh', 'pr', 'close'], exitCode: 1, httpStatus: 404, message: `no fixture pull request #${prNumber}` } }
  pr.closed = true
  return { ok: true, data: null }
}

const successCheck = (name: string): CiCheck => ({
  name, source: 'check-run', conclusion: 'success', link: null, runId: 1, startedAt: null, completedAt: '2099-01-01T00:00:00Z',
})

/**
 * The fixture round adapters: real git for the remote reads and the push,
 * fixture state for CI and pull requests. Every check run succeeds under a
 * floor name, so the walkthrough's CI passes on the first read.
 */
export function fixtureRoundAdapters(): RoundAdapters {
  return {
    lsRemoteHead,
    push: pushToRemote,
    checkRuns: async (): Promise<GithubOutcome<CiCheck[]>> =>
      ({ ok: true, data: [...new Set(Object.values(FIXTURE_FLOOR).flat())].map(successCheck) }),
    statuses: async (): Promise<GithubOutcome<CiCheck[]>> => ({ ok: true, data: [] }),
    prList: async (repo: string, input: { head: string }): Promise<GithubOutcome<PrSummary[]>> =>
      ({ ok: true, data: registry.filter(pr => pr.repo === repo && pr.head === input.head).map(pr => ({ number: pr.number, url: pr.url, state: prState(pr), headRefOid: pr.headRefOid })) }),
    prCreate: async (repo: string, input: { head: string; base: string }): Promise<GithubOutcome<{ number: number; url: string }>> => {
      // GitHub refuses only an OPEN pull request for the head branch, in the
      // same repository: a merged or closed one frees the branch.
      const existing = registry.find(pr => pr.repo === repo && pr.head === input.head && prState(pr) === 'OPEN')
      if (existing !== undefined) return { ok: false, error: { argv: ['gh', 'pr', 'create'], exitCode: 1, httpStatus: 422, message: `a pull request for ${input.head} already exists as #${existing.number}` } }
      const pr: FixturePr = { number: nextNumber++, url: `https://example.internal/pr/fixture`, repo, head: input.head, base: input.base, headRefOid: '', mergeCommit: null, closed: false }
      registry.push(pr)
      return { ok: true, data: { number: pr.number, url: pr.url } }
    },
    rerun: async (): Promise<GithubOutcome<null>> => ({ ok: true, data: null }),
  }
}

/**
 * The fixture landing adapters: the real git reads (fetch, ancestry,
 * merge-tree, remote heads) over the local bare origin, and a registry
 * merge — the reviewed head is the merge commit, a fast-forward landing
 * whose tree check passes against the real head.
 */
export function fixtureLandingAdapters(): LandingAdapters {
  return {
    fetch: (cwd: string) => import('../landing/gitRemote').then(module => module.gitFetch(cwd)),
    isAncestor: (cwd: string, ancestor: string, descendant: string) =>
      import('../landing/gitRemote').then(module => module.isAncestor(cwd, ancestor, descendant)),
    mergeTree: (cwd: string, ours: string, theirs: string) =>
      import('../landing/gitRemote').then(module => module.mergeTree(cwd, ours, theirs)),
    lsRemoteHead: (cwd: string, ref: string) => lsRemoteHead(cwd, ref),
    prMerge: async (_repo: string, prNumber: number, _method: 'merge' | 'squash' | 'rebase', headSha: string): Promise<GithubOutcome<null>> => {
      const pr = registry.find(entry => entry.number === prNumber)
      if (pr === undefined) return { ok: false, error: { argv: ['gh', 'pr', 'merge'], exitCode: 1, httpStatus: 404, message: `no fixture pull request #${prNumber}` } }
      pr.headRefOid = headSha
      pr.mergeCommit = headSha
      return { ok: true, data: null }
    },
    prView: async (_repo: string, prNumber: number): Promise<GithubOutcome<PrDetail>> => {
      const pr = registry.find(entry => entry.number === prNumber)
      if (pr === undefined) return { ok: false, error: { argv: ['gh', 'pr', 'view'], exitCode: 1, httpStatus: 404, message: `no fixture pull request #${prNumber}` } }
      return { ok: true, data: { number: pr.number, url: pr.url, state: prState(pr), headRefOid: pr.headRefOid, mergeCommit: pr.mergeCommit } }
    },
    updateBranch: async (): Promise<GithubOutcome<null>> => ({ ok: true, data: null }),
  }
}

/**
 * The fixture landing probe: no GitHub, no gh — the base branch and head are
 * read from the repository's real bare origin, and the probe reports no
 * findings. `repo` stays null, so Start's changes-on-base pre-read skips the
 * origin tree comparison (its artifacts are the local ones the spec wrote).
 */
export async function fixtureProbe(input: { main: string }): Promise<ProbeResult> {
  fixtureMain = input.main
  const symref = await runGit(['ls-remote', '--symref', 'origin', 'HEAD'], { cwd: input.main })
  const branch = symref.ok ? (symref.stdout.match(/^ref:\s*refs\/heads\/(\S+)/m)?.[1] ?? null) : null
  if (branch === null) {
    return { findings: [{ code: 'origin', message: 'The fixture repository has no origin default branch.' }], repo: null, base: null }
  }
  const head = await lsRemoteHead(input.main, `refs/heads/${branch}`)
  if (!head.ok || head.sha === null) {
    return { findings: [{ code: 'base-branch', message: `The fixture repository's base branch "${branch}" could not be read.` }], repo: null, base: null }
  }
  return { findings: [], repo: null, base: { branch, head: head.sha, tree: '' } }
}
