import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import {
  ChatSessionManager,
  hasClaudeAuth,
  type ChatQueryFactory,
} from '../chat/ChatSessionManager'

/** Minimal scriptable Query: tests push SDK messages, options are captured. */
interface FakeHandle {
  query: Query
  options: Options
  push: (message: SDKMessage) => void
  closed: boolean
}

function fakeQueryFactory(handles: FakeHandle[]): ChatQueryFactory {
  return ({ prompt: _prompt, options }) => {
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

function createHarness(db: SessionDatabase): ManagerHarness {
  const registry = new SessionRegistry()
  const handles: FakeHandle[] = []
  const events: Array<{ sessionId: string; event: ChatEvent }> = []
  const manager = new ChatSessionManager({
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
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    // Isolate auth from the host: no API key, empty CLI config dir.
    delete process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  })

  afterEach(() => {
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

  describe('auth gate', () => {
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
