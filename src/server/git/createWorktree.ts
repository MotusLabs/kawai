// createWorktree.ts - Validated, non-destructive worktree creation (§8.3).
// Revalidates repository identity, local branch assignment, and destination
// nonexistence immediately before running `git worktree add` — never with
// force flags, always through argument-array invocation so branch and path
// values cannot be mistaken for options or shell syntax.

import fs from 'node:fs'
import {
  isAbsoluteLocalPath,
  isValidGitRefName,
} from '../../shared/workspaceValidation'
import type { WorkspaceOperationResult } from '../../shared/workspace'
import { runGit } from './gitCommand'
import { canonicalizePath } from './repositoryResolution'
import { discoverRepository } from './worktreeList'

export interface CreateWorktreeInput {
  /** Canonical common Git directory (the repository id). */
  repositoryId: string
  /** Local branch short name to check out in the new worktree. */
  branch: string
  /** Absolute destination path for the new worktree. */
  destination: string
}

/** True when either path contains the other on a path boundary. */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/**
 * Create a worktree for an existing unassigned local branch. Every failure is
 * returned as a typed result — no exception escapes, nothing existing is
 * modified, and no force flag is ever passed to git.
 */
export function createWorktree(input: CreateWorktreeInput): WorkspaceOperationResult {
  const { repositoryId, branch, destination } = input

  if (!isValidGitRefName(branch)) {
    return {
      operation: 'create-worktree',
      ok: false,
      repositoryId,
      branch,
      code: 'ERR_WORKTREE_INVALID_DESTINATION',
      error: `Invalid branch name: ${branch}`,
    }
  }
  if (!isAbsoluteLocalPath(destination)) {
    return {
      operation: 'create-worktree',
      ok: false,
      repositoryId,
      branch,
      code: 'ERR_WORKTREE_INVALID_DESTINATION',
      error: `Destination must be an absolute path: ${destination}`,
    }
  }

  // Repository identity revalidation: the common dir must still be a live
  // repository whose worktrees and branches can be read right now.
  let info
  try {
    info = discoverRepository(repositoryId)
  } catch {
    info = null
  }
  if (!info) {
    return {
      operation: 'create-worktree',
      ok: false,
      repositoryId,
      branch,
      code: 'ERR_WORKSPACE_UNKNOWN_REPOSITORY',
      error: `Repository is not available: ${repositoryId}`,
    }
  }

  const canonicalDestination = canonicalizePath(destination)

  // Destination nonexistence: never overwrite an existing path.
  if (fs.existsSync(canonicalDestination)) {
    return {
      operation: 'create-worktree',
      ok: false,
      repositoryId,
      branch,
      code: 'ERR_WORKTREE_DESTINATION_EXISTS',
      error: `Destination already exists: ${canonicalDestination}`,
    }
  }

  // Containment: the destination must not overlap any existing worktree of
  // this repository — neither inside one nor containing one.
  for (const worktree of info.worktrees) {
    if (pathsOverlap(canonicalDestination, worktree.path)) {
      return {
        operation: 'create-worktree',
        ok: false,
        repositoryId,
        branch,
        code: 'ERR_WORKTREE_INVALID_DESTINATION',
        error: `Destination overlaps existing worktree ${worktree.path}`,
      }
    }
  }

  // Branch availability: must exist locally and not be checked out anywhere.
  const branchInfo = info.branches.find((candidate) => candidate.name === branch)
  if (!branchInfo) {
    return {
      operation: 'create-worktree',
      ok: false,
      repositoryId,
      branch,
      code: 'ERR_WORKTREE_UNKNOWN_BRANCH',
      error: `Branch not found in repository: ${branch}`,
    }
  }
  if (branchInfo.assignedWorktreePath) {
    return {
      operation: 'create-worktree',
      ok: false,
      repositoryId,
      branch,
      code: 'ERR_WORKTREE_BRANCH_ASSIGNED',
      error: `Branch ${branch} is already checked out at ${branchInfo.assignedWorktreePath}`,
    }
  }

  // Execute. Argument-array invocation; branch/destination are validated
  // values positioned as plain operands, so option injection is impossible.
  const result = runGit([
    '--git-dir',
    repositoryId,
    'worktree',
    'add',
    canonicalDestination,
    branch,
  ])
  if (!result.ok) {
    // A concurrent assignment between revalidation and execution surfaces as
    // git's "already checked out" refusal — report it as the assignment case.
    if (/already\s+(checked\s+out|used)/i.test(result.stderr)) {
      return {
        operation: 'create-worktree',
        ok: false,
        repositoryId,
        branch,
        code: 'ERR_WORKTREE_BRANCH_ASSIGNED',
        error: `Branch ${branch} is already checked out in another worktree`,
      }
    }
    return {
      operation: 'create-worktree',
      ok: false,
      repositoryId,
      branch,
      code: 'ERR_WORKTREE_CREATE_FAILED',
      error: `git worktree add failed: ${result.stderr.trim().slice(0, 200) || `exit ${result.exitCode ?? 'signal'}`}`,
    }
  }

  return {
    operation: 'create-worktree',
    ok: true,
    repositoryId,
    branch,
    path: canonicalizePath(canonicalDestination),
  }
}
