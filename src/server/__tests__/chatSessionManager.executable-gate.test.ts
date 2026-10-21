import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ClaudeExecutableError } from '../chat/claudeExecutable'
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

  describe('executable gate', () => {
    test('refuses creation with the executable error verbatim and persists nothing', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const registry = new SessionRegistry()
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry, onEvent: () => {},
        executableCheck: () => Promise.reject(
          new ClaudeExecutableError('missing', 'No Claude Code executable found. Install Claude Code.')
        ),
      })
      const result = await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      expect(result).toEqual({ ok: false, error: 'No Claude Code executable found. Install Claude Code.' })
      expect(db.getChatSessions()).toEqual([])
      expect(registry.getAll().filter((session) => session.kind === 'chat')).toEqual([])
    })

    test('creation re-checks after an executable failure and recovers', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let checks = 0
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        availabilityProbe: async () => {},
        executableCheck: async () => {
          checks += 1
          if (checks === 1) throw new ClaudeExecutableError('missing', 'No Claude Code executable found.')
          return { path: '/opt/claude', identity: 'id-1' }
        },
      })
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(false)
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(true)
      expect(checks).toBe(2)
    })

    test('an upgraded executable re-runs the handshake; an unchanged one reuses it', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let checks = 0
      let probes = 0
      const probedPaths: Array<string | undefined> = []
      let identity = 'id-1'
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        executableCheck: async () => {
          checks += 1
          return { path: '/opt/claude', identity }
        },
        availabilityProbe: async (_env, _launch, executablePath) => {
          probes += 1
          probedPaths.push(executablePath)
        },
      })
      await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      expect(probes).toBe(1)
      expect(probedPaths[0]).toBe('/opt/claude')

      // Same executable identity: the version check runs again, the cached
      // handshake is reused.
      await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      expect(checks).toBe(2)
      expect(probes).toBe(1)

      // An upgrade at the same path (new identity) re-runs the handshake too.
      identity = 'id-2'
      await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      expect(checks).toBe(3)
      expect(probes).toBe(2)
      expect(probedPaths[1]).toBe('/opt/claude')
    })

    test('a send after the executable disappears is refused with the record intact', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const { manager, handles } = await createHarness(db)
      let available = true
      const gated = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        queryFactory: fakeQueryFactory(handles),
        executableCheck: async () => {
          if (!available) throw new ClaudeExecutableError('missing', `Claude Code executable not found at /opt/claude.`)
          return { path: '/opt/claude', identity: 'id-1' }
        },
      })
      const created = await gated.createAvailableSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('creation should succeed')
      expect((await gated.send(created.session.id, 'first turn')).ok).toBe(true)
      handles[0]!.push(initMessage('sdk-session-9'))
      await flush()
      // The agent dies (process exit); the executable then disappears.
      handles[0]!.query.close()
      await flush()
      available = false
      const refused = await gated.send(created.session.id, 'second turn')
      expect(refused).toEqual({ ok: false, error: 'Claude Code executable not found at /opt/claude.' })
      expect(gated.has(created.session.id)).toBe(true)
      expect(manager.has(created.session.id)).toBe(false)
      expect(db.getChatSessions().map((row) => row.sdkSessionId)).toEqual(['sdk-session-9'])
      // History reading still answers (the transcript file never existed in
      // this fixture; the stored identity that locates it is intact).
      expect(gated.getHistory(created.session.id)).not.toBeNull()
    })

    test('a respawn uses the freshly verified path when the executable moved', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const handles: FakeHandle[] = []
      let current = '/old/claude'
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        queryFactory: fakeQueryFactory(handles),
        executableCheck: async () => ({ path: current, identity: current }),
      })
      const created = await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('creation should succeed')
      expect((await manager.send(created.session.id, 'first')).ok).toBe(true)
      expect(handles[0]!.options.pathToClaudeCodeExecutable).toBe('/old/claude')

      // The agent dies; the CLI moves and PATH now resolves a replacement.
      handles[0]!.query.close()
      await flush()
      current = '/new/claude'
      expect((await manager.send(created.session.id, 'second')).ok).toBe(true)
      expect(handles).toHaveLength(2)
      expect(handles[1]!.options.pathToClaudeCodeExecutable).toBe('/new/claude')
    })

    test('an injected queryFactory skips the executable check entirely', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const original = process.env.KAWAI_CLAUDE_PATH
      process.env.KAWAI_CLAUDE_PATH = '/nonexistent-claude'
      try {
        const { manager } = await createHarness(db)
        const result = await manager.createAvailableSession({ projectPath: '/tmp/proj' })
        expect(result.ok).toBe(true)
      } finally {
        if (original === undefined) delete process.env.KAWAI_CLAUDE_PATH
        else process.env.KAWAI_CLAUDE_PATH = original
      }
    })
  })

})
