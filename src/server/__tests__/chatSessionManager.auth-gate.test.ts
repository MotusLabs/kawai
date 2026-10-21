import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { hasClaudeAuth } from '../chat/ChatSessionManager'
import { anyDirectory, writeCredentialedProviderCatalog, FakeHandle, managedManager, closeDispatchers, fakeQueryFactory, createHarness, flush } from './helpers/chatSessionManagerHarness'

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

  describe('auth gate', () => {
    test('failed availability probe disables creation without creating a driver or row', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let probes = 0
      const registry = new SessionRegistry()
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry, onEvent: () => {},
        availabilityProbe: async () => { probes++; throw new Error('broken runtime') },
      })
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await manager.createAvailableSession({ projectPath: '/tmp/proj' })
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error).toContain('Claude Agent SDK is unavailable')
          expect(result.error).toContain('try again')
        }
      }
      // Failures are not cached: each attempt re-probes.
      expect(probes).toBe(2)
      expect(db.getChatSessions()).toHaveLength(0)
      expect(registry.getAll()).toHaveLength(0)
    })

    test('a probe that failed recovers once the provider environment is corrected', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let providerEnv: Record<string, string> = { ANTHROPIC_BASE_URL: 'https://broken.example' }
      const probed: string[] = []
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        availabilityProbe: async (env) => {
          probed.push(env.ANTHROPIC_BASE_URL ?? '')
          if (env.ANTHROPIC_BASE_URL === 'https://broken.example') throw new Error('unreachable')
        },
        getProviderEnv: () => providerEnv,
      })
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(false)
      providerEnv = { ANTHROPIC_BASE_URL: 'https://fixed.example' }
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(true)
      expect(probed).toEqual(['https://broken.example', 'https://fixed.example'])
    })

    test('a provider change re-probes; the same configuration (any key order) reuses the probe', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let providerEnv: Record<string, string> = { A: '1', B: '2' }
      let probes = 0
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        availabilityProbe: async () => { probes++ },
        getProviderEnv: () => providerEnv,
      })
      await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      providerEnv = { B: '2', A: '1' }
      await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      expect(probes).toBe(1)
      providerEnv = { A: '1', B: '3' }
      await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      expect(probes).toBe(2)
    })

    test('concurrent creations share one in-flight probe', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let probes = 0
      let release!: () => void
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        availabilityProbe: () => { probes++; return new Promise<void>((resolve) => { release = resolve }) },
      })
      const first = manager.createAvailableSession({ projectPath: '/tmp/proj' })
      const second = manager.createAvailableSession({ projectPath: '/tmp/proj' })
      // The executable check precedes the probe, so let it start first.
      await flush()
      release()
      expect((await first).ok).toBe(true)
      expect((await second).ok).toBe(true)
      expect(probes).toBe(1)
    })

    test('successful availability probe is cached for subsequent creations', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let probes = 0
      const registry = new SessionRegistry()
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry, onEvent: () => {},
        availabilityProbe: async () => { probes++ },
      })
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(true)
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(true)
      expect(probes).toBe(1)
    })
    test('refuses creation with an actionable error when no auth exists', async () => {
      const { manager, registry } = await createHarness(db)
      const result = manager.createSession({ projectPath: '/tmp/proj' })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('ANTHROPIC_API_KEY')
        expect(result.error).toContain('claude login')
      }
      // No side effects: nothing registered, nothing persisted.
      expect(registry.getAll()).toHaveLength(0)
      expect(db.getChatSessions()).toHaveLength(0)
      expect(hasClaudeAuth()).toBe(false)
    })

    test('accepts ANTHROPIC_API_KEY from the environment', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      expect(hasClaudeAuth()).toBe(true)
      const { manager } = await createHarness(db)
      expect(manager.createSession({ projectPath: '/tmp/proj' }).ok).toBe(true)
    })

    test('accepts an OAuth token from the environment', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const { manager } = await createHarness(db)
      expect(hasClaudeAuth()).toBe(true)
      expect(manager.createSession({ projectPath: '/tmp/proj' }).ok).toBe(true)
    })

    test('accepts ANTHROPIC_AUTH_TOKEN from the environment', () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-token'
      expect(hasClaudeAuth()).toBe(true)
    })

    test('evaluates credentials against the provider environment', () => {
      expect(hasClaudeAuth({ ANTHROPIC_AUTH_TOKEN: 'gateway-token' })).toBe(true)
      expect(hasClaudeAuth({ ANTHROPIC_API_KEY: 'sk-provider' })).toBe(true)
      // An override can also blank an inherited credential.
      process.env.ANTHROPIC_API_KEY = 'sk-host'
      expect(hasClaudeAuth({ ANTHROPIC_API_KEY: '' })).toBe(false)
      // And redirect the CLI config dir to one with stored credentials.
      const providerConfig = path.join(tempDir, 'provider-config')
      fs.mkdirSync(providerConfig, { recursive: true })
      fs.writeFileSync(path.join(providerConfig, '.credentials.json'), '{}')
      delete process.env.ANTHROPIC_API_KEY
      expect(hasClaudeAuth({ CLAUDE_CONFIG_DIR: providerConfig })).toBe(true)
    })

    test('a credential supplied only by getProviderEnv allows creation', async () => {
      const registry = new SessionRegistry()
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry, onEvent: () => {},
        queryFactory: fakeQueryFactory([]),
        getProviderEnv: () => ({ ANTHROPIC_AUTH_TOKEN: 'gateway-token' }),
      })
      expect(manager.createSession({ projectPath: '/tmp/proj' }).ok).toBe(true)
    })

    test('the availability probe runs under the provider environment', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const probed: Array<Record<string, string>> = []
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        availabilityProbe: async (providerEnv) => { probed.push(providerEnv) },
        getProviderEnv: () => ({ ANTHROPIC_BASE_URL: 'https://gw.example/a' }),
      })
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(true)
      expect(probed).toEqual([{ ANTHROPIC_BASE_URL: 'https://gw.example/a' }])
    })

    test('rejects a blank OAuth token', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = '   '
      expect(hasClaudeAuth()).toBe(false)
    })

    test('accepts CLI credentials under CLAUDE_CONFIG_DIR', async () => {
      fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true })
      fs.writeFileSync(
        path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'),
        '{}'
      )
      expect(hasClaudeAuth()).toBe(true)
      const { manager } = await createHarness(db)
      expect(manager.createSession({ projectPath: '/tmp/proj' }).ok).toBe(true)
    })

    test('a credentialed provider needs its own key variable, whatever host login exists', async () => {
      writeCredentialedProviderCatalog(tempDir)
      // A host claude.ai login and a server API key exist; neither counts.
      fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true })
      fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), '{}')
      process.env.ANTHROPIC_API_KEY = 'sk-host'
      let providerEnv: Record<string, string> = {}
      const handles: FakeHandle[] = []
      const manager = await managedManager({
        isDirectory: anyDirectory,
        profileCatalogHome: tempDir,
        db, registry: new SessionRegistry(), onEvent: () => {},
        queryFactory: fakeQueryFactory(handles),
        getProviderEnv: () => providerEnv,
      })
      const refused = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'or2-opus' })
      expect(refused).toEqual({ ok: false, error: 'Provider OR2 needs OR2_KEY in the server environment.' })
      expect(db.getChatSessions()).toEqual([])
      expect(handles).toHaveLength(0)
      // The variable alone (here from Settings) authenticates.
      providerEnv = { OR2_KEY: 'or-sentinel' }
      expect(manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'or2-opus' }).ok).toBe(true)
    })
  })

})
