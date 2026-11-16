// Synthetic data only, run by Bun before the fixture server starts.
import { initDatabase } from '../../../src/server/db'
import { join, resolve } from 'node:path'
const [dbPath, root, countText] = process.argv.slice(2)
if (!root || !dbPath || !resolve(dbPath).startsWith(resolve(root) + '/')) throw new Error('Refuse non-private archive seed')
const count = Number(countText ?? 120)
const liveCount = Number(process.argv[5] ?? 7)
const db = initDatabase({ path: dbPath })
for (let i = 0; i < count; i++) {
  db.insertChatSession({ sessionId: `chat-archive-${String(i).padStart(4, '0')}`, name: `Archived fixture ${i}`,
    projectPath: root, sdkSessionId: null, status: 'waiting', createdAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-01T00:00:00Z' })
  db.updateChatSession(`chat-archive-${String(i).padStart(4, '0')}`, { archivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() })
}
// Live rows have the same project shape; no real history or credentials.
for (let i = 0; i < liveCount; i++) db.insertChatSession({ sessionId: `chat-live-${i}`, name: `Live fixture ${i}`,
  projectPath: root, sdkSessionId: null, status: 'waiting', createdAt: '2026-01-01T00:00:00Z', lastActivityAt: '2026-01-01T00:00:00Z' })
const persisted = db.getChatSessions()
if (persisted.length !== count + liveCount || persisted.filter(row => !!row.archivedAt).length !== count) throw new Error('Archive seed did not persist the requested state')
db.close()
console.log(JSON.stringify({ archived: count, live: liveCount, db: join(root, 'agentboard.db') }))
