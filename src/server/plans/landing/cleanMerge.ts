// cleanMerge.ts - The clean-merge check (plan-execution D13), moved verbatim
// out of executionLanding.ts so every landing mechanism reads one rule
// (integration-candidates D5): after GitHub's branch update, the updated
// head has parents [H, B'], the base contains B', and its tree equals
// `merge-tree H B'`. B' is the merge's own second parent, so a base that
// moved on after the update still passes; the next up-to-date check brings
// the carried head along again.
import type { LandingAdapters } from '../execution/executionLanding'
import { runGit } from '../../git/gitCommand'

export interface CleanMergeInput {
  /** The change's worktree, else the main checkout. */
  cwd: string
  baseBranch: string
  /** The change's branch. */
  branch: string
  /** The reviewed head H the update started from. */
  reviewedHead: string
  /** The pull request's head after the update. */
  updatedHead: string
}

/**
 * The check over origin's current base: null while origin could not be read
 * (the caller waits for the next pass), else whether the update came through
 * clean, with the base head it was checked against.
 */
export async function cleanMergeCheck(
  adapters: Pick<LandingAdapters, 'fetch' | 'isAncestor' | 'mergeTree' | 'lsRemoteHead'>,
  input: CleanMergeInput,
): Promise<{ clean: boolean; base: string } | null> {
  const { cwd, reviewedHead, updatedHead } = input
  const baseRef = `refs/heads/${input.baseBranch}`
  const base = await adapters.lsRemoteHead(cwd, baseRef)
  if (!base.ok || base.sha === null) return null
  for (const ref of [baseRef, `refs/heads/${input.branch}`]) {
    const fetched = await adapters.fetch(cwd, 'origin', ref)
    if (!fetched.ok) return null
  }
  const parents = await runGit(['log', '-1', '--pretty=%P', updatedHead], { cwd })
  const parentList = parents.ok ? parents.stdout.trim().split(/\s+/) : []
  const secondParent = parentList.find(parent => parent !== reviewedHead) ?? ''
  const predicted = secondParent === '' ? null : await adapters.mergeTree(cwd, reviewedHead, secondParent)
  const secondAncestry = secondParent === '' ? null : await adapters.isAncestor(cwd, secondParent, base.sha)
  const secondContained = secondAncestry !== null && secondAncestry.ok && secondAncestry.ancestor
  const clean = parents.ok && predicted !== null && predicted.ok && predicted.conflicts.length === 0
    && parentList.length === 2
    && parentList.includes(reviewedHead)
    && secondContained
    && (await runGit(['rev-parse', `${updatedHead}^{tree}`], { cwd })).stdout.trim() === predicted.tree
  return { clean, base: base.sha }
}
