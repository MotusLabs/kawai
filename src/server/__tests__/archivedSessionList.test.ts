// Real registry -> hub -> socket open -> client router/store lifecycle path.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { Session, ServerMessage } from '../../shared/types'
import { SessionRegistry } from '../SessionRegistry'
import { ConnectionHub } from '../ws/ConnectionHub'
import { createWebSocketHandlers, type WebSocketHandlerDeps } from '../ws/socketHandlers'
import type { WSData } from '../ws/wsTypes'
import { createMessageRouter } from '../../client/protocol/messageRouter'
import type { MessageRouterDeps } from '../../client/protocol/types'
import { useSessionStore, selectSessionById } from '../../client/stores/sessionStore'
import { useChatStore } from '../../client/stores/chatStore'
import { emptyTranscript } from '../../client/stores/chatTranscript'
import { cacheSnapshot, getCachedSnapshot, clearSnapshotCache } from '../../client/terminal/snapshotCache'
import { propertyCases } from './helpers/propertyCases'

const initial = useSessionStore.getState()
const initialChat = useChatStore.getState()
function row(id: string, archivedAt: string | null = null): Session {
  return { id, name: id, kind: 'chat', source: 'managed', projectPath: '/tmp/slow-link-fixture',
    status: 'waiting', lastActivity: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z', archivedAt }
}
function fixture() {
  const registry = new SessionRegistry()
  const hub = new ConnectionHub()
  hub.wireRegistry(registry)
  const deps: MessageRouterDeps = {
    getConnectionEpoch: () => 1, sendClient: () => {},
    setTransientError: () => {}, clearTransientError: () => {},
    openSessionFormPrefilled: () => {}, setPendingHibernatingSession: () => {},
    pendingKills: { current: new Map() }, pendingHibernateSelection: { current: null },
    pendingWakeSelection: { current: null }, pendingWorktreeLaunch: { current: null },
    pendingChangeLaunch: { current: null },
  }
  const route = createMessageRouter(deps)
  const frames: ServerMessage[] = []
  const ws = { data: { terminal: {}, outputCoalescer: null }, send(payload: string) {
    const message = JSON.parse(payload) as ServerMessage
    frames.push(message)
    route(message)
    return payload.length
  } } as unknown as ServerWebSocket<WSData>
  const handlers = createWebSocketHandlers({ hub, registry,
    remote: { getHostStatuses: () => [] }, workspaceCoordinator: { getSnapshot: () => null },
    terminal: {}, chatConnections: {}, existingChatPeer: () => undefined, handleMessage: () => {},
  } as unknown as WebSocketHandlerDeps)
  return { registry, hub, frames, deps, connect: () => handlers.open(ws) }
}
beforeEach(() => { useSessionStore.setState(initial, true); useChatStore.setState(initialChat, true) })
afterEach(() => { useSessionStore.setState(initial, true); useChatStore.setState(initialChat, true); clearSnapshotCache() })

// @covers: session-updates › The session list leaves out archived chats › Archived chats stay off the connect payload
// @covers: session-updates › Chat session lifecycle changes are sent one session at a time › An archived chat is registered at boot
test('connect sends seven live rows and the 771 archived count without boot row leaks', () => {
  const f = fixture()
  for (let i = 0; i < 7; i++) f.registry.setChatSession(row(`live-${i}`))
  for (let i = 0; i < 771; i++) f.registry.setChatSession(row(`archive-${i}`, '2026-01-01'))
  expect(f.frames).toEqual([])
  f.connect()
  expect(f.frames[0]).toEqual({ type: 'sessions', sessions: f.registry.getLive() })
  expect(f.frames[1]).toEqual({ type: 'archive-summary', archivedCount: 771 })
  expect(useSessionStore.getState().sessions).toHaveLength(7)
  expect(useSessionStore.getState().archivedCount).toBe(771)
  expect(f.registry.getAll()).toHaveLength(778)
})

// @covers: session-updates › Chat session lifecycle changes are sent one session at a time › A chat session is created
// @covers: session-updates › Chat session lifecycle changes are sent one session at a time › A chat session is archived
// @covers: session-updates › Chat session lifecycle changes are sent one session at a time › A chat session is restored
// @covers: session-updates › Chat session lifecycle changes are sent one session at a time › A chat session is removed
// @covers: session-updates › Chat session lifecycle changes are sent one session at a time › An archived chat is patched without restoration
// @covers: session-updates › Chat session lifecycle changes are sent one session at a time › Archive and restore use the patch path
test('patch archive and restore preserve the selected transcript and cached snapshot', () => {
  const f = fixture(); f.connect(); f.frames.length = 0
  f.registry.setChatSession(row('chat'))
  expect(f.frames.map(x => x.type)).toEqual(['session-update'])
  useSessionStore.getState().setSelectedSessionId('chat')
  const transcript = emptyTranscript()
  useChatStore.setState({ sessions: { chat: transcript } })
  cacheSnapshot('chat', 'retained snapshot')
  f.frames.length = 0
  f.registry.updateSession('chat', { archivedAt: '2026-02-01' })
  expect(f.frames.map(x => x.type)).toEqual(['chat-session-archived'])
  expect(useSessionStore.getState().sessions).toEqual([])
  expect(selectSessionById(useSessionStore.getState(), 'chat')?.archivedAt).toBe('2026-02-01')
  expect(useSessionStore.getState().selectedSessionId).toBe('chat')
  expect(useChatStore.getState().sessions.chat).toBe(transcript)
  expect(getCachedSnapshot('chat')).toBe('retained snapshot')
  f.frames.length = 0
  f.registry.updateSession('chat', { name: 'changed while archived' })
  expect(f.frames).toEqual([])
  f.registry.updateSession('chat', { archivedAt: null })
  expect(f.frames.map(x => x.type)).toEqual(['session-update', 'archive-summary'])
  expect(useSessionStore.getState().archivedChats.has('chat')).toBe(false)
  expect(useSessionStore.getState().archivedCount).toBe(0)
  expect(useChatStore.getState().sessions.chat).toBe(transcript)
  f.frames.length = 0
  f.registry.removeChatSession('chat')
  expect(f.frames.map(x => x.type)).toEqual(['session-removed'])
  expect(useChatStore.getState().sessions.chat).toBeUndefined()
  expect(getCachedSnapshot('chat')).toBeUndefined()
})

test('unknown patch and pending kill cannot add a live card', () => {
  const f = fixture(); f.connect(); f.frames.length = 0
  expect(f.registry.updateSession('missing', { archivedAt: null })).toBeUndefined()
  expect(f.frames).toEqual([])
  f.deps.pendingKills.current.set('killed', { session: row('killed'), wasSelected: false, epoch: 1 })
  f.registry.setChatSession(row('killed'))
  expect(useSessionStore.getState().sessions).toEqual([])
})

test('P1 seed 0x51ED: lifecycle sequences preserve live ids and archive count', () => {
  let seed = 0x51ED
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8 }
  for (let c = 0; c < propertyCases(200); c++) {
    useSessionStore.setState(initial, true)
    const f = fixture(); f.connect()
    for (let step = 0; step < 200; step++) {
      const id = `chat-${random() % 30}`
      const current = f.registry.get(id)
      f.frames.length = 0
      switch (random() % 6) {
        case 0: f.registry.setChatSession(row(id)); break
        case 1: f.registry.updateSession(id, { archivedAt: '2026-02-01' }); break
        case 2: f.registry.updateSession(id, { archivedAt: null }); break
        case 3: f.registry.removeChatSession(id); break
        case 4: f.registry.updateSession(id, { name: `step-${step}` }); break
        case 5: f.connect(); break
      }
      // Each operation is atomic at its message-batch boundary (restore sends two frames).
      expect(useSessionStore.getState().sessions.map(x => x.id).sort()).toEqual(f.registry.getLive().map(x => x.id).sort())
      expect(useSessionStore.getState().archivedCount).toBe(f.registry.archivedChatCount())
      if (current?.archivedAt && f.registry.get(id)?.archivedAt) {
        expect(f.frames.filter(x => x.type === 'session-update')).toEqual([])
      }
    }
  }
})
