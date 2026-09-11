// openspecMerge.test.ts - Task 3.2 coverage: merge OpenSpec results into
// their originating worktree snapshots without copying state between
// worktrees, retaining last-valid values on failure. Uses two worktrees with
// divergent change lists and progress.
import { describe, expect, test } from 'bun:test'
import type { OpenspecCommandResult, OpenspecCommandRunner } from '../workspace/openspecDiscovery'
import { refreshSnapshotOpenSpec } from '../workspace/openspecDiscovery'
import type { WorkspaceSnapshot, WorkspaceWorktree } from '../../shared/workspace'

function worktree(id: string, path: string): WorkspaceWorktree {
  return {
    id,
    repositoryId: '/repo/.git',
    path,
    headRevision: 'abc1234',
    detached: false,
    isMain: false,
    dirty: false,
    openspec: { changes: [], stale: false },
  }
}

function snapshotWith(worktrees: WorkspaceWorktree[]): WorkspaceSnapshot {
  return {
    repositories: [
      {
        id: '/repo/.git',
        name: 'repo',
        commonDir: '/repo/.git',
        worktrees,
        branches: [],
        stale: false,
      },
    ],
    generatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function okPayload(changes: unknown[], rootPath: string): string {
  return JSON.stringify({ changes, root: { path: rootPath } })
}

describe('refreshSnapshotOpenSpec', () => {
  test('two worktrees keep divergent change lists and progress', () => {
    const runner: OpenspecCommandRunner = ({ cwd }) => {
      const result: OpenspecCommandResult =
        cwd === '/repo-main'
          ? {
              ok: true,
              exitCode: 0,
              stdout: okPayload(
                [{ name: 'add-auth', status: 'in-progress', completedTasks: 3, totalTasks: 11 }],
                '/repo-main/openspec'
              ),
              stderr: '',
            }
          : {
              ok: true,
              exitCode: 0,
              stdout: okPayload(
                [{ name: 'different-change', status: 'in-progress', completedTasks: 0, totalTasks: 4 }],
                '/repo-wt/openspec'
              ),
              stderr: '',
            }
      return result
    }

    const snapshot = snapshotWith([worktree('wt-main', '/repo-main'), worktree('wt-linked', '/repo-wt')])
    const merged = refreshSnapshotOpenSpec(snapshot, null, { runner })

    const main = merged.repositories[0].worktrees.find((wt) => wt.id === 'wt-main')
    const linked = merged.repositories[0].worktrees.find((wt) => wt.id === 'wt-linked')

    expect(main?.openspec.changes.map((change) => change.name)).toEqual(['add-auth'])
    expect(main?.openspec.changes[0].completedTasks).toBe(3)
    expect(linked?.openspec.changes.map((change) => change.name)).toEqual(['different-change'])
    expect(linked?.openspec.changes[0].completedTasks).toBe(0)
    expect(main?.openspec.stale).toBe(false)
    expect(linked?.openspec.stale).toBe(false)
  })

  test('failed refresh retains only the failing worktree’s last-valid values', () => {
    const previous = snapshotWith([
      {
        ...worktree('wt-main', '/repo-main'),
        openspec: {
          changes: [{ name: 'main-change', completedTasks: 1, totalTasks: 2 }],
          stale: false,
          rootPath: '/repo-main/openspec',
        },
      },
      {
        ...worktree('wt-linked', '/repo-wt'),
        openspec: {
          changes: [{ name: 'linked-change', completedTasks: 5, totalTasks: 5 }],
          stale: false,
          rootPath: '/repo-wt/openspec',
        },
      },
    ])

    let callCount = 0
    const runner: OpenspecCommandRunner = ({ cwd }) => {
      callCount += 1
      if (cwd === '/repo-main') {
        // The main worktree's openspec discovery fails this pass.
        return { ok: false, exitCode: 1, stdout: '', stderr: 'boom' }
      }
      return {
        ok: true,
        exitCode: 0,
        stdout: okPayload([{ name: 'linked-updated', status: 'in-progress', completedTasks: 2, totalTasks: 6 }], '/repo-wt/openspec'),
        stderr: '',
      }
    }

    const merged = refreshSnapshotOpenSpec(previous, previous, { runner })
    expect(callCount).toBe(2)

    const main = merged.repositories[0].worktrees.find((wt) => wt.id === 'wt-main')
    const linked = merged.repositories[0].worktrees.find((wt) => wt.id === 'wt-linked')

    // Retains its own last-valid values, marked stale with the error.
    expect(main?.openspec.stale).toBe(true)
    expect(main?.openspec.changes.map((change) => change.name)).toEqual(['main-change'])
    expect(main?.openspec.error).toBe('openspec exited with 1')
    // The other worktree still updates.
    expect(linked?.openspec.stale).toBe(false)
    expect(linked?.openspec.changes.map((change) => change.name)).toEqual(['linked-updated'])
  })

  test('never copies another worktree’s values into a failing one', () => {
    const previous = snapshotWith([
      worktree('wt-main', '/repo-main'), // never had openspec data
      {
        ...worktree('wt-linked', '/repo-wt'),
        openspec: { changes: [{ name: 'linked-change' }], stale: false },
      },
    ])

    const runner: OpenspecCommandRunner = ({ cwd }) => {
      if (cwd === '/repo-main') {
        return { ok: false, exitCode: 1, stdout: '', stderr: 'boom' }
      }
      return {
        ok: true,
        exitCode: 0,
        stdout: okPayload([{ name: 'linked-change' }], '/repo-wt/openspec'),
        stderr: '',
      }
    }

    const merged = refreshSnapshotOpenSpec(previous, previous, { runner })
    const main = merged.repositories[0].worktrees.find((wt) => wt.id === 'wt-main')
    // No last-valid values existed, and linked's data must not leak in.
    expect(main?.openspec.changes).toEqual([])
    expect(main?.openspec.stale).toBe(true)
  })

  test('missing-root worktrees stay empty and non-stale', () => {
    const runner: OpenspecCommandRunner = () => ({
      ok: false,
      exitCode: 1,
      stdout: JSON.stringify({
        changes: [],
        root: null,
        status: [{ severity: 'error', code: 'no_openspec_root', message: 'none' }],
      }),
      stderr: '',
    })
    const snapshot = snapshotWith([worktree('wt-main', '/repo-main')])
    const merged = refreshSnapshotOpenSpec(snapshot, null, { runner })
    expect(merged.repositories[0].worktrees[0].openspec).toEqual({ changes: [], stale: false })
  })
})
