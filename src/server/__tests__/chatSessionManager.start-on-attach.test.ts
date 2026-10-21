// chatSessionManager split: start-on-attach tests.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { type ChatQueryFactory } from '../chat/ChatSessionManager'
import { anyDirectory, FakeHandle, managedManager, closeDispatchers, fakeQueryFactory, createHarness, flush, initMessage, installManagerCleanup } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

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

  describe('start on attach', () => {
    test('starts the agent without a prompt; sends reuse the same driver', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles, events } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id

      expect(await manager.start(sessionId)).toEqual({ ok: true })
      expect(handles).toHaveLength(1)
      // No prompt, no turn: the spawn alone produced no events.
      expect(events).toEqual([])
      expect(manager.getSnapshot(sessionId)?.status).toBe('waiting')

      expect(await manager.send(sessionId, 'hello')).toEqual({ ok: true })
      expect(handles).toHaveLength(1) // one driver for start + send
      expect(handles[0]!.options.cwd).toBe('/tmp/proj')
      manager.shutdown()
    })

    test('start is refused for archived sessions and starts nothing', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      manager.archive(created.session.id)
      expect(await manager.start(created.session.id)).toEqual({
        ok: false,
        error: 'This chat session is archived. Restore it to continue the conversation.',
      })
      expect(handles).toHaveLength(0)
      // The refusal text is exposed read-only for the unavailable-recipient
      // waiting reason (team-waiting-reasons D2): same text `available`
      // rejects on, null for a session that may start.
      const record = db.getChatSession(created.session.id)!
      expect(manager.startBlockerFor(record)).toBe('This chat session is archived. Restore it to continue the conversation.')
      const fresh = manager.createSession({ projectPath: '/tmp/proj' })
      if (!fresh.ok) throw new Error('create failed')
      expect(manager.startBlockerFor(db.getChatSession(fresh.session.id)!)).toBeNull()
    })

    test('start is refused when the project directory is missing', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      let exists = true
      const { manager, handles } = await createHarness(db, () => exists)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      exists = false
      expect(await manager.start(created.session.id)).toMatchObject({ ok: false })
      expect(handles).toHaveLength(0)
      // The refusal keeps the session: sending reports the same reason.
      expect((await manager.send(created.session.id, 'hi')).ok).toBe(false)
    })

    test('start is refused when the stored transcript is missing', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const dbPath = path.join(tempDir, 'start-ghost.db')
      const dbA = initDatabase({ path: dbPath })
      const harnessA = await createHarness(dbA)
      const created = harnessA.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await harnessA.manager.send(sessionId, 'one')
      harnessA.handles[0]!.push(initMessage('sdk-start-ghost'))
      await flush()
      closeDispatchers()
      dbA.close()

      // Restart with no transcript on disk: attach must not silently start a
      // fresh conversation under the stored id.
      const dbB = initDatabase({ path: dbPath })
      const harnessB = await createHarness(dbB)
      const result = await harnessB.manager.start(sessionId)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('sdk-start-ghost')
      expect(harnessB.handles).toHaveLength(0)
      closeDispatchers()
      dbB.close()
    })

    test('concurrent start and send share one driver', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      const [started, sent] = await Promise.all([
        manager.start(sessionId),
        manager.send(sessionId, 'hello'),
      ])
      expect(started).toEqual({ ok: true })
      expect(sent).toEqual({ ok: true })
      expect(handles).toHaveLength(1)
    })

    test('a spawn failure is reported as a session error and retried later', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const registry = new SessionRegistry()
      const events: Array<{ sessionId: string; event: ChatEvent }> = []
      let broken = true
      const handles: FakeHandle[] = []
      const failingFactory: ChatQueryFactory = (params) => {
        if (broken) throw new Error('spawn exploded')
        return fakeQueryFactory(handles)(params)
      }
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry,
        onEvent: (sessionId, event) => events.push({ sessionId, event }),
        queryFactory: failingFactory,
      })
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id

      expect(await manager.start(sessionId)).toEqual({ ok: true })
      await flush()
      const error = events.find((e) => e.event.type === 'error')
      expect(error?.event).toMatchObject({ message: 'The agent process failed to start: spawn exploded' })
      // The session survives the failed spawn.
      expect(db.getChatSession(sessionId)).not.toBeNull()

      // Once the spawn works again, a later start respawns.
      broken = false
      expect(await manager.start(sessionId)).toEqual({ ok: true })
      expect(handles).toHaveLength(1)
      manager.shutdown()
    })
  })

})
