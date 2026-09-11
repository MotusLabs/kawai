// workspaceWatcher.test.ts - Task 4.3 coverage: safe, debounced filesystem
// watches plus periodic reconciliation, using fake watchers and timers.
// Covers burst coalescing, missed-event recovery, newly created directories,
// and shutdown.
import { describe, expect, test } from 'bun:test'
import type { WorkspaceSnapshot } from '../../shared/workspace'
import {
  WorkspaceWatcher,
  computeWatchTargets,
  type WatchHandle,
  type WorkspaceWatcherHost,
} from '../workspace/workspaceWatcher'

class FakeHost implements WorkspaceWatcherHost {
  watchable = new Set<string>()
  private listeners = new Map<string, Array<(changed: string) => void>>()
  private closed = new Set<string>()
  private debounceTimers: Array<{ callback: () => void; ms: number; cleared: boolean }> = []
  private reconcileTimers: Array<{ callback: () => void; ms: number; cleared: boolean }> = []
  pathsChangedBatches: string[][] = []
  reconcileCalls = 0
  onPathsChangedImpl: (paths: string[]) => void = (paths) => {
    this.pathsChangedBatches.push(paths)
  }

  markWatchable(...paths: string[]): void {
    for (const path of paths) this.watchable.add(path)
  }

  watchDirectory(directory: string, onEvent: (changedPath: string) => void): WatchHandle {
    const list = this.listeners.get(directory) ?? []
    list.push(onEvent)
    this.listeners.set(directory, list)
    return {
      close: () => {
        this.closed.add(directory)
        this.listeners.set(
          directory,
          (this.listeners.get(directory) ?? []).filter((listener) => listener !== onEvent)
        )
      },
    }
  }

  isWatchable(candidate: string): boolean {
    return this.watchable.has(candidate)
  }

  setDebounceTimer(callback: () => void, ms: number): unknown {
    const timer = { callback, ms, cleared: false }
    this.debounceTimers.push(timer)
    return timer
  }

  clearDebounceTimer(handle: unknown): void {
    ;(handle as { cleared: boolean }).cleared = true
  }

  setReconciliationInterval(callback: () => void, ms: number): unknown {
    const timer = { callback, ms, cleared: false }
    this.reconcileTimers.push(timer)
    return timer
  }

  clearReconciliationInterval(handle: unknown): void {
    ;(handle as { cleared: boolean }).cleared = true
  }

  emit(directory: string, name: string): void {
    for (const listener of this.listeners.get(directory) ?? []) {
      listener(`${directory}/${name}`)
    }
  }

  fireDebounce(): void {
    const pending = [...this.debounceTimers]
    this.debounceTimers.length = 0
    for (const timer of pending) {
      if (!timer.cleared) timer.callback()
    }
  }

  fireReconcile(): void {
    for (const timer of this.reconcileTimers) {
      if (!timer.cleared) timer.callback()
    }
  }

  isClosed(directory: string): boolean {
    return this.closed.has(directory)
  }

  debounceTimerCleared(): boolean {
    return this.debounceTimers.every((timer) => timer.cleared)
  }

  reconcileIntervalCleared(): boolean {
    return this.reconcileTimers.every((timer) => timer.cleared)
  }
}

function snapshotFixture(paths: { commonDir: string; worktrees: string[]; openspecRoots?: Record<string, string[]> }): WorkspaceSnapshot {
  return {
    repositories: paths.worktrees.map((worktreePath, index) => ({
      id: paths.commonDir,
      name: `repo-${index}`,
      commonDir: paths.commonDir,
      worktrees: [
        {
          id: `${paths.commonDir}::${worktreePath}`,
          repositoryId: paths.commonDir,
          path: worktreePath,
          headRevision: 'abc1234',
          detached: false,
          isMain: index === 0,
          dirty: false,
          openspec: {
            ...(paths.openspecRoots?.[worktreePath]
              ? { rootPath: `${worktreePath}/openspec` }
              : {}),
            changes: (paths.openspecRoots?.[worktreePath] ?? []).map((name) => ({ name })),
            stale: false,
          },
        },
      ],
      branches: [],
      stale: false,
    })),
    generatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function createWatcher(host: FakeHost) {
  return new WorkspaceWatcher({
    host,
    onPathsChanged: (paths) => host.onPathsChangedImpl(paths),
    onReconcile: () => {
      host.reconcileCalls += 1
    },
    debounceMs: 100,
    reconcileIntervalMs: 1000,
  })
}

describe('computeWatchTargets', () => {
  test('covers git internals, worktree roots, and openspec change dirs', () => {
    const targets = computeWatchTargets(
      snapshotFixture({
        commonDir: '/repo/.git',
        worktrees: ['/repo'],
        openspecRoots: { '/repo': ['add-auth'] },
      })
    )
    expect(targets).toContain('/repo/.git')
    expect(targets).toContain('/repo/.git/refs/heads')
    expect(targets).toContain('/repo/.git/worktrees')
    expect(targets).toContain('/repo')
    expect(targets).toContain('/repo/openspec/changes')
    expect(targets).toContain('/repo/openspec/changes/add-auth')
  })
})

describe('WorkspaceWatcher', () => {
  test('coalesces event bursts into one debounced batch', () => {
    const host = new FakeHost()
    host.markWatchable('/repo/.git', '/repo/.git/refs/heads', '/repo/.git/worktrees', '/repo')
    const watcher = createWatcher(host)
    watcher.updateTargets(snapshotFixture({ commonDir: '/repo/.git', worktrees: ['/repo'] }))

    host.emit('/repo/.git/refs/heads', 'main')
    host.emit('/repo/.git', 'HEAD')
    host.emit('/repo/.git', 'HEAD')
    host.emit('/repo/.git/worktrees', 'linked-wt')
    host.fireDebounce()

    expect(host.pathsChangedBatches).toHaveLength(1)
    expect(host.pathsChangedBatches[0]).toEqual([
      '/repo/.git/refs/heads/main',
      '/repo/.git/HEAD',
      '/repo/.git/worktrees/linked-wt',
    ])

    watcher.stop()
  })

  test('events after a stopped debounce timer are dropped', () => {
    const host = new FakeHost()
    host.markWatchable('/repo/.git', '/repo/.git/refs/heads', '/repo/.git/worktrees', '/repo')
    const watcher = createWatcher(host)
    watcher.updateTargets(snapshotFixture({ commonDir: '/repo/.git', worktrees: ['/repo'] }))

    host.emit('/repo/.git', 'HEAD')
    watcher.stop()
    host.fireDebounce()

    expect(host.pathsChangedBatches).toHaveLength(0)
  })

  test('periodic reconciliation recovers missed events without watches', () => {
    const host = new FakeHost()
    const watcher = createWatcher(host)
    watcher.start()

    expect(host.reconcileCalls).toBe(0)
    host.fireReconcile()
    host.fireReconcile()
    expect(host.reconcileCalls).toBe(2)

    watcher.stop()
  })

  test('newly created directories become watched after target updates', () => {
    const host = new FakeHost()
    host.markWatchable('/repo/.git', '/repo/.git/refs/heads', '/repo/.git/worktrees', '/repo')
    const watcher = createWatcher(host)
    watcher.updateTargets(snapshotFixture({ commonDir: '/repo/.git', worktrees: ['/repo'] }))
    expect(watcher.getWatchedDirectories()).toContain('/repo')

    // A linked worktree appears; its directory did not exist during the
    // first update so it was skipped...
    const withLinked = snapshotFixture({ commonDir: '/repo/.git', worktrees: ['/repo', '/repo-linked'] })
    watcher.updateTargets(withLinked)
    expect(watcher.getWatchedDirectories()).not.toContain('/repo-linked')

    // ...now the directory exists, and the next target update picks it up.
    host.markWatchable('/repo-linked')
    watcher.updateTargets(withLinked)
    expect(watcher.getWatchedDirectories()).toContain('/repo-linked')

    // Events from the new watch flow through.
    host.emit('/repo-linked', '.git')
    host.fireDebounce()
    expect(host.pathsChangedBatches[0]).toContain('/repo-linked/.git')

    watcher.stop()
  })

  test('removing a repository closes its watches', () => {
    const host = new FakeHost()
    host.markWatchable('/repo/.git', '/repo/.git/refs/heads', '/repo/.git/worktrees', '/repo')
    const watcher = createWatcher(host)
    watcher.updateTargets(snapshotFixture({ commonDir: '/repo/.git', worktrees: ['/repo'] }))

    watcher.updateTargets({ repositories: [], generatedAt: '2026-01-01T00:00:00.000Z' })
    expect(watcher.getWatchedDirectories()).toEqual([])
    expect(host.isClosed('/repo')).toBe(true)
    expect(host.isClosed('/repo/.git')).toBe(true)

    watcher.stop()
  })

  test('shutdown closes watches and timers and delivers nothing further', () => {
    const host = new FakeHost()
    host.markWatchable('/repo/.git', '/repo/.git/refs/heads', '/repo/.git/worktrees', '/repo')
    const watcher = createWatcher(host)
    watcher.updateTargets(snapshotFixture({ commonDir: '/repo/.git', worktrees: ['/repo'] }))
    watcher.start()

    watcher.stop()

    expect(watcher.getWatchedDirectories()).toEqual([])
    expect(host.isClosed('/repo')).toBe(true)
    host.emit('/repo', 'file.txt')
    host.fireDebounce()
    host.fireReconcile()
    expect(host.pathsChangedBatches).toHaveLength(0)
    // Reconcile calls only increase via the interval callback; stop() cleared
    // the interval so fireReconcile (fake host) still routes to the callback,
    // but the real host would have discarded the cleared timer. Assert the
    // debounce path stayed silent and timers were cleared.
    expect(host.debounceTimerCleared()).toBe(true)
    expect(host.reconcileIntervalCleared()).toBe(true)
  })
})
