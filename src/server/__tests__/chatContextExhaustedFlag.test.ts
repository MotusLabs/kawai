// The context-exhausted flag in the manager (chat-context-exhaustion D3): a
// failed turn with an exhausting terminal reason flags its session; other
// failures never do; the flag persists across restart, archive, and restore;
// a compaction notice or a successful turn clears it; the wire session
// carries it.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'

let tempDir: string
let project: string
let home: string
let dbPath: string
let db: SessionDatabase
const originalApiKey = process.env.ANTHROPIC_API_KEY

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-chat-exhausted-')))
  project = path.join(tempDir, 'project')
  home = path.join(tempDir, 'home')
  fs.mkdirSync(project, { recursive: true })
  dbPath = path.join(tempDir, 'test.db')
  db = initDatabase({ path: dbPath })
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
})

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

const createManager = (registry = new SessionRegistry()) => new ChatSessionManager({
  db, registry, onEvent: () => {}, profileCatalogHome: home, availabilityProbe: async () => {},
})

type Feed = (sessionId: string, event: Record<string, unknown>) => void
const feeder = (manager: ChatSessionManager): Feed =>
  (manager as unknown as { handleDriverEvent: Feed }).handleDriverEvent.bind(manager)

let seq = 0
const completed = (fields: Record<string, unknown>) => ({
  type: 'turn_completed', id: `e-${++seq}`, sequence: seq, turnId: `t-${seq}`, at: '2026-10-18T08:28:01Z', ...fields,
})

async function session(manager: ChatSessionManager): Promise<string> {
  const result = await manager.createAvailableSession({ projectPath: project })
  if (!result.ok) throw new Error(result.error)
  return result.session.id
}

test.each(['prompt_too_long', 'blocking_limit', 'rapid_refill_breaker'])('a failed turn ending %s flags the session', async reason => {
  const registry = new SessionRegistry()
  const manager = createManager(registry)
  try {
    const id = await session(manager)
    feeder(manager)(id, completed({ subtype: 'success', isError: true, terminalReason: reason }))
    expect(db.getChatSession(id)?.contextExhausted).toEqual({ at: '2026-10-18T08:28:01Z', reason })
    expect(registry.get(id)?.contextExhausted).toEqual({ at: '2026-10-18T08:28:01Z', reason })
  } finally { manager.shutdown() }
})

test('other failures and successes never flag; an unknown reason never flags', async () => {
  const manager = createManager()
  try {
    const id = await session(manager)
    const feed = feeder(manager)
    feed(id, completed({ subtype: 'error_max_turns', isError: true, terminalReason: 'max_turns' }))
    feed(id, completed({ subtype: 'success', isError: true, terminalReason: 'api_error' }))
    feed(id, completed({ subtype: 'success', isError: true, terminalReason: 'some_future_reason' }))
    feed(id, completed({ subtype: 'success', isError: true }))
    // A success subtype carrying an exhausting reason without is_error succeeded.
    feed(id, completed({ subtype: 'success', isError: false, terminalReason: 'prompt_too_long' }))
    expect(db.getChatSession(id)?.contextExhausted).toBeNull()
  } finally { manager.shutdown() }
})

test('the flag survives restart, archive, and restore', async () => {
  const first = createManager()
  let id: string
  try {
    id = await session(first)
    feeder(first)(id, completed({ subtype: 'success', isError: true, terminalReason: 'blocking_limit' }))
  } finally { first.shutdown() }
  const registry = new SessionRegistry()
  const second = createManager(registry)
  try {
    const flag = { at: '2026-10-18T08:28:01Z', reason: 'blocking_limit' }
    expect(db.getChatSession(id)?.contextExhausted).toEqual(flag)
    expect(registry.get(id)?.contextExhausted).toEqual(flag)
    expect(second.archive(id).ok).toBe(true)
    expect(db.getChatSession(id)?.contextExhausted).toEqual(flag)
    expect(second.restore(id).ok).toBe(true)
    expect(db.getChatSession(id)?.contextExhausted).toEqual(flag)
  } finally { second.shutdown() }
})

test('a compaction notice clears the flag; so does a successful turn', async () => {
  const registry = new SessionRegistry()
  const manager = createManager(registry)
  try {
    const id = await session(manager)
    const feed = feeder(manager)
    const flag = () => feed(id, completed({ subtype: 'success', isError: true, terminalReason: 'prompt_too_long' }))

    flag()
    // A notice of another kind leaves it.
    feed(id, { type: 'notice', id: 'n-0', sequence: 0, at: '2026-10-18T09:00:00Z', text: 'Something else' })
    expect(db.getChatSession(id)?.contextExhausted).not.toBeNull()
    feed(id, { type: 'notice', id: 'n-1', sequence: 0, at: '2026-10-18T09:00:00Z', text: 'Context compacted', kind: 'compacted' })
    expect(db.getChatSession(id)?.contextExhausted).toBeNull()
    expect(registry.get(id)?.contextExhausted).toBeNull()

    flag()
    expect(db.getChatSession(id)?.contextExhausted).not.toBeNull()
    feed(id, completed({ subtype: 'success', isError: false }))
    expect(db.getChatSession(id)?.contextExhausted).toBeNull()
  } finally { manager.shutdown() }
})
