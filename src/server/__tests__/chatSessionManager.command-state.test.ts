import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { anyDirectory, FakeHandle, managedManager, closeDispatchers, fakeQueryFactory, flush, installManagerCleanup } from './helpers/chatSessionManagerHarness'

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

  describe('command state delivery', () => {
    test('snapshot carries the live driver state; pushes fire on change and archive', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const registry = new SessionRegistry()
      const handles: FakeHandle[] = []
      const events: Array<{ sessionId: string; event: ChatEvent }> = []
      const commandStates: Array<{ sessionId: string; status: string }> = []
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry,
        onEvent: (sessionId, event) => events.push({ sessionId, event }),
        onCommandState: (sessionId, state) =>
          commandStates.push({ sessionId, status: state.status }),
        queryFactory: fakeQueryFactory(handles),
      })
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id

      // Before any spawn: unavailable, no special-casing on the client.
      expect(manager.getSnapshot(sessionId)?.commands).toEqual({
        status: 'unavailable',
        commands: [],
      })

      await manager.start(sessionId)
      await flush()
      expect(commandStates).toEqual([{ sessionId, status: 'loading' }])

      handles[0]!.push({
        type: 'system',
        subtype: 'commands_changed',
        commands: [{ name: 'usage', description: 'costs', builtin: true }],
      } as unknown as SDKMessage)
      await flush()
      expect(commandStates.at(-1)).toEqual({ sessionId, status: 'ready' })
      expect(manager.getSnapshot(sessionId)?.commands).toEqual({
        status: 'ready',
        commands: [{ name: 'usage', description: 'costs', aliases: [], source: 'builtin' }],
      })

      manager.archive(sessionId)
      await flush()
      expect(commandStates.at(-1)).toEqual({ sessionId, status: 'unavailable' })
      expect(manager.getSnapshot(sessionId)?.commands.status).toBe('unavailable')
      manager.shutdown()
    })

    test('blocked starts publish no command state', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const registry = new SessionRegistry()
      const commandStates: string[] = []
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry,
        onEvent: () => {},
        onCommandState: (_sessionId, state) => commandStates.push(state.status),
        queryFactory: fakeQueryFactory([]),
      })
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      manager.archive(created.session.id)
      expect(await manager.start(created.session.id)).toMatchObject({ ok: false })
      await flush()
      expect(commandStates).toEqual([])
      manager.shutdown()
    })
  })

})
