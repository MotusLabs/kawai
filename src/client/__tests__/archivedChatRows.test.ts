import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Session } from '@shared/types'
import { useSessionStore } from '../stores/sessionStore'
import { beginArchiveConnection, blockSessionRow, loadArchivePage, mergeArchiveRows, noteSessionMutation, requestSessionRows, useArchiveRowsStore } from '../stores/archivedChatRows'
const initial = useSessionStore.getState()
const archiveInitial = useArchiveRowsStore.getState()
const originalFetch = globalThis.fetch
const frame = () => new Promise(resolve => setTimeout(resolve, 5))
function row(id = 'a', archivedAt: string | null = '2026-02-01'): Session {
  return { id, name: id, kind: 'chat', source: 'managed', projectPath: '/tmp/archive',
    createdAt: '2026-01-01', lastActivity: '2026-01-01', status: 'waiting', archivedAt }
}
beforeEach(() => { useSessionStore.setState(initial, true); useArchiveRowsStore.setState(archiveInitial, true); beginArchiveConnection(1) })
afterEach(() => { globalThis.fetch = originalFetch; useSessionStore.setState(initial, true); useArchiveRowsStore.setState(archiveInitial, true) })

test('M1-M8: current HTTP replies merge by live precedence and archive timestamp', () => {
  const cases = [
    { id: 'M1', held: null, fetched: row(), live: false, archived: '2026-02-01' },
    { id: 'M2', held: row('a', null), fetched: row(), live: true, archived: undefined },
    { id: 'M3', held: row(), fetched: { ...row(), name: 'updated' }, live: false, archived: '2026-02-01' },
    { id: 'M4', held: row('a', '2026-03-01'), fetched: row(), live: false, archived: '2026-03-01' },
    { id: 'M5', held: row('a', '2026-01-01'), fetched: row(), live: false, archived: '2026-02-01' },
    { id: 'M6', held: null, fetched: row('a', null), live: true, archived: undefined },
    { id: 'M7', held: row('a', null), fetched: { ...row('a', null), name: 'old' }, live: true, archived: undefined },
  ]
  for (const c of cases) {
    useSessionStore.setState({ sessions: c.held && !c.held.archivedAt ? [c.held] : [],
      archivedChats: new Map(c.held?.archivedAt ? [['a', c.held]] : []) })
    mergeArchiveRows([c.fetched], [])
    const state = useSessionStore.getState()
    expect(state.sessions.length, c.id).toBe(c.live ? 1 : 0)
    expect(state.archivedChats.get('a')?.archivedAt, c.id).toBe(c.archived)
    if (c.id === 'M3') expect(state.archivedChats.get('a')?.name).toBe('updated')
    if (c.id === 'M7') expect(state.sessions[0]?.name).toBe('a')
  }
  mergeArchiveRows([], ['missing'])
  expect(useArchiveRowsStore.getState().status.missing).toBe('unknown')
})

// @covers: workspace-navigation › Archive requests follow current connection and lifecycle state › A lifecycle update overtakes an HTTP reply
test('M9-M11: lifecycle archive, removal and creation beat older HTTP rows and unknown replies', async () => {
  for (const kind of ['archive', 'remove', 'create']) {
    beginArchiveConnection(useArchiveRowsStore.getState().epoch + 1)
    useSessionStore.setState({ sessions: [], archivedChats: new Map() })
    let resolve!: (response: Response) => void
    globalThis.fetch = ((url: string) => {
      expect(url).toContain('/api/chat/sessions/rows?ids=a')
      return new Promise<Response>(done => { resolve = done })
    }) as typeof fetch
    requestSessionRows(['a']); await frame()
    noteSessionMutation('a')
    if (kind === 'archive') useSessionStore.setState({ archivedChats: new Map([['a', row()]]) })
    if (kind === 'create') useSessionStore.getState().updateSession(row('a', null))
    resolve(Response.json({ rows: kind === 'create' ? [] : [row('a', null)], unknown: kind === 'create' ? ['a'] : [] }))
    await frame()
    expect(useArchiveRowsStore.getState().status.a).toBeUndefined()
    expect(useSessionStore.getState().sessions.length).toBe(kind === 'create' ? 1 : 0)
    expect(useSessionStore.getState().archivedChats.has('a')).toBe(kind === 'archive')
  }
})

// @covers: workspace-navigation › Archive requests follow current connection and lifecycle state › Reconnect invalidates archive requests and pages
test('reconnect discards pending replies and permits the first page to refresh once', async () => {
  const replies: Array<(response: Response) => void> = []
  const urls: string[] = []
  globalThis.fetch = ((url: string) => { urls.push(url); return new Promise<Response>(resolve => replies.push(resolve)) }) as typeof fetch
  const first = loadArchivePage()
  void loadArchivePage()
  expect(urls).toHaveLength(1)
  beginArchiveConnection(2)
  const second = loadArchivePage()
  expect(urls).toHaveLength(2)
  replies[0]!(Response.json({ rows: [row('stale')], nextCursor: 'old', archivedCount: 20 }))
  await first
  expect(useArchiveRowsStore.getState().loading).toBe(true)
  replies[1]!(Response.json({ rows: [row('fresh')], nextCursor: null, archivedCount: 1 }))
  await second
  expect([...useSessionStore.getState().archivedChats.keys()]).toEqual(['fresh'])
  await loadArchivePage()
  expect(urls).toHaveLength(2)
  expect(beginArchiveConnection(2)).toBe(false)
})

// @covers: workspace-navigation › Archived chats are fetched by id when referenced › Team page references archived members
test('12 ids in one frame give one request, and 101 give batches of 100 and 1', async () => {
  const batches: string[][] = []
  globalThis.fetch = (async (url: string) => {
    const ids = new URL(url, 'http://fixture').searchParams.get('ids')!.split(',')
    batches.push(ids)
    return Response.json({ rows: ids.map(id => row(id)), unknown: [] })
  }) as typeof fetch
  for (let i = 0; i < 12; i++) requestSessionRows([`a-${i}`])
  await frame(); await frame()
  expect(batches.map(ids => ids.length)).toEqual([12])
  requestSessionRows(Array.from({ length: 101 }, (_, i) => `b-${i}`))
  await frame(); await frame()
  expect(batches.map(ids => ids.length)).toEqual([12, 100, 1])
})

test('HTTP failure releases page loading and a reconnect clears unknown marks', async () => {
  globalThis.fetch = (async (_url: string) => new Response('unavailable', { status: 503 })) as typeof fetch
  await loadArchivePage()
  expect(useArchiveRowsStore.getState().loading).toBe(false)
  expect(useArchiveRowsStore.getState().error).toContain('Could not load')
  mergeArchiveRows([], ['missing'])
  noteSessionMutation('missing')
  expect(useArchiveRowsStore.getState().status.missing).toBeUndefined()
  mergeArchiveRows([], ['missing'])
  beginArchiveConnection(2)
  expect(useArchiveRowsStore.getState().status).toEqual({})
})

test('HTTP rows cannot resurrect pending kills until the next connection', () => {
  blockSessionRow('killed')
  mergeArchiveRows([row('killed', null), row('archived-killed')], [])
  expect(useSessionStore.getState().sessions).toEqual([])
  beginArchiveConnection(2)
  mergeArchiveRows([row('killed', null)], [])
  expect(useSessionStore.getState().sessions[0]?.id).toBe('killed')
})
