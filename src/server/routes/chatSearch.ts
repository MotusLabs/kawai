// Conversation search across active chat sessions (chat-session-search D3):
// GET /api/chat/search?q=<query>. Read-only — it never starts an agent or
// changes a session. A query outside the shared bounds is a 400, mirroring
// the client's own guard.
import { Hono } from 'hono'
import { normalizeSearchQuery } from '../../shared/sessionSearch'
import { searchActiveSessions, type SearchSource } from '../chat/sessionSearchWalker'

export function createChatSearchRoutes(options: { source: SearchSource }) {
  const routes = new Hono()
  routes.get('/', async c => {
    const query = normalizeSearchQuery(c.req.query('q') ?? '')
    if (query === null) return c.json({ error: 'Query must be 2 to 200 characters.' }, 400)
    return c.json(await searchActiveSessions(options.source, query))
  })
  return routes
}
