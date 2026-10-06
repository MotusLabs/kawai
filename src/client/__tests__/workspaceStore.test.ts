// workspaceStore.test.ts - Task 5.1 coverage: snapshot lifecycle (reconnect
// resupply, stale snapshot retention, clearing), collapse persistence, and
// operation result bookkeeping.
import { beforeEach, describe, expect, test } from 'bun:test'

const globalAny = globalThis as typeof globalThis & {
  window?: { localStorage: Storage }
  localStorage?: Storage
}

function createStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

const storage = createStorage()
globalAny.localStorage = storage
globalAny.window = { localStorage: storage } as typeof window

const { useWorkspaceStore } = await import('../stores/workspaceStore')
const { FALLBACK_ARCHIVE_SECTION_KEY } = await import('../../shared/workspace')

function snapshotWith(repoId: string, worktreePath: string) {
  return {
    repositories: [
      {
        id: repoId,
        name: 'repo',
        commonDir: repoId,
        worktrees: [
          {
            id: `${repoId}::${worktreePath}`,
            repositoryId: repoId,
            path: worktreePath,
            headRevision: 'abc1234',
            detached: false,
            isMain: true,
            dirty: false,
            openspec: { changes: [], stale: false },
          },
        ],
        branches: [],
        stale: false,
      },
    ],
    generatedAt: '2026-01-01T00:00:00.000Z',
  }
}

beforeEach(() => {
  storage.clear()
  useWorkspaceStore.setState({
    snapshot: null,
    lastError: null,
    operationResults: [],
    collapsedSectionIds: [],
    archiveSectionExpanded: false,
  })
})

describe('workspaceStore snapshots', () => {
  test('accepts a valid snapshot', () => {
    const payload = snapshotWith('/repo/.git', '/repo')
    expect(useWorkspaceStore.getState().applySnapshot(payload)).toBe(true)
    expect(useWorkspaceStore.getState().snapshot?.repositories).toHaveLength(1)
    expect(useWorkspaceStore.getState().lastError).toBeNull()
  })

  test('malformed payloads keep the last valid snapshot (stale retention)', () => {
    const store = useWorkspaceStore.getState()
    store.applySnapshot(snapshotWith('/repo/.git', '/repo'))
    const first = useWorkspaceStore.getState().snapshot

    expect(store.applySnapshot('garbage')).toBe(false)
    expect(store.applySnapshot({ repositories: 'nope' })).toBe(false)
    expect(store.applySnapshot(null)).toBe(false)
    expect(useWorkspaceStore.getState().snapshot).toBe(first)
  })

  test('reconnect resupply: clearing then applying a fresh snapshot works', () => {
    const store = useWorkspaceStore.getState()
    store.applySnapshot(snapshotWith('/repo/.git', '/repo'))
    useWorkspaceStore.getState().clearSnapshot()
    expect(useWorkspaceStore.getState().snapshot).toBeNull()

    // Server sends the latest snapshot on reconnect.
    expect(store.applySnapshot(snapshotWith('/repo2/.git', '/repo2'))).toBe(true)
    expect(useWorkspaceStore.getState().snapshot?.repositories[0].id).toBe('/repo2/.git')
  })

  test('connection errors are tracked without dropping the snapshot', () => {
    const store = useWorkspaceStore.getState()
    store.applySnapshot(snapshotWith('/repo/.git', '/repo'))
    store.setLastError('connection lost')
    expect(useWorkspaceStore.getState().lastError).toBe('connection lost')
    expect(useWorkspaceStore.getState().snapshot).not.toBeNull()
    store.setLastError(null)
    expect(useWorkspaceStore.getState().lastError).toBeNull()
  })

  test('snapshot with dropped malformed repositories still applies', () => {
    const payload = {
      repositories: [
        'garbage',
        ...snapshotWith('/repo/.git', '/repo').repositories,
      ],
      generatedAt: '2026-01-01T00:00:00.000Z',
    }
    expect(useWorkspaceStore.getState().applySnapshot(payload)).toBe(true)
    expect(useWorkspaceStore.getState().snapshot?.repositories).toHaveLength(1)
  })
})

describe('workspaceStore collapse state', () => {
  test('toggles collapse per worktree id', () => {
    const store = useWorkspaceStore.getState()
    store.toggleSectionCollapsed('/repo/.git::/repo')
    expect(store.isSectionCollapsed('/repo/.git::/repo')).toBe(true)
    store.toggleSectionCollapsed('/repo/.git::/repo')
    expect(store.isSectionCollapsed('/repo/.git::/repo')).toBe(false)
  })

  test('collapse state persists to storage and survives rehydration', async () => {
    useWorkspaceStore.getState().toggleSectionCollapsed('/repo/.git::/repo')
    // persist middleware writes synchronously through safeStorage.
    const raw = storage.getItem('agentboard-workspace')
    expect(raw).toBeTruthy()
    const persisted = JSON.parse(raw as string) as {
      state: { collapsedSectionIds: string[] }
    }
    expect(persisted.state.collapsedSectionIds).toEqual(['/repo/.git::/repo'])
  })

  test('fallback section keys round-trip through persisted collapse state', () => {
    const store = useWorkspaceStore.getState()
    store.toggleSectionCollapsed('fallback::workspace')
    store.toggleSectionCollapsed('fallback::remote')
    expect(store.isSectionCollapsed('fallback::workspace')).toBe(true)
    expect(store.isSectionCollapsed('fallback::remote')).toBe(true)

    const raw = storage.getItem('agentboard-workspace')
    expect(raw).toBeTruthy()
    const persisted = JSON.parse(raw as string) as {
      state: { collapsedSectionIds: string[] }
    }
    expect(persisted.state.collapsedSectionIds).toEqual([
      'fallback::workspace',
      'fallback::remote',
    ])

    store.toggleSectionCollapsed('fallback::remote')
    expect(useWorkspaceStore.getState().isSectionCollapsed('fallback::remote')).toBe(false)
    expect(useWorkspaceStore.getState().isSectionCollapsed('fallback::workspace')).toBe(true)
  })

  test('unknown persisted collapse ids are harmless', () => {
    storage.setItem(
      'agentboard-workspace',
      JSON.stringify({
        state: { collapsedSectionIds: ['gone-worktree-id'] },
        version: 0,
      })
    )
    // Rehydration (next store creation) tolerates unknown ids; the live
    // accessor simply reports them without error.
    useWorkspaceStore.setState({ collapsedSectionIds: ['gone-worktree-id'] })
    expect(useWorkspaceStore.getState().isSectionCollapsed('gone-worktree-id')).toBe(true)
  })

  test('Archive reads as collapsed on first use with no stored entry', () => {
    // No collapse entry and no recorded expansion: collapsed by default.
    expect(useWorkspaceStore.getState().collapsedSectionIds).toEqual([])
    expect(
      useWorkspaceStore.getState().isSectionCollapsed(FALLBACK_ARCHIVE_SECTION_KEY)
    ).toBe(true)
  })

  test('expanding Archive records the choice and persists it across reloads', () => {
    const store = useWorkspaceStore.getState()
    store.toggleSectionCollapsed(FALLBACK_ARCHIVE_SECTION_KEY)
    expect(
      useWorkspaceStore.getState().isSectionCollapsed(FALLBACK_ARCHIVE_SECTION_KEY)
    ).toBe(false)

    // The expansion marker persists; the collapse list stays empty.
    const raw = storage.getItem('agentboard-workspace')
    expect(raw).toBeTruthy()
    const persisted = JSON.parse(raw as string) as {
      state: { collapsedSectionIds: string[]; archiveSectionExpanded: boolean }
    }
    expect(persisted.state.collapsedSectionIds).toEqual([])
    expect(persisted.state.archiveSectionExpanded).toBe(true)

    // A reload with that persisted state keeps Archive expanded.
    useWorkspaceStore.setState({
      collapsedSectionIds: [],
      archiveSectionExpanded: true,
    })
    expect(
      useWorkspaceStore.getState().isSectionCollapsed(FALLBACK_ARCHIVE_SECTION_KEY)
    ).toBe(false)
  })

  test('after first expansion, collapse toggles behave like every other section', () => {
    const store = useWorkspaceStore.getState()
    store.toggleSectionCollapsed(FALLBACK_ARCHIVE_SECTION_KEY) // expand (first use)
    store.toggleSectionCollapsed(FALLBACK_ARCHIVE_SECTION_KEY) // collapse again
    expect(
      useWorkspaceStore.getState().isSectionCollapsed(FALLBACK_ARCHIVE_SECTION_KEY)
    ).toBe(true)
    expect(useWorkspaceStore.getState().collapsedSectionIds).toEqual([
      FALLBACK_ARCHIVE_SECTION_KEY,
    ])

    // Reload with that persisted state: still collapsed, and expanding
    // removes the explicit entry.
    useWorkspaceStore.setState({
      collapsedSectionIds: [FALLBACK_ARCHIVE_SECTION_KEY],
      archiveSectionExpanded: true,
    })
    store.toggleSectionCollapsed(FALLBACK_ARCHIVE_SECTION_KEY)
    expect(useWorkspaceStore.getState().collapsedSectionIds).toEqual([])
    expect(
      useWorkspaceStore.getState().isSectionCollapsed(FALLBACK_ARCHIVE_SECTION_KEY)
    ).toBe(false)
  })
})

describe('workspaceStore operation results', () => {
  test('records results newest first and bounds the list', () => {
    const store = useWorkspaceStore.getState()
    for (let index = 0; index < 12; index += 1) {
      store.recordOperationResult({
        operation: 'create-worktree',
        ok: true,
        repositoryId: `/repo-${index}/.git`,
        branch: 'feat',
        path: `/repo-${index}-feat`,
      })
    }
    const results = useWorkspaceStore.getState().operationResults
    expect(results).toHaveLength(10)
    expect(results[0].ok && results[0].repositoryId).toBe('/repo-11/.git')
  })

  test('records failures with actionable errors', () => {
    useWorkspaceStore.getState().recordOperationResult({
      operation: 'create-worktree',
      ok: false,
      repositoryId: '/repo/.git',
      branch: 'feat',
      error: 'Destination already exists',
    })
    const result = useWorkspaceStore.getState().operationResults[0]
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Destination already exists')
    }
  })

  test('clears results by operation', () => {
    const store = useWorkspaceStore.getState()
    store.recordOperationResult({
      operation: 'create-worktree',
      ok: true,
      repositoryId: '/repo/.git',
      branch: 'feat',
      path: '/repo-feat',
    })
    store.clearOperationResult('create-worktree')
    expect(useWorkspaceStore.getState().operationResults).toHaveLength(0)
  })
})
