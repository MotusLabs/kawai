// sessionRowMemo.test.tsx - render-count coverage for memoized session rows
// (design D6). formatRelativeTime runs on every SessionRow render, so a
// counting wrapper around it is the oracle for whether a row re-rendered;
// React's Profiler cannot make that distinction because it commits its own
// re-render even when the memoized child bails out. The module mock must be
// registered before the component resolves its imports, hence the dynamic
// import below (same pattern as app.test.tsx). SessionList is deliberately
// NOT imported here: it re-exports formatRelativeTime, and Bun's loader
// deadlocks combining that re-export with the module mock. The real-parent
// integration lives in sessionListComponent.test.tsx instead.

import { afterAll, beforeAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { DndContext, closestCenter } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { Session } from '@shared/types'
import type { SortableSessionItemProps } from '../components/SessionRow'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
}

const originalWindow = globalAny.window
const originalDocument = globalAny.document

const actualTime = await import('../utils/time')
// Capture before registering the mock: property access on the pre-mock
// namespace after mock.module deadlocks Bun's module loader.
const actualFormatRelativeTime = actualTime.formatRelativeTime

let rowRenders = 0
mock.module('../utils/time', () => ({
  formatRelativeTime: (iso: string, now?: number) => {
    rowRenders += 1
    return actualFormatRelativeTime(iso, now)
  },
}))

const { SortableSessionItem } = await import('../components/SessionRow')

// See sessionListComponent.test.tsx for why these stubs live in
// beforeAll/afterAll rather than per-test.
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

const baseSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'working',
  lastActivity: '2024-01-01T00:00:00.000Z',
  createdAt: '2024-01-01T00:00:00.000Z',
  source: 'managed',
}

// baseSession.lastActivity sits at a 30s bucket boundary (00:00:00), so +15s
// stays in-bucket and +45s crosses into the next bucket.
const sameBucket = '2024-01-01T00:00:15.000Z'
const nextBucket = '2024-01-01T00:00:45.000Z'

// Shared no-op identities: the memo comparator treats callback identity as a
// change, so updates must reuse these unless a test replaces one on purpose.
const stableHandlers = {
  onSelect: () => {},
  onStartEdit: () => {},
  onCancelEdit: () => {},
  onRename: () => {},
  onHibernate: () => {},
  onKill: () => {},
  onDuplicate: () => {},
}

function makeRowProps(
  overrides: Partial<SortableSessionItemProps> = {}
): SortableSessionItemProps {
  return {
    session: baseSession,
    isNew: false,
    exitDuration: 200,
    prefersReducedMotion: true,
    useSafariLayoutFallback: false,
    isSelected: false,
    isEditing: false,
    showSessionIdPrefix: false,
    showProjectName: false,
    showLastUserMessage: false,
    showHostInfo: false,
    dropIndicator: null,
    nowTick: 0,
    remoteAllowControl: false,
    ...stableHandlers,
    ...overrides,
  }
}

// Stable across mount/updates: SortableContext rebuilds its context value
// when the items array identity changes, re-rendering rows via context.
const rowItems = [baseSession.id]

function rowTree(props: SortableSessionItemProps) {
  return (
    <DndContext collisionDetection={closestCenter}>
      <SortableContext items={rowItems} strategy={verticalListSortingStrategy}>
        <SortableSessionItem {...props} />
      </SortableContext>
    </DndContext>
  )
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON())
}

/** Direct string children of a menu item ("Rename", "Duplicate", …). */
function menuItemLabel(item: TestRenderer.ReactTestInstance): string {
  const children = Array.isArray(item.props.children)
    ? item.props.children
    : [item.props.children]
  return children.filter((child: unknown) => typeof child === 'string').join('')
}

beforeEach(() => {
  rowRenders = 0
})

describe('memoized session rows (design D6)', () => {
  test('row does not re-render on a same-bucket lastActivity-only change', () => {
    const renderer = TestRenderer.create(rowTree(makeRowProps()))
    expect(rowRenders).toBe(1)

    act(() => {
      renderer.update(rowTree(makeRowProps({ session: { ...baseSession, lastActivity: sameBucket } })))
    })

    // New session object identity, same rendered content: memo bails out.
    expect(rowRenders).toBe(1)
    act(() => renderer.unmount())
  })

  test('row re-renders on status change and on activity bucket crossing', () => {
    const renderer = TestRenderer.create(rowTree(makeRowProps()))
    expect(rowRenders).toBe(1)

    act(() => {
      renderer.update(rowTree(makeRowProps({ session: { ...baseSession, status: 'waiting' } })))
    })
    const afterStatus = rowRenders
    expect(afterStatus).toBeGreaterThan(1)

    act(() => {
      renderer.update(
        rowTree(
          makeRowProps({ session: { ...baseSession, status: 'waiting', lastActivity: nextBucket } })
        )
      )
    })
    expect(rowRenders).toBeGreaterThan(afterStatus)
    act(() => renderer.unmount())
  })

  test('label refreshes when nowTick advances', () => {
    // 5 minutes after lastActivity reads "5m"; 20 minutes reads "20m".
    const renderer = TestRenderer.create(
      rowTree(makeRowProps({ nowTick: Date.parse('2024-01-01T00:05:00.000Z') }))
    )
    expect(renderedText(renderer)).toContain('5m')

    act(() => {
      renderer.update(rowTree(makeRowProps({ nowTick: Date.parse('2024-01-01T00:20:00.000Z') })))
    })

    expect(rowRenders).toBeGreaterThan(1)
    expect(renderedText(renderer)).toContain('20m')
    act(() => renderer.unmount())
  })

  test('replacing a callback re-renders the row and invokes the new handler', () => {
    const firstCalls: string[] = []
    const secondCalls: string[] = []
    const renderer = TestRenderer.create(
      rowTree(makeRowProps({ onSelect: () => firstCalls.push('first') }))
    )

    act(() => {
      renderer.update(rowTree(makeRowProps({ onSelect: () => secondCalls.push('second') })))
    })
    expect(rowRenders).toBeGreaterThan(1)

    act(() => {
      renderer.root.findByProps({ 'data-testid': 'session-card' }).props.onClick()
    })
    expect(firstCalls).toEqual([])
    expect(secondCalls).toEqual(['second'])
    act(() => renderer.unmount())
  })

  test('adding an optional control re-renders the row and wires it up', () => {
    const duplicateCalls: string[] = []
    const renderer = TestRenderer.create(rowTree(makeRowProps({ onDuplicate: undefined })))

    // Open the context menu: without onDuplicate there is no Duplicate item.
    act(() => {
      renderer.root
        .findByProps({ 'data-testid': 'session-card' })
        .props.onContextMenu({
          preventDefault: () => {},
          stopPropagation: () => {},
          clientX: 4,
          clientY: 4,
        })
    })
    const menuItems = () =>
      renderer.root.findByProps({ role: 'menu' }).findAllByProps({ role: 'menuitem' })
    expect(menuItems().some((item) => menuItemLabel(item) === 'Duplicate')).toBe(false)

    act(() => {
      renderer.update(
        rowTree(makeRowProps({ onDuplicate: (sessionId) => duplicateCalls.push(sessionId) }))
      )
    })
    expect(rowRenders).toBeGreaterThan(1)

    const duplicateButton = menuItems().find((item) => menuItemLabel(item) === 'Duplicate')
    if (!duplicateButton) throw new Error('Expected Duplicate menu item after adding onDuplicate')
    act(() => {
      duplicateButton.props.onClick({ stopPropagation: () => {} })
    })
    expect(duplicateCalls).toEqual(['session-1'])
    act(() => renderer.unmount())
  })
})
