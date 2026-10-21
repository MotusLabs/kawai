import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { closeDispatchers, createHarness, flush, initMessage, writeTranscript } from './helpers/chatSessionManagerHarness'

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

    test('getHistory replays a stored transcript into read-only events', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      writeTranscript('sdk-hist', MATCHED_TRANSCRIPT)
      const sessionId = seedRecord('sdk-hist')
      const fresh = seedRecord(null)
      const { manager } = await createHarness(db)

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
      expect(manager.getHistory(fresh)).toEqual({ status: 'ok', events: [], cwd: null })
      expect(manager.getHistory('chat-none')).toBeNull()
    })

    test('missing transcript yields a history-unavailable fallback', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const sessionId = seedRecord('sdk-vanished')
      const { manager } = await createHarness(db)

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
      const harnessA = await createHarness(dbA)
      const created = harnessA.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await harnessA.manager.send(sessionId, 'one')
      harnessA.handles[0]!.push(initMessage('sdk-ghost'))
      await flush()
      expect(dbA.getChatSession(sessionId)?.sdkSessionId).toBe('sdk-ghost')
      closeDispatchers()
      dbA.close()

      // Restart with no transcript on disk for the stored SDK id.
      const dbB = initDatabase({ path: dbPath })
      const harnessB = await createHarness(dbB)
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
      closeDispatchers()
      dbB.close()
    })

    test('parser failure with an existing transcript still permits resume', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      writeTranscript('sdk-ugly', 'not json\n{still not json')
      const sessionId = seedRecord('sdk-ugly')
      const { manager, handles } = await createHarness(db)

      expect(manager.getHistory(sessionId)?.status).toBe('unparseable')

      // The SDK reads the file itself: an unparseable-but-present transcript
      // must not block resume the way a missing one does.
      const result = await manager.send(sessionId, 'keep going')
      expect(result.ok).toBe(true)
      expect(handles[0]!.options.resume).toBe('sdk-ugly')
    })

    test('restart cancellation of pending requests shows in restored history', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      writeTranscript('sdk-pending', PENDING_REQUEST_TRANSCRIPT)
      const sessionId = seedRecord('sdk-pending')
      const { manager } = await createHarness(db)

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

    test('worker bodies read the subagent transcript beside the session', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const parent = writeTranscript('sdk-workers', MATCHED_TRANSCRIPT)
      const subagents = path.join(parent.replace(/\.jsonl$/, ''), 'subagents')
      fs.mkdirSync(subagents, { recursive: true })
      fs.writeFileSync(path.join(subagents, 'agent-a1.meta.json'),
        JSON.stringify({ toolUseId: 'toolu_spawn_1' }))
      fs.writeFileSync(path.join(subagents, 'agent-a1.jsonl'), JSON.stringify({
        type: 'user', uuid: 'w1', isSidechain: true,
        timestamp: '2026-10-04T10:00:00.000Z',
        message: { role: 'user', content: 'Map the workspace' },
      }) + '\n')
      const sessionId = seedRecord('sdk-workers')
      const { manager } = await createHarness(db)

      const body = manager.getWorkerTranscript(sessionId, 'toolu_spawn_1')
      expect(body.status).toBe('ok')
      expect(body.events.map((e) => e.type)).toEqual(['user_message'])
      expect(manager.getWorkerTranscript(sessionId, 'toolu_other').status)
        .toBe('unavailable')
      expect(manager.getWorkerTranscript('no-such-chat', 'toolu_spawn_1').status)
        .toBe('unavailable')
    })
  })

})
