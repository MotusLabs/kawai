import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatUsageReport } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { logger } from '../logger'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { anyDirectory, FakeHandle, managedManager, closeDispatchers, fakeQueryFactory, drainNow, installManagerCleanup } from './helpers/chatSessionManagerHarness'

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


  // --------------------------------- OpenRouter usage endpoint (openrouter-provider 2.2)

  const OR_TOKEN = 'sk-or-inference-fake'
  const OR_MGMT = 'sk-or-management-fake'
  const orOriginalWarn = logger.warn

  /** The spike's capped-key capture, under the `data` wrapper OpenRouter's docs declare. */
  const OR_KEY_FIELDS = {
    limit: 0.05,
    limit_remaining: 0.04,
    limit_reset: null,
    budgets: [
      {
        scope: 'key_limit',
        limit_usd: 0.05,
        spend_usd: 0.01,
        remaining_usd: 0.04,
        reset_interval: null,
        resets_at: null,
      },
    ],
    effective_budget: null,
    is_management_key: false,
  }
  const OR_KEY_BODY = { data: OR_KEY_FIELDS }

  function writeOpenRouterCatalog(withBalanceKey: boolean): string {
    const root = path.join(tempDir, 'catalog-openrouter')
    fs.mkdirSync(path.join(root, '.kawai'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.kawai', 'providers.json'),
      JSON.stringify({
        openrouter: {
          label: 'OpenRouter',
          authTokenEnv: 'OPENROUTER_API_KEY',
          ...(withBalanceKey ? { balanceKeyEnv: 'OPENROUTER_MANAGEMENT_KEY' } : {}),
          // A credentialed provider must have a base URL in the trusted tier (D5).
          env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' },
          models: { 'openrouter-sonnet': {} },
        },
      })
    )
    // The model key in providers.json is the profile; no profiles.json entry
    // (one would be ignored with a warning).
    return root
  }

  /** A harness answering per endpoint path; an Error value makes that request throw, a function is called per pull. */
  async function createOpenRouterHarness(
    responses: Record<string, Response | Error | (() => Response | Error)>,
    withBalanceKey = false,
    refreshMs = 3_600_000
  ): Promise<ProviderHarness> {
    const catalog = writeOpenRouterCatalog(withBalanceKey)
    const fetchCalls: Array<{ url: string; auth?: string }> = []
    const providerUsageFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      fetchCalls.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization })
      const next = responses[new URL(url).pathname]
      const value = typeof next === 'function' ? next() : next
      if (!value) throw new Error(`unexpected request to ${url}`)
      if (value instanceof Error) throw value
      return value
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
      getProviderEnv: () => ({
        OPENROUTER_API_KEY: OR_TOKEN,
        ...(withBalanceKey ? { OPENROUTER_MANAGEMENT_KEY: OR_MGMT } : {}),
      }),
      profileCatalogHome: catalog,
      providerUsageFetch,
      providerUsageRefreshMs: refreshMs,
    })
    return { manager, handles, usage, fetchCalls }
  }

  function startOpenRouterSession(manager: ChatSessionManager): string {
    const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'openrouter-sonnet' })
    if (!created.ok) throw new Error(created.error)
    return created.session.id
  }

  test('archiving the last live session stops the OpenRouter pulls', async () => {
    jest.useFakeTimers()
    try {
      const { manager, usage, fetchCalls } = await createOpenRouterHarness(
        { '/api/v1/key': () => jsonResponse(OR_KEY_BODY) },
        false,
        600_000
      )
      const id = startOpenRouterSession(manager)
      expect(await manager.start(id)).toEqual({ ok: true })
      await drainNow()
      // One cadence tick pulls (and records); archiving stops every later one.
      jest.advanceTimersByTime(600_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(2)
      expect(usage).toHaveLength(2)

      await manager.archive(id)
      jest.advanceTimersByTime(600_000)
      await drainNow()
      jest.advanceTimersByTime(600_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(2)
      expect(usage).toHaveLength(2)
      expect(manager.getSnapshot(id)!.usage?.source).toBe('provider')
    } finally {
      jest.useRealTimers()
    }
  })

  test('a failed first pull still arms the cadence; the next tick shows the meters', async () => {
    jest.useFakeTimers()
    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = []
    logger.warn = (event: string, data?: Record<string, unknown>) => {
      warnings.push({ event, data })
    }
    try {
      let healthy = false
      const { manager, handles, usage, fetchCalls } = await createOpenRouterHarness(
        {
          '/api/v1/key': () =>
            healthy ? jsonResponse(OR_KEY_BODY) : jsonResponse({ error: 'boom' }, 503),
        },
        false,
        600_000
      )
      const id = startOpenRouterSession(manager)
      expect(await manager.start(id)).toEqual({ ok: true })
      await drainNow()
      // The transient failure records no data and is logged once…
      expect(fetchCalls).toHaveLength(1)
      expect(usage).toEqual([{ providerId: 'openrouter', report: null }])
      expect(manager.getSnapshot(id)!.usage).toBeNull()
      expect(warnings.filter(entry => entry.event === 'chat_openrouter_key_pull_failed')).toHaveLength(1)
      // …but the provider is routed: the next cadence tick recovers the meters.
      healthy = true
      jest.advanceTimersByTime(600_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(2)
      expect(usage[1]?.report?.windows[0]).toMatchObject({ label: 'Key cap · $0.04 left' })
      // The host-login pull stays suppressed through both outcomes.
      expect(handles[0]!.usageCalls).toEqual([])
    } finally {
      logger.warn = orOriginalWarn
      jest.useRealTimers()
    }
  })

  test('a pull whose credits meter dropped out does not end a credit cooldown (probe B)', async () => {
    jest.useFakeTimers()
    try {
      let creditsStatus = 200
      let creditsUsed = 39.99
      const { manager, fetchCalls } = await createOpenRouterHarness(
        {
          '/api/v1/key': () => jsonResponse(OR_KEY_BODY),
          '/api/v1/credits': () =>
            creditsStatus === 200
              ? jsonResponse({ data: { total_credits: 40, total_usage: creditsUsed } })
              : jsonResponse({ error: 'boom' }, creditsStatus),
        },
        true,
        600_000
      )
      manager.limitEvents.record({
        profileId: 'openrouter-sonnet',
        sessionId: 'sdk-or',
        groupId: null,
        kind: 'billing_error',
        final: true,
        status: 402,
        message: 'API Error: 402 out of credit',
        resetsAt: null,
        providerId: 'openrouter',
        window: 'credit',
      })
      // The frozen fake clock stamps the event and the first pull's reading
      // at one millisecond; move the clock so the event strictly precedes the
      // first post-event reading (the overlay ignores such a reading).
      jest.advanceTimersByTime(1)
      const id = startOpenRouterSession(manager)
      expect(await manager.start(id)).toEqual({ ok: true })
      await drainNow()
      // The complete first pull (key $0.04, credits $0.01 left) only sets the overlay's baseline.
      expect(manager.limitEvents.cooldownFor('openrouter-sonnet', 'openrouter').until).not.toBeNull()
      // The credits meter drops out: the key's larger $0.04 must not read as credit returning.
      creditsStatus = 502
      jest.advanceTimersByTime(600_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(4)
      expect(manager.limitEvents.cooldownFor('openrouter-sonnet', 'openrouter').until).not.toBeNull()
      // A later complete pull reading more left than the baseline still ends it.
      creditsStatus = 200
      creditsUsed = 30
      jest.advanceTimersByTime(600_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(6)
      expect(manager.limitEvents.cooldownFor('openrouter-sonnet', 'openrouter').until).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

})
