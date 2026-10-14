// sessionRowExit.test.tsx - the killed-row unmount contract. A removed session
// row must leave the DOM as soon as it leaves the live list: no AnimatePresence
// held-exit, no merge back from `exitingSessions`, no cleanup timer. Anything
// that keeps the node mounted is a ghost card — `toHaveCount(0)` after Kill
// still sees it.
//
// These drive the SHIPPED list components (SessionList's flat map and the
// WorkspaceSectionList grouped path), not a hand-rolled map: a re-introduced
// AnimatePresence held-exit or exitingSessions merge has to fail here.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session } from '@shared/types'
import type { WorkspaceSnapshot } from '@shared/workspace'
import SessionList from '../components/SessionList'
import { buildWorkspaceView } from '../utils/workspaceView'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'

const globalAny = globalThis as typeof globalThis & {
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  window?: Window & typeof globalThis
  document?: Document
}

const originalSetTimeout = globalAny.setTimeout
const originalClearTimeout = globalAny.clearTimeout
const originalSetInterval = globalAny.setInterval
const originalClearInterval = globalAny.clearInterval
const originalWindow = globalAny.window
const originalDocument = globalAny.document

// See sessionListComponent.test.tsx: framer-motion frame callbacks fire
// between tests, so the stubs live in beforeAll/afterAll, not beforeEach.
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
  globalAny.setTimeout = originalSetTimeout
  globalAny.clearTimeout = originalClearTimeout
  globalAny.setInterval = originalSetInterval
  globalAny.clearInterval = originalClearInterval
})

function makeSession(id: string, name: string): Session {
  return {
    id,
    name,
    tmuxWindow: `agentboard:${id}`,
    projectPath: '/repo/main',
    status: 'waiting',
    lastActivity: '2024-01-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    source: 'managed',
  }
}

/** One worktree so grouped rows land in a real section, not a fallback. */
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
      ],
      branches: [],
    },
  ],
  generatedAt: '2024-01-01T00:00:00.000Z',
}

function listProps(
  sessions: Session[],
  selectedSessionId: string | null,
  overrides: Partial<Parameters<typeof SessionList>[0]> = {}
): Parameters<typeof SessionList>[0] {
  return {
    sessions,
    hibernatingSessions: [],
    historySessions: [],
    selectedSessionId,
    loading: false,
    error: null,
    onSelect: () => {},
    onRename: () => {},
    ...overrides,
  }
}

function groupedProps(
  sessions: Session[],
  selectedSessionId: string | null
): Parameters<typeof SessionList>[0] {
  return listProps(sessions, selectedSessionId, {
    workspaceView: buildWorkspaceView(snapshot, sessions, [], [], {
      filter: { projectFilters: [], hostFilters: [] },
      collapsedSectionIds: [],
    }),
  })
}

function idsIn(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByProps({ 'data-testid': 'session-card' })
    .map((node) => (node.props as { 'data-session-id'?: string })['data-session-id'])
    .filter((id): id is string => typeof id === 'string')
}

beforeEach(() => {
  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    projectFilters: [],
    hostFilters: [],
  })
  useSessionStore.setState({ sessions: [], exitingSessions: new Map() })
})

// The store is a module singleton shared with later files in the same process
// (messageRouter's kill-failed restore asserts an exact session list).
afterEach(() => {
  useSessionStore.setState({
    sessions: [],
    exitingSessions: new Map(),
    selectedSessionId: null,
  })
  useSettingsStore.setState({
    projectFilters: [],
    hostFilters: [],
  })
})

describe('killed session rows leave the DOM', () => {
  test('flat list: the removed row unmounts on that render, not after an exit animation', async () => {
    const lead = makeSession('chat-lead', 'lead')
    const dev = makeSession('chat-dev', 'dev')
    const third = makeSession('chat-third', 'third')

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<SessionList {...listProps([lead, dev, third], lead.id)} />)
    })
    expect(idsIn(renderer).sort()).toEqual(['chat-dev', 'chat-lead', 'chat-third'])

    // Kill shape: the live list drops the row and `exitingSessions` still
    // holds it (kill-failed rollback bookkeeping). The row must not come
    // back from that map, and must not be held for an exit fade.
    await act(async () => {
      useSessionStore.setState({
        sessions: [dev, third],
        exitingSessions: new Map([[lead.id, lead]]),
      })
      renderer.update(<SessionList {...listProps([dev, third], third.id)} />)
    })
    expect(idsIn(renderer).sort()).toEqual(['chat-dev', 'chat-third'])

    // Parent churn after the removal (auto-select, a sessions snapshot) must
    // not pop the row back or leave a held node behind.
    await act(async () => {
      renderer.update(<SessionList {...listProps([dev, third], dev.id)} />)
    })
    await act(async () => {
      renderer.update(<SessionList {...listProps([dev, third], third.id)} />)
    })
    expect(idsIn(renderer).sort()).toEqual(['chat-dev', 'chat-third'])
    await act(async () => {
      renderer.unmount()
    })
  })

  test('grouped list: the removed row unmounts on that render (WorkspaceSectionList path)', async () => {
    const lead = makeSession('chat-lead', 'lead')
    const dev = makeSession('chat-dev', 'dev')
    const third = makeSession('chat-third', 'third')

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <SessionList {...groupedProps([lead, dev, third], lead.id)} />
      )
    })
    expect(idsIn(renderer).sort()).toEqual(['chat-dev', 'chat-lead', 'chat-third'])

    await act(async () => {
      useSessionStore.setState({
        sessions: [dev, third],
        exitingSessions: new Map([[lead.id, lead]]),
      })
      renderer.update(<SessionList {...groupedProps([dev, third], third.id)} />)
    })
    expect(idsIn(renderer).sort()).toEqual(['chat-dev', 'chat-third'])

    await act(async () => {
      renderer.update(<SessionList {...groupedProps([dev, third], dev.id)} />)
    })
    expect(idsIn(renderer).sort()).toEqual(['chat-dev', 'chat-third'])
    await act(async () => {
      renderer.unmount()
    })
  })

  test('a row still in the live list stays rendered even if exitingSessions also holds it', async () => {
    const lead = makeSession('chat-lead', 'lead')
    const dev = makeSession('chat-dev', 'dev')

    // kill-failed rollback shape: the session is back in `sessions` while the
    // map has not been cleared yet.
    await act(async () => {
      useSessionStore.setState({
        sessions: [lead, dev],
        exitingSessions: new Map([[lead.id, lead]]),
      })
    })
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<SessionList {...listProps([lead, dev], lead.id)} />)
    })
    expect(idsIn(renderer).sort()).toEqual(['chat-dev', 'chat-lead'])
    await act(async () => {
      renderer.unmount()
    })
  })
})
