import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatUsageReport } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { logger } from '../logger'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { anyDirectory, FakeHandle, managedManager, closeDispatchers, fakeQueryFactory, flush, waitForCondition, drainNow } from './helpers/chatSessionManagerHarness'

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

  test('an OpenRouter session start pulls /api/v1/key with the session key, never the quota endpoint', async () => {
    const { manager, handles, usage, fetchCalls } = await createOpenRouterHarness({
      '/api/v1/key': jsonResponse(OR_KEY_BODY),
    })
    const id = startOpenRouterSession(manager)
    expect(await manager.start(id)).toEqual({ ok: true })
    await flush()

    expect(fetchCalls).toEqual([
      { url: 'https://openrouter.ai/api/v1/key', auth: `Bearer ${OR_TOKEN}` },
    ])
    expect(usage).toHaveLength(1)
    expect(usage[0]!.providerId).toBe('openrouter')
    expect(usage[0]!.report?.source).toBe('provider')
    expect(usage[0]!.report?.windows[0]).toMatchObject({
      key: 'openrouter:key_limit',
      label: 'Key cap · $0.04 left',
      percentUsed: 20,
    })
    // The host-login SDK pull never ran.
    expect(handles[0]!.usageCalls).toEqual([])
    const snapshot = manager.getSnapshot(id)!
    expect(snapshot.usage?.source).toBe('provider')
    expect(snapshot.status).toBe('waiting')
  })

  test.each([401, 403])('a key pull refused with %s records no data and never shows the host plan', async status => {
    const { manager, handles, usage, fetchCalls } = await createOpenRouterHarness({
      '/api/v1/key': jsonResponse({ error: 'bad key' }, status),
    })
    const id = startOpenRouterSession(manager)
    await manager.send(id, 'hello')
    await flush()

    expect(usage).toEqual([{ providerId: 'openrouter', report: null }])
    expect(handles[0]!.usageCalls).toEqual([])
    expect(manager.getSnapshot(id)!.usage).toBeNull()
    // Even after the refusal the host-login pull stays suppressed.
    expect(await manager.start(id)).toEqual({ ok: true })
    await flush()
    expect(fetchCalls).toHaveLength(1)
    expect(handles[0]!.usageCalls).toEqual([])
  })

  test.each([
    ['a 404', jsonResponse({ error: 'no route' }, 404)],
    ['a server error', jsonResponse({ error: 'boom' }, 500)],
    ['a foreign body', jsonResponse({ hello: true })],
    ['a transport error', new Error('offline')],
  ])('a failing key endpoint (%s) records no data and keeps the host-login pull suppressed', async (_name, response) => {
    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = []
    logger.warn = (event: string, data?: Record<string, unknown>) => {
      warnings.push({ event, data })
    }
    try {
      const { manager, handles, usage, fetchCalls } = await createOpenRouterHarness({
        '/api/v1/key': response,
      })
      const id = startOpenRouterSession(manager)
      expect(await manager.start(id)).toEqual({ ok: true })
      await flush()

      expect(fetchCalls).toHaveLength(1)
      expect(fetchCalls[0]!.url).toBe('https://openrouter.ai/api/v1/key')
      expect(usage).toEqual([{ providerId: 'openrouter', report: null }])
      expect(handles[0]!.usageCalls).toEqual([])
      expect(manager.getSnapshot(id)!.usage).toBeNull()
      // The failure log (both outcomes land here) names the host and status,
      // never the key (openrouter-provider 2.2).
      const failures = warnings.filter(entry => entry.event === 'chat_openrouter_key_pull_failed')
      expect(failures.length).toBeGreaterThanOrEqual(1)
      expect(JSON.stringify(warnings).includes(OR_TOKEN)).toBe(false)
    } finally {
      logger.warn = orOriginalWarn
    }
  })

  test('a balance key pulls credits with the management value and merges the credits meter', async () => {
    const { manager, usage, fetchCalls } = await createOpenRouterHarness(
      {
        '/api/v1/key': jsonResponse(OR_KEY_BODY),
        '/api/v1/credits': jsonResponse({ data: { total_credits: 40, total_usage: 15.57 } }),
      },
      true
    )
    const id = startOpenRouterSession(manager)
    expect(await manager.start(id)).toEqual({ ok: true })
    await flush()

    expect(fetchCalls).toEqual([
      { url: 'https://openrouter.ai/api/v1/key', auth: `Bearer ${OR_TOKEN}` },
      { url: 'https://openrouter.ai/api/v1/credits', auth: `Bearer ${OR_MGMT}` },
    ])
    expect(usage[0]!.report?.windows.map(window => window.key)).toEqual([
      'openrouter:key_limit',
      'openrouter:credits',
    ])
    expect(usage[0]!.report?.windows[1]).toMatchObject({ label: 'Credits · $24.43 left' })
  })

  test('a credits refusal drops only the credits meter and logs once per value, never the key', async () => {
    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = []
    logger.warn = (event: string, data?: Record<string, unknown>) => {
      warnings.push({ event, data })
    }
    try {
      const { manager, usage, fetchCalls } = await createOpenRouterHarness(
        {
          '/api/v1/key': () => jsonResponse(OR_KEY_BODY),
          '/api/v1/credits': () => jsonResponse({ error: 'Only management keys' }, 403),
        },
        true,
        25
      )
      const id = startOpenRouterSession(manager)
      expect(await manager.start(id)).toEqual({ ok: true })
      await flush()
      expect(usage[0]!.report?.windows.map(window => window.key)).toEqual(['openrouter:key_limit'])
      const refusals = warnings.filter(entry => entry.event === 'chat_openrouter_credits_refused')
      expect(refusals).toHaveLength(1)
      expect(refusals[0]!.data).toMatchObject({ providerId: 'openrouter' })
      expect(JSON.stringify(warnings).includes(OR_MGMT)).toBe(false)
      expect(JSON.stringify(warnings).includes(OR_TOKEN)).toBe(false)
      // A later refresh carrying the same value recurs on the credits
      // endpoint (fresh responses each pull) and still does not log again.
      await waitForCondition(() => fetchCalls.filter(call => call.url.endsWith('/api/v1/credits')).length >= 2)
      expect(fetchCalls.filter(call => call.url.endsWith('/api/v1/credits')).length).toBeGreaterThanOrEqual(2)
      expect(warnings.filter(entry => entry.event === 'chat_openrouter_credits_refused')).toHaveLength(1)
    } finally {
      logger.warn = orOriginalWarn
    }
  })

  test('a pulled remaining amount feeds the credit-cooldown overlay (openrouter-provider D8)', async () => {
    let remaining = 0.04
    const keyBody = () =>
      jsonResponse({ data: { ...OR_KEY_FIELDS, limit_remaining: remaining, budgets: [{ ...OR_KEY_FIELDS.budgets[0], remaining_usd: remaining }] } })
    const { manager } = await createOpenRouterHarness({ '/api/v1/key': keyBody }, false, 25)
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
    const id = startOpenRouterSession(manager)
    // Out of credit with no reset known: the profile cools.
    expect(manager.limitEvents.cooldownFor('openrouter-sonnet', 'openrouter').until).not.toBeNull()
    expect(await manager.start(id)).toEqual({ ok: true })
    await flush()
    // The first post-event pull (0.04 left) only sets the overlay's baseline.
    expect(manager.limitEvents.cooldownFor('openrouter-sonnet', 'openrouter').until).not.toBeNull()
    // A later pull reporting more left than the baseline ends the cooldown early.
    remaining = 0.05
    await waitForCondition(
      () => manager.limitEvents.cooldownFor('openrouter-sonnet', 'openrouter').until === null,
      2_000
    )
  })

  test('agent reports are not kept for an own-endpoint provider', async () => {
    const { manager, handles, usage } = await createOpenRouterHarness({
      '/api/v1/key': jsonResponse(OR_KEY_BODY),
    })
    const id = startOpenRouterSession(manager)
    expect(await manager.start(id)).toEqual({ ok: true })
    await flush()
    expect(usage).toHaveLength(1)
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
          limits: [{ kind: 'session', percent: 22.4, resets_at: null, severity: 'normal' }],
        },
      },
    } as unknown as SDKMessage)
    handles[0]!.push({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: 1793701399 } },
      },
      uuid: 'rl-1',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    // Neither report replaced the pull's own data.
    expect(usage).toHaveLength(1)
    expect(manager.getSnapshot(id)!.usage?.windows[0]).toMatchObject({ key: 'openrouter:key_limit' })
  })

  test('a topped-up balance appears through the scheduled pull without a turn', async () => {
    jest.useFakeTimers()
    try {
      let remaining = 0.04
      const { manager, fetchCalls } = await createOpenRouterHarness(
        {
          '/api/v1/key': () =>
            jsonResponse({ data: { ...OR_KEY_FIELDS, limit_remaining: remaining, budgets: [{ ...OR_KEY_FIELDS.budgets[0], remaining_usd: remaining }] } }),
        },
        false,
        600_000
      )
      const id = startOpenRouterSession(manager)
      expect(await manager.start(id)).toEqual({ ok: true })
      await drainNow()
      expect(manager.getSnapshot(id)!.usage?.windows[0]).toMatchObject({ label: 'Key cap · $0.04 left' })

      // The owner tops up; the next 10-minute cadence tick shows it — no turn ran.
      remaining = 0.03
      jest.advanceTimersByTime(600_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(2)
      expect(manager.getSnapshot(id)!.usage?.windows[0]).toMatchObject({ label: 'Key cap · $0.03 left' })
    } finally {
      jest.useRealTimers()
    }
  })

})
