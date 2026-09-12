// sessionListGrouped.test.tsx - Task 6.2 coverage: SessionList renders live,
// hibernating, and historical rows inside worktree groups with explicit
// local-ungrouped and remote fallbacks — grouping, lifecycle actions, filters,
// empty groups, collapse, and dormant-row toggles.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { AgentSession, Session } from '@shared/types'
import type { WorkspaceSnapshot } from '@shared/workspace'
import SessionList from '../components/SessionList'
import { buildWorkspaceView } from '../utils/workspaceView'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

const originalSetTimeout = globalAny.setTimeout
const originalClearTimeout = globalAny.clearTimeout
const originalWindow = globalAny.window
const originalDocument = globalAny.document

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

function makeAgentSession(sessionId: string, projectPath: string, host?: string): AgentSession {
  return {
    sessionId,
    logFilePath: `/tmp/${sessionId}.jsonl`,
    projectPath,
    agentType: 'claude',
    displayName: sessionId,
    createdAt: '2024-01-01T00:00:00.000Z',
    lastActivityAt: '2024-01-01T00:00:00.000Z',
    isActive: false,
    ...(host !== undefined ? { host } : {}),
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
          id: '/repo/.git::/repo/main',
          repositoryId: '/repo/.git',
          path: '/repo/main',
          branch: 'main',
          headRevision: 'aaaaaaa1',
          detached: false,
          isMain: true,
          dirty: false,
          openspec: { changes: [], stale: false },
        },
        {
          id: '/repo/.git::/repo/feat',
          repositoryId: '/repo/.git',
          path: '/repo/feat',
          branch: 'feat',
          headRevision: 'bbbbbbb2',
          detached: false,
          isMain: false,
          dirty: true,
          openspec: { changes: [], stale: false },
        },
        // A worktree with no sessions at all still gets a group.
        {
          id: '/repo/.git::/repo/empty',
          repositoryId: '/repo/.git',
          path: '/repo/empty',
          branch: 'spare',
          headRevision: 'ccccccc3',
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
}

function makeView(
  sessions: Session[],
  hibernating: AgentSession[],
  history: AgentSession[],
  options: { projectFilters?: string[]; collapsed?: string[] } = {}
) {
  return buildWorkspaceView(snapshot, sessions, hibernating, history, {
    filter: {
      projectFilters: options.projectFilters ?? [],
      hostFilters: [],
    },
    collapsedWorktreeIds: options.collapsed ?? [],
  })
}

function renderList(overrides: Partial<Parameters<typeof SessionList>[0]> = {}) {
  const props: Parameters<typeof SessionList>[0] = {
    sessions: [baseSession],
    hibernatingSessions: [],
    historySessions: [],
    selectedSessionId: null,
    loading: false,
    error: null,
    onSelect: () => {},
    onRename: () => {},
    ...overrides,
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<SessionList {...props} />)
  })
  return { renderer, props }
}

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
  await new Promise((resolve) => originalSetTimeout?.(resolve, 64))
  globalAny.window = originalWindow
  globalAny.document = originalDocument
})

beforeEach(() => {
  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
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

afterEach(() => {
  globalAny.setTimeout = originalSetTimeout
  globalAny.clearTimeout = originalClearTimeout
  useSettingsStore.setState({
    projectFilters: [],
    hostFilters: [],
  })
  useSessionStore.setState({ exitingSessions: new Map() })
})

describe('SessionList grouped rendering', () => {
  test('renders live, hibernating, and history rows inside their worktree groups', () => {
    const sessions: Session[] = [
      baseSession,
      { ...baseSession, id: 'live-feat', projectPath: '/repo/feat/src' },
    ]
    const hibernating = [makeAgentSession('hib-feat', '/repo/feat')]
    const history = [makeAgentSession('hist-main', '/repo/main/docs')]
    const view = makeView(sessions, hibernating, history)

    const { renderer } = renderList({
      sessions,
      hibernatingSessions: hibernating,
      historySessions: history,
      workspaceView: view,
    })

    const groups = renderer.root.findAllByProps({ 'data-testid': 'worktree-group' })
    expect(groups.map((g) => g.props['data-worktree-id'])).toEqual([
      '/repo/.git::/repo/main',
      '/repo/.git::/repo/feat',
      '/repo/.git::/repo/empty',
    ])

    const mainGroup = groups[0]
    const mainCards = mainGroup.findAllByProps({ 'data-testid': 'session-card' })
    expect(mainCards.map((c) => c.props['data-session-id'])).toEqual(['live-main'])

    // History is collapsed by default (persisted setting) — the row stays hidden.
    expect(mainGroup.findAllByProps({ 'data-testid': 'grouped-history-rows' })).toHaveLength(0)

    const featGroup = groups[1]
    const featCards = featGroup.findAllByProps({ 'data-testid': 'session-card' })
    expect(featCards.map((c) => c.props['data-session-id'])).toEqual(['live-feat'])
    expect(featGroup.findAllByProps({ 'data-testid': 'hibernating-session-card' })).toHaveLength(1)

    // Empty worktree group renders its header without any rows.
    const emptyGroup = groups[2]
    expect(emptyGroup.findAllByProps({ 'data-testid': 'session-card' })).toHaveLength(0)
    expect(emptyGroup.findByProps({ 'data-testid': 'worktree-group-header' })).toBeTruthy()

    act(() => renderer.unmount())
  })

  test('renders explicit local-ungrouped and remote fallback sections', () => {
    const sessions: Session[] = [
      baseSession,
      { ...baseSession, id: 'live-plain', projectPath: '/plain/project' },
      {
        ...baseSession,
        id: 'live-remote',
        projectPath: '/remote/path',
        remote: true,
        host: 'box.example',
      },
    ]
    const view = makeView(sessions, [], [])

    const { renderer } = renderList({ sessions, workspaceView: view })

    const ungrouped = renderer.root.findByProps({ 'data-testid': 'local-ungrouped-section' })
    expect(ungrouped.findAllByProps({ 'data-testid': 'session-card' }).map((c) => c.props['data-session-id'])).toEqual(['live-plain'])

    const remote = renderer.root.findByProps({ 'data-testid': 'remote-section' })
    expect(remote.findAllByProps({ 'data-testid': 'session-card' }).map((c) => c.props['data-session-id'])).toEqual(['live-remote'])

    act(() => renderer.unmount())
  })

  test('filters hide rows but keep group headers and repository context', () => {
    const sessions: Session[] = [baseSession, { ...baseSession, id: 'live-feat', projectPath: '/repo/feat' }]
    // Only the feat worktree's project path passes the filter.
    const view = makeView(sessions, [], [], { projectFilters: ['/repo/feat'] })

    const { renderer } = renderList({
      sessions,
      workspaceView: view,
    })

    const groups = renderer.root.findAllByProps({ 'data-testid': 'worktree-group' })
    // All three headers still render with repository context.
    expect(groups).toHaveLength(3)

    const visibleCards = renderer.root
      .findAllByProps({ 'data-testid': 'session-card' })
      .map((c) => c.props['data-session-id'])
    expect(visibleCards).toEqual(['live-feat'])

    act(() => renderer.unmount())
  })

  test('collapse hides rows and reports the worktree id', () => {
    const collapsed = ['/repo/.git::/repo/main']
    const view = makeView([baseSession], [], [], { collapsed })

    const toggled: string[] = []
    const { renderer } = renderList({
      sessions: [baseSession],
      workspaceView: view,
      onToggleWorktreeCollapse: (id) => toggled.push(id),
    })

    const mainGroup = renderer.root.findAllByProps({ 'data-testid': 'worktree-group' })[0]
    expect(mainGroup.props['data-collapsed']).toBe('true')
    expect(mainGroup.findAllByProps({ 'data-testid': 'session-card' })).toHaveLength(0)

    const header = mainGroup.findByProps({ 'data-testid': 'worktree-group-header' })
    const collapseButton = header.findByProps({ 'aria-expanded': false })
    act(() => {
      collapseButton.props.onClick()
    })
    expect(toggled).toEqual(['/repo/.git::/repo/main'])

    act(() => renderer.unmount())
  })

  test('dormant toggles expose hibernating and history rows inside groups', () => {
    const hibernating = [makeAgentSession('hib-feat', '/repo/feat')]
    const history = [makeAgentSession('hist-main', '/repo/main')]
    const view = makeView([baseSession], hibernating, history)

    const { renderer } = renderList({
      sessions: [baseSession],
      hibernatingSessions: hibernating,
      historySessions: history,
      workspaceView: view,
    })

    // History rows hidden while the toggle is collapsed.
    expect(renderer.root.findAllByProps({ 'data-testid': 'grouped-history-rows' })).toHaveLength(0)

    act(() => {
      renderer.root.findByProps({ 'data-testid': 'workspace-history-toggle' }).props.onClick()
    })
    expect(
      useSettingsStore.getState().historySessionsExpanded
    ).toBe(true)

    act(() => {
      renderer.root.findByProps({ 'data-testid': 'workspace-hibernating-toggle' }).props.onClick()
    })
    expect(
      useSettingsStore.getState().hibernatingSessionsExpanded
    ).toBe(false)

    act(() => renderer.unmount())
  })

  test('lifecycle actions fire from rows inside groups', () => {
    const hibernating = [makeAgentSession('hib-feat', '/repo/feat')]
    const view = makeView([baseSession, { ...baseSession, id: 'live-feat', projectPath: '/repo/feat' }], hibernating, [])

    const kills: string[] = []
    const hibernates: string[] = []
    const selects: string[] = []
    const resumes: string[] = []
    const moves: string[] = []
    const { renderer } = renderList({
      sessions: [baseSession, { ...baseSession, id: 'live-feat', projectPath: '/repo/feat' }],
      hibernatingSessions: hibernating,
      workspaceView: view,
      onSelect: (id) => selects.push(id),
      onKill: (id) => kills.push(id),
      onHibernate: (agentSessionId) => hibernates.push(agentSessionId),
      onResume: (id) => resumes.push(id),
      onMoveToHistory: (id) => moves.push(id),
    })

    const featGroup = renderer.root.findAllByProps({ 'data-testid': 'worktree-group' })[1]
    const liveCard = featGroup.findByProps({ 'data-testid': 'session-card' })
    act(() => {
      liveCard.props.onClick()
    })
    expect(selects).toEqual(['live-feat'])

    // Long-press opens the context menu; kill fires with the row's session id.
    globalAny.setTimeout = ((callback: () => void, delay?: number) => {
      if (delay === 500) callback()
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalAny.clearTimeout = (() => {}) as typeof clearTimeout
    act(() => {
      liveCard.props.onTouchStart({ touches: [{ clientX: 1, clientY: 2 }] })
    })
    const menu = renderer.root.findByProps({ role: 'menu' })
    const killButton = menu.findAllByProps({ role: 'menuitem' }).find((button) =>
      Array.isArray(button.props.children)
        ? button.props.children.includes('Kill Session')
        : false
    )
    if (!killButton) throw new Error('Expected kill menu item')
    act(() => {
      killButton.props.onClick({ stopPropagation: () => {} })
    })
    expect(kills).toEqual(['live-feat'])

    // Hibernating wake from the group's dormant rows (context-menu action).
    const hibernatingCard = featGroup.findByProps({ 'data-testid': 'hibernating-session-card' })
    act(() => {
      hibernatingCard.props.onClick()
    })
    act(() => {
      hibernatingCard.props.onContextMenu({
        preventDefault: () => {},
        stopPropagation: () => {},
        clientX: 10,
        clientY: 20,
      })
    })
    const wakeItem = renderer.root
      .findAllByProps({ role: 'menuitem' })
      .find((button) => Array.isArray(button.props.children) && button.props.children.includes('Wake'))
    if (!wakeItem) throw new Error('Expected wake menu item')
    act(() => {
      wakeItem.props.onClick({ stopPropagation: () => {} })
    })
    expect(resumes).toEqual(['hib-feat'])

    act(() => renderer.unmount())
  })

  test('history pagination caps rows per group and Show more extends the limit', () => {
    const history = Array.from({ length: 25 }, (_, i) =>
      makeAgentSession(`hist-${i}`, '/repo/main')
    )
    const view = makeView([baseSession], [], history)

    useSettingsStore.setState({ historySessionsExpanded: true })
    const { renderer } = renderList({
      sessions: [baseSession],
      historySessions: history,
      workspaceView: view,
    })

    const historyRows = renderer.root.findAllByProps({ 'data-testid': 'grouped-history-rows' })
    expect(historyRows).toHaveLength(1)
    const rendered = historyRows[0].findAllByType('button')
    const showMore = rendered.find((button) =>
      Array.isArray(button.props.children) && button.props.children.join('').includes('Show more')
    )
    if (!showMore) throw new Error('Expected Show more button')
    expect((showMore.props.children as (string | number)[]).join('')).toBe('Show more (5 remaining)')

    act(() => {
      showMore.props.onClick()
    })

    const historyRowsAfter = renderer.root.findAllByProps({ 'data-testid': 'grouped-history-rows' })
    expect(
      historyRowsAfter[0].findAllByType('button').filter(
        (button) => !Array.isArray(button.props.children) || !button.props.children.join('').includes('Show more')
      ).length
    ).toBe(25)

    act(() => renderer.unmount())
  })

  test('worktree header new-session action reports the exact worktree root', () => {
    const sessions: Session[] = [
      baseSession,
      { ...baseSession, id: 'live-plain', projectPath: '/plain/project' },
      {
        ...baseSession,
        id: 'live-remote',
        projectPath: '/remote/path',
        remote: true,
        host: 'box.example',
      },
    ]
    const view = makeView(sessions, [], [])
    const requestedPaths: string[] = []

    const { renderer } = renderList({
      sessions,
      workspaceView: view,
      onNewSessionInWorktree: (worktreePath) => requestedPaths.push(worktreePath),
    })

    // One action per worktree group (including empty worktrees), firing with
    // the group's exact root path.
    const buttons = renderer.root.findAllByProps({ 'data-testid': 'worktree-new-session' })
    expect(buttons).toHaveLength(3)
    act(() => {
      buttons.forEach((button) => button.props.onClick())
    })
    expect(requestedPaths).toEqual(['/repo/main', '/repo/feat', '/repo/empty'])

    // The accessible label names the repository and the exact path.
    expect(buttons[0].props['aria-label']).toBe('New session in repo worktree /repo/main')

    // Fallback sections never receive the contextual action.
    const ungrouped = renderer.root.findByProps({ 'data-testid': 'local-ungrouped-section' })
    expect(ungrouped.findAllByProps({ 'data-testid': 'worktree-new-session' })).toHaveLength(0)
    const remote = renderer.root.findByProps({ 'data-testid': 'remote-section' })
    expect(remote.findAllByProps({ 'data-testid': 'worktree-new-session' })).toHaveLength(0)

    // Without the callback prop, no action buttons render at all.
    const { renderer: plain } = renderList({ sessions: [baseSession], workspaceView: view })
    expect(plain.root.findAllByProps({ 'data-testid': 'worktree-new-session' })).toHaveLength(0)

    act(() => renderer.unmount())
    act(() => plain.unmount())
  })

  test('collapsed worktree keeps its header new-session action', () => {
    const collapsed = ['/repo/.git::/repo/main']
    const view = makeView([baseSession], [], [], { collapsed })
    const requestedPaths: string[] = []

    const { renderer } = renderList({
      sessions: [baseSession],
      workspaceView: view,
      onNewSessionInWorktree: (worktreePath) => requestedPaths.push(worktreePath),
    })

    const mainGroup = renderer.root.findAllByProps({ 'data-testid': 'worktree-group' })[0]
    expect(mainGroup.props['data-collapsed']).toBe('true')
    const button = mainGroup.findByProps({ 'data-testid': 'worktree-new-session' })
    act(() => {
      button.props.onClick()
    })
    expect(requestedPaths).toEqual(['/repo/main'])

    act(() => renderer.unmount())
  })

  test('worktree header branch-browser action reports the repository id', () => {
    const view = makeView([baseSession], [], [])
    const browsedRepositoryIds: string[] = []

    const { renderer } = renderList({
      sessions: [baseSession],
      workspaceView: view,
      onBrowseBranches: (repositoryId) => browsedRepositoryIds.push(repositoryId),
    })

    const buttons = renderer.root.findAllByProps({ 'data-testid': 'worktree-branch-browser' })
    expect(buttons).toHaveLength(3)
    act(() => {
      buttons[0].props.onClick()
    })
    expect(browsedRepositoryIds).toEqual(['/repo/.git'])
    expect(buttons[0].props['aria-label']).toBe('Browse branches in repo')

    // Without the callback prop, no browse buttons render.
    const { renderer: plain } = renderList({ sessions: [baseSession], workspaceView: view })
    expect(plain.root.findAllByProps({ 'data-testid': 'worktree-branch-browser' })).toHaveLength(0)

    act(() => renderer.unmount())
    act(() => plain.unmount())
  })

  test('falls back to the flat list when no workspace snapshot exists', () => {
    const { renderer } = renderList({ sessions: [baseSession], workspaceView: null })

    expect(renderer.root.findAllByProps({ 'data-testid': 'worktree-group' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ 'data-testid': 'session-card' })).toHaveLength(1)

    act(() => renderer.unmount())
  })
})

describe('SessionList grouped drag constraints', () => {
  const liveA1: Session = { ...baseSession, id: 'live-a1', projectPath: '/repo/main' }
  const liveA2: Session = { ...baseSession, id: 'live-a2', projectPath: '/repo/main/src' }
  const liveB1: Session = { ...baseSession, id: 'live-b1', projectPath: '/repo/feat' }

  function resetManualOrder() {
    useSettingsStore.setState({
      manualSessionOrder: [],
      sessionSortMode: 'created',
      sessionSortDirection: 'asc',
      projectFilters: [],
      hostFilters: [],
    })
  }

  function groupDragContext(renderer: TestRenderer.ReactTestRenderer, worktreeId: string) {
    const group = renderer.root
      .findAllByProps({ 'data-testid': 'worktree-group' })
      .find((section) => section.props['data-worktree-id'] === worktreeId)
    if (!group) throw new Error(`Expected group ${worktreeId}`)
    const contexts = group.findAll(
      (instance) =>
        typeof instance.props?.onDragEnd === 'function' &&
        typeof instance.props?.onDragCancel === 'function'
    )
    if (contexts.length !== 1) throw new Error(`Expected one drag context in ${worktreeId}`)
    return contexts[0]
  }

  test('within-group drop reorders only that group in the manual order', () => {
    resetManualOrder()
    const sessions = [liveA1, liveA2, liveB1]
    const view = makeView(sessions, [], [])
    const { renderer } = renderList({ sessions, workspaceView: view })

    // The main group's context owns live-a1/live-a2; drag a2 above a1.
    const mainContext = groupDragContext(renderer, '/repo/.git::/repo/main')
    act(() => {
      mainContext.props.onDragEnd({ active: { id: 'live-a2' }, over: { id: 'live-a1' } })
    })

    const { manualSessionOrder, sessionSortMode } = useSettingsStore.getState()
    expect(sessionSortMode).toBe('manual')
    // Group keys reordered within the group; the other group's key keeps its
    // relative position in the global spine.
    expect(manualSessionOrder).toEqual(['live-a2', 'live-a1', 'live-b1'])

    act(() => renderer.unmount())
  })

  test('cross-group drop is rejected without touching the manual order', () => {
    resetManualOrder()
    const sessions = [liveA1, liveA2, liveB1]
    const view = makeView(sessions, [], [])
    const { renderer } = renderList({ sessions, workspaceView: view })

    const contexts = renderer.root.findAll(
      (instance) =>
        typeof instance.props?.onDragEnd === 'function' &&
        typeof instance.props?.onDragCancel === 'function'
    )
    expect(contexts).toHaveLength(2)

    // The main group's drag context resolves over-ids against its own rows
    // only: a feat-group session id is unknown there, so nothing applies.
    const mainContext = groupDragContext(renderer, '/repo/.git::/repo/main')
    act(() => {
      mainContext.props.onDragEnd({ active: { id: 'live-a1' }, over: { id: 'live-b1' } })
    })

    const { manualSessionOrder, sessionSortMode } = useSettingsStore.getState()
    expect(manualSessionOrder).toEqual([])
    expect(sessionSortMode).not.toBe('manual')

    act(() => renderer.unmount())
  })

  test('cross-group keyboard navigation follows the flattened visible order', () => {
    // Mirrors the App-level guarantee at the component boundary: visible
    // entries flatten expanded groups in render order, so selection can walk
    // from one group into the next and skips collapsed groups.
    const sessions = [
      liveA1,
      { ...baseSession, id: 'live-a2', projectPath: '/repo/main/src' },
      liveB1,
    ]
    const collapsedFeat = makeView(sessions, [], [], { collapsed: ['/repo/.git::/repo/feat'] })
    expect(
      collapsedFeat.visibleEntries.map((entry) => entry.key)
    ).toEqual(['live-a1', 'live-a2'])

    const expanded = makeView(sessions, [], [])
    expect(expanded.visibleEntries.map((entry) => entry.key)).toEqual([
      'live-a1',
      'live-a2',
      'live-b1',
    ])
  })
})
