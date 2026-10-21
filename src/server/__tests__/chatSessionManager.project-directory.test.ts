// chatSessionManager split: project-directory tests.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { managedManager, closeDispatchers, createHarness, flush, installManagerCleanup } from './helpers/chatSessionManagerHarness'

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

  describe('project directory', () => {
    test('creation refuses a path that is not an existing directory, with no side effects', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const registry = new SessionRegistry()
      // No isDirectory override: the real filesystem check runs.
      const manager = await managedManager({ db, registry, onEvent: () => {} })
      const file = path.join(tempDir, 'file.txt')
      fs.writeFileSync(file, '')
      for (const projectPath of [
        path.join(tempDir, 'missing'),
        `${tempDir} (deleted)`,
        file,
      ]) {
        expect(manager.createSession({ projectPath })).toEqual({
          ok: false,
          error: `Project directory does not exist: ${projectPath}`,
        })
      }
      expect(registry.getAll()).toHaveLength(0)
      expect(db.getChatSessions()).toHaveLength(0)
      expect(manager.createSession({ projectPath: `  ${tempDir}  ` }).ok).toBe(true)
    })

    test('a home-relative path is checked and stored as an absolute path', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const checked: string[] = []
      const { manager } = await createHarness(db, (dir) => {
        checked.push(dir)
        return true
      })
      const result = manager.createSession({ projectPath: '~/work/app' })
      if (!result.ok) throw new Error('create failed')
      const expected = path.join(os.homedir(), 'work', 'app')
      expect(checked).toEqual([expected])
      expect(result.session.projectPath).toBe(expected)
      expect(db.getChatSession(result.session.id)?.projectPath).toBe(expected)
    })

    test('availability-checked creation refuses a missing directory before probing', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      let probes = 0
      const manager = await managedManager({
        isDirectory: () => false,
        db, registry: new SessionRegistry(), onEvent: () => {},
        availabilityProbe: async () => { probes++ },
      })
      expect(await manager.createAvailableSession({ projectPath: '/tmp/gone (deleted)' })).toEqual({
        ok: false,
        error: 'Project directory does not exist: /tmp/gone (deleted)',
      })
      expect(probes).toBe(0)
      expect(db.getChatSessions()).toHaveLength(0)
    })

    test('send refuses to spawn when the directory disappeared, keeping the session', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      let exists = true
      const { manager, registry, handles, events } = await createHarness(db, () => exists)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id

      exists = false
      expect(await manager.send(sessionId, 'Hi')).toEqual({
        ok: false,
        error:
          'Cannot start the agent: the project directory /tmp/proj no longer exists. ' +
          'Create a new chat session in an existing directory.',
      })
      expect(handles).toHaveLength(0)
      expect(events).toHaveLength(0)
      expect(registry.get(sessionId)?.status).toBe('waiting')
      expect(db.getChatSession(sessionId)).not.toBeNull()
      expect(manager.getSnapshot(sessionId)?.events).toEqual([])

      // Restoring the directory makes the session usable again.
      exists = true
      expect(await manager.send(sessionId, 'Hi')).toEqual({ ok: true })
      expect(handles).toHaveLength(1)
    })

    test('a live driver is not blocked by the check; a crashed one is', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      let exists = true
      const { manager, handles } = await createHarness(db, () => exists)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      expect(await manager.send(sessionId, 'first')).toEqual({ ok: true })

      // The running process keeps its cwd, so later turns still go through.
      exists = false
      expect(await manager.send(sessionId, 'second')).toEqual({ ok: true })
      expect(handles).toHaveLength(1)

      // Once the process dies, a respawn would need the directory.
      handles[0]!.query.close()
      await flush()
      const result = await manager.send(sessionId, 'third')
      expect(result.ok).toBe(false)
      expect(handles).toHaveLength(1)
    })
  })

})
