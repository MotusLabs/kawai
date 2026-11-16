import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { SessionRegistry } from '../SessionRegistry'
import { createArchivedChatRoutes } from '../routes/archivedChats'
import type { Session } from '../../shared/types'
import { propertyCases } from './helpers/propertyCases'
function row(id: string, archivedAt: string | null): Session {
  return { id, name: id, archivedAt, kind: 'chat', source: 'managed', status: 'waiting',
    projectPath: '/tmp/archive-fixture', createdAt: '2026-01-01', lastActivity: '2026-01-01',
    groupId: 'developers', taskId: 'task-fixture', parked: { messageId: 'message', until: null, profileId: 'fixture', reason: 'test' } }
}
function app(registry: SessionRegistry) {
  const app = new Hono()
  app.get('/api/sessions', c => c.json(registry.getAll()))
  app.route('/api/chat/sessions', createArchivedChatRoutes({ registry, whenRestored: async () => {} }))
  return app
}
test('archive routes clamp limits, reject malformed cursors and 101 ids, and preserve registry-shaped rows', async () => {
  const registry = new SessionRegistry()
  for (let i = 0; i < 120; i++) registry.setChatSession(row(`id-${String(i).padStart(3, '0')}`, '2026-01-01'))
  registry.setChatSession(row('live', null))
  const api = app(registry)
  expect((await (await api.request('/api/chat/sessions/archived?limit=0')).json()).rows).toHaveLength(1)
  expect((await (await api.request('/api/chat/sessions/archived?limit=500')).json()).rows).toHaveLength(100)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  for (const cursor of ['broken', '', encode({ archivedAt: 'invalid', id: 'id-001' }),
    encode({ archivedAt: '2026-01-01', id: 12 }), encode(['2026-01-01', 'id-001']),
    encode({ archivedAt: '2026-01-01', id: 'id-001' }) + '%']) {
    expect((await api.request('/api/chat/sessions/archived?before=' + encodeURIComponent(cursor))).status).toBe(400)
  }
  expect((await api.request('/api/chat/sessions/rows?ids=' + Array.from({ length: 101 }, (_, i) => i).join(','))).status).toBe(400)
  const reply = await (await api.request('/api/chat/sessions/rows?ids=live,id-000,unknown')).json()
  expect(reply.rows).toEqual([registry.get('live'), registry.get('id-000')])
  expect(reply.unknown).toEqual(['unknown'])
  expect((await (await api.request('/api/sessions')).json())).toHaveLength(121)
})

test('P2 seed 0xA2C1: keyset walks preserve ties without duplicates or gaps during archive and restore', async () => {
  let seed = 0xA2C1
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8 }
  for (let c = 0; c < propertyCases(100); c++) {
    const registry = new SessionRegistry()
    const count = random() % 301, limit = 1 + random() % 100
    for (let i = 0; i < count; i++) registry.setChatSession(row(`id-${String(i).padStart(3, '0')}`, `2026-01-0${1 + random() % 3}`))
    const api = app(registry)
    const initial = new Set(registry.getAll().map(row => row.id))
    const restored = new Set<string>(), seen: Session[] = []
    let cursor: string | null = null
    do {
      const reply: { rows: Session[]; nextCursor: string | null } = await (await api.request(`/api/chat/sessions/archived?limit=${limit}${cursor ? '&before=' + cursor : ''}`)).json()
      seen.push(...reply.rows); cursor = reply.nextCursor
      if (cursor) {
        const id = `id-${String(random() % Math.max(1, count)).padStart(3, '0')}`
        registry.updateSession(id, { archivedAt: null }); restored.add(id)
        registry.setChatSession(row(`new-${seen.length}`, '2026-02-01'))
      }
    } while (cursor)
    expect(new Set(seen.map(row => row.id)).size).toBe(seen.length)
    for (const id of initial) if (!restored.has(id)) expect(seen.some(row => row.id === id)).toBe(true)
    expect(seen.every(row => !!row.archivedAt)).toBe(true)
    const keys = seen.map(row => `${row.archivedAt}/${row.id}`)
    expect(keys).toEqual([...keys].sort().reverse())
  }
})
