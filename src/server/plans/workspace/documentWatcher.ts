// The document sources' dedicated watcher (plan-workspace 2.4, CP1 §5):
// debounced non-recursive watches over the subscribed directories, plus the
// reconciliation interval that re-reads every subscribed source. Mirrors the
// navigator's WorkspaceWatcher, with the same constants — the watch is the
// latency optimization, the period is the correctness mechanism (inotify
// misses new directories and events).
import type { WatchHandle, WorkspaceWatcherHost } from '../../workspace/workspaceWatcher'
import {
  WORKSPACE_RECONCILE_INTERVAL_MS, WORKSPACE_WATCH_DEBOUNCE_MS,
} from '../../workspace/workspaceWatcher'

export interface SourceWatcherOptions {
  host: WorkspaceWatcherHost
  /** Debounced batch of changed filesystem paths. */
  onPathsChanged(paths: string[]): void
  /** Periodic full reconciliation (missed-event recovery). */
  onReconcile(): void
  debounceMs?: number
  reconcileIntervalMs?: number
}

export class SourceWatcher {
  private readonly options: Required<Pick<SourceWatcherOptions, 'debounceMs' | 'reconcileIntervalMs'>> & SourceWatcherOptions
  private readonly handles = new Map<string, WatchHandle>()
  private readonly pending = new Set<string>()
  private debounceHandle: unknown = null
  private reconcileHandle: unknown = null
  private stopped = false

  constructor(options: SourceWatcherOptions) {
    this.options = {
      debounceMs: WORKSPACE_WATCH_DEBOUNCE_MS,
      reconcileIntervalMs: WORKSPACE_RECONCILE_INTERVAL_MS,
      ...options,
    }
  }

  /** Diff the current watches against the subscribed sources' directories. */
  setTargets(dirs: Iterable<string>): void {
    if (this.stopped) return
    const desired = new Set([...dirs].filter(directory => this.options.host.isWatchable(directory)))
    for (const [directory, handle] of this.handles) {
      if (!desired.has(directory)) {
        handle.close()
        this.handles.delete(directory)
      }
    }
    for (const directory of desired) {
      if (this.handles.has(directory)) continue
      try {
        this.handles.set(directory, this.options.host.watchDirectory(directory, changed => this.record(changed)))
      } catch {
        // Unwatchable right now (deleted mid-flight, permissions); the
        // reconciliation pass re-reads the sources either way.
      }
    }
  }

  start(): void {
    if (this.stopped || this.reconcileHandle !== null) return
    this.reconcileHandle = this.options.host.setReconciliationInterval(() => this.options.onReconcile(), this.options.reconcileIntervalMs)
  }

  stop(): void {
    this.stopped = true
    for (const handle of this.handles.values()) handle.close()
    this.handles.clear()
    if (this.debounceHandle !== null) {
      this.options.host.clearDebounceTimer(this.debounceHandle)
      this.debounceHandle = null
    }
    this.pending.clear()
    if (this.reconcileHandle !== null) {
      this.options.host.clearReconciliationInterval(this.reconcileHandle)
      this.reconcileHandle = null
    }
  }

  private record(changedPath: string): void {
    if (this.stopped) return
    this.pending.add(changedPath)
    if (this.debounceHandle !== null) this.options.host.clearDebounceTimer(this.debounceHandle)
    this.debounceHandle = this.options.host.setDebounceTimer(() => {
      this.debounceHandle = null
      const paths = [...this.pending]
      this.pending.clear()
      if (paths.length > 0) this.options.onPathsChanged(paths)
    }, this.options.debounceMs)
  }
}
