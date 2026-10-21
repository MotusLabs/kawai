import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatUsageReport } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { anyDirectory, FakeHandle, managedManager, closeDispatchers, fakeQueryFactory, flush, waitForCondition } from './helpers/chatSessionManagerHarness'

describe('ChatSessionManager provider usage pull', () => {

  let tempDir: string
  let db: SessionDatabase
  const original = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    configDir: process.env.CLAUDE_CONFIG_DIR,
    home: process.env.HOME,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN,
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-zai-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
    // The provider routing comes from getProviderEnv per test, never from
    // the machine's real environment.
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_AUTH_TOKEN
  })

  afterEach(() => {
    if (original.apiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = original.apiKey
    if (original.configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = original.configDir
    if (original.home === undefined) delete process.env.HOME
    else process.env.HOME = original.home
    if (original.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = original.baseUrl
    if (original.authToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
    else process.env.ANTHROPIC_AUTH_TOKEN = original.authToken
    closeDispatchers()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** The 2026-10-12 quota capture, first at 2% and then at 50% after a refresh. */
  const CAPTURE = (percentage: number) => ({
    code: 200,
    msg: 'Operation successful',
    data: {
      limits: [{ type: 'TIME_LIMIT', percentage, nextResetTime: 1793701399997 }],
      level: 'pro',
    },
    success: true,
  })

  const SDK_PULL = {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 22.37, resets_at: '2026-10-07T18:11:04.000Z' },
    },
  }

  interface ProviderHarness {
    manager: ChatSessionManager
    handles: FakeHandle[]
    usage: Array<{ providerId: string; report: ChatUsageReport | null }>
    fetchCalls: Array<{ url: string; auth?: string }>
  }

  async function createProviderHarness(
    providerEnv: Record<string, string>,
    responses: Array<Response>,
    catalogHome?: string,
    refreshMs = 50
  ): Promise<ProviderHarness> {
    const fetchCalls: Array<{ url: string; auth?: string }> = []
    const canned = [...responses]
    const providerUsageFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      fetchCalls.push({ url: String(input), auth: headers.Authorization })
      const next = canned.shift() ?? canned[canned.length - 1]
      if (!next) throw new Error('no canned response left')
      return next
    }) as unknown as typeof fetch
    const handles: FakeHandle[] = []
    const usage: Array<{ providerId: string; report: ChatUsageReport | null }> = []
    const manager = await managedManager({
      isDirectory: anyDirectory,
      registry: new SessionRegistry(),
      db,
      onEvent: () => {},
      onUsage: (providerId, report) => usage.push({ providerId, report }),
      queryFactory: fakeQueryFactory(handles, () => Promise.resolve(SDK_PULL)),
      ...(Object.keys(providerEnv).length > 0 ? { getProviderEnv: () => providerEnv } : {}),
      ...(catalogHome ? { profileCatalogHome: catalogHome } : {}),
      providerUsageFetch,
      providerUsageRefreshMs: refreshMs,
    })
    return { manager, handles, usage, fetchCalls }
  }

  test('archiving the last live session stops the pulls', async () => {
    const { manager, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' },
      [jsonResponse(CAPTURE(2))]
    )
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    await flush()
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1)
    const beforeArchive = fetchCalls.length

    await manager.archive(created.session.id)
    // Several cadences pass: the tick clears the timer without a request,
    // and the held report stays visible.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(fetchCalls).toHaveLength(beforeArchive)
    expect(usage).toHaveLength(1)
    expect(manager.getSnapshot(created.session.id)!.usage?.source).toBe('provider')
  })

  /** A fetch the test resolves manually, to hold a pull in flight. */
  function deferredFetch(): {
    impl: typeof fetch
    deferreds: Array<(response: Response) => void>
  } {
    const deferreds: Array<(response: Response) => void> = []
    const impl = (async () =>
      new Promise<Response>((resolve) => {
        deferreds.push(resolve)
      })) as unknown as typeof fetch
    return { impl, deferreds }
  }

  async function createManualHarness(providerUsageFetch: typeof fetch) {
    const handles: FakeHandle[] = []
    const usage: Array<{ providerId: string; report: ChatUsageReport | null }> = []
    const manager = await managedManager({
      isDirectory: anyDirectory,
      registry: new SessionRegistry(),
      db,
      onEvent: () => {},
      onUsage: (providerId, report) => usage.push({ providerId, report }),
      queryFactory: fakeQueryFactory(handles, () => Promise.resolve(SDK_PULL)),
      getProviderEnv: () => ({
        ANTHROPIC_BASE_URL: 'https://zai.test',
        ANTHROPIC_AUTH_TOKEN: 'sk-glm-token',
      }),
      providerUsageFetch,
      providerUsageRefreshMs: 25,
    })
    return { manager, usage }
  }

  test('an in-flight first pull publishes nothing after shutdown', async () => {
    const { impl, deferreds } = deferredFetch()
    const { manager, usage } = await createManualHarness(impl)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    await flush()
    expect(deferreds.length).toBe(1) // the spawn pull is in flight

    manager.shutdown()
    deferreds[0]!(jsonResponse(CAPTURE(2)))
    await flush()
    // The late answer publishes nothing and arms no refresh timer.
    expect(usage).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(deferreds.length).toBe(1)
  })

  test('an in-flight refresh publishes nothing after shutdown', async () => {
    const { impl, deferreds } = deferredFetch()
    const { manager, usage } = await createManualHarness(impl)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    await flush()
    deferreds[0]!(jsonResponse(CAPTURE(2)))
    await flush()
    expect(usage).toHaveLength(1)

    // The next tick's refresh is in flight when the server shuts down.
    await waitForCondition(() => deferreds.length >= 2)
    manager.shutdown()
    deferreds[1]!(jsonResponse(CAPTURE(99)))
    await flush()
    expect(usage).toHaveLength(1)
    expect(manager.getSnapshot(created.session.id)!.usage?.windows[0]).toMatchObject({
      percentUsed: 2,
    })
  })


})
