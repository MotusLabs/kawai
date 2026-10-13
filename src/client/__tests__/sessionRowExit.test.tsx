// sessionRowExit.test.tsx - the killed-row unmount contract. A removed session
// row must leave the DOM as soon as it leaves the live list: no AnimatePresence
// held-exit, no merge back from `exitingSessions`, no cleanup timer. Anything
// that keeps the node mounted is a ghost card — `toHaveCount(0)` after Kill
// still sees it. This test drives the real row under the shipped list shape.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { DndContext, closestCenter } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { Session } from '@shared/types'
import { useSessionStore } from '../stores/sessionStore'

const globalAny = globalThis as typeof globalThis & {
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
  window?: Window & typeof globalThis
  document?: Document
}

const originalSetTimeout = globalAny.setTimeout
const originalClearTimeout = globalAny.clearTimeout
const originalWindow = globalAny.window
const originalDocument = globalAny.document

const { SortableSessionItem } = await import('../components/SessionRow')

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
})

function makeSession(id: string, name: string): Session {
  return {
    id,
    name,
    tmuxWindow: `agentboard:${id}`,
    projectPath: `/tmp/${name}`,
    status: 'waiting',
    lastActivity: '2024-01-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    source: 'managed',
  }
}

const handlers = {
  onSelect: () => {},
  onStartEdit: () => {},
  onCancelEdit: () => {},
  onRename: () => {},
  onHibernate: () => {},
  onKill: () => {},
  onDuplicate: () => {},
}

function rowProps(session: Session, isSelected: boolean) {
  return {
    session,
    isNew: false,
    exitDuration: 30,
    prefersReducedMotion: false,
    useSafariLayoutFallback: false,
    isSelected,
    isEditing: false,
    showSessionIdPrefix: false,
    showProjectName: false,
    showLastUserMessage: false,
    showHostInfo: false,
    dropIndicator: null,
    nowTick: 0,
    remoteAllowControl: false,
    ...handlers,
  }
}

/** The list shape both navigators share: plain rows, no AnimatePresence. */
function listTree(sessions: Session[], selected: string | null) {
  const items = sessions.map((session) => session.id)
  return (
    <DndContext collisionDetection={closestCenter}>
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        {sessions.map((session) => (
          <SortableSessionItem
            key={session.id}
            {...rowProps(session, session.id === selected)}
          />
        ))}
      </SortableContext>
    </DndContext>
  )
}

function idsIn(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType('div')
    .map((node) => (node.props as { 'data-session-id'?: string })['data-session-id'])
    .filter((id): id is string => typeof id === 'string')
}

beforeEach(() => {
  useSessionStore.setState({ sessions: [], exitingSessions: new Map() })
})

// The store is a module singleton shared with later files in the same process
// (messageRouter's kill-failed restore asserts an exact session list).
afterEach(() => {
  useSessionStore.setState({ sessions: [], exitingSessions: new Map(), selectedSessionId: null })
})

describe('killed session rows leave the DOM', () => {
  test('row removed from the list unmounts immediately, even with a parent mid-exit re-render', async () => {
    const lead = makeSession('chat-lead', 'lead')
    const dev = makeSession('chat-dev', 'dev')
    const third = makeSession('chat-third', 'third')

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(listTree([lead, dev, third], lead.id))
    })
    expect(idsIn(renderer).sort()).toEqual(['chat-dev', 'chat-lead', 'chat-third'])

    // Kill: the live list drops the lead (exitingSessions may still hold it
    // for kill-failed rollback — rows must not be rendered from there).
    await act(async () => {
      useSessionStore.setState({
        sessions: [dev, third],
        exitingSessions: new Map([[lead.id, lead]]),
      })
    })
    await act(async () => {
      renderer.update(listTree([dev, third], third.id))
    })
    expect(idsIn(renderer)).not.toContain('chat-lead')

    // Parent churn after the removal (auto-select, a sessions snapshot) must
    // not pop the row back or leave a held node behind.
    await act(async () => {
      renderer.update(listTree([dev, third], dev.id))
    })
    await act(async () => {
      renderer.update(listTree([dev, third], third.id))
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
      renderer = TestRenderer.create(listTree([lead, dev], lead.id))
    })
    expect(idsIn(renderer).sort()).toEqual(['chat-dev', 'chat-lead'])
    await act(async () => {
      renderer.unmount()
    })
  })
})
