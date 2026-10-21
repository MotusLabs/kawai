import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatNotification } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { anyDirectory, writeCredentialedProviderCatalog, FakeHandle, testManagers, managedManager, closeDispatchers, fakeQueryFactory } from './helpers/chatSessionManagerHarness'

describe('ChatSessionManager notifications', () => {
  let tempDir: string
  let db: SessionDatabase
  const originals = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  }

  beforeEach(() => {
    jest.useRealTimers()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatnotify-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    // Same isolation as the main describe: the default profile's credentials
    // check reads a config dir this block owns, never the operator's login.
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  })

  afterEach(() => {
    jest.useRealTimers()
    for (const [name, value] of Object.entries(originals)) {
      if (value !== undefined) process.env[name] = value
      else delete process.env[name]
    }
    closeDispatchers()
    testManagers.clear()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /** Manager harness capturing notification pushes. */
  async function noticeHarness() {
    const handles: FakeHandle[] = []
    const pushes: Array<{ sessionId: string; notifications: ChatNotification[] }> = []
    const manager = await managedManager({
      isDirectory: anyDirectory,
      profileCatalogHome: tempDir,
      registry: new SessionRegistry(),
      db,
      onEvent: () => {},
      onNotifications: (sessionId, notifications) =>
        pushes.push({ sessionId, notifications }),
      queryFactory: fakeQueryFactory(handles),
    })
    return { manager, handles, pushes }
  }

  /**
   * Drain the driver's stream delivery under fake timers: the spawn and
   * frame-delivery paths are microtasks, so rounds of awaited microtask
   * ticks suffice without advancing the clock.
   */
  async function drain(rounds = 40): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve()
  }

  function writeCredentials(fields: Record<string, unknown>): string {
    const configDir = process.env.CLAUDE_CONFIG_DIR!
    fs.mkdirSync(configDir, { recursive: true })
    const filePath = path.join(configDir, '.credentials.json')
    fs.writeFileSync(filePath, JSON.stringify(fields))
    return filePath
  }

  /** Credentials with a refresh token expiring `daysFromNow` (access 1h older). */
  function expiringCredentials(daysFromNow: number): Record<string, unknown> {
    const at = Date.now() + daysFromNow * 24 * 60 * 60 * 1000
    return {
      claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: at - 3_600_000, refreshTokenExpiresAt: at },
    }
  }

  /** A system/notification frame off the fake stream. */
  function notifyFrame(overrides: Record<string, unknown> = {}): SDKMessage {
    return {
      type: 'system',
      subtype: 'notification',
      key: 'model-context-window',
      text: 'Context low',
      priority: 'high',
      color: 'warning',
      uuid: 'notification-uuid',
      session_id: 'sdk-1',
      ...overrides,
    } as unknown as SDKMessage
  }

  /** A started session with a live (fake) driver to push frames into. */
  async function startedSession(
    manager: InstanceType<typeof ChatSessionManager>,
    handles: FakeHandle[],
    text = 'hello'
  ): Promise<string> {
    // The auth gate needs a credentials file to exist; a field-less one
    // authenticates (existsSync) without producing an account notice.
    if (!fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'))) {
      writeCredentials({})
    }
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    await manager.send(created.session.id, text)
    await drain()
    return created.session.id
  }

  test('an agent notice replaces a same-key notice and never leaks across sessions', async () => {
    const { manager, handles, pushes } = await noticeHarness()
    const first = await startedSession(manager, handles)
    const second = await startedSession(manager, handles, 'second')
    handles[0]!.push(notifyFrame({ text: 'first copy' }))
    await drain()
    handles[0]!.push(notifyFrame({ text: 'second copy' }))
    await drain()
    // Same-key replacement: only the newer text is held.
    expect(manager.getSnapshot(first)!.notifications).toHaveLength(1)
    expect(manager.getSnapshot(first)!.notifications[0]).toMatchObject({
      key: 'model-context-window',
      source: 'agent',
      severity: 'warning',
      text: 'second copy',
    })
    // Session B shows nothing of session A's notices.
    expect(manager.getSnapshot(second)!.notifications).toEqual([])
    expect(pushes.every((push) => push.sessionId === first)).toBe(true)
  })

  test('a timed notice expires after its timeout; an untimed one persists', async () => {
    jest.useFakeTimers()
    const { manager, handles, pushes } = await noticeHarness()
    const id = await startedSession(manager, handles)
    handles[0]!.push(notifyFrame({ timeout_ms: 15_000 }))
    handles[0]!.push(notifyFrame({ key: 'error-compacting-conversation', text: 'Error compacting conversation', color: 'error', priority: 'immediate', timeout_ms: undefined }))
    await drain()
    expect(manager.getSnapshot(id)!.notifications).toHaveLength(2)

    jest.advanceTimersByTime(14_999)
    await drain()
    expect(manager.getSnapshot(id)!.notifications).toHaveLength(2)
    jest.advanceTimersByTime(1)
    await drain()
    // The timed notice is gone; the untimed one stays until closed.
    expect(manager.getSnapshot(id)!.notifications.map((notice) => notice.key)).toEqual([
      'error-compacting-conversation',
    ])
    expect(pushes.at(-1)!.notifications).toEqual(manager.getSnapshot(id)!.notifications)
  })

  test('an expiring replacement is not removed by its predecessor timer', async () => {
    jest.useFakeTimers()
    const { manager, handles } = await noticeHarness()
    const id = await startedSession(manager, handles)
    handles[0]!.push(notifyFrame({ timeout_ms: 5_000 }))
    await drain()
    jest.advanceTimersByTime(3_000)
    handles[0]!.push(notifyFrame({ timeout_ms: 30_000 }))
    await drain()
    jest.advanceTimersByTime(5_000)
    await drain()
    // The old 5s timer fired but the replacement (armed at +3s for 30s)
    // survives it; it only goes at +33s.
    expect(manager.getSnapshot(id)!.notifications.map((notice) => notice.key)).toEqual([
      'model-context-window',
    ])
    jest.advanceTimersByTime(28_000)
    await drain()
    expect(manager.getSnapshot(id)!.notifications).toEqual([])
  })

  test('archive clears agent notices but keeps the account notice', async () => {
    writeCredentials(expiringCredentials(1.4))
    const { manager, handles, pushes } = await noticeHarness()
    const id = await startedSession(manager, handles)
    handles[0]!.push(notifyFrame())
    await drain()
    expect(manager.getSnapshot(id)!.notifications).toHaveLength(2)

    expect(manager.archive(id)).toEqual({ ok: true })
    // The archived chat shows the account notice only (design D4).
    expect(manager.getSnapshot(id)!.notifications.map((notice) => notice.source)).toEqual(['account'])
    expect(pushes.at(-1)!.notifications).toEqual(manager.getSnapshot(id)!.notifications)
  })

  test('kill clears notices with the session and a restart begins clean', async () => {
    const { manager, handles } = await noticeHarness()
    const id = await startedSession(manager, handles)
    handles[0]!.push(notifyFrame())
    await drain()
    expect(manager.getSnapshot(id)!.notifications).toHaveLength(1)

    manager.kill(id)
    expect(manager.getSnapshot(id)).toBeNull()

    // A crashed driver's notices do not survive its respawn.
    const fresh = await startedSession(manager, handles, 'again')
    expect(manager.getSnapshot(fresh)!.notifications).toEqual([])
  })

  test('an unexpected exit clears untimed notices; the same session respawn starts clean', async () => {
    const { manager, handles, pushes } = await noticeHarness()
    const id = await startedSession(manager, handles)
    handles[0]!.push(notifyFrame({ timeout_ms: undefined }))
    await drain()
    expect(manager.getSnapshot(id)!.notifications).toHaveLength(1)

    // The process exits on its own. The session keeps its dead driver, and
    // the next send respawns inside the same driver object — no new
    // construction, so only the process-end callback clears the notices
    // the crashed process emitted.
    handles[0]!.query.close()
    await drain()
    expect(manager.getSnapshot(id)!.notifications).toEqual([])
    expect(pushes.at(-1)!.notifications).toEqual([])

    await manager.send(id, 'after the crash')
    await drain()
    expect(handles).toHaveLength(2)
    expect(manager.getSnapshot(id)!.notifications).toEqual([])
  })

  test('the snapshot carries the account notice computed on attach', async () => {
    writeCredentials(expiringCredentials(1.4))
    const { manager } = await noticeHarness()
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const snapshot = manager.getSnapshot(created.session.id)!
    expect(snapshot.notifications).toHaveLength(1)
    expect(snapshot.notifications[0]).toMatchObject({
      key: 'login-expiry',
      source: 'account',
      severity: 'warning',
      text: 'Your login expires in 2 days',
      hint: 'run /login in a Claude terminal to renew',
    })
  })

  test('a credentialed provider session shows no host-login expiry notice', async () => {
    writeCredentials(expiringCredentials(1.4))
    writeCredentialedProviderCatalog(tempDir)
    process.env.OR2_KEY = 'or-sentinel'
    try {
      const { manager } = await noticeHarness()
      const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'or2-opus' })
      if (!created.ok) throw new Error(created.error)
      expect(manager.getSnapshot(created.session.id)!.notifications).toEqual([])
      // A host-login session on the same server still sees it.
      const host = manager.createSession({ projectPath: '/tmp/proj' })
      if (!host.ok) throw new Error(host.error)
      expect(manager.getSnapshot(host.session.id)!.notifications.map((n) => n.key)).toEqual(['login-expiry'])
    } finally {
      delete process.env.OR2_KEY
    }
  })

  test('two sessions sharing a credentials path both update on a change', async () => {
    writeCredentials(expiringCredentials(1.4))
    const { manager, pushes } = await noticeHarness()
    const first = manager.createSession({ projectPath: '/tmp/proj' })
    const second = manager.createSession({ projectPath: '/tmp/proj' })
    if (!first.ok) throw new Error(first.error)
    if (!second.ok) throw new Error(second.error)
    // Both attach: both map to the same (default) credentials path.
    manager.getSnapshot(first.session.id)
    manager.getSnapshot(second.session.id)
    expect(manager.getSnapshot(first.session.id)!.notifications).toHaveLength(1)
    expect(manager.getSnapshot(second.session.id)!.notifications).toHaveLength(1)

    // The user renews: the slow-timer recheck pushes the empty list to both.
    writeCredentials(expiringCredentials(30))
    manager.recheckAccountNotices([first.session.id, second.session.id])
    const cleared = pushes.filter((push) => push.notifications.length === 0)
    expect(cleared.map((push) => push.sessionId).sort()).toEqual(
      [first.session.id, second.session.id].sort()
    )
    expect(manager.getSnapshot(first.session.id)!.notifications).toEqual([])
  })

  test('a profile the catalog cannot resolve yields no account notice', async () => {
    // A persisted row survives a restart even when its profile entry is gone;
    // the refresh must map it to null instead of failing the snapshot.
    const ghost = {
      sessionId: 'chat-ghost',
      name: 'ghost',
      projectPath: '/tmp/proj',
      sdkSessionId: null,
      claudeProfileId: 'vanished',
      approvalPolicy: 'manual' as const,
      nameSource: 'manual' as const,
      groupId: null,
      status: 'waiting' as const,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    }
    db.insertChatSession(ghost)
    writeCredentials(expiringCredentials(1.4))
    const { manager } = await noticeHarness()
    const snapshot = manager.getSnapshot('chat-ghost')!
    expect(snapshot.notifications).toEqual([])
  })

  test('an unreadable or expired login yields no notice', async () => {
    const { manager } = await noticeHarness()
    writeCredentials({})
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    writeCredentials(expiringCredentials(-0.5))
    expect(manager.getSnapshot(created.session.id)!.notifications).toEqual([])
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), '{torn')
    expect(manager.getSnapshot(created.session.id)!.notifications).toEqual([])
  })

  test('dismissNotification removes the key and pushes the new list; unknown keys are a no-op', async () => {
    const { manager, handles, pushes } = await noticeHarness()
    const id = await startedSession(manager, handles)
    handles[0]!.push(notifyFrame())
    await drain()
    expect(pushes).toHaveLength(1)

    expect(manager.dismissNotification(id, 'missing-key')).toEqual({ ok: true })
    expect(pushes).toHaveLength(1)

    expect(manager.dismissNotification(id, 'model-context-window')).toEqual({ ok: true })
    expect(manager.getSnapshot(id)!.notifications).toEqual([])
    expect(pushes).toHaveLength(2)
    expect(pushes[1]!.notifications).toEqual([])

    // Account keys never pass the server-side dismiss.
    writeCredentials(expiringCredentials(1.4))
    manager.getSnapshot(id)
    expect(manager.dismissNotification(id, 'login-expiry')).toEqual({ ok: true })
    expect(manager.getSnapshot(id)!.notifications.map((notice) => notice.source)).toEqual(['account'])

    expect(manager.dismissNotification('missing-session', 'k').ok).toBe(false)
  })

  test('snapshot ordering: priority first, then newest, account ahead on ties', async () => {
    writeCredentials(expiringCredentials(1.4))
    const { manager, handles } = await noticeHarness()
    const id = await startedSession(manager, handles)
    handles[0]!.push(notifyFrame({ key: 'low-note', text: 'meh', priority: 'low', color: undefined }))
    await drain()
    handles[0]!.push(notifyFrame({ key: 'urgent-note', text: 'now', priority: 'immediate', color: 'error' }))
    await drain()
    const keys = manager.getSnapshot(id)!.notifications.map((notice) => notice.key)
    // immediate agent, then the account notice (high), then the low agent.
    expect(keys).toEqual(['urgent-note', 'login-expiry', 'low-note'])
  })
})
