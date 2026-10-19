// integrationStart.ts - The pre-reads behind Start's two appended entries
// (integration-candidates D8). They run in Start's read phase, like
// `changes-on-base`, and write nothing outside the object store:
// - `promotion-idle` reads the plan's running promotion row;
// - `landings-on-base`, in every mode, fetches the execution's base head and
//   checks `git merge-base --is-ancestor <merge_sha> <base head>` for each
//   landing fact of the plan. The fact's `merge_sha` is the commit on the
//   branch it landed on, never the pull request's head, so a squash landing
//   counts by its squash commit.
// The fetch brings the base head's ancestry into the main checkout's object
// store, so a `merge_sha` the base lacks is either not an ancestor or not
// present at all, and both read as off the base.
import type { ProbeResult } from '../landingProbe'
import { gitFetch, isAncestor } from '../gitRemote'

export interface IntegrationStartFacts {
  runningPromotion: { id: string; number: number; branch: string; step: string | null } | null
  offBaseLandings: Array<{ change: string; branch: string }>
  /** The base could not be fetched: Start refuses through landing-ready with it. */
  error?: string
}

export interface IntegrationStartInput {
  main: string
  probe: Pick<ProbeResult, 'base' | 'integration'>
  /** The plan's landing facts. */
  landings: ReadonlyArray<{ change: string; executionId: string; mergeSha: string }>
  /** The branch an execution landed on: its recorded base branch. */
  baseBranchOf: (executionId: string) => string | null
  runningPromotion: { id: string; number: number; branch: string; step: string | null } | null
  git?: { fetch: typeof gitFetch; isAncestor: typeof isAncestor }
}

export async function readIntegrationStartFacts(input: IntegrationStartInput): Promise<IntegrationStartFacts> {
  const git = input.git ?? { fetch: gitFetch, isAncestor }
  const base = input.probe.base
  // An unreadable base already refuses as landing-ready; nothing to compare with.
  if (base === null || input.landings.length === 0) return { runningPromotion: input.runningPromotion, offBaseLandings: [] }
  // While the integration branch is missing, the base head is the default head it will be created from.
  const integration = input.probe.integration
  const fetchBranch = integration !== undefined && !integration.exists ? integration.target : base.branch
  const fetched = await git.fetch(input.main, 'origin', `refs/heads/${fetchBranch}`)
  if (!fetched.ok) {
    return { runningPromotion: input.runningPromotion, offBaseLandings: [], error: `The base ${fetchBranch} could not be fetched to check the plan's landed work: ${fetched.error.stderr.trim() || 'git fetch failed'}` }
  }
  const offBaseLandings: IntegrationStartFacts['offBaseLandings'] = []
  for (const landing of input.landings) {
    const contained = await git.isAncestor(input.main, landing.mergeSha, base.head)
    if (contained.ok && contained.ancestor) continue
    offBaseLandings.push({ change: landing.change, branch: input.baseBranchOf(landing.executionId) ?? 'an unknown branch' })
  }
  return { runningPromotion: input.runningPromotion, offBaseLandings }
}
