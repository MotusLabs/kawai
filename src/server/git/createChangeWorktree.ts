// createChangeWorktree.ts - Seeded, non-destructive change-worktree creation
// (§7.2/§7.3). Creates `.worktrees/<change-name>` on branch `<change-name>`
// (the existing local branch when present and unassigned, otherwise a new
// branch from the main worktree's HEAD), copies `openspec/changes/<change>/`
// from the main worktree into it, commits the copy on the new branch, and
// appends `.worktrees/` to the worktree's `.gitignore` when absent.
//
// Revalidation happens immediately before execution: repository identity,
// destination nonexistence, and branch assignment are re-read from Git, and
// no force flag is ever passed. All writes are confined to the freshly
// created branch — the main worktree's checkout and index are never touched
// (its untracked change artifacts are copied, not moved or committed).

import fs from 'node:fs'
import path from 'node:path'
import {
  CHANGE_WORKTREES_DIR,
  type WorkspaceOperationResult,
} from '../../shared/workspace'
import { isValidChangeName } from '../../shared/workspaceValidation'
import { runGit, type GitCommandOptions } from './gitCommand'
import { canonicalizePath } from './repositoryResolution'
import { discoverRepository } from './worktreeList'

export interface CreateChangeWorktreeInput {
  /** Canonical common Git directory (the repository id). */
  repositoryId: string
  /** OpenSpec change name; doubles as the branch name and path segment. */
  change: string
}

export interface CreateChangeWorktreeOptions {
  /** Extra env for the seed commit (tests supply git identity). */
  env?: Record<string, string>
}

/** Convention destination: `<main>/.worktrees/<change-name>`. */
function conventionDestination(mainWorktreePath: string, change: string): string {
  return canonicalizePath(`${mainWorktreePath}/${CHANGE_WORKTREES_DIR}/${change}`)
}

/** True when a .gitignore line already excludes the worktrees directory. */
function gitignoreHasWorktreesEntry(content: string): boolean {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.replace(/\/$/, '') === CHANGE_WORKTREES_DIR) return true
  }
  return false
}

function branchAssignedFailure(
  repositoryId: string,
  change: string,
  detail: string
): WorkspaceOperationResult {
  return {
    operation: 'create-change-worktree',
    ok: false,
    repositoryId,
    change,
    code: 'ERR_WORKTREE_BRANCH_ASSIGNED',
    error: `Branch ${change} is already checked out ${detail}`,
  }
}

/**
 * Best-effort cleanup of a half-seeded worktree: non-forced
 * `git worktree remove` only. Returns null when it worked; otherwise a
 * partial-state note for the error message. A branch created by `-b` is
 * deliberately left in place (branch deletion is out of scope); a retry
 * reuses it via the existing-branch path.
 */
function cleanupPartialWorktree(
  repositoryId: string,
  destination: string,
  gitOptions: GitCommandOptions
): string | null {
  const removed = runGit(['--git-dir', repositoryId, 'worktree', 'remove', destination], gitOptions)
  if (removed.ok) return null
  return ` A partial worktree was left at ${destination}; remove it manually if unwanted.`
}

/**
 * Create and seed the convention worktree for one OpenSpec change. Every
 * failure is returned as a typed result — no exception escapes, nothing
 * existing is modified, and no force flag is ever passed to git.
 */
export function createChangeWorktree(
  input: CreateChangeWorktreeInput,
  options: CreateChangeWorktreeOptions = {}
): WorkspaceOperationResult {
  const { repositoryId, change } = input

  // The change name becomes both a branch name and a single path segment
  // under .worktrees/, so it must satisfy both grammars.
  if (!isValidChangeName(change)) {
    return {
      operation: 'create-change-worktree',
      ok: false,
      repositoryId,
      change,
      code: 'ERR_CHANGE_INVALID_NAME',
      error: `Invalid change name: ${change}`,
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
      operation: 'create-change-worktree',
      ok: false,
      repositoryId,
      change,
      code: 'ERR_WORKSPACE_UNKNOWN_REPOSITORY',
      error: `Repository is not available: ${repositoryId}`,
    }
  }

  const main = info.worktrees.find((worktree) => worktree.isMain)
  if (!main || !fs.existsSync(main.path)) {
    return {
      operation: 'create-change-worktree',
      ok: false,
      repositoryId,
      change,
      code: 'ERR_WORKSPACE_NO_MAIN_WORKTREE',
      error: `Repository has no accessible main worktree: ${repositoryId}`,
    }
  }

  const destination = conventionDestination(main.path, change)
  const gitOptions: GitCommandOptions = { env: options.env }

  // Destination nonexistence: never overwrite an existing path.
  if (fs.existsSync(destination)) {
    return {
      operation: 'create-change-worktree',
      ok: false,
      repositoryId,
      change,
      code: 'ERR_WORKTREE_DESTINATION_EXISTS',
      error: `Destination already exists: ${destination}`,
    }
  }

  const worktreesDir = path.dirname(destination)
  if (fs.existsSync(worktreesDir) && !fs.statSync(worktreesDir).isDirectory()) {
    return {
      operation: 'create-change-worktree',
      ok: false,
      repositoryId,
      change,
      code: 'ERR_WORKTREE_CREATE_FAILED',
      error: `Cannot create worktrees directory, a file exists at ${worktreesDir}`,
    }
  }

  // Branch availability, re-read immediately before execution: an existing
  // `<change>` branch must not be checked out anywhere. The main worktree's
  // current HEAD is the explicit start-point for the new-branch case, so no
  // git HEAD resolution is left to ambient state.
  const existingBranch = info.branches.find((branch) => branch.name === change)
  if (existingBranch?.assignedWorktreePath) {
    return branchAssignedFailure(repositoryId, change, `at ${existingBranch.assignedWorktreePath}`)
  }

  const addArgs = existingBranch
    ? ['worktree', 'add', destination, change]
    : ['worktree', 'add', '-b', change, destination, main.headRevision]
  const added = runGit(['--git-dir', repositoryId, ...addArgs], gitOptions)
  if (!added.ok) {
    // A concurrent assignment between revalidation and execution surfaces
    // as git's "already checked out" refusal — report it as the assignment
    // case, never with a force retry.
    if (/already\s+(checked\s+out|used)/i.test(added.stderr)) {
      return branchAssignedFailure(repositoryId, change, 'in another worktree')
    }
    return {
      operation: 'create-change-worktree',
      ok: false,
      repositoryId,
      change,
      code: 'ERR_WORKTREE_CREATE_FAILED',
      error: `git worktree add failed: ${added.stderr.trim().slice(0, 200) || `exit ${added.exitCode ?? 'signal'}`}`,
    }
  }

  const seeded = seedChangeArtifacts(change, main.path, destination, gitOptions)
  if (!seeded.ok) {
    const partial = cleanupPartialWorktree(repositoryId, destination, gitOptions)
    return {
      operation: 'create-change-worktree',
      ok: false,
      repositoryId,
      change,
      code: seeded.code,
      error: `${seeded.error}${partial ?? ''}`,
    }
  }

  return {
    operation: 'create-change-worktree',
    ok: true,
    repositoryId,
    change,
    branch: change,
    path: destination,
    commit: seeded.commit,
    gitignoreUpdated: seeded.gitignoreUpdated,
  }
}

type SeedResult =
  | { ok: true; commit: string; gitignoreUpdated: boolean }
  | { ok: false; code: 'ERR_CHANGE_MISSING_ARTIFACTS' | 'ERR_CHANGE_SEED_FAILED'; error: string }

/**
 * Copy `openspec/changes/<change>/` from the main worktree into the fresh
 * worktree, append the `.worktrees/` ignore entry to the worktree's own
 * `.gitignore` when absent, and commit both on the new branch. The commit
 * skips hooks: it is machine-authored seeding, and user hooks that need
 * interactive tooling must not block worktree creation. Cleanup of the
 * half-seeded worktree on failure belongs to the caller.
 */
function seedChangeArtifacts(
  change: string,
  mainWorktreePath: string,
  destination: string,
  gitOptions: GitCommandOptions
): SeedResult {
  // The source is the main worktree's live filesystem, which Git-state
  // revalidation cannot confirm — existence is checked here, right before
  // the copy, and the caller cleans the fresh worktree up on failure.
  const source = path.join(mainWorktreePath, 'openspec', 'changes', change)
  let sourceIsDirectory = false
  try {
    sourceIsDirectory = fs.statSync(source).isDirectory()
  } catch {
    sourceIsDirectory = false
  }
  if (!sourceIsDirectory) {
    return {
      ok: false,
      code: 'ERR_CHANGE_MISSING_ARTIFACTS',
      error: `Change artifacts not found in the main worktree: ${source}`,
    }
  }

  try {
    fs.cpSync(source, path.join(destination, 'openspec', 'changes', change), { recursive: true })
  } catch (error) {
    return {
      ok: false,
      code: 'ERR_CHANGE_SEED_FAILED',
      error: `Copying change artifacts failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // The ignore entry lives in the new worktree's .gitignore (part of the
  // seed commit), so no write ever lands in the main worktree.
  let gitignoreUpdated = false
  const gitignorePath = path.join(destination, '.gitignore')
  try {
    const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : ''
    if (!gitignoreHasWorktreesEntry(current)) {
      const appended = current === '' || current.endsWith('\n') ? current : `${current}\n`
      fs.writeFileSync(gitignorePath, `${appended}${CHANGE_WORKTREES_DIR}/\n`)
      gitignoreUpdated = true
    }
  } catch (error) {
    return {
      ok: false,
      code: 'ERR_CHANGE_SEED_FAILED',
      error: `Updating .gitignore failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const addArgs = ['add', '--', 'openspec']
  if (fs.existsSync(gitignorePath)) addArgs.push('.gitignore')
  const added = runGit(['-C', destination, ...addArgs], gitOptions)
  if (!added.ok) {
    return seedFailed(`git add failed: ${added.stderr.trim().slice(0, 200)}`)
  }

  const committed = runGit(
    ['-C', destination, 'commit', '--no-verify', '-m', `chore(openspec): seed change ${change} from the main worktree`],
    gitOptions
  )
  if (!committed.ok) {
    return seedFailed(
      `git commit failed: ${committed.stderr.trim().slice(0, 200) || `exit ${committed.exitCode ?? 'signal'}`}`
    )
  }

  const revision = runGit(['-C', destination, 'rev-parse', 'HEAD'], gitOptions)
  if (!revision.ok) {
    return seedFailed('Reading the seed commit revision failed')
  }

  return { ok: true, commit: revision.stdout.trim(), gitignoreUpdated }
}

function seedFailed(reason: string): SeedResult {
  return { ok: false, code: 'ERR_CHANGE_SEED_FAILED', error: `Seeding failed: ${reason}` }
}
