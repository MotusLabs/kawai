import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Session } from '../../shared/types'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatWireLogs } from '../chat/ChatWireLogs'
import { anyDirectory, FakeHandle, managedManager, closeDispatchers, fakeQueryFactory, createHarness, flush, initMessage, writeTranscript, waitForCondition } from './helpers/chatSessionManagerHarness'

describe('ChatSessionManager', () => {

  let tempDir: string
  let db: SessionDatabase

  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalHome = process.env.HOME

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    // Isolate auth from the host: no API key, empty CLI config dir. HOME is
    // pinned so the profile catalog resolves against an empty home — a real
    // ~/.kawai must not leak into these tests.
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
  })

  afterEach(() => {
    if (originalOAuthToken !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    }
    if (originalAuthToken !== undefined) {
      process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken
    } else {
      delete process.env.ANTHROPIC_AUTH_TOKEN
    }
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
    if (originalConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
    closeDispatchers()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('archive and restore', () => {
    test('archiving an idle session keeps record, conversation, and protocol log', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const wireLogs = new ChatWireLogs({ dir: path.join(tempDir, 'chat-wire') })
      const handles: FakeHandle[] = []
      const registry = new SessionRegistry()
      const updates: Array<Session | undefined> = []
      registry.on('session-update', (session) => updates.push(session))
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry, onEvent: () => {},
        queryFactory: fakeQueryFactory(handles), wireLogs,
      })
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await manager.send(sessionId, 'one')
      handles[0]!.push(initMessage('sdk-archived'))
      await flush()
      handles[0]!.wire!.record('in', '{"type":"system"}')
      await flush()
      // The append is scheduled on a timer; wait for it deterministically.
      await wireLogs.get(sessionId).flush()

      expect(manager.archive(sessionId)).toEqual({ ok: true })
      expect(handles[0]!.closed).toBe(true)
      // Record, conversation id, and protocol log all survive.
      const row = db.getChatSession(sessionId)!
      expect(row.archivedAt).toBeTruthy()
      expect(row.sdkSessionId).toBe('sdk-archived')
      expect(row.status).toBe('waiting')
      expect(fs.existsSync(wireLogs.get(sessionId).currentPath)).toBe(true)
      expect(manager.getSnapshot(sessionId)).not.toBeNull()
      const published = registry.get(sessionId)
      expect(published?.archivedAt).toBe(row.archivedAt)
      expect(updates.at(-1)?.archivedAt).toBe(row.archivedAt)

      // A second archive is a harmless idempotent no-op.
      expect(manager.archive(sessionId)).toEqual({ ok: true })
    })

    test('archiving an in-flight turn cancels pending requests and reports them to subscribers', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles, events, registry } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await manager.send(sessionId, 'work')
      const handle = handles[0]!
      const approval = handle.options.canUseTool!(
        'Bash',
        { command: 'ls' },
        { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' }
      )
      await flush()
      expect(registry.get(sessionId)?.status).toBe('permission')
      expect(manager.getPendingRequests(sessionId)).toHaveLength(1)

      expect(manager.archive(sessionId)).toEqual({ ok: true })
      await flush()
      await expect(approval).resolves.toMatchObject({ behavior: 'deny' })
      const types = events
        .filter((e) => e.sessionId === sessionId)
        .map((e) => e.event.type)
      expect(types).toContain('request_resolved')
      expect(
        events.some(
          (e) =>
            e.sessionId === sessionId &&
            e.event.type === 'request_resolved' &&
            e.event.outcome === 'cancelled'
        )
      ).toBe(true)
      expect(types).toContain('turn_interrupted')
      expect(registry.get(sessionId)?.status).toBe('waiting')
      expect(manager.getPendingRequests(sessionId)).toEqual([])
      expect(handle.closed).toBe(true)
    })

    test('send to an archived session is refused and starts no driver', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      manager.archive(sessionId)
      const result = await manager.send(sessionId, 'hello?')
      expect(result).toEqual({
        ok: false,
        error: 'This chat session is archived. Restore it to continue the conversation.',
      })
      expect(handles).toHaveLength(0)
    })

    test('a driver import racing archive never starts the process', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      // First send starts the in-flight driver promise (import resolving);
      // archive lands before it completes. ensureDriver must discard the
      // driver instead of registering it.
      const sendPromise = manager.send(sessionId, 'race')
      manager.archive(sessionId)
      await sendPromise
      await flush()
      expect(handles.every((handle) => handle.closed)).toBe(true)
      expect(db.getChatSession(sessionId)?.archivedAt).toBeTruthy()
      // Still archived and driverless afterwards.
      expect((await manager.send(sessionId, 'again')).ok).toBe(false)
      const started = handles.filter((handle) => !handle.closed)
      expect(started).toHaveLength(0)
    })

    test('restore clears archived_at and the next send resumes the stored conversation', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles, registry } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await manager.send(sessionId, 'first')
      handles[0]!.push(initMessage('sdk-resume-after-archive'))
      await flush()
      manager.archive(sessionId)
      expect(registry.get(sessionId)?.archivedAt).toBeTruthy()

      expect(manager.restore(sessionId)).toEqual({ ok: true })
      expect(db.getChatSession(sessionId)?.archivedAt).toBeNull()
      // The published session carries archivedAt: null (falsy = live).
      expect(registry.get(sessionId)?.archivedAt).toBeNull()
      // Resume needs the transcript on disk (the resume gate).
      writeTranscript('sdk-resume-after-archive', '[]')
      expect((await manager.send(sessionId, 'continue')).ok).toBe(true)
      expect(handles[1]!.options.resume).toBe('sdk-resume-after-archive')
      // Restoring an unarchived session is a harmless no-op.
      expect(manager.restore(sessionId)).toEqual({ ok: true })
    })

    test('archived sessions survive a manager restart as archived, idle, and driverless', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const wireLogs = new ChatWireLogs({ dir: path.join(tempDir, 'chat-wire') })
      const handles: FakeHandle[] = []
      const managerA = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        queryFactory: fakeQueryFactory(handles), wireLogs,
      })
      const created = managerA.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await managerA.send(sessionId, 'one')
      handles[0]!.push(initMessage('sdk-restart-archived'))
      await flush()
      handles[0]!.wire!.record('in', '{"type":"system"}')
      await flush()
      managerA.archive(sessionId)
      const archivedAt = db.getChatSession(sessionId)!.archivedAt!
      managerA.shutdown()

      // "Restart": fresh registry and manager on the same database and logs.
      const handlesB: FakeHandle[] = []
      const registryB = new SessionRegistry()
      const managerB = await managedManager({
        isDirectory: anyDirectory,
        db, registry: registryB, onEvent: () => {},
        queryFactory: fakeQueryFactory(handlesB), wireLogs,
      })
      expect(registryB.get(sessionId)?.archivedAt).toBe(archivedAt)
      expect(registryB.get(sessionId)?.status).toBe('waiting')
      // Attach replays the transcript snapshot without starting a driver.
      expect(managerB.getSnapshot(sessionId)?.events.length).toBeGreaterThanOrEqual(0)
      expect(handlesB).toHaveLength(0)
      // Send is refused while archived even after restart.
      expect((await managerB.send(sessionId, 'nope')).ok).toBe(false)
      expect(handlesB).toHaveLength(0)

      // Kill on an archived session removes row and protocol log.
      const logFile = wireLogs.get(sessionId).currentPath
      // The append is scheduled on a timer; wait for it deterministically.
      await wireLogs.get(sessionId).flush()
      expect(fs.existsSync(logFile)).toBe(true)
      expect(managerB.kill(sessionId)).toBe(true)
      // Deletion runs on the log's async chain; poll instead of trusting fixed timers.
      await waitForCondition(() => !fs.existsSync(logFile))
      expect(db.getChatSession(sessionId)).toBeNull()
      expect(registryB.get(sessionId)).toBeUndefined()
      managerB.shutdown()
    })

    test('archive and restore on unknown sessions return actionable errors', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager } = await createHarness(db)
      expect(manager.archive('chat-none')).toEqual({
        ok: false,
        error: 'Unknown chat session chat-none',
      })
      expect(manager.restore('chat-none')).toEqual({
        ok: false,
        error: 'Unknown chat session chat-none',
      })
    })
  })

})
