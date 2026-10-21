import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase, type SessionDatabase } from '../db'
import { anyDirectory, closeDispatchers, createHarness, flush, installManagerCleanup } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

describe('ChatSessionManager usage', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalHome = process.env.HOME
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-usage-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
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
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
    closeDispatchers()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function rateLimitEvent(fields: Record<string, unknown>): SDKMessage {
    return {
      type: 'rate_limit_event',
      rate_limit_info: fields,
      uuid: 'rl-uuid',
      session_id: 'sdk-1',
    } as unknown as SDKMessage
  }

  const PROBE_EVENT = rateLimitEvent({
    status: 'allowed',
    unifiedWindows: {
      five_hour: { utilization: 0.2237, resetsAt: Date.parse('2026-10-07T18:11:04.000Z') / 1000 },
      seven_day: { utilization: 0.1712, resetsAt: Date.parse('2026-10-12T09:00:00.000Z') / 1000 },
    },
  })

  const FULL_PULL = {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 22.37, resets_at: '2026-10-07T18:11:04.000Z' },
      seven_day: { utilization: 17.12, resets_at: '2026-10-12T09:00:00.000Z' },
    },
  }

  test('pushed reports are stored per provider, shared by its sessions, and snapshotted', async () => {
    const { manager, handles, usage } = await createHarness(db)
    const first = manager.createSession({ projectPath: '/tmp/proj' })
    if (!first.ok) throw new Error('create failed')
    // Neither report nor verdict: the snapshot carries no usage.
    expect(manager.getSnapshot(first.session.id)!.usage).toBeNull()

    const second = manager.createSession({ projectPath: '/tmp/proj' })
    if (!second.ok) throw new Error('create failed')
    await manager.send(first.session.id, 'hello')
    // The fake query has no usage control, so the spawn records the
    // no-data verdict first (broadcast as null).
    handles[0]!.push(PROBE_EVENT)
    await flush()

    expect(usage).toHaveLength(2)
    expect(usage[0]).toEqual({ providerId: 'claude', report: null })
    expect(usage[1]).toMatchObject({ providerId: 'claude' })
    expect(usage[1].report?.windows.map((window) => window.key)).toEqual([
      'five_hour',
      'seven_day',
    ])
    // The second session of the same profile sees the same report.
    expect(manager.getSnapshot(first.session.id)!.usage).toBe(usage[1].report)
    expect(manager.getSnapshot(second.session.id)!.usage).toBe(usage[1].report)
    expect(manager.profileIdOf(first.session.id)).toBe('default')

    // A later, windowless push keeps the windows and updates the status.
    handles[0]!.push(rateLimitEvent({ status: 'rejected' }))
    await flush()
    const held = manager.getSnapshot(first.session.id)!.usage!
    expect(held.status).toBe('limited')
    expect(held.windows.map((window) => window.key)).toEqual([
      'five_hour',
      'seven_day',
    ])
  })

  test('parked work pauses its session (with reason and resume time) until it is unparked', async () => {
    const { manager, registry } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    const store = manager.mailbox.store
    const mail = store.enqueue({ teamId: 't', toKind: 'session', toId: id, fromSession: id, fromGroup: null, originPath: '/tmp/proj', body: 'work' })
    store.claim(mail.id, id); store.markPushed(mail.id); store.markDelivered(mail.id)
    const resume = store.enqueue({ teamId: 't', toKind: 'session', toId: id, fromSession: id, fromGroup: null, originPath: '/tmp/proj', body: 'resume', deliverAt: '2099-01-01T00:00:00.000Z' })
    store.park(mail.id, '2099-01-01T00:00:00.000Z', resume.id)
    expect(registry.get(id)?.parked).toEqual({ messageId: mail.id, until: '2099-01-01T00:00:00.000Z', profileId: 'glm', reason: 'Provider limit on glm' })
    store.unpark(mail.id)
    expect(registry.get(id)?.parked).toBeNull()
  })

  test('cancelling a holder\'s only parked message clears its paused state, and an archived holder stays archived', async () => {
    const { manager, registry } = await createHarness(db)
    const parkWork = (id: string) => {
      const store = manager.mailbox.store
      const mail = store.enqueue({ teamId: 't', toKind: 'session', toId: id, fromSession: id, fromGroup: null, originPath: '/tmp/proj', body: 'work' })
      store.claim(mail.id, id); store.markPushed(mail.id); store.markDelivered(mail.id)
      const resume = store.enqueue({ teamId: 't', toKind: 'session', toId: id, fromSession: id, fromGroup: null, originPath: '/tmp/proj', body: 'resume', deliverAt: '2099-01-01T00:00:00.000Z' })
      store.park(mail.id, '2099-01-01T00:00:00.000Z', resume.id)
      return { mail, resume }
    }
    const live = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    const archived = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!live.ok || !archived.ok) throw new Error('create failed')
    const liveWork = parkWork(live.session.id)
    const archivedWork = parkWork(archived.session.id)
    expect(manager.archive(archived.session.id).ok).toBe(true)
    expect(registry.get(live.session.id)?.parked).not.toBeNull()

    const store = manager.mailbox.store
    expect(store.cancel(liveWork.mail.id, { kind: 'human' })).toBe(true)
    expect(store.cancel(archivedWork.mail.id, { kind: 'human' })).toBe(true)
    expect(registry.get(live.session.id)?.parked).toBeNull()
    expect(registry.get(archived.session.id)?.parked).toBeNull()
    expect(registry.get(archived.session.id)?.archivedAt).toBeTruthy()
    expect(db.getChatSession(archived.session.id)?.archivedAt).toBeTruthy()
    expect(store.get(archivedWork.resume.id)?.state).toBe('cancelled')
    // Nothing pends for the live holder either, so group mail may reach it again.
    expect(store.parkedBy(live.session.id)).toEqual([])
  })

  test('limit failures are recorded against the session profile and group', async () => {
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    handles[0]!.push({
      type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 100,
      error_status: 429, error: 'rate_limit', uuid: 'r-uuid', session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    expect(manager.limitEvents.forProfile('glm')).toMatchObject([
      { profileId: 'glm', sessionId: created.session.id, groupId: null, kind: 'rate_limit', final: false, status: 429 },
    ])
    expect(manager.limitEvents.forProfile('default')).toEqual([])
  })

  test('the final event records the provider and the rejected report window', async () => {
    fs.mkdirSync(path.join(tempDir, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(tempDir, '.kawai', 'providers.json'), JSON.stringify({
      zai: {
        label: 'Z.AI',
        models: { glm: { label: 'GLM', model: 'opus' }, 'glm-flash': { label: 'GLM Flash', model: 'sonnet' } },
      },
    }))
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    const reset = Math.floor(Date.now() / 1000) + 2400
    handles[0]!.push({
      type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset, rateLimitType: 'seven_day_opus' },
    } as unknown as SDKMessage)
    handles[0]!.push({
      type: 'assistant', error: 'rate_limit', parent_tool_use_id: null, session_id: 'sdk-1', uuid: 'a-uuid',
      message: { id: 'msg_err2', role: 'assistant', content: [{ type: 'text', text: 'API Error: 429 quota' }] },
    } as unknown as SDKMessage)
    await flush()
    expect(manager.limitEvents.forProfile('glm')).toEqual([{
      id: expect.any(String), profileId: 'glm', sessionId: created.session.id, groupId: null, at: expect.any(String),
      kind: 'rate_limit', final: true, status: 429, message: 'API Error: 429 quota',
      resetsAt: new Date(reset * 1000).toISOString(), providerId: 'zai', window: 'seven_day_opus',
    }])
    manager.shutdown()
  })

  test("a zone-less reset in the error text is read in the profile's limitResetTimeZone", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token'
    const project = path.join(tempDir, 'proj')
    fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(project, '.kawai', 'profiles.json'), JSON.stringify({
      'glm-cn': { label: 'GLM CN', limitResetTimeZone: 'Asia/Shanghai' },
    }))
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: project, claudeProfileId: 'glm-cn' })
    if (!created.ok) throw new Error(created.error)
    await manager.send(created.session.id, 'hello')
    handles[0]!.push({
      type: 'assistant', error: 'rate_limit', parent_tool_use_id: null, session_id: 'sdk-1', uuid: 'a-uuid',
      message: { id: 'msg_err', role: 'assistant', content: [{ type: 'text', text: 'API Error: [1308][Your limit will reset at 2026-10-13 17:17:00]' }] },
    } as unknown as SDKMessage)
    await flush()
    expect(manager.limitEvents.forProfile('glm-cn')).toMatchObject([
      { final: true, resetsAt: '2026-10-13T09:17:00.000Z' },
    ])
    manager.shutdown()
  })

  test('an assistant usage_report is stored for the session profile provider', async () => {
    // glm maps to zai in a pinned catalog: the report is held per provider,
    // whatever host catalog the suite would otherwise read.
    const catalog = path.join(tempDir, 'catalog-glm')
    fs.mkdirSync(path.join(catalog, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(catalog, '.kawai', 'providers.json'), JSON.stringify({ zai: { label: 'Z.AI', models: { glm: {} } } }))
    fs.writeFileSync(path.join(catalog, '.kawai', 'profiles.json'), JSON.stringify({ glm: { label: 'GLM' } }))
    const { manager, handles, usage } = await createHarness(db, anyDirectory, undefined, undefined, undefined, undefined, undefined, catalog)
    const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    handles[0]!.push({
      type: 'assistant',
      message: {
        id: 'msg_usage',
        content: [{ type: 'text', text: 'Usage report' }],
        role: 'assistant',
      },
      parent_tool_use_id: null,
      uuid: 'u-uuid',
      session_id: 'sdk-1',
      usage_report: {
        rate_limits: {
          limits: [
            { kind: 'session', percent: 22.4, resets_at: null, severity: 'normal' },
          ],
        },
      },
    } as unknown as SDKMessage)
    await flush()
    expect(usage).toHaveLength(2)
    expect(usage[0]).toEqual({ providerId: 'zai', report: null }) // spawn verdict
    expect(usage[1]).toMatchObject({ providerId: 'zai' })
    expect(usage[1].report?.windows).toHaveLength(1)
    expect(manager.getSnapshot(created.session.id)!.usage).toBe(usage[1].report)
  })

  test('the pull fallback fills usage before any push and only once per provider', async () => {
    const { manager, handles, usage } = await createHarness(
      db,
      anyDirectory,
      async (opts) => ({ ...FULL_PULL, opts })
    )
    const first = manager.createSession({ projectPath: '/tmp/proj' })
    if (!first.ok) throw new Error('create failed')
    await manager.send(first.session.id, 'hello')
    await flush()
    expect(handles[0]!.usageCalls).toEqual([{ skipBehaviors: true }])
    expect(usage).toHaveLength(1)
    expect(usage[0].report?.windows).toHaveLength(2)
    expect(manager.getSnapshot(first.session.id)!.usage).toBe(usage[0].report)

    // A second session of the same profile spawns later: no second pull.
    const second = manager.createSession({ projectPath: '/tmp/proj' })
    if (!second.ok) throw new Error('create failed')
    await manager.send(second.session.id, 'hi')
    await flush()
    const calls = handles.flatMap((handle) => handle.usageCalls)
    expect(calls).toHaveLength(1)
  })

  test('a no-data pull suppresses later pulls until a push replaces the verdict', async () => {
    const { manager, handles, usage } = await createHarness(
      db,
      anyDirectory,
      async () => ({ rate_limits_available: false, rate_limits: null })
    )
    const first = manager.createSession({ projectPath: '/tmp/proj' })
    if (!first.ok) throw new Error('create failed')
    await manager.send(first.session.id, 'hello')
    await flush()
    // The verdict broadcasts as null and keeps the snapshot empty.
    expect(usage).toEqual([{ providerId: 'claude', report: null }])
    expect(manager.getSnapshot(first.session.id)!.usage).toBeNull()

    // Another session of the profile spawns: the verdict skips the pull.
    const second = manager.createSession({ projectPath: '/tmp/proj' })
    if (!second.ok) throw new Error('create failed')
    await manager.send(second.session.id, 'again')
    await flush()
    expect(handles.flatMap((handle) => handle.usageCalls)).toHaveLength(1)

    // A pushed report replaces the verdict and reaches the snapshot.
    handles[1]!.push(PROBE_EVENT)
    await flush()
    const held = manager.getSnapshot(second.session.id)!.usage!
    expect(held.windows.map((window) => window.key)).toEqual([
      'five_hour',
      'seven_day',
    ])
    expect(usage.at(-1)!.report).toBe(held)
  })

  test('usage does not survive a manager restart (memory only)', async () => {
    const dbPath = path.join(tempDir, 'usage-restart.db')
    const dbA = initDatabase({ path: dbPath })
    const harnessA = await createHarness(dbA, anyDirectory, async () => FULL_PULL)
    const created = harnessA.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await harnessA.manager.send(created.session.id, 'hello')
    await flush()
    expect(harnessA.manager.getSnapshot(created.session.id)!.usage).not.toBeNull()
    harnessA.manager.shutdown()
    closeDispatchers()
    dbA.close()

    const dbB = initDatabase({ path: dbPath })
    const harnessB = await createHarness(dbB, anyDirectory, async () => FULL_PULL)
    expect(harnessB.manager.getSnapshot(created.session.id)!.usage).toBeNull()
    // ...and the fresh store pulls again on the next spawn.
    await harnessB.manager.send(created.session.id, 'resume')
    await flush()
    expect(harnessB.handles[0]!.usageCalls).toHaveLength(1)
    harnessB.manager.shutdown()
    closeDispatchers()
    dbB.close()
  })
})
