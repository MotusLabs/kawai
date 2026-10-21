import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Session } from '../../shared/types'
import { initDatabase, type SessionDatabase } from '../db'
import { anyDirectory, closeDispatchers, createHarness, flush, initMessage, fireCwdChanged, writeTranscript } from './helpers/chatSessionManagerHarness'

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

  describe('cwd tracking', () => {
    test('a cwd move patches the stored path, republishes it, and skips no-ops', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const harness = await createHarness(db)
      const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      expect(await harness.manager.send(sessionId, 'enter a worktree')).toEqual({ ok: true })
      expect(harness.handles[0]!.options.cwd).toBe('/tmp/proj')

      const updates: Session[] = []
      harness.registry.on('session-update', (session: Session) => updates.push(session))
      const worktree = '/tmp/proj/.claude/worktrees/add-feature'
      await fireCwdChanged(harness.handles[0]!, worktree)

      // The stored row and the published Session both show the new directory.
      expect(db.getChatSession(sessionId)?.projectPath).toBe(worktree)
      expect(harness.registry.get(sessionId)?.projectPath).toBe(worktree)
      // The session-update broadcast carries the move (worktree tracking D2),
      // so clients re-group the row without a reload.
      const moved = updates.filter((session) => session.id === sessionId)
      expect(moved.at(-1)?.projectPath).toBe(worktree)

      // A repeat for the same directory is a no-op: no write, no broadcast.
      const updateCount = updates.length
      await fireCwdChanged(harness.handles[0]!, worktree)
      expect(updates).toHaveLength(updateCount)
      expect(db.getChatSession(sessionId)?.projectPath).toBe(worktree)
      harness.manager.shutdown()
    })

    test('a respawn after the move resumes in the new directory', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const harness = await createHarness(db)
      const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await harness.manager.send(sessionId, 'first')
      harness.handles[0]!.push(initMessage('sdk-cwd-session'))
      await flush()
      const worktree = '/tmp/proj/.claude/worktrees/add-feature'
      await fireCwdChanged(harness.handles[0]!, worktree)

      // The process dies; the respawn must land in the worktree, not the
      // creation path, and still resume the same conversation.
      harness.handles[0]!.query.close()
      await flush()
      expect(await harness.manager.send(sessionId, 'second')).toEqual({ ok: true })
      expect(harness.handles).toHaveLength(2)
      expect(harness.handles[1]!.options.cwd).toBe(worktree)
      expect(harness.handles[1]!.options.resume).toBe('sdk-cwd-session')
      harness.manager.shutdown()
    })

    test('several hook events together issue exactly one scoped refresh for the newest path', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const harness = await createHarness(db, anyDirectory, undefined, undefined, undefined, 5)
      const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      await harness.manager.send(created.session.id, 'cd around')
      // A fast cd chain collapses into one discovery pass for its final
      // directory (worktree tracking D2).
      await fireCwdChanged(harness.handles[0]!, '/tmp/proj/.claude/worktrees/one')
      await fireCwdChanged(harness.handles[0]!, '/tmp/proj/.claude/worktrees/two')
      await fireCwdChanged(harness.handles[0]!, '/tmp/proj/.claude/worktrees/three')
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(harness.refreshes).toEqual(['/tmp/proj/.claude/worktrees/three'])
      harness.manager.shutdown()
    })

    test('kill cancels a pending refresh', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const harness = await createHarness(db, anyDirectory, undefined, undefined, undefined, 5)
      const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await harness.manager.send(sessionId, 'move')
      await fireCwdChanged(harness.handles[0]!, '/tmp/proj/.claude/worktrees/gone')
      harness.manager.kill(sessionId)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(harness.refreshes).toEqual([])
    })

    for (const action of ['send', 'start'] as const) {
      test(`direct ${action} recovers the path before validating and spawning`, async () => {
        process.env.ANTHROPIC_API_KEY = 'sk-test-key'
        const worktree = '/tmp/proj/.claude/worktrees/recovered'
        const now = new Date().toISOString()
        db.insertChatSession({
          sessionId: 'chat-recovered', name: 'Recovered',
          projectPath: '/tmp/proj', sdkSessionId: 'sdk-late-cwd',
          status: 'waiting', createdAt: now, lastActivityAt: now,
        })
        // No transcript at startup. It arrives before the first direct action,
        // and the original directory is gone: the guard must use the new cwd.
        const harness = await createHarness(db, (directory) => directory === worktree,
          undefined, undefined, undefined, 5)
        writeTranscript('sdk-late-cwd', JSON.stringify({
          type: 'user', uuid: 'recovered-user', cwd: worktree,
          message: { role: 'user', content: 'hello' },
        }))
        const outcome = action === 'send'
          ? await harness.manager.send('chat-recovered', 'continue')
          : await harness.manager.start('chat-recovered')
        expect(outcome).toEqual({ ok: true })
        expect(db.getChatSession('chat-recovered')?.projectPath).toBe(worktree)
        expect(harness.handles[0]!.options.cwd).toBe(worktree)
        expect(harness.handles[0]!.options.resume).toBe('sdk-late-cwd')
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(harness.refreshes).toEqual([worktree])
        harness.manager.shutdown()
      })
    }

    test('history recovery refreshes discovery once for the latest moved path', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const harness = await createHarness(db, anyDirectory, undefined, undefined, undefined, 5)
      const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const id = created.session.id
      await harness.manager.send(id, 'first')
      harness.handles[0]!.push(initMessage('sdk-history-cwd'))
      await flush()
      const recover = (cwd: string) => {
        writeTranscript('sdk-history-cwd', JSON.stringify({
          type: 'user', uuid: 'moved-user', cwd,
          message: { role: 'user', content: 'hello' },
        }))
        harness.manager.getHistory(id)
      }
      recover('/tmp/other-repo/one')
      recover('/tmp/other-repo/two')
      recover('/tmp/other-repo/two') // same-path recovery is a no-op
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(harness.refreshes).toEqual(['/tmp/other-repo/two'])
      expect(harness.registry.get(id)?.projectPath).toBe('/tmp/other-repo/two')
      harness.manager.shutdown()
    })

    test('a restored session whose transcript moved comes back with the worktree path', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const first = await createHarness(db)
      const created = first.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await first.manager.send(sessionId, 'enter a worktree')
      first.handles[0]!.push(initMessage('sdk-moved-session'))
      await flush()
      first.manager.shutdown()

      // The transcript records the conversation ending in a worktree.
      const movedLine = (uuid: string, cwd: string) =>
        JSON.stringify({
          type: 'user',
          uuid,
          timestamp: '2026-10-04T10:00:00.000Z',
          message: { role: 'user', content: 'hello' },
          cwd,
        })
      const transcriptPath = writeTranscript(
        'sdk-moved-session',
        [
          movedLine('u1', '/tmp/proj'),
          movedLine('u2', '/tmp/proj/.claude/worktrees/add-feature'),
        ].join('\n')
      )

      // Restart: restorePersisted adopts the transcript's last cwd (design
      // D3), so the row, the registry, and any respawn land in the worktree.
      const restored = await createHarness(db)
      expect(restored.registry.get(sessionId)?.projectPath).toBe(
        '/tmp/proj/.claude/worktrees/add-feature'
      )
      expect(db.getChatSession(sessionId)?.projectPath).toBe(
        '/tmp/proj/.claude/worktrees/add-feature'
      )
      expect(await restored.manager.send(sessionId, 'continue')).toEqual({ ok: true })
      expect(restored.handles[0]!.options.cwd).toBe(
        '/tmp/proj/.claude/worktrees/add-feature'
      )

      // A later transcript move reaches the attach/history replay the same
      // way (design D3): replaying the history syncs and re-publishes the
      // row. (The first attach after a restart is what replays history —
      // here send already cached a snapshot, so call the replay directly.)
      const updates: Session[] = []
      restored.registry.on('session-update', (session: Session) => updates.push(session))
      fs.writeFileSync(
        transcriptPath,
        movedLine('u3', '/tmp/proj/.claude/worktrees/later') + '\n'
      )
      const replay = restored.manager.getHistory(sessionId)
      expect(replay?.cwd).toBe('/tmp/proj/.claude/worktrees/later')
      expect(restored.registry.get(sessionId)?.projectPath).toBe(
        '/tmp/proj/.claude/worktrees/later'
      )
      expect(db.getChatSession(sessionId)?.projectPath).toBe(
        '/tmp/proj/.claude/worktrees/later'
      )
      expect(updates.at(-1)?.projectPath).toBe(
        '/tmp/proj/.claude/worktrees/later'
      )
      restored.manager.shutdown()
    })
  })

})
