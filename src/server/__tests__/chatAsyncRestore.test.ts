// Async boot restore and attach-time history (async-transcript-parsing D2/D3):
// rows land after construction and whenRestored() waits for them, log
// discovery still excludes rows that are restoring, shutdown stops a restore
// in flight, and loadHistory fills the snapshot memo once, off the event loop,
// without overwriting a synchronous capture that won the race. The attach
// race pins the snapshot-before-live-events invariant end to end.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import type { ServerMessage } from '../../shared/types'
import { ChatConnections } from '../chat/ChatConnections'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'

const TRANSCRIPT = [
  JSON.stringify({
    type: 'user', uuid: 'u1', timestamp: '2026-10-12T10:00:00.000Z',
    cwd: '/tmp/proj', message: { role: 'user', content: 'hello' },
  }),
  JSON.stringify({
    type: 'assistant', uuid: 'a1', timestamp: '2026-10-12T10:00:01.000Z',
    message: { id: 'msg_1', content: [{ type: 'text', text: 'hi' }] },
  }),
].join('\n')

describe('async chat restore and history', () => {
  let tempDir: string
  let db: SessionDatabase
  let registry: SessionRegistry
  const managers: ChatSessionManager[] = []
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-async-restore-')))
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude')
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    registry = new SessionRegistry()
  })
  afterEach(() => {
    for (const manager of managers.splice(0)) manager.shutdown()
    db.close()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const createManager = (onEvent: (sessionId: string, event: ChatEvent) => void = () => {}) => {
    const manager = new ChatSessionManager({
      db, registry, onEvent, profileCatalogHome: tempDir, authCheck: () => true,
      queryFactory: fixtureQueryFactory, isDirectory: () => true,
    })
    managers.push(manager)
    return manager
  }
  const writeTranscript = (sdkSessionId: string, content = TRANSCRIPT) => {
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${sdkSessionId}.jsonl`), content)
  }
  const seed = (sdkSessionId: string | null) => {
    const sessionId = `chat-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    db.insertChatSession({
      sessionId, name: 'seed', projectPath: '/tmp/proj', sdkSessionId,
      status: 'working', createdAt: now, lastActivityAt: now,
    })
    return sessionId
  }
  const memo = (manager: ChatSessionManager) =>
    (manager as unknown as { snapshotHistory: Map<string, ChatEvent[]> }).snapshotHistory

  test('rows land after construction; whenRestored resolves once all are in', async () => {
    writeTranscript('sdk-a')
    const a = seed('sdk-a')
    const b = seed(null)
    const manager = createManager()
    // The constructor returned before any transcript was read.
    expect(manager.has(a)).toBe(false)
    await manager.whenRestored()
    expect(manager.has(a) && manager.has(b)).toBe(true)
    expect(registry.get(a)?.status).toBe('waiting')
    expect(db.getChatSession(a)?.status).toBe('waiting')
  })

  test('log discovery excludes the SDK ids of rows still restoring', async () => {
    writeTranscript('sdk-a')
    seed('sdk-a')
    seed('sdk-b')
    const manager = createManager()
    expect([...manager.getSdkSessionIds()].sort()).toEqual(['sdk-a', 'sdk-b'])
    await manager.whenRestored()
    expect([...manager.getSdkSessionIds()].sort()).toEqual(['sdk-a', 'sdk-b'])
  })

  test('shutdown stops a restore in flight', async () => {
    writeTranscript('sdk-a')
    const a = seed('sdk-a')
    const manager = createManager()
    manager.shutdown()
    await manager.whenRestored()
    expect(manager.has(a)).toBe(false)
    expect(manager.getSdkSessionIds().size).toBe(0)
  })

  test('loadHistory fills the snapshot memo once from one async read', async () => {
    writeTranscript('sdk-a')
    const a = seed('sdk-a')
    const manager = createManager()
    await manager.whenRestored()
    const reads = spyOn(fsp, 'readFile')
    try {
      await Promise.all([manager.loadHistory(a), manager.loadHistory(a)])
      await manager.loadHistory(a)
      const transcriptReads = reads.mock.calls.filter(call => String(call[0]).endsWith('sdk-a.jsonl'))
      expect(transcriptReads).toHaveLength(1)
    } finally { reads.mockRestore() }
    const snapshot = manager.getSnapshot(a)
    expect(snapshot?.events.map(event => event.type)).toEqual(['user_message', 'assistant_text'])
    expect(snapshot?.events).toEqual(manager.getHistory(a)?.events ?? [])
  })

  test('a synchronous capture that wins the race keeps its result', async () => {
    writeTranscript('sdk-a')
    const a = seed('sdk-a')
    const manager = createManager()
    await manager.whenRestored()
    const loading = manager.loadHistory(a)
    manager.getSnapshot(a)
    const captured = memo(manager).get(a)
    expect(captured).toHaveLength(2)
    // A live cwd change after synchronous capture must beat the older
    // transcript still being read by the asynchronous load.
    const liveCwd = '/tmp/proj/new-worktree'
    ;(manager as unknown as { handleDriverCwdChanged(id: string, cwd: string): void })
      .handleDriverCwdChanged(a, liveCwd)
    await loading
    expect(memo(manager).get(a)).toBe(captured!)
    expect(registry.get(a)?.projectPath).toBe(liveCwd)
    expect(db.getChatSession(a)?.projectPath).toBe(liveCwd)
  })

  test('kill during a history load leaves no memo behind', async () => {
    writeTranscript('sdk-a')
    const a = seed('sdk-a')
    const manager = createManager()
    await manager.whenRestored()
    const loading = manager.loadHistory(a)
    expect(manager.kill(a)).toBe(true)
    await loading
    expect(memo(manager).has(a)).toBe(false)
    expect(manager.getSnapshot(a)).toBeNull()
  })

  test('a chat-attach concurrent with a live assistant_delta still gets the delta after the snapshot', async () => {
    let connections: ChatConnections | null = null
    const manager = createManager((sessionId, event) => connections?.publish(sessionId, event))
    connections = new ChatConnections(manager)
    await manager.whenRestored()
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    // Client A attaches first and starts the agent: the memo is captured.
    const first: ServerMessage[] = []
    await connections.handle({ send: message => first.push(message) }, { type: 'chat-attach', sessionId: id })
    // The driver's event callback, invoked exactly as a streaming turn would.
    const emit = (sequence: number) =>
      (manager as unknown as { handleDriverEvent(id: string, event: ChatEvent): void }).handleDriverEvent(id, {
        type: 'assistant_delta', id: `delta-${sequence}`, sequence: 0, at: 'now',
        turnId: 'turn-1', messageId: 'message-1', delta: `${sequence}`,
      })
    // Client B attaches while deltas stream: one lands while its history load
    // is pending, one after the load but before the snapshot is assembled.
    const load = manager.loadHistory.bind(manager)
    manager.loadHistory = async sessionId => {
      const pending = load(sessionId)
      emit(1)
      await pending
      emit(2)
    }
    const second: ServerMessage[] = []
    const attaching = connections.handle({ send: message => second.push(message) }, { type: 'chat-attach', sessionId: id })
    emit(0)
    await attaching
    emit(3)
    await new Promise(resolve => setTimeout(resolve, 5))

    const deltas = (events: ChatEvent[]) =>
      events.flatMap(event => event.type === 'assistant_delta' ? [event.delta] : [])
    const received = second.flatMap((message): Array<{ snapshot: string[] } | { live: string[] }> =>
      message.type === 'chat-snapshot' && message.sessionId === id ? [{ snapshot: deltas(message.events) }]
        : message.type === 'chat-events' && message.sessionId === id ? [{ live: deltas(message.events) }]
          : [])
    // Every delta exactly once, in order, and none before the snapshot.
    expect(received).toEqual([{ snapshot: ['0', '1', '2'] }, { live: ['3'] }])
    // Client A, subscribed throughout, saw the same deltas live.
    const firstLive = first.flatMap(message => message.type === 'chat-events' ? deltas(message.events) : [])
    expect(firstLive).toEqual(['0', '1', '2', '3'])
  })
})
