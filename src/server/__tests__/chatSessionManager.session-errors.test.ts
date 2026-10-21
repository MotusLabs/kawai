import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { closeDispatchers, createHarness, installManagerCleanup } from './helpers/chatSessionManagerHarness'

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

  test('actions on unknown sessions and idle sessions return actionable errors', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const { manager } = await createHarness(db)
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
    const { manager, registry, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hi')

    manager.shutdown()
    expect(handles[0]!.closed).toBe(true)
    // Rows survive shutdown; the restart path restores them.
    expect(db.getChatSession(created.session.id)).not.toBeNull()
    expect(registry.get(created.session.id)).toBeDefined()
  })

})
