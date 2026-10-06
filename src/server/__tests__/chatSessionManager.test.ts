import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Session } from '../../shared/types'
import type { ChatEvent } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatWireLogs } from '../chat/ChatWireLogs'
import { ClaudeExecutableError } from '../chat/claudeExecutable'
import type { ChatWireRecorder } from '../chat/wireTap'
import {
  ChatSessionManager,
  hasClaudeAuth,
  type ChatQueryFactory,
} from '../chat/ChatSessionManager'

/** Every fictitious project path (`/tmp/proj`) counts as an existing directory. */
const anyDirectory = () => true

/** Minimal scriptable Query: tests push SDK messages, options are captured. */
interface FakeHandle {
  query: Query
  options: Options
  wire?: ChatWireRecorder
  push: (message: SDKMessage) => void
  closed: boolean
}

function fakeQueryFactory(handles: FakeHandle[]): ChatQueryFactory {
  return ({ prompt: _prompt, options, wire }) => {
    const queue: SDKMessage[] = []
    let resolveMessage:
      | ((result: IteratorResult<SDKMessage>) => void)
      | null = null
    let ended = false
    const handle = { closed: false } as FakeHandle

    const stream = async function* (): AsyncGenerator<SDKMessage, void> {
      while (true) {
        const next = await new Promise<IteratorResult<SDKMessage>>(
          (resolve) => {
            if (queue.length > 0) {
              resolve({ value: queue.shift()!, done: false })
            } else if (ended) {
              resolve({ value: undefined, done: true })
            } else {
              resolveMessage = resolve
            }
          }
        )
        if (next.done) return
        yield next.value
      }
    }

    const query = Object.assign(stream(), {
      interrupt: () => Promise.resolve(undefined),
      close: () => {
        handle.closed = true
        ended = true
        resolveMessage?.({ value: undefined, done: true })
      },
    }) as unknown as Query

    handle.query = query
    handle.options = options
    handle.wire = wire
    handle.push = (message) => {
      if (resolveMessage) {
        const resolve = resolveMessage
        resolveMessage = null
        resolve({ value: message, done: false })
      } else {
        queue.push(message)
      }
    }
    handles.push(handle)
    return query
  }
}

interface ManagerHarness {
  manager: ChatSessionManager
  registry: SessionRegistry
  handles: FakeHandle[]
  events: Array<{ sessionId: string; event: ChatEvent }>
}

function createHarness(
  db: SessionDatabase,
  isDirectory: (path: string) => boolean = anyDirectory
): ManagerHarness {
  const registry = new SessionRegistry()
  const handles: FakeHandle[] = []
  const events: Array<{ sessionId: string; event: ChatEvent }> = []
  const manager = new ChatSessionManager({
    isDirectory,
    registry,
    db,
    onEvent: (sessionId, event) => events.push({ sessionId, event }),
    queryFactory: fakeQueryFactory(handles),
  })
  return { manager, registry, handles, events }
}

/** Let the driver's stream loop drain pushed messages. */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function initMessage(sessionId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
  } as unknown as SDKMessage
}

/** Write an SDK transcript where findTranscriptPath looks for it. */
function writeTranscript(sdkSessionId: string, content: string): string {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${sdkSessionId}.jsonl`)
  fs.writeFileSync(filePath, content)
  return filePath
}

describe('ChatSessionManager', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    // Isolate auth from the host: no API key, empty CLI config dir.
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
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
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('profiles persist, retain metadata, reject unknown IDs, and restore the SDK conversation', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const first = createHarness(db)
    expect(first.manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'unknown' }).ok).toBe(false)
    expect(db.getChatSessions()).toEqual([])
    expect(first.registry.getAll()).toEqual([])
    const created = first.manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!created.ok) throw new Error(created.error)
    expect(created.session.claudeProfileId).toBe('glm')
    const id = created.session.id
    expect(db.getChatSession(id)?.claudeProfileId).toBe('glm')
    await first.manager.send(id, 'first')
    first.handles[0]!.push(initMessage('profile-conversation'))
    await flush()
    writeTranscript('profile-conversation', JSON.stringify({ type: 'user', message: { role: 'user', content: 'first' } }))
    first.manager.shutdown()
    const restored = createHarness(db)
    expect(restored.registry.get(id)?.claudeProfileId).toBe('glm')
    expect((await restored.manager.send(id, 'resume')).ok).toBe(true)
    expect(restored.handles[0]!.options.resume).toBe('profile-conversation')
    expect(restored.handles[0]!.options.model).toBe('sonnet')
    expect(restored.handles[0]!.options.env?.ANTHROPIC_BASE_URL).toBe('https://zai.ruslan.casa/api/anthropic')
    restored.manager.shutdown()
    db.updateChatSession(id, { claudeProfileId: 'removed-profile' })
    const unknown = createHarness(db)
    expect(unknown.registry.get(id)?.claudeProfileId).toBe('removed-profile')
    const result = await unknown.manager.send(id, 'resume')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('removed-profile')
    expect(unknown.handles).toHaveLength(0)
    expect(db.getChatSession(id)?.sdkSessionId).toBe('profile-conversation')
    unknown.manager.shutdown()
  })

  test('profile auth uses global credentials and refuses unauthenticated launch without side effects', async () => {
    let globalEnv = { ANTHROPIC_AUTH_TOKEN: 'global-token' }
    const registry = new SessionRegistry()
    const handles: FakeHandle[] = []
    const manager = new ChatSessionManager({ isDirectory: anyDirectory, db, registry, onEvent: () => {}, queryFactory: fakeQueryFactory(handles), getProviderEnv: () => globalEnv })
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
    let globalEnv = { ANTHROPIC_AUTH_TOKEN: 'global-token' }
    const launches: Options[] = []
    let fail = false
    const manager = new ChatSessionManager({ isDirectory: anyDirectory, db, registry: new SessionRegistry(), onEvent: () => {}, getProviderEnv: () => globalEnv,
      availabilityProbe: async (_env, launch) => { launches.push(launch!); if (fail) throw new Error('failed') },
    })
    const create = (claudeProfileId: string) => manager.createAvailableSession({ projectPath: '/tmp/proj', claudeProfileId })
    await Promise.all([create('glm'), create('glm')])
    await create('minimax')
    await create('glm')
    expect(launches).toHaveLength(2)
    expect(launches[0]?.model).toBe('sonnet')
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

  describe('auth gate', () => {
    test('failed availability probe disables creation without creating a driver or row', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let probes = 0
      const registry = new SessionRegistry()
      const manager = new ChatSessionManager({
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
      const manager = new ChatSessionManager({
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
      const manager = new ChatSessionManager({
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
      const manager = new ChatSessionManager({
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
      const manager = new ChatSessionManager({
        isDirectory: anyDirectory,
        db, registry, onEvent: () => {},
        availabilityProbe: async () => { probes++ },
      })
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(true)
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(true)
      expect(probes).toBe(1)
    })
    test('refuses creation with an actionable error when no auth exists', () => {
      const { manager, registry } = createHarness(db)
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

    test('accepts ANTHROPIC_API_KEY from the environment', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      expect(hasClaudeAuth()).toBe(true)
      const { manager } = createHarness(db)
      expect(manager.createSession({ projectPath: '/tmp/proj' }).ok).toBe(true)
    })

    test('accepts an OAuth token from the environment', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const { manager } = createHarness(db)
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

    test('a credential supplied only by getProviderEnv allows creation', () => {
      const registry = new SessionRegistry()
      const manager = new ChatSessionManager({
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
      const manager = new ChatSessionManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        availabilityProbe: async (providerEnv) => { probed.push(providerEnv) },
        getProviderEnv: () => ({ ANTHROPIC_BASE_URL: 'https://gw.example/a' }),
      })
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(true)
      expect(probed).toEqual([{ ANTHROPIC_BASE_URL: 'https://gw.example/a' }])
    })

    test('rejects a blank OAuth token', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = '   '
      expect(hasClaudeAuth()).toBe(false)
    })

    test('accepts CLI credentials under CLAUDE_CONFIG_DIR', () => {
      fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true })
      fs.writeFileSync(
        path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'),
        '{}'
      )
      expect(hasClaudeAuth()).toBe(true)
      const { manager } = createHarness(db)
      expect(manager.createSession({ projectPath: '/tmp/proj' }).ok).toBe(true)
    })
  })

  describe('executable gate', () => {
    test('refuses creation with the executable error verbatim and persists nothing', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const registry = new SessionRegistry()
      const manager = new ChatSessionManager({
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
      const manager = new ChatSessionManager({
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
      const manager = new ChatSessionManager({
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
      const { manager, handles } = createHarness(db)
      let available = true
      const gated = new ChatSessionManager({
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
      const manager = new ChatSessionManager({
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
        const { manager } = createHarness(db)
        const result = await manager.createAvailableSession({ projectPath: '/tmp/proj' })
        expect(result.ok).toBe(true)
      } finally {
        if (original === undefined) delete process.env.KAWAI_CLAUDE_PATH
        else process.env.KAWAI_CLAUDE_PATH = original
      }
    })
  })

  test('provider env reaches the SDK spawn and Settings changes apply to the next driver', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    let providerEnv: Record<string, string> = { ANTHROPIC_BASE_URL: 'https://gw.example/a' }
    const handles: FakeHandle[] = []
    const manager = new ChatSessionManager({
      isDirectory: anyDirectory,
      db, registry: new SessionRegistry(), onEvent: () => {},
      queryFactory: fakeQueryFactory(handles),
      getProviderEnv: () => providerEnv,
    })
    const first = manager.createSession({ projectPath: '/tmp/proj' })
    if (!first.ok) throw new Error('create failed')
    await manager.send(first.session.id, 'hello')
    expect(handles[0]!.options.env?.ANTHROPIC_BASE_URL).toBe('https://gw.example/a')

    providerEnv = { ANTHROPIC_BASE_URL: 'https://gw.example/b' }
    const second = manager.createSession({ projectPath: '/tmp/proj' })
    if (!second.ok) throw new Error('create failed')
    await manager.send(second.session.id, 'hello')
    expect(handles[1]!.options.env?.ANTHROPIC_BASE_URL).toBe('https://gw.example/b')
    manager.kill(first.session.id)
    manager.kill(second.session.id)
  })

  test('without provider env the SDK spawn omits env', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const { manager, handles } = createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    expect('env' in handles[0]!.options).toBe(false)
    manager.kill(created.session.id)
  })

  test('each driver records into its session wire log, and kill deletes the log', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const wireLogs = new ChatWireLogs({ dir: path.join(tempDir, 'chat-wire') })
    const handles: FakeHandle[] = []
    const manager = new ChatSessionManager({
      isDirectory: anyDirectory,
      db, registry: new SessionRegistry(), onEvent: () => {},
      queryFactory: fakeQueryFactory(handles), wireLogs,
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const sessionId = created.session.id
    await manager.send(sessionId, 'hello')
    expect(handles[0]!.options.spawnClaudeCodeProcess).toBeTypeOf('function')
    expect(handles[0]!.wire).toBe(wireLogs.get(sessionId))
    handles[0]!.wire!.record('in', '{"type":"system"}')
    expect((await wireLogs.readPage(sessionId, { limit: 10 })).frames.map(frame => frame.raw))
      .toEqual(['{"type":"system"}'])
    const logFile = wireLogs.get(sessionId).currentPath
    expect(fs.existsSync(logFile)).toBe(true)

    manager.kill(sessionId)
    await flush()
    expect(fs.existsSync(logFile)).toBe(false)
  })

  test('startup prunes wire logs of sessions that no longer exist', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const dir = path.join(tempDir, 'chat-wire')
    const first = new ChatSessionManager({ isDirectory: anyDirectory, db, registry: new SessionRegistry(), onEvent: () => {} })
    const kept = first.createSession({ projectPath: '/tmp/proj' })
    if (!kept.ok) throw new Error('create failed')
    const seed = new ChatWireLogs({ dir })
    for (const id of [kept.session.id, 'chat-orphan']) {
      seed.get(id).record('in', 'frame')
      await seed.get(id).flush()
    }
    new ChatSessionManager({
      isDirectory: anyDirectory,
      db, registry: new SessionRegistry(), onEvent: () => {}, wireLogs: new ChatWireLogs({ dir }),
    })
    await flush()
    expect(fs.readdirSync(dir)).toEqual([`${kept.session.id}.jsonl`])
  })

  test('without wire logs the SDK spawns its own process', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const { manager, handles } = createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    expect('spawnClaudeCodeProcess' in handles[0]!.options).toBe(false)
    manager.kill(created.session.id)
  })

  test('create registers a chat session and persists a row', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const { manager, registry } = createHarness(db)
    const result = manager.createSession({
      projectPath: '/tmp/proj',
      name: 'delta',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const session = registry.get(result.session.id)
    expect(session).toMatchObject({
      id: result.session.id,
      name: 'delta',
      kind: 'chat',
      projectPath: '/tmp/proj',
      status: 'waiting',
      source: 'managed',
      agentType: 'claude',
    })
    expect(result.session.id).toMatch(/^chat-[0-9a-f-]{36}$/)
    expect(result.session.tmuxWindow).toBeUndefined()
    expect(result.session.createdAt).toBeTruthy()

    const row = db.getChatSession(result.session.id)
    expect(row).toMatchObject({
      sessionId: result.session.id,
      name: 'delta',
      projectPath: '/tmp/proj',
      sdkSessionId: null,
      status: 'waiting',
    })

    // A generated name is used when none is offered.
    const unnamed = manager.createSession({ projectPath: '/tmp/proj' })
    expect(unnamed.ok).toBe(true)
    if (unnamed.ok) expect(unnamed.session.name).toMatch(/^[a-z]+-[a-z]+$/)
  })

  test('reconnect snapshots retain unfinished output and live pending requests without duplicating disk events', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const { manager, handles } = createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'hello')
    const handle = handles[0]!
    handle.push({ type: 'assistant', uuid: 'live-a', message: { id: 'message-a', role: 'assistant', content: [{ type: 'text', text: 'unfinished' }] } } as unknown as SDKMessage)
    await flush()
    const pending = handle.options.canUseTool!('Bash', { command: 'echo hello' }, {
      signal: new AbortController().signal, toolUseID: 'tool-a', requestId: 'request-a',
    })
    await flush()
    const snapshot = manager.getSnapshot(id)!
    expect(snapshot.status).toBe('permission')
    expect(snapshot.pendingRequests).toHaveLength(1)
    expect(snapshot.events.filter(event => event.type === 'assistant_text')).toHaveLength(1)
    expect(snapshot.throughSequence).toBe(snapshot.events.at(-1)!.sequence)
    expect(snapshot.events.map(event => event.sequence)).toEqual(snapshot.events.map((_, index) => index + 1))
    const requestId = snapshot.pendingRequests[0]!.requestId
    expect(manager.resolveApproval(id, requestId, 'allow').ok).toBe(true)
    await pending
    expect(manager.getSnapshot(id)!.pendingRequests).toEqual([])
    expect(manager.getSnapshot(id)!.status).toBe('working')
    expect(manager.getSnapshot(id)!.events.at(-1)).toMatchObject({ type: 'request_resolved', outcome: 'allowed' })
    manager.kill(id)
    expect(manager.getSnapshot(id)).toBeNull()
  })

  test('first send lazily spawns the driver and persists sdkSessionId immediately', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const { manager, registry, handles, events } = createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const sessionId = created.session.id

    expect(handles).toHaveLength(0) // no SDK spawn at create time
    await manager.send(sessionId, 'hello')
    expect(handles).toHaveLength(1) // spawned lazily by the first turn
    expect(registry.get(sessionId)?.status).toBe('working')
    expect(handles[0]!.options.cwd).toBe('/tmp/proj')
    expect(handles[0]!.options.resume).toBeUndefined()
    expect(
      events.filter((e) => e.sessionId === sessionId).map((e) => e.event.type)
    ).toEqual(['turn_started', 'user_message'])

    // The init message reveals the SDK session id; it must hit the db at once.
    handles[0]!.push(initMessage('sdk-session-abc'))
    await flush()
    expect(db.getChatSession(sessionId)?.sdkSessionId).toBe('sdk-session-abc')
    expect(manager.getSdkSessionIds().has('sdk-session-abc')).toBe(true)

    // The row still exists with the id after a later status write.
    expect(manager.interrupt(sessionId)).toEqual({ ok: true })
    expect(db.getChatSession(sessionId)?.sdkSessionId).toBe('sdk-session-abc')
  })

  test('kill denies pending approvals, removes session and row, ignores later sends', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const { manager, registry, handles } = createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const sessionId = created.session.id
    await manager.send(sessionId, 'go')
    const handle = handles[0]!

    const approval = handle.options.canUseTool!(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' }
    )
    await flush()
    handle.push(initMessage('sdk-doomed'))
    await flush()

    expect(manager.kill(sessionId)).toBe(true)
    expect(handle.closed).toBe(true)
    await expect(approval).resolves.toMatchObject({
      behavior: 'deny',
      interrupt: true,
    })
    expect(registry.get(sessionId)).toBeUndefined()
    expect(db.getChatSession(sessionId)).toBeNull()
    expect(manager.getSdkSessionIds().has('sdk-doomed')).toBe(false)

    // Killing again is a no-op; sends to the dead session are refused.
    expect(manager.kill(sessionId)).toBe(false)
    await expect(manager.send(sessionId, 'ghost')).resolves.toMatchObject({
      ok: false,
    })
  })

  describe('archive and restore', () => {
    test('archiving an idle session keeps record, conversation, and protocol log', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const wireLogs = new ChatWireLogs({ dir: path.join(tempDir, 'chat-wire') })
      const handles: FakeHandle[] = []
      const registry = new SessionRegistry()
      const updates: Array<Session | undefined> = []
      registry.on('session-update', (session) => updates.push(session))
      const manager = new ChatSessionManager({
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
      const { manager, handles, events, registry } = createHarness(db)
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
      const { manager, handles } = createHarness(db)
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
      const { manager, handles } = createHarness(db)
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
      const { manager, handles, registry } = createHarness(db)
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
      const managerA = new ChatSessionManager({
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
      const managerB = new ChatSessionManager({
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
      expect(fs.existsSync(logFile)).toBe(true)
      expect(managerB.kill(sessionId)).toBe(true)
      await flush()
      expect(fs.existsSync(logFile)).toBe(false)
      expect(db.getChatSession(sessionId)).toBeNull()
      expect(registryB.get(sessionId)).toBeUndefined()
      managerB.shutdown()
    })

    test('archive and restore on unknown sessions return actionable errors', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager } = createHarness(db)
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

  test('actions on unknown sessions and idle sessions return actionable errors', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const { manager } = createHarness(db)
    expect(manager.interrupt('chat-none')).toMatchObject({ ok: false })
    await expect(manager.send('chat-none', 'x')).resolves.toMatchObject({
      ok: false,
    })
    expect(
      manager.resolveApproval('chat-none', 'req-1', 'allow')
    ).toMatchObject({ ok: false })

    // Known but idle (no driver): interrupt is a harmless no-op, approvals
    // have nothing pending.
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    expect(manager.interrupt(created.session.id)).toEqual({ ok: true })
    const approval = manager.resolveApproval(created.session.id, 'req-1', 'deny')
    expect(approval).toMatchObject({ ok: false })
    if (!approval.ok) {
      expect(approval.error).toContain('req-1')
    }
    const answer = manager.answerQuestion(created.session.id, 'req-1', {})
    expect(answer).toMatchObject({ ok: false })
    if (!answer.ok) {
      expect(answer.error).toContain('req-1')
    }
  })

  test('shutdown settles drivers without removing sessions', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const { manager, registry, handles } = createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hi')

    manager.shutdown()
    expect(handles[0]!.closed).toBe(true)
    // Rows survive shutdown; the restart path restores them.
    expect(db.getChatSession(created.session.id)).not.toBeNull()
    expect(registry.get(created.session.id)).toBeDefined()
  })

  describe('project directory', () => {
    test('creation refuses a path that is not an existing directory, with no side effects', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const registry = new SessionRegistry()
      // No isDirectory override: the real filesystem check runs.
      const manager = new ChatSessionManager({ db, registry, onEvent: () => {} })
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

    test('a home-relative path is checked and stored as an absolute path', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const checked: string[] = []
      const { manager } = createHarness(db, (dir) => {
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
      const manager = new ChatSessionManager({
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
      const { manager, registry, handles, events } = createHarness(db, () => exists)
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
      const { manager, handles } = createHarness(db, () => exists)
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

  describe('restart restore', () => {
    test('rows load as idle chat sessions; next send resumes the stored SDK id', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const dbPath = path.join(tempDir, 'restart.db')
      const dbA = initDatabase({ path: dbPath })
      const harnessA = createHarness(dbA)
      const created = harnessA.manager.createSession({
        projectPath: '/tmp/proj',
        name: 'echo',
      })
      if (!created.ok) throw new Error('create failed')
      const startedId = created.session.id

      // A second session created but never started: no SDK id.
      const fresh = harnessA.manager.createSession({ projectPath: '/tmp/other' })
      if (!fresh.ok) throw new Error('create failed')

      await harnessA.manager.send(startedId, 'one')
      harnessA.handles[0]!.push(initMessage('sdk-resume-me'))
      await flush()
      // Turn still in flight: the persisted row says working.
      expect(dbA.getChatSession(startedId)?.status).toBe('working')
      dbA.close()

      // "Restart": fresh db handle, registry, and manager on the same file.
      const dbB = initDatabase({ path: dbPath })
      const harnessB = createHarness(dbB)
      const registryB = harnessB.registry

      const restored = registryB.get(startedId)
      expect(restored).toMatchObject({
        id: startedId,
        name: 'echo',
        kind: 'chat',
        projectPath: '/tmp/proj',
        status: 'waiting',
        agentType: 'claude',
      })
      expect(dbB.getChatSession(startedId)).toMatchObject({
        sdkSessionId: 'sdk-resume-me',
        status: 'waiting',
      })
      expect(harnessB.manager.getSdkSessionIds().has('sdk-resume-me')).toBe(
        true
      )

      // The never-started session restored too, with no SDK id.
      expect(registryB.get(fresh.session.id)).toMatchObject({
        kind: 'chat',
        status: 'waiting',
      })
      expect(dbB.getChatSession(fresh.session.id)?.sdkSessionId).toBeNull()

      // Continuing the started session resumes the stored SDK conversation
      // (resume needs the transcript on disk — see the resume gate).
      writeTranscript('sdk-resume-me', '[]')
      await harnessB.manager.send(startedId, 'continue')
      expect(harnessB.handles[0]!.options.resume).toBe('sdk-resume-me')
      // The fresh session starts with no resume.
      await harnessB.manager.send(fresh.session.id, 'begin')
      expect(harnessB.handles[1]!.options.resume).toBeUndefined()

      // Chat sessions coexist with terminal ones in the same registry.
      registryB.replaceSessions([
        {
          id: 'term-1',
          name: 't',
          tmuxWindow: 'agentboard:1',
          projectPath: '/tmp/proj',
          status: 'waiting',
          lastActivity: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          source: 'external',
        },
      ])
      const all = registryB.getAll()
      expect(all.filter((s) => s.kind === 'chat')).toHaveLength(2)
      expect(all.find((s) => s.id === 'term-1')).toBeDefined()
      dbB.close()
    })
  })

  describe('transcript history and resume', () => {
    const MATCHED_TRANSCRIPT = [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-10-04T10:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-10-04T10:00:01.000Z',
        message: {
          id: 'msg_1',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-10-04T10:00:02.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'ok',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-10-04T10:00:03.000Z',
        message: {
          id: 'msg_2',
          content: [{ type: 'text', text: 'done' }],
        },
      }),
    ].join('\n')

    /** A tool that died holding an approval: no tool_result was ever written. */
    const PENDING_REQUEST_TRANSCRIPT = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-10-04T12:00:00.000Z',
      message: {
        id: 'msg_1',
        content: [
          {
            type: 'tool_use',
            id: 'call_pending',
            name: 'Bash',
            input: { command: 'rm -rf /' },
          },
        ],
      },
    })

    function seedRecord(sdkSessionId: string | null): string {
      const sessionId = `chat-${crypto.randomUUID()}`
      const now = new Date().toISOString()
      db.insertChatSession({
        sessionId,
        name: 'seed',
        projectPath: '/tmp/proj',
        sdkSessionId,
        status: 'waiting',
        createdAt: now,
        lastActivityAt: now,
      })
      return sessionId
    }

    test('getHistory replays a stored transcript into read-only events', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      writeTranscript('sdk-hist', MATCHED_TRANSCRIPT)
      const sessionId = seedRecord('sdk-hist')
      const fresh = seedRecord(null)
      const { manager } = createHarness(db)

      const history = manager.getHistory(sessionId)
      expect(history?.status).toBe('ok')
      expect(history?.events.map((e) => e.type)).toEqual([
        'user_message',
        'tool_call',
        'tool_result',
        'assistant_text',
      ])
      for (const event of history?.events ?? []) {
        expect(event.sequence).toBe(0)
      }

      // Never-started sessions have no SDK id and replay as empty.
      expect(manager.getHistory(fresh)).toEqual({ status: 'ok', events: [] })
      expect(manager.getHistory('chat-none')).toBeNull()
    })

    test('missing transcript yields a history-unavailable fallback', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const sessionId = seedRecord('sdk-vanished')
      const { manager } = createHarness(db)

      const history = manager.getHistory(sessionId)
      expect(history?.status).toBe('missing')
      expect(history?.events.map((e) => e.type)).toEqual(['notice'])
      if (history?.events[0]?.type === 'notice') {
        expect(history.events[0].text).toContain('History unavailable')
      }
    })

    test('failed resume preserves the stored id and starts no fresh conversation', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const dbPath = path.join(tempDir, 'resume-fail.db')
      const dbA = initDatabase({ path: dbPath })
      const harnessA = createHarness(dbA)
      const created = harnessA.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await harnessA.manager.send(sessionId, 'one')
      harnessA.handles[0]!.push(initMessage('sdk-ghost'))
      await flush()
      expect(dbA.getChatSession(sessionId)?.sdkSessionId).toBe('sdk-ghost')
      dbA.close()

      // Restart with no transcript on disk for the stored SDK id.
      const dbB = initDatabase({ path: dbPath })
      const harnessB = createHarness(dbB)
      const result = await harnessB.manager.send(sessionId, 'continue')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('transcript')
        expect(result.error).toContain('sdk-ghost')
      }
      // Nothing spawned: the message must not reach a fresh conversation.
      expect(harnessB.handles).toHaveLength(0)
      // The row and its SDK id survive so a restored transcript can resume.
      expect(dbB.getChatSession(sessionId)?.sdkSessionId).toBe('sdk-ghost')
      expect(harnessB.manager.getHistory(sessionId)?.status).toBe('missing')

      // Restoring the transcript makes the same id resume again.
      writeTranscript('sdk-ghost', MATCHED_TRANSCRIPT)
      await harnessB.manager.send(sessionId, 'continue')
      expect(harnessB.handles[0]!.options.resume).toBe('sdk-ghost')
      dbB.close()
    })

    test('parser failure with an existing transcript still permits resume', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      writeTranscript('sdk-ugly', 'not json\n{still not json')
      const sessionId = seedRecord('sdk-ugly')
      const { manager, handles } = createHarness(db)

      expect(manager.getHistory(sessionId)?.status).toBe('unparseable')

      // The SDK reads the file itself: an unparseable-but-present transcript
      // must not block resume the way a missing one does.
      const result = await manager.send(sessionId, 'keep going')
      expect(result.ok).toBe(true)
      expect(handles[0]!.options.resume).toBe('sdk-ugly')
    })

    test('restart cancellation of pending requests shows in restored history', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      writeTranscript('sdk-pending', PENDING_REQUEST_TRANSCRIPT)
      const sessionId = seedRecord('sdk-pending')
      const { manager } = createHarness(db)

      // Restored session, no live driver: the dead request is reconstructed
      // and immediately marked cancelled (design D7).
      const history = manager.getHistory(sessionId)
      expect(history?.events.map((e) => e.type)).toEqual([
        'tool_call',
        'approval_request',
        'request_resolved',
      ])
      expect(history?.events[1]).toMatchObject({ requestId: 'call_pending' })
      expect(history?.events[2]).toMatchObject({
        requestId: 'call_pending',
        outcome: 'cancelled',
      })
      expect(manager.getPendingRequests(sessionId)).toEqual([])
    })
  })
})
