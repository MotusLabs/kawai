import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatUsageReport } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { anyDirectory, FakeHandle, managedManager, closeDispatchers, fakeQueryFactory, flush, waitForCondition, installManagerCleanup } from './helpers/chatSessionManagerHarness'

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

  test('a routed profile refreshes on the cadence without a turn', async () => {
    const { manager, handles, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' },
      [jsonResponse(CAPTURE(2)), jsonResponse(CAPTURE(50))]
    )
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    expect(await manager.start(created.session.id)).toEqual({ ok: true })
    await flush()
    expect(usage[0]!.report?.windows[0]).toMatchObject({ percentUsed: 2 })

    // No turn runs; the timer re-pulls and the new percentage replaces the old.
    await waitForCondition(() => usage.length >= 2)
    expect(usage[1]!.report?.windows[0]).toMatchObject({ percentUsed: 50 })
    expect(manager.getSnapshot(created.session.id)!.usage?.windows[0]).toMatchObject({
      percentUsed: 50,
    })
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2)
    expect(fetchCalls.every(call => call.url === 'https://zai.test/api/monitor/usage/quota/limit' && call.auth === 'sk-glm-token')).toBe(true)
    expect(handles[0]!.usageCalls).toEqual([])
  })

  test('a session on another profile keeps the provider fresh after the first archives', async () => {
    // glm and glm-flash share zai (providers-and-workers 5.2): archiving the
    // glm session must not stop the pulls while the glm-flash session lives,
    // and archiving the last one does.
    const catalog = path.join(tempDir, 'catalog-fresh')
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
    const { manager, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' },
      [jsonResponse(CAPTURE(2)), jsonResponse(CAPTURE(50)), jsonResponse(CAPTURE(77))],
      catalog
    )
    const first = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!first.ok) throw new Error(first.error)
    const second = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm-flash' })
    if (!second.ok) throw new Error(second.error)
    await manager.start(first.session.id)
    await manager.start(second.session.id)
    await flush()

    await manager.archive(first.session.id)
    // The glm-flash session alone keeps the cadence alive: a fresh pull
    // lands after the archive.
    await waitForCondition(() => fetchCalls.length >= 3)
    await flush()
    expect(usage.at(-1)!.report?.windows[0]).toMatchObject({ percentUsed: 77 })
    expect(manager.getSnapshot(second.session.id)!.usage?.windows[0]).toMatchObject({ percentUsed: 77 })

    // With no live session of the provider left, the cadence stops.
    await manager.archive(second.session.id)
    const settled = fetchCalls.length
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(fetchCalls).toHaveLength(settled)
  })

  test('the refresh pull resolves through a live session, never an archived or driverless sibling\'s', async () => {
    // Invariant (providers-and-workers 5.2): the refresh cadence picks its
    // pull target from a LIVE session of the provider — a record that is
    // neither archived nor without a started driver — never from an earlier
    // sibling's record. Project-level provider overlays make the targets
    // observable: zai's base URL is overlaid to zai-archived in the dead
    // siblings' project, while the live session's project keeps the harness
    // default (zai-live). Catalog files never carry credentials, so the
    // pull's base URL is the pin.
    const catalog = path.join(tempDir, 'catalog-live-target')
    fs.mkdirSync(path.join(catalog, '.kawai'), { recursive: true })
    fs.writeFileSync(
      path.join(catalog, '.kawai', 'providers.json'),
      JSON.stringify({ zai: { label: 'Z.AI', models: { glm: {}, 'glm-flash': {} } } })
    )
    const projA = path.join(tempDir, 'projA')
    fs.mkdirSync(path.join(projA, '.kawai'), { recursive: true })
    fs.writeFileSync(
      path.join(projA, '.kawai', 'providers.json'),
      JSON.stringify({ zai: { env: { ANTHROPIC_BASE_URL: 'https://zai-archived.test/api/anthropic' } } })
    )
    const { manager, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai-live.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-live' },
      [jsonResponse(CAPTURE(2)), jsonResponse(CAPTURE(50)), jsonResponse(CAPTURE(77)), jsonResponse(CAPTURE(88))],
      catalog
    )
    // Insertion order matters: the dead siblings sit before the live one,
    // so a resolver that ignores liveness picks an archived target.
    const archived = manager.createSession({ projectPath: projA, claudeProfileId: 'glm' })
    if (!archived.ok) throw new Error(archived.error)
    const driverless = manager.createSession({ projectPath: projA, claudeProfileId: 'glm' })
    if (!driverless.ok) throw new Error(driverless.error)
    const live = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm-flash' })
    if (!live.ok) throw new Error(live.error)
    await manager.start(archived.session.id)
    await manager.start(live.session.id)
    await flush()

    await manager.archive(archived.session.id)
    // Archive deletes the driver today, and the archivedAt filter is what
    // keeps the pull correct if that ever stops holding: reinstate a stale
    // driver entry artificially to pin the filter's own semantics. The stub
    // answers the dispatch pass's eligibility probe so it stays inert.
    ;(manager as unknown as { drivers: Map<string, unknown> }).drivers.set(archived.session.id, {
      getPendingRequests: () => [],
      interrupt() {},
      deliver() {},
    })
    // Every pull from here on runs after the archive: all must resolve the
    // live session's endpoint, not a dead sibling's. (Each started session's
    // own start pull legitimately used its project's URL, so only the tail
    // asserts.)
    const afterArchive = fetchCalls.length
    await waitForCondition(() => fetchCalls.length >= afterArchive + 2)
    await flush()
    const tail = fetchCalls.slice(afterArchive)
    expect(tail.length).toBeGreaterThanOrEqual(2)
    expect(tail.every(call => call.url === 'https://zai-live.test/api/monitor/usage/quota/limit')).toBe(true)
  })

  test('routing usage sources: a profile maps to its provider, a provider stays un-mapped', async () => {
    // Provider 'glm' holds profile 'glm-air' beside provider 'zai' holding
    // profile 'glm' (providers-and-workers D14): the router's profile source
    // re-maps a profile to its provider's report, while the provider source
    // reads by provider id and must not re-map it back to zai.
    const catalog = path.join(tempDir, 'catalog-usage-keys')
    fs.mkdirSync(path.join(catalog, '.kawai'), { recursive: true })
    fs.writeFileSync(
      path.join(catalog, '.kawai', 'providers.json'),
      JSON.stringify({
        zai: { label: 'Z.AI', models: { glm: {} } },
        glm: { label: 'GLM', models: { 'glm-air': {} } },
      })
    )
    const { manager } = await createProviderHarness({}, [], catalog, 3_600_000)
    const store = (manager as unknown as {
      usageLimits: { record(id: string, report: ChatUsageReport): void }
    }).usageLimits
    const at = '2026-10-12T12:00:00.000Z'
    store.record('zai', { status: 'allowed', windows: [{ key: 'zai:time_limit', label: 'zai', percentUsed: 61, resetsAt: null }], receivedAt: at, source: 'provider' })
    store.record('glm', { status: 'warning', windows: [{ key: 'glm:time_limit', label: 'glm', percentUsed: 12, resetsAt: null }], receivedAt: at, source: 'provider' })
    const sources = (manager as unknown as {
      teamMail: { router: { options: {
        usageOf(id: string): ChatUsageReport | null
        providerUsageOf(id: string): ChatUsageReport | null
      } } }
    }).teamMail.router.options
    expect(sources.usageOf('glm')?.windows[0]).toMatchObject({ key: 'zai:time_limit' })
    expect(sources.usageOf('glm-air')?.windows[0]).toMatchObject({ key: 'glm:time_limit' })
    expect(sources.providerUsageOf('glm')?.windows[0]).toMatchObject({ key: 'glm:time_limit' })
    expect(sources.providerUsageOf('zai')?.windows[0]).toMatchObject({ key: 'zai:time_limit' })
  })

  test.each([
    { code: 500, msg: '404 NOT_FOUND' },
    { code: 1001, msg: 'Authentication refused' },
    { code: 500, msg: 'upstream unavailable' },
  ])('a failed provider refresh $code/$msg keeps the held report and never pulls the SDK', async body => {
    const { manager, handles, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic' },
      [jsonResponse(CAPTURE(2)), jsonResponse({ success: false, ...body })]
    )
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    expect(await manager.start(created.session.id)).toEqual({ ok: true })
    await flush()
    const held = manager.getSnapshot(created.session.id)!.usage
    expect(held?.source).toBe('provider')

    await waitForCondition(() => fetchCalls.length >= 2)
    await flush()
    expect(manager.getSnapshot(created.session.id)!.usage).toEqual(held)
    expect(usage).toHaveLength(1)
    expect(handles[0]!.usageCalls).toEqual([])
  })

})