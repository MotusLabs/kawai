// workspaceView.test.ts - Task 5.2 coverage: pure selectors associating
// active, hibernating, and historical sessions with the deepest worktree and
// producing change sections (with and without worktrees), unmatched-worktree
// sections including the main worktree, Workspace/remote fallbacks,
// attention counts, and the flattened visible navigation order.
import { describe, expect, test } from 'bun:test'
import type { AgentSession, Session } from '@shared/types'
import {
  changeSectionKey,
  FALLBACK_REMOTE_SECTION_KEY,
  FALLBACK_WORKSPACE_SECTION_KEY,
  type WorkspaceSnapshot,
} from '@shared/workspace'
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

const ADD_AUTH_WT = '/repo/.worktrees/add-auth'
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
          id: `/repo/.git::${ADD_AUTH_WT}`,
          repositoryId: '/repo/.git',
          path: ADD_AUTH_WT,
          branch: 'add-auth',
          headRevision: 'ddddddd4',
          detached: false,
          isMain: false,
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
      changeRegistry: [
        {
          name: 'add-auth',
          status: 'in-progress',
          completedTasks: 9,
          totalTasks: 11,
          source: 'worktree',
          worktreeId: `/repo/.git::${ADD_AUTH_WT}`,
          worktreePath: ADD_AUTH_WT,
        },
        { name: 'add-dark-mode', source: 'registry' },
      ],
    },
  ],
  generatedAt: '2026-01-01T00:00:00.000Z',
}

const changeKey = (name: string) => changeSectionKey('/repo/.git', name)
const MAIN_KEY = '/repo/.git::/repo'

function findSection(view: ReturnType<typeof buildWorkspaceView>, key: string) {
  return view.sections.find((section) => section.key === key)
}

describe('buildWorkspaceView sectioning', () => {
  test('change sections come first, unmatched worktrees (incl. main) after', () => {
    const view = buildWorkspaceView(snapshot, [], [], [])
    expect(view.sections.map((section) => section.key)).toEqual([
      changeKey('add-auth'),
      changeKey('add-dark-mode'),
      MAIN_KEY,
      '/repo/.git::/repo-linked',
      '/repo/.git::/repo-nested',
    ])
  })

  test('associates live, hibernating, and history sessions with the deepest worktree', () => {
    const view = buildWorkspaceView(
      snapshot,
      [
        liveSession('s1', '/repo/src'), // deepest match: /repo (main)
        liveSession('s2', `${ADD_AUTH_WT}/src`), // deepest match: change worktree
        liveSession('s3', '/repo/nested-wt/sub'), // deepest match: /repo/nested-wt
      ],
      [agentSession('h1', '/repo-linked')], // hibernating in linked worktree
      [agentSession('y1', '/repo-linked/docs')] // history, nested path
    )

    expect(findSection(view, MAIN_KEY)?.entries.map((e) => e.key)).toEqual(['s1'])
    expect(findSection(view, changeKey('add-auth'))?.entries.map((e) => e.key)).toEqual(['s2'])
    expect(findSection(view, '/repo/.git::/repo-nested')?.entries.map((e) => e.key)).toEqual(['s3'])
    expect(findSection(view, '/repo/.git::/repo-linked')?.entries.map((e) => e.kind)).toEqual([
      'hibernating',
      'history',
    ])
  })

  test('a change section without a worktree exists with no sessions', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('s1', `${ADD_AUTH_WT}/src`)],
      [],
      []
    )
    const dark = findSection(view, changeKey('add-dark-mode'))
    expect(dark?.kind).toBe('change')
    expect(dark?.entries).toHaveLength(0)
    expect(view.visibleEntries.map((e) => e.key)).toEqual(['s1'])
  })

  test('session moving across worktrees regroups on the next snapshot', () => {
    const first = buildWorkspaceView(snapshot, [liveSession('s1', '/repo/src')], [], [])
    expect(findSection(first, MAIN_KEY)?.entries).toHaveLength(1)

    const second = buildWorkspaceView(snapshot, [liveSession('s1', `${ADD_AUTH_WT}/src`)], [], [])
    expect(findSection(second, MAIN_KEY)?.entries).toHaveLength(0)
    expect(findSection(second, changeKey('add-auth'))?.entries).toHaveLength(1)
  })

  test('an inconsistent registry anchor degrades to a registry-only section', () => {
    const inconsistent: WorkspaceSnapshot = {
      ...snapshot,
      repositories: [
        {
          ...snapshot.repositories[0],
          changeRegistry: [
            { name: 'add-auth', source: 'worktree', worktreeId: '/repo/.git::/missing' },
          ],
        },
      ],
    }
    const view = buildWorkspaceView(inconsistent, [liveSession('s1', `${ADD_AUTH_WT}/src`)], [], [])
    const section = findSection(view, changeKey('add-auth'))
    expect(section?.kind).toBe('change')
    if (section?.kind === 'change') {
      expect(section.change.worktreeId).toBeUndefined()
      expect(section.change.missingInWorktree).toBeUndefined()
    }
    // The real worktree is unmatched, so the session lands under it.
    expect(findSection(view, `/repo/.git::${ADD_AUTH_WT}`)?.entries.map((e) => e.key)).toEqual(['s1'])
  })

  test('a snapshot without a registry keeps plain worktree sections', () => {
    const legacy: WorkspaceSnapshot = {
      ...snapshot,
      repositories: [{ ...snapshot.repositories[0], changeRegistry: undefined }],
    }
    const view = buildWorkspaceView(legacy, [liveSession('s1', '/repo/src')], [], [])
    expect(view.sections.map((section) => section.kind)).toEqual([
      'worktree',
      'worktree',
      'worktree',
      'worktree',
    ])
  })

  test('local sessions outside Git fall into the Workspace section', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('s1', '/repo'), liveSession('s2', '/plain/project')],
      [],
      []
    )
    expect(view.workspace.kind).toBe('workspace')
    expect(view.workspace.entries.map((e) => e.key)).toEqual(['s2'])
    expect(findSection(view, MAIN_KEY)?.entries.map((e) => e.key)).toEqual(['s1'])
  })

  test('remote sessions never receive local Git metadata', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('r1', '/some/remote/path', { remote: true, host: 'build-box' })],
      [],
      []
    )
    expect(view.remote.entries).toHaveLength(1)
    expect(view.workspace.entries).toHaveLength(0)
    for (const section of view.sections) {
      expect(section.entries).toHaveLength(0)
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
    const view = buildWorkspaceView(snapshot, [liveSession('s1', '/repo-x/src')], [], [])
    expect(view.workspace.entries).toHaveLength(1)
  })

  test('null snapshot groups everything into Workspace plus remote', () => {
    const view = buildWorkspaceView(
      null,
      [liveSession('s1', '/anywhere'), liveSession('r1', '/remote/path', { remote: true })],
      [],
      []
    )
    expect(view.sections).toHaveLength(0)
    expect(view.workspace.entries).toHaveLength(1)
    expect(view.remote.entries).toHaveLength(1)
  })
})

describe('buildWorkspaceView attention counts', () => {
  test('counts permission-waiting live sessions per section', () => {
    const view = buildWorkspaceView(
      snapshot,
      [
        liveSession('s1', '/repo', { status: 'permission' }),
        liveSession('s2', '/repo'),
        liveSession('s3', `${ADD_AUTH_WT}/src`, { status: 'permission' }),
      ],
      [],
      []
    )
    expect(findSection(view, MAIN_KEY)?.attentionCount).toBe(1)
    expect(findSection(view, changeKey('add-auth'))?.attentionCount).toBe(1)
  })

  test('collapsed sections still surface hidden permission counts', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('s1', '/repo', { status: 'permission' })],
      [],
      [],
      { collapsedSectionIds: [MAIN_KEY] }
    )
    const main = findSection(view, MAIN_KEY)
    expect(main?.collapsed).toBe(true)
    expect(main?.attentionCount).toBe(1) // rows exist but are hidden
    expect(view.visibleEntries.map((e) => e.key)).toEqual([])
  })

  test('change sections collapse by their stable key', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('s1', `${ADD_AUTH_WT}/src`, { status: 'permission' })],
      [],
      [],
      { collapsedSectionIds: [changeKey('add-auth')] }
    )
    const section = findSection(view, changeKey('add-auth'))
    expect(section?.collapsed).toBe(true)
    expect(section?.attentionCount).toBe(1)
    expect(view.visibleEntries).toHaveLength(0)
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
    const main = findSection(view, MAIN_KEY)
    expect(main?.entries).toHaveLength(0)
    expect(main?.hiddenAttentionCount).toBe(1)
    // Repository and change context remains despite the empty filtered rows.
    expect(view.sections).toHaveLength(5)
  })
})

describe('buildWorkspaceView fallback section collapse', () => {
  test('fallback sections carry their reserved keys and collapse state', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('s1', '/plain'), liveSession('r1', '/remote/path', { remote: true })],
      [],
      [],
      { collapsedSectionIds: [FALLBACK_REMOTE_SECTION_KEY] }
    )
    expect(view.workspace.key).toBe(FALLBACK_WORKSPACE_SECTION_KEY)
    expect(view.workspace.collapsed).toBe(false)
    expect(view.remote.key).toBe(FALLBACK_REMOTE_SECTION_KEY)
    expect(view.remote.collapsed).toBe(true)
  })

  test('a collapsed Remote section hides its rows and reports hidden attention', () => {
    const view = buildWorkspaceView(
      snapshot,
      [
        liveSession('r1', '/remote/one', { remote: true, status: 'permission' }),
        liveSession('r2', '/remote/two', { remote: true }),
        liveSession('s1', '/repo'),
      ],
      [],
      [],
      { collapsedSectionIds: [FALLBACK_REMOTE_SECTION_KEY] }
    )
    // Rows stay counted on the section (header count), but the permission
    // waiting inside the collapsed pane is reported as hidden attention.
    expect(view.remote.entries.map((e) => e.key)).toEqual(['r1', 'r2'])
    expect(view.remote.attentionCount).toBe(0)
    expect(view.remote.hiddenAttentionCount).toBe(1)
    // Keyboard navigation order skips the collapsed pane's rows.
    expect(view.visibleEntries.map((e) => e.key)).toEqual(['s1'])
  })

  test('a collapsed Workspace section drops its rows from the navigation order', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('s1', '/repo'), liveSession('w1', '/plain')],
      [],
      [],
      { collapsedSectionIds: [FALLBACK_WORKSPACE_SECTION_KEY] }
    )
    expect(view.workspace.entries.map((e) => e.key)).toEqual(['w1'])
    expect(view.visibleEntries.map((e) => e.key)).toEqual(['s1'])
  })

  test('expanded fallback sections keep attention in the visible count', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('r1', '/remote/one', { remote: true, status: 'permission' })],
      [],
      []
    )
    expect(view.remote.attentionCount).toBe(1)
    expect(view.remote.hiddenAttentionCount).toBe(0)
    expect(view.visibleEntries.map((e) => e.key)).toEqual(['r1'])
  })
})

describe('buildWorkspaceView flattened navigation order', () => {
  test('visible entries follow section order then fallback sections', () => {
    const view = buildWorkspaceView(
      snapshot,
      [
        liveSession('s1', '/repo'),
        liveSession('s2', `${ADD_AUTH_WT}/src`),
        liveSession('s3', '/repo-linked'),
        liveSession('s4', '/plain'),
        liveSession('r1', '/remote', { remote: true }),
      ],
      [],
      []
    )
    expect(view.visibleEntries.map((e) => e.key)).toEqual(['s2', 's1', 's3', 's4', 'r1'])
  })

  test('collapsed sections drop their rows from the flattened order', () => {
    const view = buildWorkspaceView(
      snapshot,
      [liveSession('s1', '/repo'), liveSession('s2', '/repo-linked'), liveSession('s3', '/plain')],
      [],
      [],
      { collapsedSectionIds: [MAIN_KEY] }
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
    expect(findSection(view, MAIN_KEY)?.entries).toHaveLength(1)
    expect(findSection(view, '/repo/.git::/repo-linked')?.entries).toHaveLength(0)
  })

  test('empty worktrees (no sessions) remain visible as sections', () => {
    const view = buildWorkspaceView(snapshot, [liveSession('s1', '/repo')], [], [])
    expect(view.sections).toHaveLength(5)
    expect(findSection(view, '/repo/.git::/repo-nested')?.entries).toHaveLength(0)
    expect(view.visibleEntries.map((e) => e.key)).toEqual(['s1'])
  })
})
