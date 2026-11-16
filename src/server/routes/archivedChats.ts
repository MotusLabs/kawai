// Read-only registry-shaped rows; archive payloads never queue on the socket.
import { Hono } from 'hono'
import type { SessionRegistry } from '../SessionRegistry'

interface Cursor { archivedAt: string; id: string }
function decodeCursor(value: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (typeof parsed?.archivedAt !== 'string' || !Number.isFinite(Date.parse(parsed.archivedAt)) ||
      typeof parsed?.id !== 'string' || !parsed.id) return null
    return parsed
  } catch { return null }
}
export function createArchivedChatRoutes(options: {
  registry: SessionRegistry
  whenRestored: () => Promise<void>
}) {
  const routes = new Hono()
  routes.get('/archived', async c => {
    const before = c.req.query('before')
    const cursor = before === undefined ? null : decodeCursor(before)
    if (before !== undefined && !cursor) return c.json({ error: 'Invalid archive cursor.' }, 400)
    const requested = Number(c.req.query('limit') ?? 50)
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.trunc(requested))) : 50
    await options.whenRestored()
    const archived = options.registry.getAll().filter(row => row.kind === 'chat' && !!row.archivedAt)
      .sort((a, b) => (a.archivedAt! < b.archivedAt! ? 1 : a.archivedAt! > b.archivedAt! ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    const remaining = cursor ? archived.filter(row => row.archivedAt! < cursor.archivedAt ||
      (row.archivedAt === cursor.archivedAt && row.id < cursor.id)) : archived
    const rows = remaining.slice(0, limit)
    const last = rows.at(-1)
    const nextCursor = remaining.length > rows.length && last
      ? Buffer.from(JSON.stringify({ archivedAt: last.archivedAt, id: last.id })).toString('base64url') : null
    return c.json({ rows, nextCursor, archivedCount: archived.length })
  })
  routes.get('/rows', async c => {
    const ids = (c.req.query('ids') ?? '').split(',').filter(Boolean)
    if (ids.length > 100) return c.json({ error: 'At most 100 ids are allowed.' }, 400)
    await options.whenRestored()
    const rows = [], unknown: string[] = []
    for (const id of new Set(ids)) {
      const row = options.registry.get(id)
      if (row) rows.push(row)
      else unknown.push(id)
    }
    return c.json({ rows, unknown })
  })
  return routes
}
