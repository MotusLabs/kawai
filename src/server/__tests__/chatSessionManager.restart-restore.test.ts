// chatSessionManager split: restart-restore tests.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { closeDispatchers, createHarness, flush, initMessage, writeTranscript, installManagerCleanup } from './helpers/chatSessionManagerHarness'

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

  describe('restart restore', () => {
    test('rows load as idle chat sessions; next send resumes the stored SDK id', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const dbPath = path.join(tempDir, 'restart.db')
      const dbA = initDatabase({ path: dbPath })
      const harnessA = await createHarness(dbA)
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
      closeDispatchers()
      dbA.close()

      // "Restart": fresh db handle, registry, and manager on the same file.
      const dbB = initDatabase({ path: dbPath })
      const harnessB = await createHarness(dbB)
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
      closeDispatchers()
      dbB.close()
    })

    test('create records name provenance and a restart restores it unchanged', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const dbPath = path.join(tempDir, 'name-source.db')
      const dbA = initDatabase({ path: dbPath })
      const harnessA = await createHarness(dbA)

      const named = harnessA.manager.createSession({
        projectPath: '/tmp/proj',
        name: 'show-chat-rate-limits',
      })
      if (!named.ok) throw new Error('create failed')
      expect(named.session.name).toBe('show-chat-rate-limits')
      expect(named.session.nameSource).toBe('manual')

      const unnamed = harnessA.manager.createSession({ projectPath: '/tmp/other' })
      if (!unnamed.ok) throw new Error('create failed')
      expect(unnamed.session.nameSource).toBe('placeholder')

      expect(dbA.getChatSession(named.session.id)?.nameSource).toBe('manual')
      expect(dbA.getChatSession(unnamed.session.id)?.nameSource).toBe(
        'placeholder'
      )
      closeDispatchers()
      dbA.close()

      // "Restart": fresh db handle, registry, and manager on the same file.
      const dbB = initDatabase({ path: dbPath })
      const harnessB = await createHarness(dbB)
      const restoredNamed = harnessB.registry.get(named.session.id)
      const restoredUnnamed = harnessB.registry.get(unnamed.session.id)
      expect(restoredNamed?.name).toBe('show-chat-rate-limits')
      expect(restoredNamed?.nameSource).toBe('manual')
      expect(restoredUnnamed?.nameSource).toBe('placeholder')
      expect(dbB.getChatSession(named.session.id)?.nameSource).toBe('manual')
      closeDispatchers()
      dbB.close()
    })
  })

})
