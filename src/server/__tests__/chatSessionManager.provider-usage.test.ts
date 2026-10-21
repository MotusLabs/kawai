import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatUsageReport } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { anyDirectory, FakeHandle, managedManager, closeDispatchers, fakeQueryFactory, flush, installManagerCleanup } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

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

  test('a profile with no base URL is never probed; the SDK pull answers', async () => {
    const { manager, handles, usage, fetchCalls } = await createProviderHarness({}, [])
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    await flush()

    expect(fetchCalls).toEqual([])
    // The fake query's usage control answered; no provider request was made.
    expect(handles[0]!.usageCalls).toHaveLength(1)
    expect(usage.some((entry) => entry.report?.source === 'pull')).toBe(true)
  })

  test('a path-prefixed provider records usage on attach without a prompt or SDK pull', async () => {
    const { manager, handles, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' },
      [jsonResponse(CAPTURE(2))]
    )
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    expect(await manager.start(created.session.id)).toEqual({ ok: true })
    await flush()

    expect(fetchCalls).toEqual([
      { url: 'https://zai.test/api/monitor/usage/quota/limit', auth: 'sk-glm-token' },
    ])
    // Exactly one broadcast — the provider report; the host-login SDK pull
    // never ran.
    expect(usage).toHaveLength(1)
    expect(usage[0]!.report?.source).toBe('provider')
    expect(usage[0]!.report?.windows[0]).toMatchObject({ key: 'zai:time_limit', percentUsed: 2 })
    expect(handles[0]!.usageCalls).toEqual([])
    expect(manager.getSnapshot(created.session.id)!.usage?.source).toBe('provider')
    expect(manager.getSnapshot(created.session.id)!.usage?.windows[0]).toMatchObject({ key: 'zai:time_limit', percentUsed: 2 })
    expect(manager.getSnapshot(created.session.id)!.status).toBe('waiting')
  })

  test('profiles share a provider: one pull serves sibling models', async () => {
    // glm and glm-flash are models of zai in this pinned catalog; the
    // sibling sessions share one pull, one report, and one refresh cadence
    // (providers-and-workers 5.1).
    const catalog = path.join(tempDir, 'catalog')
    fs.mkdirSync(path.join(catalog, '.kawai'), { recursive: true })
    fs.writeFileSync(
      path.join(catalog, '.kawai', 'providers.json'),
      JSON.stringify({ zai: { label: 'Z.AI', models: { glm: {}, 'glm-flash': {} } } })
    )
    fs.writeFileSync(
      path.join(catalog, '.kawai', 'profiles.json'),
      JSON.stringify({
        glm: { label: 'GLM', env: { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' } },
        'glm-flash': { label: 'GLM Flash', env: { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' } },
      })
    )
    const { manager, handles, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' },
      [jsonResponse(CAPTURE(2))],
      catalog,
      // No cadence tick inside the test: the counts below are claim-driven.
      3_600_000
    )
    const first = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!first.ok) throw new Error(first.error)
    const second = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm-flash' })
    if (!second.ok) throw new Error(second.error)
    await manager.start(first.session.id)
    await flush()

    // Exactly one provider pull — the second profile's claim resolves to the
    // same already-routed provider.
    expect(fetchCalls).toHaveLength(1)
    expect(usage).toHaveLength(1)
    expect(usage[0]!.providerId).toBe('zai')
    expect(usage[0]!.report?.source).toBe('provider')

    // The sibling session attaches: no second claim, no SDK pull, and its
    // own snapshot reads the provider's report under its own profile id.
    await manager.start(second.session.id)
    await flush()
    expect(fetchCalls).toHaveLength(1)
    expect(handles[1]!.usageCalls).toEqual([])
    expect(manager.getSnapshot(second.session.id)!.usage?.source).toBe('provider')
    expect(manager.getSnapshot(second.session.id)!.usage?.windows[0]).toMatchObject({ key: 'zai:time_limit', percentUsed: 2 })
  })

  test.each([401, 403, 1001])('a provider auth code %s records no data and skips the SDK pull', async code => {
    const { manager, handles, usage } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' },
      [jsonResponse({ code, msg: 'Authentication refused', success: false })]
    )
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    await flush()

    expect(usage).toEqual([{ providerId: 'claude', report: null }])
    expect(handles[0]!.usageCalls).toEqual([])
    expect(manager.getSnapshot(created.session.id)!.usage).toBeNull()
  })

  test('a base URL without the endpoint falls back to the host-login SDK pull', async () => {
    const { manager, handles, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://other-gateway.test' },
      [new Response('nope', { status: 404 })]
    )
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    await flush()

    expect(fetchCalls).toHaveLength(1) // probed exactly once
    expect(handles[0]!.usageCalls).toHaveLength(1) // then the SDK pull ran
    expect(usage.some((entry) => entry.report?.source === 'pull')).toBe(true)
  })

  test.each([
    { code: 500, msg: '404 NOT_FOUND' },
    { code: 500, msg: 'upstream unavailable' },
    { code: 9999, msg: 'unknown failure' },
  ])('a non-auth quota envelope $code/$msg permits the SDK pull without retrying the probe', async body => {
    const { manager, handles, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic' },
      [jsonResponse({ success: false, ...body })]
    )
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    expect(await manager.start(created.session.id)).toEqual({ ok: true })
    await flush()

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.url).toBe('https://zai.test/api/monitor/usage/quota/limit')
    expect(handles[0]!.usageCalls).toHaveLength(1)
    expect(usage.some(entry => entry.report?.source === 'provider')).toBe(false)
    expect(manager.getSnapshot(created.session.id)!.usage?.source).toBe('pull')

    expect(await manager.start(created.session.id)).toEqual({ ok: true })
    await flush()
    expect(fetchCalls).toHaveLength(1)
    expect(handles[0]!.usageCalls).toHaveLength(1)
  })
})
