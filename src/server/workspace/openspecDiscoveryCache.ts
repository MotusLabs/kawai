// openspecDiscoveryCache.ts - The per-worktree memory of the last successful
// `openspec list` result and the fingerprint taken before that run
// (bounded-openspec-discovery D2). `shouldRunOpenSpec` is the pure reuse
// decision (design table RD); the cache also counts runs and reuses for the
// coordinator's per-pass debug line. It lives in server memory only: every
// start runs the CLI once per worktree.

import type { WorktreeOpenSpecState } from '../../shared/workspace'

/** A cached result older than this is rediscovered even when unchanged. */
export const OPENSPEC_REUSE_MAX_AGE_MS = 600_000

export interface CachedOpenSpecDiscovery {
  /** Fingerprint taken before the run that produced `state`. */
  fingerprint: string
  /** When that run was started (ms since epoch). */
  discoveredAt: number
  /** A non-stale CLI result for this worktree path. */
  state: WorktreeOpenSpecState
}

/**
 * Table RD: run unless there is an entry, a non-null fingerprint equal to the
 * stored one, and the entry is under OPENSPEC_REUSE_MAX_AGE_MS old.
 */
export function shouldRunOpenSpec(
  previous: CachedOpenSpecDiscovery | undefined,
  fingerprint: string | null,
  now: number
): boolean {
  if (!previous) return true
  if (fingerprint === null) return true
  if (fingerprint !== previous.fingerprint) return true
  return now - previous.discoveredAt >= OPENSPEC_REUSE_MAX_AGE_MS
}

export interface OpenSpecPassCounts {
  runs: number
  reused: number
}

export class OpenSpecDiscoveryCache {
  private readonly entries = new Map<string, CachedOpenSpecDiscovery>()
  private counts: OpenSpecPassCounts = { runs: 0, reused: 0 }

  get(worktreePath: string): CachedOpenSpecDiscovery | undefined {
    return this.entries.get(worktreePath)
  }

  set(worktreePath: string, entry: CachedOpenSpecDiscovery): void {
    this.entries.set(worktreePath, entry)
  }

  delete(worktreePath: string): void {
    this.entries.delete(worktreePath)
  }

  /** Drop entries for worktrees no longer listed (DO7). */
  retainOnly(worktreePaths: Set<string>): void {
    // Deleting the current key while iterating a Map is safe.
    for (const key of this.entries.keys()) {
      if (!worktreePaths.has(key)) this.entries.delete(key)
    }
  }

  paths(): string[] {
    return [...this.entries.keys()]
  }

  countRun(): void {
    this.counts.runs += 1
  }

  countReuse(): void {
    this.counts.reused += 1
  }

  /** Counts since the last call, then reset. */
  takeCounts(): OpenSpecPassCounts {
    const counts = this.counts
    this.counts = { runs: 0, reused: 0 }
    return counts
  }
}
