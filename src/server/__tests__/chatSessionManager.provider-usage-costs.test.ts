// chatSessionManager split: provider-usage-costs tests.
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent, ChatUsageReport } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { anyDirectory, FakeHandle, managedManager, closeDispatchers, fakeQueryFactory, createHarness, flush, initMessage, resultWithWindow, writeTranscript, drainNow, installManagerCleanup } from './helpers/chatSessionManagerHarness'

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

  // --------------------------------- OpenRouter usage endpoint (openrouter-provider 2.2)

  const OR_TOKEN = 'sk-or-inference-fake'
  const OR_MGMT = 'sk-or-management-fake'

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

  const costFrame = (cost: number): SDKMessage => ({
    type: 'stream_event',
    event: { type: 'message_delta', delta: {}, usage: { cost } },
    parent_tool_use_id: null,
    uuid: `se-${Math.random()}`,
    session_id: 'sdk-1',
  } as unknown as SDKMessage)


  test('several quick costed turns cause one extra pull about 30 s after the first', async () => {
    jest.useFakeTimers()
    try {
      const { manager, handles, fetchCalls } = await createOpenRouterHarness(
        { '/api/v1/key': () => jsonResponse(OR_KEY_BODY) },
        false,
        3_600_000
      )
      const id = startOpenRouterSession(manager)
      expect(await manager.start(id)).toEqual({ ok: true })
      await drainNow()
      expect(fetchCalls).toHaveLength(1)

      // Three turns carrying a provider cost complete within 20 seconds.
      const costedTurn = async () => {
        expect(await manager.send(id, 'costly work')).toEqual({ ok: true })
        handles[0]!.push(costFrame(0.002))
        handles[0]!.push(resultWithWindow())
        await drainNow()
      }
      await costedTurn()
      jest.advanceTimersByTime(10_000)
      await costedTurn()
      jest.advanceTimersByTime(10_000)
      await costedTurn()
      await drainNow()

      // One pull lands about 30 s after the first costed turn.
      jest.advanceTimersByTime(30_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(2)
      expect(fetchCalls[1]!.url).toBe('https://openrouter.ai/api/v1/key')

      // A turn within a minute of that pull schedules nothing more.
      await costedTurn()
      jest.advanceTimersByTime(60_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(2)

      // A turn after the minute has passed schedules the next one.
      await costedTurn()
      jest.advanceTimersByTime(30_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(3)
    } finally {
      jest.useRealTimers()
    }
  })

  test('a costed turn on a quota-serving provider schedules no extra pull', async () => {
    jest.useFakeTimers()
    try {
      const { manager, handles, fetchCalls } = await createProviderHarness(
        { ANTHROPIC_BASE_URL: 'https://zai.test', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' },
        [jsonResponse(CAPTURE(2))],
        undefined,
        3_600_000
      )
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      expect(await manager.start(created.session.id)).toEqual({ ok: true })
      await drainNow()
      expect(fetchCalls).toHaveLength(1)
      expect(await manager.send(created.session.id, 'costly work')).toEqual({ ok: true })
      handles[0]!.push(costFrame(0.002))
      handles[0]!.push(resultWithWindow())
      await drainNow()
      jest.advanceTimersByTime(60_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  describe('history window (chat-history-window 2.2)', () => {
    /** Turns at 100 h, 50 h, and 3 h ago; the oldest carries a tool pair. */
    function multiDayTranscript(): string {
      const at = (hoursAgo: number) =>
        new Date(Date.parse('2026-10-18T12:00:00.000Z') - hoursAgo * 3_600_000).toISOString()
      const lines = [
        { type: 'user', uuid: 'u-100', timestamp: at(100), message: { role: 'user', content: 'oldest question' } },
        { type: 'assistant', uuid: 'a-100', timestamp: at(100), message: { id: 'm-100', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-old', name: 'Bash', input: { command: 'echo' } }] } },
        { type: 'user', uuid: 'u-100r', timestamp: at(100), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-old', content: 'out' }] } },
        { type: 'assistant', uuid: 'a-100t', timestamp: at(99), message: { id: 'm-100t', role: 'assistant', content: [{ type: 'text', text: 'oldest answer' }] } },
        { type: 'user', uuid: 'u-50', timestamp: at(50), message: { role: 'user', content: 'middle question' } },
        { type: 'assistant', uuid: 'a-50', timestamp: at(50), message: { id: 'm-50', role: 'assistant', content: [{ type: 'text', text: 'middle answer' }] } },
        { type: 'user', uuid: 'u-3', timestamp: at(3), message: { role: 'user', content: 'recent question' } },
        { type: 'assistant', uuid: 'a-3', timestamp: at(3), message: { id: 'm-3', role: 'assistant', content: [{ type: 'text', text: 'recent answer' }] } },
      ]
      return lines.map(line => JSON.stringify(line)).join('\n')
    }

    /** A restarted manager whose stored sdk id replays the multi-day transcript. */
    async function restartedManager() {
      const first = await createHarness(db)
      const created = first.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      await first.manager.send(created.session.id, 'seed')
      first.handles[0]!.push(initMessage('sdk-hist-window'))
      await flush()
      first.manager.shutdown()
      writeTranscript('sdk-hist-window', multiDayTranscript())
      const restarted = await createHarness(db)
      return { manager: restarted.manager, handles: restarted.handles, sessionId: created.session.id }
    }

    const userTexts = (snapshot: { events: ChatEvent[] }): string[] =>
      snapshot.events.filter((event): event is Extract<ChatEvent, { type: 'user_message' }> => event.type === 'user_message').map(event => event.text)

    test('a snapshot carries only the last 24 hours of a multi-day memo', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, sessionId } = await restartedManager()
      const snapshot = manager.getSnapshot(sessionId)!
      expect(userTexts(snapshot)).toEqual(['recent question'])
      expect(snapshot.historyHasOlder).toBe(true)
      expect(snapshot.historyStartId).toBe(snapshot.events[0]!.id)
      expect(snapshot.historyStartId).toMatch(/^hist-/)
      // The window is unchanged for a caller that sends no historyFrom.
      expect(manager.getSnapshot(sessionId, {})!.events).toEqual(snapshot.events)
    })

    test('historyFrom widens a reconnect snapshot to the held unit', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, sessionId } = await restartedManager()
      const narrow = manager.getSnapshot(sessionId)!
      // The client's oldest held event is the middle turn's replayed opener.
      const widened = manager.getSnapshot(sessionId, { historyFrom: 'hist-u-50' })!
      expect(userTexts(widened)).toEqual(['middle question', 'recent question'])
      expect(widened.historyStartId).toBe('hist-u-50')
      expect(widened.historyHasOlder).toBe(true)
      // An id the server no longer has falls back to the default window.
      const fallback = manager.getSnapshot(sessionId, { historyFrom: 'hist-gone' })!
      expect(fallback.events).toEqual(narrow.events)
      expect(fallback.historyStartId).toBe(narrow.historyStartId)
    })

    test('a pending approval rides a windowed snapshot; live events append', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles, sessionId } = await restartedManager()
      expect(await manager.start(sessionId)).toEqual({ ok: true })
      const handle = handles[0]!
      await manager.send(sessionId, 'probe')
      handle.push({ type: 'assistant', uuid: 'live-1', message: { id: 'm-live', role: 'assistant', content: [{ type: 'text', text: 'working now' }] } } as unknown as SDKMessage)
      await flush()
      const pending = handle.options.canUseTool!('Bash', { command: 'echo now' }, {
        signal: new AbortController().signal, toolUseID: 'toolu-live', requestId: 'request-live',
      })
      await flush()
      const snapshot = manager.getSnapshot(sessionId)!
      // Requests are whole whatever the window did to the events.
      expect(snapshot.pendingRequests).toHaveLength(1)
      const requestId = snapshot.pendingRequests[0]!.requestId
      // Old memo turns stay out; the live turn is in; the live tail is not cut.
      expect(snapshot.events.some(event => event.type === 'user_message' && (event as { text: string }).text === 'oldest question')).toBe(false)
      expect(snapshot.events.some(event => event.type === 'assistant_text' && (event as { text: string }).text === 'working now')).toBe(true)
      expect(snapshot.throughSequence).toBeGreaterThan(0)
      expect(snapshot.historyHasOlder).toBe(true)
      expect(manager.resolveApproval(sessionId, requestId, 'allow').ok).toBe(true)
      await pending
      manager.shutdown()
    })

    test('an archived chat windows and pages without starting an agent', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles, sessionId } = await restartedManager()
      manager.archive(sessionId)
      const snapshot = manager.getSnapshot(sessionId)!
      expect(snapshot.historyHasOlder).toBe(true)
      const page = manager.getHistoryPage(sessionId, snapshot.historyStartId!)!
      expect(page.stale).toBe(false)
      expect(userTexts(page)).toEqual(['middle question'])
      expect(handles).toHaveLength(0)
      expect(manager.getSnapshot(sessionId, {})).not.toBeNull()
    })

    test('getHistoryPage pages back day by day, resolves tool anchors, reports stale', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, sessionId } = await restartedManager()
      const snapshot = manager.getSnapshot(sessionId)!
      // The 24 hours before the recent turn hold no turns, so one use still
      // loads the middle turn (the gap rule).
      const first = manager.getHistoryPage(sessionId, snapshot.historyStartId!)!
      expect(userTexts(first)).toEqual(['middle question'])
      expect(first.hasOlder).toBe(true)
      // The next page reaches the oldest turn; nothing older remains.
      const second = manager.getHistoryPage(sessionId, first.events[0]!.id)!
      expect(userTexts(second)).toEqual(['oldest question'])
      expect(second.hasOlder).toBe(false)
      // A search anchor inside the oldest turn pulls the whole page back.
      const anchored = manager.getHistoryPage(sessionId, snapshot.historyStartId!, 'tool:toolu-old')!
      expect(userTexts(anchored)).toEqual(['oldest question', 'middle question'])
      expect(anchored.hasOlder).toBe(false)
      // An unknown beforeId is stale with no events; unknown sessions none.
      expect(manager.getHistoryPage(sessionId, 'hist-drifted')).toEqual({ events: [], hasOlder: false, stale: true })
      expect(manager.getHistoryPage('chat-missing', 'hist-u-3')).toBeNull()
    })
  })

})
