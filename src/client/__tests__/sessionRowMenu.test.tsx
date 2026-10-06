// sessionRowMenu.test.tsx - Chat archive/restore row-menu coverage: a live
// chat row offers Archive (not Restore), an archived chat row offers Restore
// (not Archive), both keep Kill, and terminal rows offer neither action.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { DndContext, closestCenter } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { Session } from '@shared/types'
import { SortableSessionItem } from '../components/SessionRow'

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

const baseChat: Session = {
  id: 'chat-1',
  name: 'chat',
  projectPath: '/tmp/project',
  status: 'waiting',
  lastActivity: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  source: 'managed',
  kind: 'chat',
}

function menuItemNames(root: TestRenderer.ReactTestInstance): string[] {
  return root.findAllByProps({ role: 'menuitem' }).map((item) =>
    item.children
      .filter((child): child is string => typeof child === 'string')
      .map((child) => child.trim())
      .join('')
  )
}

function renderRow(
  session: Session,
  actions: Partial<{
    onArchiveChat: (sessionId: string) => void
    onRestoreChat: (sessionId: string) => void
    onKill: (sessionId: string) => void
  }>
): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <DndContext collisionDetection={closestCenter}>
        <SortableContext items={[session.id]} strategy={verticalListSortingStrategy}>
          <SortableSessionItem
            session={session}
            isNew={false}
            exitDuration={200}
            prefersReducedMotion={false}
            useSafariLayoutFallback={false}
            isSelected={false}
            isEditing={false}
            showSessionIdPrefix={false}
            showProjectName={false}
            showLastUserMessage={false}
            showHostInfo={false}
            dropIndicator={null}
            nowTick={Date.now()}
            remoteAllowControl={false}
            onSelect={() => {}}
            onCancelEdit={() => {}}
            onRename={() => {}}
            onArchiveChat={actions.onArchiveChat}
            onRestoreChat={actions.onRestoreChat}
            onKill={actions.onKill}
          />
        </SortableContext>
      </DndContext>
    )
  })
  const row = renderer.root.findByProps({ 'data-testid': 'session-card' })
  act(() => {
    row.props.onContextMenu({
      preventDefault: () => {},
      stopPropagation: () => {},
      clientX: 4,
      clientY: 6,
    })
  })
  return renderer
}

describe('SessionRow chat archive menu', () => {
  test('a live chat offers Archive and Kill', () => {
    const archived: string[] = []
    const renderer = renderRow(baseChat, {
      onArchiveChat: (sessionId) => archived.push(sessionId),
      onKill: () => {},
    })

    expect(menuItemNames(renderer.root)).toContain('Archive')
    expect(menuItemNames(renderer.root)).not.toContain('Restore')
    expect(menuItemNames(renderer.root)).toContain('Kill Session')

    const archiveButton = renderer.root
      .findAllByProps({ role: 'menuitem' })
      .find((item) =>
        item.children.some((child) => typeof child === 'string' && child.trim() === 'Archive')
      )
    if (!archiveButton) throw new Error('Expected Archive menu item')
    act(() => {
      archiveButton.props.onClick({ stopPropagation: () => {} })
    })
    expect(archived).toEqual(['chat-1'])

    act(() => renderer.unmount())
  })

  test('an archived chat offers Restore and Kill but not Archive', () => {
    const archived: string[] = []
    const restored: string[] = []
    const renderer = renderRow(
      { ...baseChat, archivedAt: '2026-02-01T00:00:00.000Z' },
      {
        onArchiveChat: (sessionId) => archived.push(sessionId),
        onRestoreChat: (sessionId) => restored.push(sessionId),
        onKill: () => {},
      }
    )

    expect(menuItemNames(renderer.root)).toContain('Restore')
    expect(menuItemNames(renderer.root)).not.toContain('Archive')
    expect(menuItemNames(renderer.root)).toContain('Kill Session')

    const restoreButton = renderer.root
      .findAllByProps({ role: 'menuitem' })
      .find((item) =>
        item.children.some((child) => typeof child === 'string' && child.trim() === 'Restore')
      )
    if (!restoreButton) throw new Error('Expected Restore menu item')
    act(() => {
      restoreButton.props.onClick({ stopPropagation: () => {} })
    })
    expect(restored).toEqual(['chat-1'])
    expect(archived).toEqual([])

    act(() => renderer.unmount())
  })

  test('terminal rows never offer Archive or Restore', () => {
    const renderer = renderRow(
      { ...baseChat, kind: undefined, tmuxWindow: 'agentboard:1' },
      {
        onArchiveChat: () => {},
        onRestoreChat: () => {},
      }
    )

    expect(menuItemNames(renderer.root)).not.toContain('Archive')
    expect(menuItemNames(renderer.root)).not.toContain('Restore')

    act(() => renderer.unmount())
  })
})
