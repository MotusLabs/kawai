import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { createHarness, flush, initMessage, resultWithWindow, writeTranscript, installManagerCleanup } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

describe('ChatSessionManager model', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalHome = process.env.HOME
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-model-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
  })
  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('a reported model persists immediately, snapshots, and pushes once', async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    // Before the first report the snapshot carries an explicit null.
    expect(harness.manager.getSnapshot(id)!.model).toBeNull()

    await harness.manager.send(id, 'turn')
    const fake = harness.handles[0]!
    fake.push(initMessage('sdk-model-1', 'claude-sonnet-5-5'))
    await flush()
    // No turn boundary yet, but the write is immediate (design D5): model
    // changes are rare, so they never wait for one.
    expect(db.getChatSession(id)!.model).toBe('claude-sonnet-5-5')
    expect(harness.manager.getSnapshot(id)!.model).toBe('claude-sonnet-5-5')
    expect(harness.models).toEqual([{ sessionId: id, model: 'claude-sonnet-5-5' }])

    // An unchanged model on the next turn never re-fires the sink.
    fake.push(resultWithWindow())
    await flush()
    await harness.manager.send(id, 'second')
    fake.push(initMessage('sdk-model-1', 'claude-sonnet-5-5'))
    await flush()
    expect(harness.models).toHaveLength(1)
    harness.manager.shutdown()
  })

  test('the snapshot falls back to the stored column after a restart', async () => {
    const seed = await createHarness(db)
    const created = seed.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await seed.manager.send(id, 'turn')
    seed.handles[0]!.push(initMessage('sdk-model-1', 'claude-sonnet-5-5'))
    seed.handles[0]!.push(resultWithWindow())
    await flush()
    // The restarted manager resumes from the SDK transcript, which must exist.
    writeTranscript('sdk-model-1', '[]')
    seed.manager.shutdown()

    const harness = await createHarness(db)
    expect(harness.manager.getSnapshot(id)!.model).toBe('claude-sonnet-5-5')

    // A /model switch after the restart updates record, row, and snapshot.
    await harness.manager.send(id, 'switched')
    harness.handles[0]!.push(initMessage('sdk-model-1', 'sonnet'))
    await flush()
    expect(db.getChatSession(id)!.model).toBe('sonnet')
    expect(harness.manager.getSnapshot(id)!.model).toBe('sonnet')
    harness.manager.shutdown()
  })
})
