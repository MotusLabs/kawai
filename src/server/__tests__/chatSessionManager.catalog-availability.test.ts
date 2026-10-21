// chatSessionManager split: catalog-availability tests.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ClaudeLaunchConfiguration } from '../chat/ClaudeProfiles'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { anyDirectory, FakeHandle, managedManager, closeDispatchers, fakeQueryFactory, createHarness, installManagerCleanup } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

describe('ChatSessionManager', () => {

  let tempDir: string
  let db: SessionDatabase

  /**
   * The shipped catalog has no LAN profile; tests that exercise one write a
   * user-level fixture (reserved documentation address) into the pinned HOME.
   * A user file replaces the shipped default wholesale, so the shipped
   * profiles ride along.
   */
  function writeLanCatalog(): void {
    const shipped = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dir, '../../../config/profiles.default.json'), 'utf8'),
    ) as Record<string, unknown>
    // The GLM pair lives in the shipped providers default; flatten it into
    // legacy entries so these launch tests read the same settings.
    const providers = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dir, '../../../config/providers.default.json'), 'utf8'),
    ) as Record<string, { env?: Record<string, string>; limitResetTimeZone?: string; models?: Record<string, { label?: string; model?: string }> }>
    for (const provider of Object.values(providers)) {
      for (const [key, model] of Object.entries(provider.models ?? {})) {
        shipped[key] = {
          ...(model.label ? { label: model.label } : {}),
          ...(model.model ? { model: model.model } : {}),
          ...(provider.limitResetTimeZone ? { limitResetTimeZone: provider.limitResetTimeZone } : {}),
          env: { ...provider.env },
        }
      }
    }
    // Bracket access: a dotted property would read as a LAN hostname to the scrub grep.
    shipped['lan'] = { label: 'LAN', env: { ANTHROPIC_BASE_URL: 'http://192.0.2.10:9292' } }
    fs.mkdirSync(path.join(tempDir, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(tempDir, '.kawai', 'profiles.json'), JSON.stringify(shipped))
  }

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

  test('create-time approval policy: supplied policy sticks, absent means manual, profiles leave it unchanged', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const { manager, registry } = await createHarness(db)

    // A supplied policy is stored on the session, registry, and DB row.
    const auto = manager.createSession({ projectPath: '/tmp/proj', approvalPolicy: 'auto' })
    if (!auto.ok) throw new Error(auto.error)
    expect(auto.session.approvalPolicy).toBe('auto')
    expect(registry.get(auto.session.id)?.approvalPolicy).toBe('auto')
    expect(db.getChatSession(auto.session.id)?.approvalPolicy).toBe('auto')

    // Absent field falls back to manual (older clients, terminal path).
    const manual = manager.createSession({ projectPath: '/tmp/proj' })
    if (!manual.ok) throw new Error(manual.error)
    expect(manual.session.approvalPolicy).toBe('manual')
    expect(db.getChatSession(manual.session.id)?.approvalPolicy).toBe('manual')

    // A named profile does not override the supplied policy.
    const profiled = manager.createSession({
      projectPath: '/tmp/proj',
      claudeProfileId: 'glm',
      approvalPolicy: 'auto',
    })
    if (!profiled.ok) throw new Error(profiled.error)
    expect(profiled.session.claudeProfileId).toBe('glm')
    expect(profiled.session.approvalPolicy).toBe('auto')
    manager.shutdown()
  })

  test('resume re-resolves the stored profile against the current filesystem', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token'
    const project = path.join(tempDir, 'proj')
    fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
    const catalogFile = path.join(project, '.kawai', 'profiles.json')
    fs.writeFileSync(catalogFile, JSON.stringify({
      'glm-turbo': { label: 'GLM Turbo', model: 'glm-5.3-flash[1m]' },
    }))
    const first = await createHarness(db)
    const created = first.manager.createSession({ projectPath: project, claudeProfileId: 'glm-turbo' })
    expect(created.ok).toBe(true)
    await first.manager.send(created.ok ? created.session.id : '', 'first turn')
    expect(first.handles[0]!.options.model).toBe('glm-5.3-flash[1m]')
    first.manager.shutdown()

    // The defining file is gone after a restart: the session survives with
    // its stored identity, and sending reports the missing profile.
    fs.rmSync(catalogFile)
    const restored = await createHarness(db)
    const result = await restored.manager.send(created.ok ? created.session.id : '', 'resume')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('glm-turbo')
    expect(restored.registry.get(created.ok ? created.session.id : '')?.claudeProfileId).toBe('glm-turbo')
    expect(restored.handles).toHaveLength(0)
  })

  test('catalog file failures are reported and the rest of the catalog still launches', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token'
    const project = path.join(tempDir, 'proj')
    fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
    const badFile = path.join(project, '.kawai', 'profiles.json')
    fs.writeFileSync(badFile, '{ not json')
    const reported: string[][] = []
    const manager = await managedManager({
      isDirectory: anyDirectory,
      db, registry: new SessionRegistry(), onEvent: () => {},
      queryFactory: fakeQueryFactory([]),
      catalogErrorLog: errors => reported.push(errors),
    })
    // The invalid file is skipped: Default (shipped catalog) still creates
    // and spawns — but the failure is reported instead of vanishing.
    const created = manager.createSession({ projectPath: project })
    expect(created.ok).toBe(true)
    expect((await manager.send(created.ok ? created.session.id : '', 'hi')).ok).toBe(true)
    expect(reported.length).toBeGreaterThan(0)
    expect(reported[0]![0]).toContain(badFile)
    manager.shutdown()
  })

  test('profile auth uses global credentials and refuses unauthenticated launch without side effects', async () => {
    writeLanCatalog()
    let globalEnv = { ANTHROPIC_AUTH_TOKEN: 'global-token' }
    const registry = new SessionRegistry()
    const handles: FakeHandle[] = []
    const manager = await managedManager({ isDirectory: anyDirectory, db, registry, onEvent: () => {}, queryFactory: fakeQueryFactory(handles), getProviderEnv: () => globalEnv })
    for (const profile of ['glm', 'minimax', 'kimi']) {
      const result = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: profile })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error)
      globalEnv = { ANTHROPIC_AUTH_TOKEN: '' }
      expect((await manager.send(result.session.id, 'no auth')).ok).toBe(false)
      expect(handles).toHaveLength(0)
      globalEnv = { ANTHROPIC_AUTH_TOKEN: 'global-token' }
    }
    manager.shutdown()
    globalEnv = { ANTHROPIC_AUTH_TOKEN: '' }
    const count = db.getChatSessions().length
    expect(manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'lan' }).ok).toBe(false)
    expect(db.getChatSessions()).toHaveLength(count)
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'
    expect(manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'lan' }).ok).toBe(true)
  })

  test('availability caches complete profile configuration and retries failures', async () => {
    writeLanCatalog()
    let globalEnv = { ANTHROPIC_AUTH_TOKEN: 'global-token' }
    const launches: ClaudeLaunchConfiguration[] = []
    let fail = false
    const manager = await managedManager({ isDirectory: anyDirectory, db, registry: new SessionRegistry(), onEvent: () => {}, getProviderEnv: () => globalEnv,
      availabilityProbe: async (_env, launch) => { launches.push(launch!); if (fail) throw new Error('failed') },
    })
    const create = (claudeProfileId: string) => manager.createAvailableSession({ projectPath: '/tmp/proj', claudeProfileId })
    await Promise.all([create('glm'), create('glm')])
    await create('minimax')
    await create('glm')
    expect(launches).toHaveLength(2)
    expect(launches[0]?.model).toBe('opus')
    expect(launches[1]?.model).toBe('MiniMax-M3')
    expect(launches[0]?.settings).toMatchObject({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]' } })
    globalEnv = { ANTHROPIC_AUTH_TOKEN: 'changed-token' }
    await create('glm')
    expect(launches).toHaveLength(3)
    fail = true
    expect((await create('lan')).ok).toBe(false)
    fail = false
    expect((await create('lan')).ok).toBe(true)
    expect(launches).toHaveLength(5)
    manager.shutdown()
  })

})
