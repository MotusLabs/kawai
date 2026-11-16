import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { ServerWebSocket, Server } from 'bun'
import { createHash } from 'node:crypto'
import { WorkspaceCoordinator, type WorkspaceDiscoveryApi } from '../workspace/workspaceCoordinator'
import { ConnectionHub } from '../ws/ConnectionHub'
import { SessionRegistry } from '../SessionRegistry'
import { createServerFetch, createWebSocketHandlers, type WebSocketHandlerDeps } from '../ws/socketHandlers'
import type { WSData } from '../ws/wsTypes'
import type { ServerMessage, WorkspaceSnapshot } from '../../shared/types'

function socket(data: Partial<WSData>, frames: ServerMessage[]) {
  return { data: { terminal: {}, ...data }, send(payload: string) { frames.push(JSON.parse(payload)); return payload.length } } as unknown as ServerWebSocket<WSData>
}
function open(hub: ConnectionHub, ws: ServerWebSocket<WSData>, snapshot: WorkspaceSnapshot | null, digest: string) {
  createWebSocketHandlers({ hub, registry: new SessionRegistry(),
    remote: { getHostStatuses: () => [] }, workspaceCoordinator: { getSnapshot: () => snapshot, getDigest: () => digest },
    terminal: {}, chatConnections: {}, handleMessage: () => {}, existingChatPeer: () => undefined,
  } as unknown as WebSocketHandlerDeps).open(ws)
}
// @covers: workspace-navigation › Reconnects skip an unchanged workspace snapshot › Reconnect with an unchanged workspace
// @covers: workspace-navigation › Reconnects skip an unchanged workspace snapshot › The workspace changed while disconnected
// @covers: workspace-navigation › Reconnects skip an unchanged workspace snapshot › A first connect names no digest
test('W1-W5: upgrade digest validation reaches the actual open handler', () => {
  const snapshot = { repositories: [], generatedAt: '2026-01-01' }
  const digest = '0123456789abcdef'
  for (const c of [
    { id: 'W1', url: '', present: true, sent: 1 },
    { id: 'W2', url: digest, present: true, sent: 0 },
    { id: 'W2-upper', url: digest.toUpperCase(), present: true, sent: 0 },
    { id: 'W3', url: '1111111111111111', present: true, sent: 1 },
    { id: 'W4', url: 'zz', present: true, sent: 1 },
    { id: 'W4-long', url: '0123456789abcdef0', present: true, sent: 1 },
    { id: 'W5', url: digest, present: false, sent: 0 },
  ]) {
    let data!: WSData
    const fetch = createServerFetch(new Hono())
    fetch(new Request(`http://fixture/ws?workspace=${c.url}`), {
      upgrade(_req: Request, options: { data: WSData }) { data = options.data; return true },
    } as unknown as Server<WSData>)
    expect(data.workspaceDigest, c.id).toBe(/^[a-f0-9]{16}$/i.test(c.url) ? c.url.toLowerCase() : undefined)
    const frames: ServerMessage[] = [], hub = new ConnectionHub()
    const ws = socket(data, frames)
    ws.data.terminal = {} as WSData['terminal']
    open(hub, ws, c.present ? snapshot : null, digest)
    expect(frames.filter(frame => frame.type === 'workspace-snapshot').length, c.id).toBe(c.sent)
  }
})

// @covers: workspace-navigation › Reconnects skip an unchanged workspace snapshot › A server restart with the same workspace
// @covers: workspace-navigation › Reconnects skip an unchanged workspace snapshot › Initial unavailable snapshot differs or has no valid held digest
// @covers: workspace-navigation › Reconnects skip an unchanged workspace snapshot › Later changes follow a suppressed initial snapshot
test('W5a-W5c: first publication compares deferred digest once and later changes broadcast', () => {
  const digest = '0123456789abcdef'
  for (const requested of [digest, '1111111111111111', undefined]) {
    const frames: ServerMessage[] = [], hub = new ConnectionHub()
    const ws = socket({ workspaceDigest: requested }, frames)
    open(hub, ws, null, digest)
    hub.publishWorkspaceSnapshot({ repositories: [], generatedAt: 'first' }, digest)
    expect(frames.filter(frame => frame.type === 'workspace-snapshot')).toHaveLength(requested === digest ? 0 : 1)
    hub.publishWorkspaceSnapshot({ repositories: [], generatedAt: 'later' }, '2222222222222222')
    expect(frames.filter(frame => frame.type === 'workspace-snapshot').at(-1)).toEqual({
      type: 'workspace-snapshot', snapshot: { repositories: [], generatedAt: 'later' }, digest: '2222222222222222',
    })
    expect(ws.data.pendingWorkspaceDigest).toBeUndefined()
  }
})

// @covers: workspace-navigation › Reconnects skip an unchanged workspace snapshot › Only the generation time differs
test('W6-W8: coordinator content digest ignores generation time, changes with content and survives restart', async () => {
  let name = 'repo'
  const discovery: WorkspaceDiscoveryApi = {
    resolveSeeds: async seeds => {
      expect(seeds).toEqual(['/fixture'])
      const dirs = { commonDir: '/fixture/.git', gitDir: '/fixture/.git', toplevel: '/fixture' }
      return { repositories: new Map([['/fixture/.git', dirs]]), seeds: [{ canonicalPath: '/fixture', dirs }] }
    },
    buildRepository: async commonDir => {
      expect(commonDir).toBe('/fixture/.git')
      return { id: commonDir, commonDir, name, branches: [], worktrees: [], stale: false }
    },
    refreshOpenSpec: async repository => repository,
  }
  const published: Array<{ snapshot: WorkspaceSnapshot; digest: string }> = []
  const make = () => new WorkspaceCoordinator({ getSeeds: () => ['/fixture'], discovery,
    broadcast: (snapshot, digest) => published.push({ snapshot, digest }) })
  const first = make(); await first.requestRefresh()
  const digest = first.getDigest()!
  expect(digest).toMatch(/^[a-f0-9]{16}$/)
  expect(digest).toBe(createHash('sha256').update(JSON.stringify(first.getSnapshot()!.repositories)).digest('hex').slice(0, 16))
  await first.reconcile()
  expect(first.getDigest()).toBe(digest)
  expect(published).toHaveLength(1)
  const restarted = make(); await restarted.requestRefresh()
  expect(restarted.getDigest()).toBe(digest)
  name = 'changed'; await first.reconcile()
  expect(first.getDigest()).not.toBe(digest)
  expect(published.at(-1)?.digest).toBe(first.getDigest()!)
})
