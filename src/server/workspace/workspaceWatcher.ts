// workspaceWatcher.ts - Safe, debounced filesystem watches for Git and
// OpenSpec metadata plus periodic full reconciliation. Watches are a latency
// optimization: Linux inotify watches are non-recursive and new directories
// are invisible until targets update, so the periodic reconciliation pass is
// the correctness mechanism that recovers missed events.

import path from 'node:path'
import type { WorkspaceSnapshot } from '../../shared/workspace'

export interface WatchHandle {
  close(): void
}

export interface WorkspaceWatcherHost {
  /** Start watching one existing directory (non-recursive). */
  watchDirectory(directory: string, onEvent: (changedPath: string) => void): WatchHandle
  /** True when the path exists and is watchable. */
  isWatchable(candidate: string): boolean
  setDebounceTimer(callback: () => void, ms: number): unknown
  clearDebounceTimer(handle: unknown): void
  setReconciliationInterval(callback: () => void, ms: number): unknown
  clearReconciliationInterval(handle: unknown): void
}

export const WORKSPACE_WATCH_DEBOUNCE_MS = 400
export const WORKSPACE_RECONCILE_INTERVAL_MS = 30_000

/** Node/Bun host adapter (injectable for tests). */
export function createNodeWatcherHost(fs: {
  watch(
    path: string,
    listener: (event: string, filename: string | Buffer | null) => void
  ): { close(): void }
  existsSync(path: string): boolean
}): WorkspaceWatcherHost {
  return {
    watchDirectory(directory, onEvent) {
      const watcher = fs.watch(directory, (_event, filename) => {
        const name = filename == null ? '' : filename.toString()
        onEvent(name ? path.join(directory, name) : directory)
      })
      return { close: () => watcher.close() }
    },
    isWatchable: (candidate) => fs.existsSync(candidate),
    setDebounceTimer: (callback, ms) => setTimeout(callback, ms),
    clearDebounceTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setReconciliationInterval: (callback, ms) => setInterval(callback, ms),
    clearReconciliationInterval: (handle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  }
}

/**
 * Compute the watch targets for a snapshot: Git common-dir internals (HEAD,
 * refs/heads, linked worktree metadata), worktree roots, and OpenSpec
 * change directories. The caller skips targets that do not exist yet.
 */
export function computeWatchTargets(snapshot: WorkspaceSnapshot): string[] {
  const targets = new Set<string>()
  for (const repository of snapshot.repositories) {
    targets.add(repository.commonDir)
    targets.add(path.join(repository.commonDir, 'refs', 'heads'))
    targets.add(path.join(repository.commonDir, 'worktrees'))
    for (const worktree of repository.worktrees) {
      targets.add(worktree.path)
      const rootPath = worktree.openspec.rootPath
      if (rootPath) {
        const changesDir = path.join(rootPath, 'changes')
        targets.add(changesDir)
        for (const change of worktree.openspec.changes) {
          targets.add(path.join(changesDir, change.name))
        }
      }
    }
  }
  return [...targets]
}

export interface WorkspaceWatcherOptions {
  host: WorkspaceWatcherHost
  /** Debounced batch of changed filesystem paths. */
  onPathsChanged(paths: string[]): void
  /** Periodic full reconciliation (missed-event recovery). */
  onReconcile(): void
  debounceMs?: number
  reconcileIntervalMs?: number
}

export class WorkspaceWatcher {
  private readonly options: Required<Pick<WorkspaceWatcherOptions, 'debounceMs' | 'reconcileIntervalMs'>> &
    WorkspaceWatcherOptions
  private handles = new Map<string, WatchHandle>()
  private pendingPaths = new Set<string>()
  private debounceHandle: unknown = null
  private reconcileHandle: unknown = null
  private stopped = false

  constructor(options: WorkspaceWatcherOptions) {
    this.options = {
      debounceMs: WORKSPACE_WATCH_DEBOUNCE_MS,
      reconcileIntervalMs: WORKSPACE_RECONCILE_INTERVAL_MS,
      ...options,
    }
  }

  /** Diff current watches against the snapshot's targets. */
  updateTargets(snapshot: WorkspaceSnapshot): void {
    if (this.stopped) return
    const desired = new Set(
      computeWatchTargets(snapshot).filter((target) => this.options.host.isWatchable(target))
    )
    for (const [directory, handle] of this.handles) {
      if (!desired.has(directory)) {
        handle.close()
        this.handles.delete(directory)
      }
    }
    for (const directory of desired) {
      if (this.handles.has(directory)) continue
      try {
        this.handles.set(
          directory,
          this.options.host.watchDirectory(directory, (changedPath) => {
            this.recordChange(changedPath)
          })
        )
      } catch {
        // Unwatchable right now (deleted mid-flight, permissions); the
        // reconciliation pass re-adds it once it exists again.
      }
    }
  }

  /** Start periodic reconciliation. */
  start(): void {
    if (this.stopped || this.reconcileHandle !== null) return
    this.reconcileHandle = this.options.host.setReconciliationInterval(() => {
      this.options.onReconcile()
    }, this.options.reconcileIntervalMs)
  }

  /** Fire a reconciliation immediately (used at startup and after refreshes). */
  reconcileNow(): void {
    this.options.onReconcile()
  }

  /** Close all watches and timers; no further events are delivered. */
  stop(): void {
    this.stopped = true
    for (const handle of this.handles.values()) {
      handle.close()
    }
    this.handles.clear()
    if (this.debounceHandle !== null) {
      this.options.host.clearDebounceTimer(this.debounceHandle)
      this.debounceHandle = null
    }
    this.pendingPaths.clear()
    if (this.reconcileHandle !== null) {
      this.options.host.clearReconciliationInterval(this.reconcileHandle)
      this.reconcileHandle = null
    }
  }

  getWatchedDirectories(): string[] {
    return [...this.handles.keys()]
  }

  private recordChange(changedPath: string): void {
    if (this.stopped) return
    this.pendingPaths.add(changedPath)
    if (this.debounceHandle !== null) {
      this.options.host.clearDebounceTimer(this.debounceHandle)
    }
    this.debounceHandle = this.options.host.setDebounceTimer(() => {
      this.debounceHandle = null
      const paths = [...this.pendingPaths]
      this.pendingPaths.clear()
      if (paths.length > 0) {
        this.options.onPathsChanged(paths)
      }
    }, this.options.debounceMs)
  }
}
