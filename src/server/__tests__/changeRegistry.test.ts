// changeRegistry.test.ts - Task 3.2/3.3 coverage: per-repository change
// registry from the main worktree's OpenSpec root, canonical-source
// resolution against `.worktrees/<change-name>`, and registry derivation
// inside the snapshot refresh (including last-valid retention on failure).
import { describe, expect, test } from 'bun:test'
import type { OpenspecCommandResult, OpenspecCommandRunner } from '../workspace/openspecDiscovery'
import { refreshRepositoryOpenSpec } from '../workspace/openspecDiscovery'
import {
  conventionWorktreePath,
  resolveChangeRegistry,
} from '../workspace/changeRegistry'
import type { ChangeRegistryEntry, WorkspaceRepository, WorkspaceWorktree } from '../../shared/workspace'

function worktree(
  path: string,
  options: { isMain?: boolean; changes?: Array<{ name: string; completedTasks?: number; totalTasks?: number }> } = {}
): WorkspaceWorktree {
  return {
    id: `/repo/.git::${path}`,
    repositoryId: '/repo/.git',
    path,
    headRevision: '0123456789abcdef',
    detached: false,
    isMain: options.isMain === true,
    dirty: false,
    openspec: {
      changes: (options.changes ?? []).map((change) => ({
        name: change.name,
        ...(change.completedTasks !== undefined ? { completedTasks: change.completedTasks } : {}),
        ...(change.totalTasks !== undefined ? { totalTasks: change.totalTasks } : {}),
      })),
      stale: false,
    },
  }
}

function repository(worktrees: WorkspaceWorktree[]): WorkspaceRepository {
  return {
    id: '/repo/.git',
    name: 'repo',
    commonDir: '/repo/.git',
    worktrees,
    branches: [],
    stale: false,
  }
}

describe('conventionWorktreePath', () => {
  test('joins under the convention directory', () => {
    expect(conventionWorktreePath('/repo', 'add-auth')).toBe('/repo/.worktrees/add-auth')
  })
})

describe('resolveChangeRegistry', () => {
  test('seeds registry-only changes with no convention worktree', () => {
    const registry = resolveChangeRegistry(
      repository([worktree('/repo', { isMain: true, changes: [{ name: 'add-auth' }] })])
    )
    expect(registry).toEqual<ChangeRegistryEntry[]>([{ name: 'add-auth', source: 'registry' }])
  })

  test('worktree copy is canonical once it exists, even when divergent', () => {
    const registry = resolveChangeRegistry(
      repository([
        worktree('/repo', { isMain: true, changes: [{ name: 'add-auth', completedTasks: 3, totalTasks: 11 }] }),
        worktree('/repo/.worktrees/add-auth', { changes: [{ name: 'add-auth', completedTasks: 9, totalTasks: 11 }] }),
      ])
    )
    expect(registry).toEqual<ChangeRegistryEntry[]>([
      {
        name: 'add-auth',
        completedTasks: 9,
        totalTasks: 11,
        source: 'worktree',
        worktreeId: '/repo/.git::/repo/.worktrees/add-auth',
        worktreePath: '/repo/.worktrees/add-auth',
      },
    ])
  })

  test('flags a convention worktree that lacks the change', () => {
    const registry = resolveChangeRegistry(
      repository([
        worktree('/repo', { isMain: true, changes: [{ name: 'add-auth', completedTasks: 1, totalTasks: 4 }] }),
        worktree('/repo/.worktrees/add-auth', { changes: [{ name: 'other-change' }] }),
      ])
    )
    expect(registry).toEqual<ChangeRegistryEntry[]>([
      {
        name: 'add-auth',
        completedTasks: 1,
        totalTasks: 4,
        source: 'registry',
        worktreeId: '/repo/.git::/repo/.worktrees/add-auth',
        worktreePath: '/repo/.worktrees/add-auth',
        missingInWorktree: true,
      },
    ])
  })

  test('a matching basename outside the convention directory never matches', () => {
    const registry = resolveChangeRegistry(
      repository([
        worktree('/repo', { isMain: true, changes: [{ name: 'add-auth' }] }),
        worktree('/elsewhere/add-auth', { changes: [{ name: 'add-auth', completedTasks: 5 }] }),
      ])
    )
    expect(registry).toEqual<ChangeRegistryEntry[]>([{ name: 'add-auth', source: 'registry' }])
  })

  test('sorts entries by change name and yields empty without a main worktree or seeds', () => {
    expect(
      resolveChangeRegistry(
        repository([
          worktree('/repo', {
            isMain: true,
            changes: [{ name: 'z-last' }, { name: 'a-first' }],
          }),
        ])
      ).map((entry) => entry.name)
    ).toEqual(['a-first', 'z-last'])
    expect(resolveChangeRegistry(repository([worktree('/repo')]))).toEqual([])
    expect(resolveChangeRegistry(repository([worktree('/repo', { changes: [{ name: 'x' }] })]))).toEqual([])
  })
})

describe('refreshRepositoryOpenSpec registry merge', () => {
  const okPayload = (changes: unknown[]): string =>
    JSON.stringify({ changes, root: { path: '/repo/openspec' } })

  function runnerFor(mainChanges: unknown[], worktreeChanges: unknown[]): OpenspecCommandRunner {
    return ({ cwd }) => {
      const result: OpenspecCommandResult =
        cwd === '/repo'
          ? { ok: true, exitCode: 0, stdout: okPayload(mainChanges), stderr: '' }
          : { ok: true, exitCode: 0, stdout: okPayload(worktreeChanges), stderr: '' }
      return result
    }
  }

  test('derives the registry from discovered states', () => {
    const refreshed = refreshRepositoryOpenSpec(
      repository([worktree('/repo', { isMain: true }), worktree('/repo/.worktrees/add-auth')]),
      undefined,
      {
        runner: runnerFor(
          [{ name: 'add-auth', completedTasks: 2, totalTasks: 5 }],
          [{ name: 'add-auth', completedTasks: 4, totalTasks: 5 }]
        ),
      }
    )
    expect(refreshed.changeRegistry).toEqual<ChangeRegistryEntry[]>([
      {
        name: 'add-auth',
        completedTasks: 4,
        totalTasks: 5,
        source: 'worktree',
        worktreeId: '/repo/.git::/repo/.worktrees/add-auth',
        worktreePath: '/repo/.worktrees/add-auth',
      },
    ])
  })

  test('retains last-valid registry values when discovery fails', () => {
    const seed = repository([worktree('/repo', { isMain: true })])
    const first = refreshRepositoryOpenSpec(seed, undefined, {
      runner: runnerFor([{ name: 'add-auth', completedTasks: 1, totalTasks: 3 }], []),
    })
    expect(first.changeRegistry).toEqual<ChangeRegistryEntry[]>([
      { name: 'add-auth', completedTasks: 1, totalTasks: 3, source: 'registry' },
    ])

    const failing: OpenspecCommandRunner = () => ({
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'boom',
    })
    const second = refreshRepositoryOpenSpec(seed, [first], { runner: failing })
    expect(second.worktrees[0].openspec.stale).toBe(true)
    expect(second.changeRegistry).toEqual<ChangeRegistryEntry[]>([
      { name: 'add-auth', completedTasks: 1, totalTasks: 3, source: 'registry' },
    ])
  })
})
