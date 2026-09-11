import { describe, expect, test } from 'bun:test'
import type {
  ClientMessage,
  ServerMessage,
} from '../types'
import {
  repositoryId,
  shortRevision,
  worktreeId,
  type OpenSpecChangeSummary,
  type WorkspaceRepository,
  type WorkspaceSnapshot,
  type WorkspaceWorktree,
} from '../workspace'

function worktreeFixture(overrides: Partial<WorkspaceWorktree> = {}): WorkspaceWorktree {
  return {
    id: worktreeId(repositoryId('/repo/.git'), '/repo'),
    repositoryId: repositoryId('/repo/.git'),
    path: '/repo',
    branch: 'main',
    headRevision: '0123456789abcdef0123456789abcdef01234567',
    detached: false,
    isMain: true,
    dirty: false,
    openspec: { changes: [], stale: false },
    ...overrides,
  }
}

describe('workspace ids', () => {
  test('repository id is the canonical common dir', () => {
    expect(repositoryId('/repo/.git')).toBe('/repo/.git')
  })

  test('worktree id combines repository identity and canonical worktree path', () => {
    expect(worktreeId('/repo/.git', '/repo-wt')).toBe('/repo/.git::/repo-wt')
  })

  test('distinct worktree paths produce distinct ids', () => {
    expect(worktreeId('/repo/.git', '/repo-a')).not.toBe(worktreeId('/repo/.git', '/repo-b'))
  })

  test('same repository identity across common-dir aliases is stable', () => {
    expect(worktreeId('/repo/.git', '/repo-a')).toBe(worktreeId('/repo/.git', '/repo-a'))
  })
})

describe('shortRevision', () => {
  test('shortens a full revision to seven characters', () => {
    expect(shortRevision('0123456789abcdef')).toBe('0123456')
  })

  test('returns short revisions unchanged', () => {
    expect(shortRevision('abc')).toBe('abc')
  })
})

describe('workspace snapshot shape', () => {
  test('snapshot composes repositories, worktrees, branches, and openspec state', () => {
    const changes: OpenSpecChangeSummary[] = [
      { name: 'add-auth', status: 'in-progress', completedTasks: 3, totalTasks: 5, lastModified: '2026-01-01T00:00:00.000Z' },
    ]
    const worktree = worktreeFixture({
      branch: undefined,
      detached: true,
      openspec: { changes, stale: false, rootPath: '/repo/openspec' },
    })
    const repository: WorkspaceRepository = {
      id: repositoryId('/repo/.git'),
      name: 'repo',
      commonDir: '/repo/.git',
      worktrees: [worktree],
      branches: [{ name: 'main', revision: worktree.headRevision }],
      stale: false,
    }
    const snapshot: WorkspaceSnapshot = {
      repositories: [repository],
      generatedAt: '2026-01-01T00:00:00.000Z',
    }

    expect(snapshot.repositories).toHaveLength(1)
    expect(snapshot.repositories[0].worktrees[0].detached).toBe(true)
    expect(snapshot.repositories[0].worktrees[0].branch).toBeUndefined()
    expect(snapshot.repositories[0].worktrees[0].openspec.changes[0].name).toBe('add-auth')
    expect(snapshot.repositories[0].branches[0].assignedWorktreeId).toBeUndefined()
  })
})

describe('workspace websocket messages', () => {
  test('server workspace-snapshot message carries a snapshot', () => {
    const message: ServerMessage = {
      type: 'workspace-snapshot',
      snapshot: { repositories: [], generatedAt: '2026-01-01T00:00:00.000Z' },
    }
    expect(message.type).toBe('workspace-snapshot')
    if (message.type === 'workspace-snapshot') {
      expect(message.snapshot.repositories).toEqual([])
    }
  })

  test('server workspace-operation-result covers success and failure', () => {
    const ok: ServerMessage = {
      type: 'workspace-operation-result',
      result: { operation: 'create-worktree', ok: true, repositoryId: '/repo/.git', branch: 'feat', path: '/repo-feat' },
    }
    const failed: ServerMessage = {
      type: 'workspace-operation-result',
      result: { operation: 'create-worktree', ok: false, error: 'destination exists' },
    }
    expect(ok.type).toBe('workspace-operation-result')
    expect(failed.type).toBe('workspace-operation-result')
  })

  test('client create-worktree message includes destination and optional launch', () => {
    const withLaunch: ClientMessage = {
      type: 'create-worktree',
      repositoryId: '/repo/.git',
      branch: 'feat',
      destination: '/repo-feat',
      launchSession: true,
    }
    const withoutLaunch: ClientMessage = {
      type: 'create-worktree',
      repositoryId: '/repo/.git',
      branch: 'feat',
      destination: '/repo-feat',
    }
    expect(withLaunch.type).toBe('create-worktree')
    expect(withoutLaunch.type).toBe('create-worktree')
  })

  test('client workspace-refresh message accepts an optional project path', () => {
    const scoped: ClientMessage = { type: 'workspace-refresh', projectPath: '/repo' }
    const full: ClientMessage = { type: 'workspace-refresh' }
    expect(scoped.type).toBe('workspace-refresh')
    expect(full.type).toBe('workspace-refresh')
  })
})
