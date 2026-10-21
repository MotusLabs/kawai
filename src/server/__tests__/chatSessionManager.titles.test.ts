import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { closeDispatchers, createHarness, flush, waitForCondition, initMessage, writeTranscript, installManagerCleanup } from './helpers/chatSessionManagerHarness'

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

  test('a live session adopts generated titles while unclaimed and never after a manual rename', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    expect(created.session.nameSource).toBe('placeholder')
    const transcript = writeTranscript(
      'title-session',
      JSON.stringify({ type: 'ai-title', aiTitle: 'first title', sessionId: 'title-session' }) + '\n'
    )
    await harness.manager.send(id, 'hello')
    // The init message carries the SDK session id; the title tail starts with
    // it and adopts the transcript's current title.
    harness.handles[0]!.push(initMessage('title-session'))
    await waitForCondition(
      () => db.getChatSession(id)?.name === 'first title'
    )
    expect(harness.registry.get(id)?.nameSource).toBe('auto')
    // A later title replaces an auto name (design D2).
    fs.appendFileSync(
      transcript,
      JSON.stringify({ type: 'ai-title', aiTitle: 'better title', sessionId: 'title-session' }) + '\n'
    )
    await waitForCondition(
      () => db.getChatSession(id)?.name === 'better title'
    )
    expect(db.getChatSession(id)?.nameSource).toBe('auto')
    // A user rename pins the name: later titles never touch it (design D1).
    expect(harness.manager.rename(id, 'my own name').ok).toBe(true)
    fs.appendFileSync(
      transcript,
      JSON.stringify({ type: 'ai-title', aiTitle: 'too late', sessionId: 'title-session' }) + '\n'
    )
    await flush(10)
    expect(db.getChatSession(id)?.name).toBe('my own name')
    expect(db.getChatSession(id)?.nameSource).toBe('manual')
    expect(harness.registry.get(id)?.name).toBe('my own name')
    harness.manager.shutdown()
  })

  test('no title tail outlives kill, archive, or shutdown', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    // Kill: the session is gone, so nothing adopts the appended title.
    const killHarness = await createHarness(db)
    const killCreated = killHarness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!killCreated.ok) throw new Error(killCreated.error)
    const killId = killCreated.session.id
    writeTranscript(
      'title-kill',
      JSON.stringify({ type: 'ai-title', aiTitle: 'kill title', sessionId: 'title-kill' }) + '\n'
    )
    await killHarness.manager.send(killId, 'hello')
    killHarness.handles[0]!.push(initMessage('title-kill'))
    await waitForCondition(
      () => db.getChatSession(killId)?.name === 'kill title'
    )
    killHarness.manager.kill(killId)
    fs.appendFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj', 'title-kill.jsonl'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'post-kill', sessionId: 'title-kill' }) + '\n'
    )
    await flush(10)
    expect(db.getChatSession(killId)).toBeNull()
    killHarness.manager.shutdown()

    // Archive: the record stays, the tail does not follow later writes.
    const archiveHarness = await createHarness(db)
    const archiveCreated = archiveHarness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!archiveCreated.ok) throw new Error(archiveCreated.error)
    const archiveId = archiveCreated.session.id
    writeTranscript(
      'title-archive',
      JSON.stringify({ type: 'ai-title', aiTitle: 'archive title', sessionId: 'title-archive' }) + '\n'
    )
    await archiveHarness.manager.send(archiveId, 'hello')
    archiveHarness.handles[0]!.push(initMessage('title-archive'))
    await waitForCondition(
      () => db.getChatSession(archiveId)?.name === 'archive title'
    )
    expect(archiveHarness.manager.archive(archiveId).ok).toBe(true)
    fs.appendFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj', 'title-archive.jsonl'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'post-archive', sessionId: 'title-archive' }) + '\n'
    )
    await flush(10)
    expect(db.getChatSession(archiveId)?.name).toBe('archive title')
    archiveHarness.manager.shutdown()

    // Shutdown: every tail ends with the server.
    const shutdownHarness = await createHarness(db)
    const shutdownCreated = shutdownHarness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!shutdownCreated.ok) throw new Error(shutdownCreated.error)
    const shutdownId = shutdownCreated.session.id
    writeTranscript(
      'title-shutdown',
      JSON.stringify({ type: 'ai-title', aiTitle: 'shutdown title', sessionId: 'title-shutdown' }) + '\n'
    )
    await shutdownHarness.manager.send(shutdownId, 'hello')
    shutdownHarness.handles[0]!.push(initMessage('title-shutdown'))
    await waitForCondition(
      () => db.getChatSession(shutdownId)?.name === 'shutdown title'
    )
    shutdownHarness.manager.shutdown()
    fs.appendFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj', 'title-shutdown.jsonl'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'post-shutdown', sessionId: 'title-shutdown' }) + '\n'
    )
    await flush(10)
    expect(db.getChatSession(shutdownId)?.name).toBe('shutdown title')
  })

})
