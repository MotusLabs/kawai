// chatSessionManager split: approval-policy tests.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { anyDirectory, managedManager, closeDispatchers, createHarness, flush, installManagerCleanup } from './helpers/chatSessionManagerHarness'

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

  test('approval policy: starts manual, switches live, refuses invalid changes', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const { manager, registry, events } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    expect(created.session.approvalPolicy).toBe('manual')

    expect(manager.setApprovalPolicy(id, 'auto')).toEqual({ ok: true })
    expect(registry.get(id)?.approvalPolicy).toBe('auto')
    expect(db.getChatSession(id)?.approvalPolicy).toBe('auto')
    // Repeat is a no-op success that emits no second notice.
    expect(manager.setApprovalPolicy(id, 'auto')).toEqual({ ok: true })
    const notices = events
      .map((entry) => entry.event)
      .filter((event) => event.type === 'notice')
    expect(notices).toHaveLength(1)
    expect((notices[0] as { text: string }).text).toBe('Auto-approve on')
    // The notice is part of the snapshot a later attach receives.
    expect(
      manager.getSnapshot(id)?.events.some(
        (event) =>
          event.type === 'notice' &&
          (event as { text: string }).text === 'Auto-approve on'
      )
    ).toBe(true)

    // Unknown sessions and unsupported values refuse without side effects.
    expect(manager.setApprovalPolicy('chat-missing', 'auto')).toMatchObject({ ok: false })
    expect(
      manager.setApprovalPolicy(id, 'yolo' as unknown as 'auto')
    ).toMatchObject({ ok: false })
    expect(db.getChatSession(id)?.approvalPolicy).toBe('auto')

    // Archived sessions refuse; restoring keeps the stored policy.
    manager.archive(id)
    expect(manager.setApprovalPolicy(id, 'manual')).toMatchObject({ ok: false })
    expect(db.getChatSession(id)?.approvalPolicy).toBe('auto')
    manager.restore(id)
    expect(registry.get(id)?.approvalPolicy).toBe('auto')
    manager.kill(id)
  })

  test('approval policy survives a backend restart', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const dbPath = path.join(tempDir, 'policy-restart.db')
    const dbA = initDatabase({ path: dbPath })
    const harnessA = await createHarness(dbA)
    const created = harnessA.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    harnessA.manager.setApprovalPolicy(created.session.id, 'auto')
    harnessA.manager.shutdown()
    closeDispatchers()
    dbA.close()

    const dbB = initDatabase({ path: dbPath })
    try {
      const registryB = new SessionRegistry()
      await managedManager({
        isDirectory: anyDirectory,
        db: dbB,
        registry: registryB,
        onEvent: () => {},
      })
      expect(registryB.get(created.session.id)?.approvalPolicy).toBe('auto')
    } finally {
      closeDispatchers()
      dbB.close()
    }
  })

  test('switching to auto grants a pending approval and the next request', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const { manager, handles, events } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await manager.send(id, 'go')
    await flush()
    const controller = new AbortController()
    const approval = handles[0]!.options.canUseTool!(
      'Bash',
      { command: 'ls' },
      { signal: controller.signal, toolUseID: 'toolu_1', requestId: 'sdk-req-1' }
    )
    await flush()
    expect(
      events.some(({ event }) => event.type === 'approval_request')
    ).toBe(true)

    expect(manager.setApprovalPolicy(id, 'auto')).toEqual({ ok: true })
    await expect(approval).resolves.toEqual({ behavior: 'allow' })
    // A second tool use arrives after the switch: granted without a card.
    const next = handles[0]!.options.canUseTool!(
      'Write',
      { file_path: '/tmp/x', content: 'x' },
      { signal: controller.signal, toolUseID: 'toolu_2', requestId: 'sdk-req-2' }
    )
    await expect(next).resolves.toEqual({ behavior: 'allow' })
    const policyResolutions = events
      .map((entry) => entry.event)
      .filter(
        (event): event is Extract<ChatEvent, { type: 'request_resolved' }> =>
          event.type === 'request_resolved'
      )
      .filter((event) => event.decidedBy === 'policy')
    expect(policyResolutions).toHaveLength(2)
    expect(manager.getSnapshot(id)?.pendingRequests).toEqual([])
    manager.kill(id)
  })

})
