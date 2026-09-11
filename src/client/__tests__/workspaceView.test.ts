// workspaceView.test.ts - Task 5.2 coverage: pure selectors associating
// active, hibernating, and historical sessions with the deepest worktree and
// producing repository groups, local-ungrouped/remote fallbacks, attention
// counts, and the flattened visible navigation order.
import { describe, expect, test } from 'bun:test'
import type { AgentSession, Session } from '@shared/types'
import type { WorkspaceSnapshot } from '@shared/workspace'
import { buildWorkspaceView } from '../utils/workspaceView'

function liveSession(id: string, projectPath: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    tmuxWindow: `agentboard:${id}`,
    projectPath,
    status: 'working',
    lastActivity: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'managed',
    remote: false,
    ...overrides,
  }
}

function agentSession(sessionId: string, projectPath: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId,
    logFilePath: `/logs/${sessionId}.jsonl`,
    projectPath,
    agentType: 'claude',
    displayName: sessionId,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    isActive: false,
    ...overrides,
  }
}

const snapshot: WorkspaceSnapshot = {
  repositories: [
    {
      id: '/repo/.git',
      name: 'repo',
      commonDir: '/repo/.git',
      stale: false,
      worktrees: [
        {
          id: '/repo/.git::/repo',
          repositoryId: '/repo/.git',
          path: '/repo',
          branch: 'main',
          headRevision: 'aaaaaaa1',
          detached: false,
          isMain: true,
          dirty: false,
          openspec: { changes: [], stale: false },
        },
        {
          id: '/repo/.git::/repo-linked',
          repositoryId: '/repo/.git',
          path: '/repo-linked',
          branch: 'feat/x',
          headRevision: 'bbbbbbb2',
          detached: false,
          isMain: false,
          dirty: true,
          openspec: { changes: [], stale: false },
        },
        {
          id: '/repo/.git::/repo-nested',
          repositoryId: '/repo/.git',
          path: '/repo/nested-wt',
          headRevision: 'ccccccc3',
          detached: true,
          isMain: false,
          dirty: false,
          openspec: { changes: [], stale: false },
        },
      ],
      branches: [],
    },
  ],
  generatedAt: '2026-01-01T00:00:00.000Z',
}

describe('buildWorkspaceView grouping', () => {
  test('associates live, hibernating, and history sessions with the deepest worktree', () => {
    const view = buildWorkspaceView(
      snapshot,
      [
        liveSession('s1', '/repo/src'), // deepest match: /repo
        liveSession('s2', '/repo/nested-wt/sub'), // deepest match: /repo/nested-wt
      ],
      [agentSession('h1', '/repo-linked')], // hibernating in linked worktree
      [agentSession('y1', '/repo-linked/docs')] // history, nested path
    )

    const main = view.worktreeGroups.find((g) => g.worktreeId === '/repo/.git::/repo')
    const linked = view.worktreeGroups.find((g) => g.worktreeId === '/repo/.git::/repo-linked')
    const nested = view.worktreeGroups.find((g) => g.worktreeId === '/repo/.git::/repo-nested')

    expect(main?.entries.map((e) => e.key)).toEqual(['s1'])
    expect(linked?.entries.map((e) => e.kind)).toEqual(['hibernating', 'history'])
    expect(nested?.entries.map((e) => e.key)).toEqual(['s2'])
  })

  test('session moving across worktrees regroups on the next snapshot', () => {
    const first = buildWorkspaceView(snapshot, [liveSession('s1', '/repo/src')], [], [])
    expect(first.worktreeGroups.find((g) => g.worktreeId === '/repo/.git::/repo')?.entries).toHaveLength(1)

    const second = buildWorkspaceView(snapshot, [liveSession('s1', '/repo-linked/src')], [], [])
    expect(second.worktreeGroups.find((g) => g.worktreeId === '/repo/.git::/repo')?.entries).toHaveLength(0)
    expect(second.worktreeGroups.find((g) => g.worktreeId === '/repo/.git::/repo-linked')?.entries).toHaveLength(1)
  })

  test('local sessions outside Git fall into the ungrouped section', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('s1', '/repo'), liveSession('s2', '/plain/project')],
      [],
      []
    )
    expect(view.localUngrouped.entries.map((e) => e.key)).toEqual(['s2'])
    expect(view.worktreeGroups.find((g) => g.worktreeId === '/repo/.git::/repo')?.entries.map((e) => e.key)).toEqual(['s1'])
  })

  test('remote sessions never receive local Git metadata', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('r1', '/some/remote/path', { remote: true, host: 'build-box' })],
      [],
      []
    )
    expect(view.remote.entries).toHaveLength(1)
    expect(view.localUngrouped.entries).toHaveLength(0)
    for (const group of view.worktreeGroups) {
      expect(group.entries).toHaveLength(0)
    }
  })

  test('remote-host agent sessions fall into the remote section', () => {
    const view = buildWorkspaceView(
      snapshot,
      [],
      [agentSession('rh', '/home/user/repo', { host: 'build-box' })],
      []
    )
    expect(view.remote.entries).toHaveLength(1)
  })

  test('path boundaries are respected (/repo does not capture /repo-x)', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('s1', '/repo-x/src')],
      [],
      []
    )
    expect(view.localUngrouped.entries).toHaveLength(1)
  })

  test('null snapshot groups everything local-ungrouped plus remote', () => {
    const view = buildWorkspaceView(
      null,
      [liveSession('s1', '/anywhere'), liveSession('r1', '/remote/path', { remote: true })],
      [],
      []
    )
    expect(view.worktreeGroups).toHaveLength(0)
    expect(view.localUngrouped.entries).toHaveLength(1)
    expect(view.remote.entries).toHaveLength(1)
  })
})

describe('buildWorkspaceView attention counts', () => {
  test('counts permission-waiting live sessions per group', () => {
    const view = buildWorkspaceView(
      snapshot,
      [
        liveSession('s1', '/repo', { status: 'permission' }),
        liveSession('s2', '/repo'),
        liveSession('s3', '/repo-linked', { status: 'permission' }),
      ],
      [],
      []
    )
    const main = view.worktreeGroups.find((g) => g.worktreeId === '/repo/.git::/repo')
    const linked = view.worktreeGroups.find((g) => g.worktreeId === '/repo/.git::/repo-linked')
    expect(main?.attentionCount).toBe(1)
    expect(linked?.attentionCount).toBe(1)
  })

  test('collapsed groups still surface hidden permission counts', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('s1', '/repo', { status: 'permission' })],
      [],
      [],
      { collapsedWorktreeIds: ['/repo/.git::/repo'] }
    )
    const main = view.worktreeGroups.find((g) => g.worktreeId === '/repo/.git::/repo')
    expect(main?.collapsed).toBe(true)
    expect(main?.attentionCount).toBe(1) // rows exist but are hidden
    expect(view.visibleEntries.map((e) => e.key)).toEqual([])
  })

  test('filtered-out permission sessions count as hidden attention', () => {
    const view = buildWorkspaceView(
      snapshot,
      [
        liveSession('s1', '/repo', { status: 'permission' }),
        liveSession('s2', '/repo'),
      ],
      [],
      [],
      { filter: { projectFilters: ['/other'], hostFilters: [] } }
    )
    const main = view.worktreeGroups.find((g) => g.worktreeId === '/repo/.git::/repo')
    expect(main?.entries).toHaveLength(0)
    expect(main?.hiddenAttentionCount).toBe(1)
    // Repository context remains despite the empty filtered group.
    expect(view.worktreeGroups).toHaveLength(3)
  })
})

describe('buildWorkspaceView flattened navigation order', () => {
  test('visible entries follow group order then fallback sections', () => {
    const view = buildWorkspaceView(
      snapshot,
      [
        liveSession('s1', '/repo'),
        liveSession('s2', '/repo-linked'),
        liveSession('s3', '/plain'),
        liveSession('r1', '/remote', { remote: true }),
      ],
      [],
      []
    )
    expect(view.visibleEntries.map((e) => e.key)).toEqual(['s1', 's2', 's3', 'r1'])
  })

  test('collapsed groups drop their rows from the flattened order', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('s1', '/repo'), liveSession('s2', '/repo-linked'), liveSession('s3', '/plain')],
      [],
      [],
      { collapsedWorktreeIds: ['/repo/.git::/repo'] }
    )
    expect(view.visibleEntries.map((e) => e.key)).toEqual(['s2', 's3'])
  })

  test('host filter applies to live and agent rows alike', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('s1', '/repo', { host: 'box-a' })],
      [agentSession('h1', '/repo-linked', { host: 'box-b' })],
      [],
      { filter: { projectFilters: [], hostFilters: ['box-a'] } }
    )
    expect(view.worktreeGroups.find((g) => g.worktreeId === '/repo/.git::/repo')?.entries).toHaveLength(1)
    expect(view.worktreeGroups.find((g) => g.worktreeId === '/repo/.git::/repo-linked')?.entries).toHaveLength(0)
  })

  test('empty worktrees (no sessions) remain visible as groups', () => {
    const view = buildWorkspaceView(snapshot, [liveSession('s1', '/repo')], [], [])
    expect(view.worktreeGroups).toHaveLength(3)
    expect(view.worktreeGroups.find((g) => g.worktreeId === '/repo/.git::/repo-nested')?.entries).toHaveLength(0)
    expect(view.visibleEntries.map((e) => e.key)).toEqual(['s1'])
  })
})
