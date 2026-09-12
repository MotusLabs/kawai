// WorktreeOpenSpecRows.test.tsx - Task 6.4 coverage: compact OpenSpec change
// rows and progress inside a worktree — progress display, missing optional
// values, no-root worktrees, collapsed-count behavior, and isolated
// stale/error presentation.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { AgentSession, Session } from '@shared/types'
import type { WorkspaceSnapshot } from '@shared/workspace'
import WorktreeOpenSpecRows from '../components/WorktreeOpenSpecRows'
import SessionList from '../components/SessionList'
import { buildWorkspaceView } from '../utils/workspaceView'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
}

const originalWindow = globalAny.window
const originalDocument = globalAny.document

beforeAll(() => {
  globalAny.window = {
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  } as unknown as Window & typeof globalThis
  globalAny.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Document
})

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 64))
  globalAny.window = originalWindow
  globalAny.document = originalDocument
})

function renderRows(openspec: WorktreeSnapshotOpenspec) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<WorktreeOpenSpecRows openspec={openspec} />)
  })
  return renderer
}

type WorktreeSnapshotOpenspec = Parameters<typeof WorktreeOpenSpecRows>[0]['openspec']

describe('WorktreeOpenSpecRows', () => {
  test('shows change name, status, compact progress, and last-modified', () => {
    const renderer = renderRows({
      rootPath: '/repo/main/openspec',
      changes: [
        {
          name: 'add-auth',
          status: 'in-progress',
          completedTasks: 9,
          totalTasks: 11,
          lastModified: '2026-09-01T00:00:00.000Z',
        },
      ],
      stale: false,
    })

    const row = renderer.root.findByProps({ 'data-testid': 'worktree-openspec-change' })
    expect(row.props['data-change-name']).toBe('add-auth')
    expect(row.props['aria-label']).toBe(
      'OpenSpec change add-auth, in-progress, 9 of 11 tasks complete'
    )

    const progress = renderer.root.findByProps({ 'data-testid': 'worktree-openspec-progress' })
    expect(progress.props.children).toEqual([9, '/', 11])
    expect(progress.props['aria-label']).toBe('9 of 11 tasks complete')

    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain('in-progress')

    act(() => renderer.unmount())
  })

  test('omits progress when task counts are unavailable instead of inventing them', () => {
    const renderer = renderRows({
      changes: [{ name: 'fix-nav', status: 'planned' }],
      stale: false,
    })

    const row = renderer.root.findByProps({ 'data-testid': 'worktree-openspec-change' })
    expect(row.props['aria-label']).toBe('OpenSpec change fix-nav, planned')
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'worktree-openspec-progress' })
    ).toHaveLength(0)

    act(() => renderer.unmount())
  })

  test('renders nothing for a worktree without an OpenSpec root', () => {
    const renderer = renderRows({ changes: [], stale: false })
    expect(renderer.toJSON()).toBeNull()
    act(() => renderer.unmount())
  })

  test('discovery failure keeps last-valid changes visible with an isolated error', () => {
    const renderer = renderRows({
      changes: [{ name: 'add-auth', completedTasks: 9, totalTasks: 11 }],
      stale: true,
      error: 'openspec exited with code 1',
    })

    const staleBadge = renderer.root.findByProps({ 'data-testid': 'worktree-openspec-stale' })
    expect(staleBadge.props.title).toBe('openspec exited with code 1')
    expect(staleBadge.props['aria-label']).toBe(
      'OpenSpec unavailable: openspec exited with code 1'
    )

    // Last-valid data stays visible.
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'worktree-openspec-change' })
    ).toHaveLength(1)

    act(() => renderer.unmount())
  })

  test('stale without an error uses a generic message', () => {
    const renderer = renderRows({
      changes: [],
      stale: true,
    })
    const staleBadge = renderer.root.findByProps({ 'data-testid': 'worktree-openspec-stale' })
    expect(staleBadge.props.title).toBe('OpenSpec discovery failed; showing last known changes')
    act(() => renderer.unmount())
  })
})

describe('OpenSpec rows within the grouped navigator', () => {
  const baseSession: Session = {
    id: 'live-main',
    name: 'live-main',
    tmuxWindow: 'agentboard:1',
    projectPath: '/repo/main',
    status: 'working',
    lastActivity: '2024-01-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    source: 'managed',
  }

  const snapshot = (collapsedId: string | undefined, openspec: WorktreeSnapshotOpenspec): WorkspaceSnapshot => ({
    repositories: [
      {
        id: '/repo/.git',
        name: 'repo',
        commonDir: '/repo/.git',
        stale: false,
        worktrees: [
          {
            id: '/repo/.git::/repo/main',
            repositoryId: '/repo/.git',
            path: '/repo/main',
            branch: 'main',
            headRevision: 'aaaaaaa1',
            detached: false,
            isMain: true,
            dirty: false,
            openspec,
          },
          // A sibling worktree with its own, different OpenSpec state: data
          // must not bleed across worktrees.
          {
            id: '/repo/.git::/repo/feat',
            repositoryId: '/repo/.git',
            path: '/repo/feat',
            branch: 'feat',
            headRevision: 'bbbbbbb2',
            detached: false,
            isMain: false,
            dirty: false,
            openspec: { changes: [], stale: false },
          },
        ],
        branches: [],
      },
    ],
    generatedAt: '2024-01-01T00:00:00.000Z',
  })

  beforeEach(() => {
    useSettingsStore.setState({
      sessionSortMode: 'created',
      sessionSortDirection: 'asc',
      showProjectName: true,
      showLastUserMessage: true,
      showSessionIdPrefix: false,
      projectFilters: [],
      hostFilters: [],
      hibernatingSessionsExpanded: true,
      historySessionsExpanded: false,
    })
    useSessionStore.setState({ exitingSessions: new Map() })
  })

  function renderNavigator(collapsedId: string | undefined, openspec: WorktreeSnapshotOpenspec) {
    const view = buildWorkspaceView(
      snapshot(collapsedId, openspec),
      [baseSession],
      [] as AgentSession[],
      [] as AgentSession[],
      { collapsedWorktreeIds: collapsedId ? [collapsedId] : [] }
    )
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <SessionList
          sessions={[baseSession]}
          selectedSessionId={null}
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
          workspaceView={view}
        />
      )
    })
    return renderer
  }

  test('renders OpenSpec rows inside the owning worktree only', () => {
    const renderer = renderNavigator(undefined, {
      changes: [{ name: 'add-auth', completedTasks: 9, totalTasks: 11 }],
      stale: false,
    })

    const rows = renderer.root.findAllByProps({ 'data-testid': 'worktree-openspec-rows' })
    expect(rows).toHaveLength(1)
    expect(rows[0].props['data-testid']).toBe('worktree-openspec-rows')

    const groups = renderer.root.findAllByProps({ 'data-testid': 'worktree-group' })
    const mainGroup = groups.find((g) => g.props['data-worktree-id'] === '/repo/.git::/repo/main')
    const featGroup = groups.find((g) => g.props['data-worktree-id'] === '/repo/.git::/repo/feat')
    if (!mainGroup || !featGroup) throw new Error('Expected both worktree groups')
    expect(mainGroup.findAllByProps({ 'data-testid': 'worktree-openspec-change' })).toHaveLength(1)
    expect(featGroup.findAllByProps({ 'data-testid': 'worktree-openspec-change' })).toHaveLength(0)

    act(() => renderer.unmount())
  })

  test('collapsed group hides rows while the header counts active changes', () => {
    const renderer = renderNavigator('/repo/.git::/repo/main', {
      changes: [
        { name: 'add-auth', completedTasks: 9, totalTasks: 11 },
        { name: 'fix-nav' },
      ],
      stale: false,
    })

    const mainGroup = renderer.root
      .findAllByProps({ 'data-testid': 'worktree-group' })
      .find((g) => g.props['data-worktree-id'] === '/repo/.git::/repo/main')
    if (!mainGroup) throw new Error('Expected main worktree group')
    expect(mainGroup.findAllByProps({ 'data-testid': 'worktree-openspec-change' })).toHaveLength(0)

    const header = mainGroup.findByProps({ 'data-testid': 'worktree-group-header' })
    expect(header.props['data-openspec-count']).toBe(2)
    const countBadge = header.findByProps({ 'data-testid': 'worktree-openspec-count' })
    expect(countBadge.props['aria-label']).toBe('2 active OpenSpec changes')

    act(() => renderer.unmount())
  })
})
