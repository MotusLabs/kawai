// openspecDiscovery.ts - Per-worktree `openspec list --json` discovery with
// timeouts, bounded output, missing-root handling, and defensive parsing of
// optional fields. Results belong only to the worktree whose filesystem they
// were read from; a missing OpenSpec root is an empty, non-error result.

import type {
  OpenSpecChangeSummary,
  WorktreeOpenSpecState,
  WorkspaceSnapshot,
} from '../../shared/workspace'

export const OPENSPEC_TIMEOUT_MS = 15_000
export const OPENSPEC_MAX_OUTPUT_BYTES = 512 * 1024

export interface OpenspecCommandResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
}

export type OpenspecCommandRunner = (options: {
  cwd: string
  timeoutMs: number
}) => OpenspecCommandResult

/** Default runner: invoke the installed openspec CLI synchronously. */
export function runOpenspecList({ cwd, timeoutMs }: { cwd: string; timeoutMs: number }): OpenspecCommandResult {
  try {
    const result = Bun.spawnSync(['openspec', 'list', '--json'], {
      cwd,
      timeout: timeoutMs,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = result.stdout ? result.stdout.toString('utf8') : ''
    const stderr = result.stderr ? result.stderr.toString('utf8') : ''
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout:
        stdout.length > OPENSPEC_MAX_OUTPUT_BYTES
          ? stdout.slice(0, OPENSPEC_MAX_OUTPUT_BYTES)
          : stdout,
      stderr,
    }
  } catch {
    return { ok: false, exitCode: null, stdout: '', stderr: 'openspec spawn failed' }
  }
}

/** Parse one entry of the openspec `changes` array defensively. */
export function parseOpenSpecChangeEntry(value: unknown): OpenSpecChangeSummary | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name.length === 0) return null
  const change: OpenSpecChangeSummary = { name: record.name }
  if (typeof record.status === 'string') change.status = record.status
  if (typeof record.completedTasks === 'number' && Number.isSafeInteger(record.completedTasks) && record.completedTasks >= 0) {
    change.completedTasks = record.completedTasks
  }
  if (typeof record.totalTasks === 'number' && Number.isSafeInteger(record.totalTasks) && record.totalTasks >= 0) {
    change.totalTasks = record.totalTasks
  }
  if (typeof record.lastModified === 'string') change.lastModified = record.lastModified
  return change
}

/**
 * Parse `openspec list --json` stdout. Returns null when the payload is not
 * valid JSON or lacks a changes array; a `no_openspec_root` status payload
 * parses to an empty result (missing root, not an error).
 */
export function parseOpenspecListOutput(stdout: string): { rootPath?: string; changes: OpenSpecChangeSummary[] } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.changes)) return null

  const changes: OpenSpecChangeSummary[] = []
  for (const entry of record.changes) {
    const change = parseOpenSpecChangeEntry(entry)
    if (change) changes.push(change)
  }
  const root =
    typeof record.root === 'object' && record.root !== null
      ? (record.root as Record<string, unknown>)
      : null
  const rootPath = root && typeof root.path === 'string' ? root.path : undefined
  return { ...(rootPath !== undefined ? { rootPath } : {}), changes }
}

interface OpenspecStatusEntry {
  severity?: unknown
  code?: unknown
  message?: unknown
}

/** True when a non-zero exit payload reports only a missing openspec root. */
function isMissingRootPayload(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>
    if (parsed.root !== null && parsed.root !== undefined) return false
    if (!Array.isArray(parsed.status)) return false
    return parsed.status.some((entry) => {
      const status = entry as OpenspecStatusEntry
      return status.code === 'no_openspec_root'
    })
  } catch {
    return false
  }
}

/**
 * Discover OpenSpec state for one worktree. Failures return a stale/error
 * state; the caller merges the previous values (task 3.2).
 */
export function discoverWorktreeOpenSpec(
  worktreePath: string,
  options: { runner?: OpenspecCommandRunner; timeoutMs?: number } = {}
): WorktreeOpenSpecState {
  const runner = options.runner ?? runOpenspecList
  const timeoutMs = options.timeoutMs ?? OPENSPEC_TIMEOUT_MS
  const result = runner({ cwd: worktreePath, timeoutMs })

  if (result.ok) {
    const parsed = parseOpenspecListOutput(result.stdout)
    if (parsed) {
      return {
        changes: parsed.changes,
        stale: false,
        ...(parsed.rootPath !== undefined ? { rootPath: parsed.rootPath } : {}),
      }
    }
    return { changes: [], stale: true, error: 'Unparseable openspec output' }
  }

  if (result.exitCode !== 0 && result.exitCode !== null && isMissingRootPayload(result.stdout)) {
    // No openspec root in this worktree: empty, non-error result.
    return { changes: [], stale: false }
  }

  const reason =
    result.exitCode === null
      ? 'openspec timed out'
      : `openspec exited with ${result.exitCode}`
  return { changes: [], stale: true, error: reason }
}

/**
 * Refresh OpenSpec state for every worktree in a snapshot. Results are
 * merged only into the worktree whose filesystem produced them — state is
 * never copied between worktrees, so two worktrees of one repository keep
 * divergent change lists and progress. A failed refresh retains the
 * worktree's last valid values with a stale indication.
 */
export function refreshSnapshotOpenSpec(
  snapshot: WorkspaceSnapshot,
  previous: WorkspaceSnapshot | null | undefined,
  options: { runner?: OpenspecCommandRunner; timeoutMs?: number } = {}
): WorkspaceSnapshot {
  const previousOpenSpecByWorktreeId = new Map<string, WorktreeOpenSpecState>()
  for (const repository of previous?.repositories ?? []) {
    for (const worktree of repository.worktrees) {
      previousOpenSpecByWorktreeId.set(worktree.id, worktree.openspec)
    }
  }

  return {
    ...snapshot,
    repositories: snapshot.repositories.map((repository) => ({
      ...repository,
      worktrees: repository.worktrees.map((worktree) => {
        const discovered = discoverWorktreeOpenSpec(worktree.path, options)
        if (discovered.stale) {
          const lastValid = previousOpenSpecByWorktreeId.get(worktree.id)
          if (lastValid && !lastValid.stale) {
            // Retain this worktree's own last-valid values, marked stale.
            return {
              ...worktree,
              openspec: { ...lastValid, stale: true, ...(discovered.error !== undefined ? { error: discovered.error } : {}) },
            }
          }
        }
        return { ...worktree, openspec: discovered }
      }),
    })),
  }
}
