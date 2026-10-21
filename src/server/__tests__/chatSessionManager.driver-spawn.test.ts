import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatWireLogs } from '../chat/ChatWireLogs'
import { anyDirectory, FakeHandle, managedManager, closeDispatchers, fakeQueryFactory, createHarness, flush, waitForCondition, installManagerCleanup } from './helpers/chatSessionManagerHarness'

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

  test('provider env reaches the SDK spawn and Settings changes apply to the next driver', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    let providerEnv: Record<string, string> = { ANTHROPIC_BASE_URL: 'https://gw.example/a' }
    const handles: FakeHandle[] = []
    const manager = await managedManager({
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

  test('without provider env the SDK spawn gets the server env minus catalog-named key variables', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    process.env.OPENROUTER_MANAGEMENT_KEY = 'management-sentinel'
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    delete process.env.OPENROUTER_MANAGEMENT_KEY
    // The shipped catalog names OpenRouter's keys (openrouter-provider D3).
    const env = handles[0]!.options.env as Record<string, string | undefined>
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('test-oauth-token')
    expect(env).not.toHaveProperty('OPENROUTER_MANAGEMENT_KEY')
    manager.kill(created.session.id)
  })

  test('each driver records into its session wire log, and kill deletes the log', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const wireLogs = new ChatWireLogs({ dir: path.join(tempDir, 'chat-wire') })
    const handles: FakeHandle[] = []
    const manager = await managedManager({
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
    // Deletion runs on the log's async chain; poll instead of trusting fixed timers.
    await waitForCondition(() => !fs.existsSync(logFile))
  })

  test('startup prunes wire logs of sessions that no longer exist', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const dir = path.join(tempDir, 'chat-wire')
    const first = await managedManager({ isDirectory: anyDirectory, db, registry: new SessionRegistry(), onEvent: () => {} })
    const kept = first.createSession({ projectPath: '/tmp/proj' })
    if (!kept.ok) throw new Error('create failed')
    const seed = new ChatWireLogs({ dir })
    for (const id of [kept.session.id, 'chat-orphan']) {
      seed.get(id).record('in', 'frame')
      await seed.get(id).flush()
    }
    await managedManager({
      isDirectory: anyDirectory,
      db, registry: new SessionRegistry(), onEvent: () => {}, wireLogs: new ChatWireLogs({ dir }),
    })
    // The prune's rm runs on an async chain; poll instead of trusting fixed timers.
    await waitForCondition(() => fs.readdirSync(dir).length === 1)
    expect(fs.readdirSync(dir)).toEqual([`${kept.session.id}.jsonl`])
  })

  test('without wire logs the SDK spawns its own process', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    expect('spawnClaudeCodeProcess' in handles[0]!.options).toBe(false)
    manager.kill(created.session.id)
  })

  test('create registers a chat session and persists a row', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const { manager, registry } = await createHarness(db)
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
    const { manager, handles } = await createHarness(db)
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

})
