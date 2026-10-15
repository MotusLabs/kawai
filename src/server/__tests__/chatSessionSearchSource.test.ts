import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'

/** The read-only search accessors of ChatSessionManager (chat-session-search D1). */
describe('ChatSessionManager search source', () => {
  let tempDir: string
  let db: SessionDatabase
  let registry: SessionRegistry
  let manager: ChatSessionManager | null = null
  let queryFactoryCalls = 0
  const saved = { config: process.env.CLAUDE_CONFIG_DIR, home: process.env.HOME }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-search-src-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
    queryFactoryCalls = 0
  })

  afterEach(() => {
    manager?.dispatcher.close()
    manager?.shutdown()
    manager = null
    db.close()
    if (saved.config !== undefined) process.env.CLAUDE_CONFIG_DIR = saved.config
    else delete process.env.CLAUDE_CONFIG_DIR
    if (saved.home !== undefined) process.env.HOME = saved.home
    else delete process.env.HOME
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function insert(sessionId: string, patch: Partial<ChatSessionRecord> = {}) {
    const now = new Date().toISOString()
    db.insertChatSession({
      sessionId, name: sessionId, projectPath: '/tmp/proj', sdkSessionId: null,
      status: 'waiting', createdAt: now, lastActivityAt: now, ...patch,
    })
  }

  function writeTranscript(sdkSessionId: string, ...texts: string[]) {
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${sdkSessionId}.jsonl`),
      texts.map((text, i) => JSON.stringify({
        type: 'user', uuid: `${sdkSessionId}-u${i}`, message: { role: 'user', content: text },
      })).join('\n')
    )
  }

  async function start(): Promise<ChatSessionManager> {
    registry = new SessionRegistry()
    manager = new ChatSessionManager({
      isDirectory: () => true,
      registry,
      db,
      onEvent: () => {},
      providerUsageFetch: (async () => { throw new Error('no network in tests') }) as unknown as typeof fetch,
      queryFactory: () => { queryFactoryCalls++; throw new Error('a search must not start an agent') },
    })
    await manager.whenRestored()
    return manager
  }

  test('activeRecords excludes archived chats', async () => {
    insert('live')
    insert('archived')
    db.updateChatSession('archived', { archivedAt: new Date().toISOString() })
    const m = await start()
    expect(m.activeRecords().map(record => record.sessionId)).toEqual(['live'])
  })

  test('an unloaded chat is replayed without being memoized, started, or changed', async () => {
    insert('cold', { sdkSessionId: 'sdk-cold' })
    writeTranscript('sdk-cold', 'opened PR #147')
    const m = await start()
    const before = JSON.stringify(registry.get('cold'))

    const found = await m.searchableEvents('cold')

    expect(found.readable).toBe(true)
    expect(found.events.some(event => event.type === 'user_message' && event.text === 'opened PR #147')).toBe(true)
    // Not memoized: a later attach reads the transcript afresh.
    writeTranscript('sdk-cold', 'rewritten on disk')
    const attached = m.getSnapshot('cold')?.events.flatMap(event => (event.type === 'user_message' ? [event.text] : []))
    expect(attached).toEqual(['rewritten on disk'])
    expect(JSON.stringify(registry.get('cold'))).toBe(before)
    expect(db.getChatSession('cold')?.status).toBe('waiting')
    expect(queryFactoryCalls).toBe(0)
  })

  test('a loaded chat reads its memoized history', async () => {
    insert('warm', { sdkSessionId: 'sdk-warm' })
    writeTranscript('sdk-warm', 'first mention')
    const m = await start()
    await m.loadHistory('warm')
    // The file changing afterwards does not matter: the memo is the source.
    writeTranscript('sdk-warm', 'rewritten on disk')

    const found = await m.searchableEvents('warm')

    expect(found.readable).toBe(true)
    const texts = found.events.flatMap(event => (event.type === 'user_message' ? [event.text] : []))
    expect(texts).toEqual(['first mention'])
  })

  test('a missing transcript is reported unreadable, with no placeholder events', async () => {
    insert('lost', { sdkSessionId: 'sdk-lost' })
    const m = await start()

    const found = await m.searchableEvents('lost')

    expect(found).toEqual({ events: [], readable: false })
  })

  test('a chat that never started has nothing to search and is readable', async () => {
    insert('fresh')
    const m = await start()
    expect(await m.searchableEvents('fresh')).toEqual({ events: [], readable: true })
  })

  test('an unknown session is empty and readable', async () => {
    const m = await start()
    expect(await m.searchableEvents('nope')).toEqual({ events: [], readable: true })
  })
})
