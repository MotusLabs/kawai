import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Session } from '../../shared/types'
import { initDatabase, type SessionDatabase } from '../db'
import { closeDispatchers, createHarness } from './helpers/chatSessionManagerHarness'

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

  describe('rename', () => {
    test('rename reaches db, registry, and the session-update broadcast as manual', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, registry } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      expect(created.session.nameSource).toBe('placeholder')

      const updates: Session[] = []
      registry.on('session-update', (session: Session) => updates.push(session))

      expect(manager.rename(sessionId, '  Claude Code Chat metrics  ').ok).toBe(
        true
      )

      expect(db.getChatSession(sessionId)?.name).toBe('Claude Code Chat metrics')
      expect(db.getChatSession(sessionId)?.nameSource).toBe('manual')

      const inRegistry = registry.get(sessionId)
      expect(inRegistry?.name).toBe('Claude Code Chat metrics')
      expect(inRegistry?.nameSource).toBe('manual')

      expect(updates).toHaveLength(1)
      expect(updates[0]?.id).toBe(sessionId)
      expect(updates[0]?.name).toBe('Claude Code Chat metrics')
      expect(updates[0]?.nameSource).toBe('manual')
    })

    test('rename is a claim: provenance becomes manual even when the name is unchanged', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, registry } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      // An unnamed session starts on a placeholder; re-submitting that same
      // string is still a claim, so provenance must move to manual.
      expect(created.session.nameSource).toBe('placeholder')

      expect(manager.rename(sessionId, created.session.name).ok).toBe(true)
      expect(registry.get(sessionId)?.nameSource).toBe('manual')
      expect(db.getChatSession(sessionId)?.nameSource).toBe('manual')
    })

    test('rename refuses an empty name and an unknown session', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')

      const empty = manager.rename(created.session.id, '   ')
      expect(empty.ok).toBe(false)
      if (!empty.ok) expect(empty.error).toContain('empty')

      const unknown = manager.rename('chat-missing', 'anything')
      expect(unknown.ok).toBe(false)
      if (!unknown.ok) expect(unknown.error).toContain('Unknown')

      // Refusals leave the stored name alone.
      expect(db.getChatSession(created.session.id)?.nameSource).toBe(
        'placeholder'
      )
    })
  })

})
