// repositoryResolution.ts - Canonicalize known local project paths, resolve
// their worktree/common Git directories, and deduplicate repositories.
// Seeds come from live sessions, persisted agent sessions, and history — the
// app never scans arbitrary directory trees (see design.md).

import fs from 'node:fs'
import path from 'node:path'
import { runGitAsync } from './gitCommand'

export interface ResolvedGitDirs {
  /** Canonical absolute path of this worktree's .git directory. */
  gitDir: string
  /** Canonical absolute common Git directory — the repository identity. */
  commonDir: string
  /** Canonical absolute worktree root (toplevel). */
  toplevel: string
}

/**
 * Canonicalize a path via realpath on its longest existing ancestor. Deleted
 * tails are preserved as-is so display paths stay recognizable while the
 * existing portion resolves symlinks.
 */
export function canonicalizePath(input: string): string {
  const absolute = path.resolve(input)
  if (fs.existsSync(absolute)) {
    try {
      return fs.realpathSync(absolute)
    } catch {
      return absolute
    }
  }
  const parent = path.dirname(absolute)
  if (parent === absolute) {
    return absolute
  }
  return path.join(canonicalizePath(parent), path.basename(absolute))
}

/**
 * Resolve the worktree and common Git directories containing `workdir`.
 * Returns null for non-Git paths, git failures, and timeouts.
 */
export async function resolveGitDirs(workdir: string): Promise<ResolvedGitDirs | null> {
  const result = await runGitAsync(
    ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
    { cwd: workdir }
  )
  if (!result.ok) return null
  const lines = result.stdout.trim().split('\n')
  if (lines.length < 3) return null
  const [gitDir, commonDir, toplevel] = lines.map((line) => line.trim())
  if (!gitDir || !commonDir || !toplevel) return null
  return {
    gitDir: canonicalizePath(gitDir),
    commonDir: canonicalizePath(commonDir),
    toplevel: canonicalizePath(toplevel),
  }
}

export interface ResolvedSeed {
  /** Canonical seed path after symlink resolution of existing ancestors. */
  canonicalPath: string
  /** Resolved Git directories, or null when the seed is not in a repository. */
  dirs: ResolvedGitDirs | null
}

export interface ResolvedRepositories {
  /** repositoryId (canonical commonDir) -> one resolved Git dirs sample. */
  repositories: Map<string, ResolvedGitDirs>
  /** Every seed with its resolution, in input order. */
  seeds: ResolvedSeed[]
}

/**
 * Resolve seed project paths to their containing repositories and deduplicate
 * by canonical common Git directory. A repository becomes known once any seed
 * resolves into it; nested repositories stay distinct because their common
 * directories differ.
 */
export async function resolveSeedRepositories(seeds: Iterable<string>): Promise<ResolvedRepositories> {
  // Read-only rev-parse per seed: resolve them concurrently so a pass costs
  // one subprocess round-trip instead of one per project path.
  const resolved = await Promise.all(
    [...seeds]
      .filter((seed) => seed && path.isAbsolute(seed))
      .map(async (seed) => ({
        canonicalPath: canonicalizePath(seed),
        dirs: await resolveGitDirs(canonicalizePath(seed)),
      }))
  )
  const repositories = new Map<string, ResolvedGitDirs>()
  for (const seed of resolved) {
    if (seed.dirs && !repositories.has(seed.dirs.commonDir)) {
      repositories.set(seed.dirs.commonDir, seed.dirs)
    }
  }
  return { repositories, seeds: resolved }
}
