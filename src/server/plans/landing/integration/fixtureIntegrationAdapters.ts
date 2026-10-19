// Deterministic integration and promotion adapters for the development
// fixture (integration-candidates L2, 8.3): the browser walkthrough lands
// two changes on an integration branch and promotes it without GitHub or gh.
// Git stays real — the fixture repository's origin is a local bare
// repository, so the ref writes happen there with the same rules GitHub
// applies: a create refuses an existing ref and a fast-forward refuses a
// non-descendant, both as HTTP 422 (Kawai's read-back and moved/rewritten
// rules then run unchanged), and never forced (`update-ref` with the old
// value). A promotion's merge writes a real merge commit of the pull
// request's head onto its base, so the record step's tree check and the
// integration branch's fast-forward to the verified head run on real
// commits. Pull requests, CI, and `gh pr close` stay the fixture registry's
// (`fixtureAdapters.ts`); the repository allows merge commits. Wired only
// under the fixture switch, like the execution fixture adapters.
import { runGitAsync } from '../../../git/gitCommand'
import type { InspectorReads } from '../../execution/effectInspectors'
import { fixtureLandingAdapters, fixtureMainCheckout, fixturePrClose, fixtureProbe, fixturePullRequest, fixtureRoundAdapters } from '../../execution/fixtureAdapters'
import { startupReads } from '../../execution/startupReads'
import type { GithubOutcome } from '../github'
import { gitFetch, isAncestor, lsRemoteHead } from '../gitRemote'
import type { ProbeResult } from '../landingProbe'
import type { LandingMechanisms } from '../landingMechanisms'
import { directMechanism } from '../directMechanism'
import type { IntegrationStore } from './integrationStore'
import type { IntegrationAdapters } from './integrationEffects'
import { integrationMechanism } from './integrationMechanism'
import type { PromotionAdapters } from './promotionEffects'
import { realPromotionReads, type PromotionReads } from './PromotionService'

/** The repository a fixture promotion names (`merge-commits-allowed` reads it; nothing calls GitHub). */
export const FIXTURE_REPO = 'fixture/local'

const refused = (argv: string[], status: number, message: string): GithubOutcome<null> =>
  ({ ok: false, error: { argv, exitCode: 1, httpStatus: status, message } })

/** The fixture's bare origin: origin's URL after `insteadOf` rewriting (a GitHub-shaped URL maps to a local path). */
async function originDir(): Promise<string | null> {
  const main = fixtureMainCheckout()
  if (main === null) return null
  const url = await runGitAsync(['ls-remote', '--get-url', 'origin'], { cwd: main })
  return url.ok ? url.stdout.trim() : null
}

/** A ref of the bare origin, null when absent. */
async function refHead(origin: string, branch: string): Promise<string | null> {
  const head = await runGitAsync(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: origin })
  return head.ok ? head.stdout.trim() : null
}

/** The POST …/git/refs of the fixture: a new ref at `sha`, 422 when it exists. */
async function createRef(_repo: string, branch: string, sha: string): Promise<GithubOutcome<null>> {
  const argv = ['gh', 'api', '-X', 'POST', 'git/refs', branch]
  const origin = await originDir()
  if (origin === null) return refused(argv, 404, 'The fixture repository has no origin.')
  // An empty old value: the update fails when the ref already exists.
  const created = await runGitAsync(['update-ref', `refs/heads/${branch}`, sha, ''], { cwd: origin })
  if (created.ok) return { ok: true, data: null }
  if (await refHead(origin, branch) !== null) return refused(argv, 422, `Reference already exists: refs/heads/${branch}`)
  return refused(argv, 500, created.stderr.trim() || `refs/heads/${branch} could not be created`)
}

/** The non-forced PATCH …/git/refs/heads/<branch>: 422 unless `sha` descends from the head. */
async function fastForwardRef(_repo: string, branch: string, sha: string): Promise<GithubOutcome<null>> {
  const argv = ['gh', 'api', '-X', 'PATCH', 'git/refs/heads', branch]
  const origin = await originDir()
  if (origin === null) return refused(argv, 404, 'The fixture repository has no origin.')
  const head = await refHead(origin, branch)
  if (head === null) return refused(argv, 422, `Reference does not exist: refs/heads/${branch}`)
  const ancestor = await runGitAsync(['merge-base', '--is-ancestor', head, sha], { cwd: origin })
  if (!ancestor.ok) return refused(argv, 422, 'Update is not a fast forward')
  const moved = await runGitAsync(['update-ref', `refs/heads/${branch}`, sha, head], { cwd: origin })
  return moved.ok ? { ok: true, data: null } : refused(argv, 422, 'Update is not a fast forward')
}

/** The fixture ref adapters: real ref writes on the bare origin, real remote reads. */
export function fixtureRefAdapters(): IntegrationAdapters {
  return { createRef, fastForwardRef, lsRemoteHead, fetch: gitFetch, isAncestor }
}

/**
 * A promotion's `gh pr merge --merge` on the fixture: a real merge commit of
 * the head onto the pull request's base, written without force (the base's
 * old value is checked), recorded on the registry row as its merge commit.
 */
async function promotionMerge(_repo: string, prNumber: number, method: 'merge' | 'squash' | 'rebase', headSha: string): Promise<GithubOutcome<null>> {
  const argv = ['gh', 'pr', 'merge', String(prNumber), `--${method}`]
  const pr = fixturePullRequest(prNumber)
  if (pr === null) return refused(argv, 404, `no fixture pull request #${prNumber}`)
  const origin = await originDir()
  if (origin === null) return refused(argv, 404, 'The fixture repository has no origin.')
  const base = await refHead(origin, pr.base)
  if (base === null) return refused(argv, 422, `the base branch ${pr.base} is missing`)
  const tree = await runGitAsync(['merge-tree', '--write-tree', base, headSha], { cwd: origin })
  if (!tree.ok) return refused(argv, 405, `Pull request #${prNumber} is not mergeable: ${tree.stdout.split('\n').slice(1).join(' ').trim()}`)
  const commit = await runGitAsync([
    '-c', 'user.name=Kawai fixture', '-c', 'user.email=kawai@example.internal',
    'commit-tree', tree.stdout.split('\n')[0]!.trim(), '-p', base, '-p', headSha, '-m', `Merge pull request #${prNumber} from ${pr.head}`,
  ], { cwd: origin })
  if (!commit.ok) return refused(argv, 500, commit.stderr.trim())
  const mergeSha = commit.stdout.trim()
  const moved = await runGitAsync(['update-ref', `refs/heads/${pr.base}`, mergeSha, base], { cwd: origin })
  if (!moved.ok) return refused(argv, 405, `the base branch ${pr.base} moved`)
  pr.headRefOid = headSha
  pr.mergeCommit = mergeSha
  return { ok: true, data: null }
}

/** The promotion adapters under the fixture: the registry's pull requests and CI, real refs and merge commits. */
export function fixturePromotionAdapters(): PromotionAdapters {
  return {
    landing: { ...fixtureLandingAdapters(), prMerge: promotionMerge },
    rounds: fixtureRoundAdapters(),
    refs: fixtureRefAdapters(),
    prClose: fixturePrClose,
  }
}

/** The promotion probe under the fixture: the execution fixture probe, naming the fixture repository. */
export async function fixturePromotionProbe(input: { main: string }): Promise<ProbeResult> {
  const probe = await fixtureProbe(input)
  return { ...probe, repo: probe.base === null ? null : FIXTURE_REPO }
}

/** Promote's reads under the fixture: real git, and a repository that allows merge commits. */
export function fixturePromotionReads(): PromotionReads {
  return { ...realPromotionReads(), allowMergeCommit: async () => true }
}

/** D14's inspection reads under the fixture: real git, the registry's pull requests. */
export function fixtureInspectorReads(): InspectorReads {
  const rounds = fixtureRoundAdapters()
  const landing = fixtureLandingAdapters()
  return {
    ...startupReads(),
    prList: async (repo, head, base) => {
      const pulls = await rounds.prList(repo, { head, base })
      if (!pulls.ok) throw new Error(pulls.error.message)
      return pulls.data
    },
    prView: async (repo, pr) => {
      const view = await landing.prView(repo, pr)
      if (!view.ok) throw new Error(view.error.message)
      return view.data
    },
    runAttempt: async () => 1,
  }
}

/**
 * The landing registry under the fixture: direct and integration landing
 * probe through the fixture probe (no gh), and the integration mechanism
 * writes refs through the fixture ref adapters. The execution probe keeps
 * `repo` null (Start's origin-tree pre-read stays skipped); the start effect
 * names the fixture repository instead, which nothing calls.
 */
export function fixtureMechanisms(store: IntegrationStore): LandingMechanisms {
  const integration = integrationMechanism(store, fixtureRefAdapters(), {
    direct: input => fixtureProbe(input),
    commitTree: async () => ({ ok: true, data: '' }),
  })
  return new Map([
    [directMechanism.mode, { ...directMechanism, probe: input => fixtureProbe(input) }],
    [integration.mode, { ...integration, startEffects: input => integration.startEffects!({ ...input, probe: { ...input.probe, repo: input.probe.repo ?? FIXTURE_REPO } }) }],
  ])
}
