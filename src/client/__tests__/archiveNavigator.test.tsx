import { afterEach, beforeEach, expect, test } from 'bun:test'
import { useState } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import SessionList from '../components/SessionList'
import { buildWorkspaceView } from '../utils/workspaceView'
import { FALLBACK_ARCHIVE_SECTION_KEY } from '@shared/workspace'
import { useSessionStore } from '../stores/sessionStore'
import { useArchiveRowsStore, beginArchiveConnection } from '../stores/archivedChatRows'
import { sessionReferences, useReferencedSessions } from '../hooks/useReferencedSessions'
import type { Session } from '@shared/types'
const initial = useSessionStore.getState(), initialArchive = useArchiveRowsStore.getState()
const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch }
let renderer: TestRenderer.ReactTestRenderer | undefined
const delay = () => new Promise(resolve => setTimeout(resolve, 10))
function row(id: string): Session {
  return { id, name: id, kind: 'chat', source: 'managed', projectPath: '/tmp/archive',
    archivedAt: '2026-01-01', status: 'waiting', createdAt: '2026-01-01', lastActivity: '2026-01-01' }
}
function Navigator() {
  const [collapsed, setCollapsed] = useState(true)
  const state = useSessionStore()
  return <SessionList sessions={state.sessions} hibernatingSessions={[]} historySessions={[]}
    selectedSessionId={state.selectedSessionId} loading={false} error={null} onSelect={() => {}} onRename={() => {}}
    onToggleSectionCollapse={() => setCollapsed(value => !value)}
    workspaceView={buildWorkspaceView(null, state.sessions, [], [], {
      archivedChats: [...state.archivedChats.values()], archivedCount: state.archivedCount,
      collapsedSectionIds: collapsed ? [FALLBACK_ARCHIVE_SECTION_KEY] : [],
    })} />
}
beforeEach(() => {
  useSessionStore.setState(initial, true); useArchiveRowsStore.setState(initialArchive, true); beginArchiveConnection(1)
  Object.assign(globalThis, {
    window: { innerWidth: 1024, innerHeight: 768, addEventListener() {}, removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) },
    document: { addEventListener() {}, removeEventListener() {} },
  })
})
afterEach(() => {
  act(() => renderer?.unmount()); renderer = undefined
  Object.assign(globalThis, original)
  useSessionStore.setState(initial, true); useArchiveRowsStore.setState(initialArchive, true)
})
// @covers: workspace-navigation › Archive loads archived chat rows on demand › Collapsed Archive loads no archived rows
// @covers: workspace-navigation › Archive loads archived chat rows on demand › Expanding Archive loads the first page
// @covers: workspace-navigation › Archive loads archived chat rows on demand › Scrolling loads the next page
// @covers: workspace-navigation › Archive loads archived chat rows on demand › Archiving or restoring while Archive is open
test('Archive header counts unloaded rows and expands and scrolls through HTTP pages', async () => {
  const urls: string[] = [], pending: Array<(response: Response) => void> = []
  globalThis.fetch = ((url: string) => { urls.push(url); return new Promise<Response>(resolve => pending.push(resolve)) }) as typeof fetch
  useSessionStore.setState({ archivedCount: 771 })
  act(() => { renderer = TestRenderer.create(<Navigator />) })
  expect(urls).toEqual([])
  const header = () => renderer!.root.findByProps({ 'data-testid': 'fallback-section-header', 'data-section-kind': 'archive' })
  expect(header().props['data-session-count']).toBe(771)
  act(() => renderer!.root.findByProps({ 'aria-label': 'Expand Archive section' }).props.onClick())
  expect(urls).toHaveLength(1)
  expect(renderer!.root.findAllByProps({ role: 'status' }).length).toBeGreaterThan(0)
  await act(async () => { pending[0]!(Response.json({ rows: [row('first')], nextCursor: 'next', archivedCount: 771 })); await delay() })
  expect(useSessionStore.getState().archivedChats.has('first')).toBe(true)
  act(() => renderer!.root.findByProps({ 'data-testid': 'fallback-pane-scroll' }).props.onScroll({ currentTarget: { scrollHeight: 100, scrollTop: 90, clientHeight: 20 } }))
  expect(urls[1]).toContain('before=next')
  await act(async () => { pending[1]!(Response.json({ rows: [row('second')], nextCursor: null, archivedCount: 771 })); await delay() })
  expect(useSessionStore.getState().archivedChats.size).toBe(2)
  act(() => useSessionStore.getState().updateSession({ ...row('first'), archivedAt: null }))
  expect(useSessionStore.getState().archivedChats.has('first')).toBe(false)
  expect(useSessionStore.getState().sessions[0]?.id).toBe('first')
})
// @covers: workspace-navigation › Archived chats are fetched by id when referenced › Team page references archived members
test('rendered archived assignees resolve in one batch while Archive stays collapsed', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `assignee-${i}`), urls: string[] = []
  globalThis.fetch = (async (url: string) => {
    urls.push(url)
    expect(url).toContain('/rows?')
    expect(new URL(url, 'http://fixture').searchParams.get('ids')?.split(',')).toEqual(ids)
    return Response.json({ rows: ids.map(row), unknown: [] })
  }) as typeof fetch
  function Assignees() {
    const rows = useReferencedSessions(ids.map(sessionId => ({ assignee: { targetKind: 'session', targetId: sessionId } })))
    return <p>{ids.map(id => rows.filter(row => row.id === id)[0]?.name ?? 'loading').join(',')}</p>
  }
  await act(async () => { renderer = TestRenderer.create(<Assignees />); await delay(); await delay() })
  expect(urls).toHaveLength(1)
  expect(renderer!.root.findByType('p').children.join('')).toBe(ids.join(','))
})

test('reference inventory includes session targets and participants while excluding group targets', () => {
  expect(sessionReferences({ assignments: [{ targetKind: 'session', targetId: 'target' },
    { targetKind: 'group', targetId: 'group' }], participants: ['participant'],
    mail: { fromSession: 'sender', toKind: 'session', toId: 'recipient' },
    ownerSession: 'owner', sessionIds: ['listed'], autoRequestedBy: ['requester'] }).sort())
    .toEqual(['listed', 'owner', 'participant', 'recipient', 'requester', 'sender', 'target'])
})
