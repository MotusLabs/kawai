import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { closeDispatchers, createHarness, flush, initMessage, installManagerCleanup } from './helpers/chatSessionManagerHarness'

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

  test('first send lazily spawns the driver and persists sdkSessionId immediately', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const { manager, registry, handles, events } = await createHarness(db)
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
    const { manager, registry, handles } = await createHarness(db)
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

})
