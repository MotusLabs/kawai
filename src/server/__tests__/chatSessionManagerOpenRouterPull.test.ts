// OpenRouter usage pulls through the real pull path (openrouter-provider D6),
// narrowed to follow-up N3: a successful pull that carried no meters must
// clear the held report, while failed and refused pulls keep today's behavior.
// Harness copied slim from chatSessionManager.test.ts — that file is far past
// 500 lines, so these tests live here.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatUsageReport } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager, type ChatQueryFactory } from '../chat/ChatSessionManager'

/** Minimal scriptable Query: enough of a stream for the driver to attach to. */
interface FakeHandle {
  query: Query
  options: Options
  closed: boolean
}

function fakeQueryFactory(handles: FakeHandle[]): ChatQueryFactory {
  return ({ options }) => {
    const queue: SDKMessage[] = []
    let resolveMessage: ((result: IteratorResult<SDKMessage>) => void) | null = null
    let ended = false
    const handle: FakeHandle = { query: null as unknown as Query, options, closed: false }

    const stream = async function* (): AsyncGenerator<SDKMessage, void> {
      while (true) {
        const next = await new Promise<IteratorResult<SDKMessage>>((resolve) => {
          if (queue.length > 0) resolve({ value: queue.shift()!, done: false })
          else if (ended) resolve({ value: undefined, done: true })
          else resolveMessage = resolve
        })
        if (next.done) return
        yield next.value
      }
    }

    const query = Object.assign(stream(), {
      interrupt: () => Promise.resolve(undefined),
      close: () => {
        handle.closed = true
        ended = true
        resolveMessage?.({ value: undefined, done: true })
      },
      // The host-login gap-fill never runs for a routed OpenRouter provider;
      // an answer stands by in case a path ever falls through.
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
        Promise.resolve(SDK_PULL),
    }) as unknown as Query

    handle.query = query
    handles.push(handle)
    return query
  }
}

const OR_TOKEN = 'sk-or-inference-fake'
const OR_MGMT = 'sk-or-management-fake'

/** A capped key: one `key_limit` budget, the spike's capture. */
const OR_KEY_BODY = {
  data: {
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
  },
}

/** An uncapped key: the cap was removed, no budgets remain (follow-up N3). */
const OR_UNCAPPED_BODY = {
  data: {
    limit: null,
    limit_remaining: null,
    limit_reset: null,
    budgets: [],
    effective_budget: null,
    is_management_key: false,
  },
}

/** The host-login gap-fill's canned answer; never read for a routed provider. */
const SDK_PULL = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 22.37, resets_at: '2026-10-07T18:11:04.000Z' },
  },
}

describe('ChatSessionManager OpenRouter pull recording (follow-up N3)', () => {
  let tempDir: string
  let db: SessionDatabase
  const managers = new Set<ChatSessionManager>()
  const original = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    configDir: process.env.CLAUDE_CONFIG_DIR,
    home: process.env.HOME,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN,
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-orpull-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
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
    for (const manager of managers) {
      manager.dispatcher.close()
      manager.observations.stop()
    }
    managers.clear()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function writeOpenRouterCatalog(): string {
    const root = path.join(tempDir, 'catalog-openrouter')
    fs.mkdirSync(path.join(root, '.kawai'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.kawai', 'providers.json'),
      JSON.stringify({
        openrouter: {
          label: 'OpenRouter',
          authTokenEnv: 'OPENROUTER_API_KEY',
          env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' },
          models: { 'openrouter-sonnet': {} },
        },
      })
    )
    return root
  }

  /** A harness answering per endpoint path; an Error value makes that request throw, a function is called per pull. */
  async function createPullHarness(
    responses: Record<string, Response | Error | (() => Response | Error)>,
    refreshMs = 25
  ): Promise<{
    manager: ChatSessionManager
    usage: Array<{ providerId: string; report: ChatUsageReport | null }>
    fetchCalls: Array<{ url: string; auth?: string }>
  }> {
    const catalog = writeOpenRouterCatalog()
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
    const manager = new ChatSessionManager({
      isDirectory: () => true,
      registry: new SessionRegistry(),
      db,
      onEvent: () => {},
      onUsage: (providerId, report) => usage.push({ providerId, report }),
      queryFactory: fakeQueryFactory(handles),
      getProviderEnv: () => ({ OPENROUTER_API_KEY: OR_TOKEN }),
      profileCatalogHome: catalog,
      providerUsageFetch,
      providerUsageRefreshMs: refreshMs,
    })
    await manager.whenRestored()
    managers.add(manager)
    return { manager, usage, fetchCalls }
  }

  function startSession(manager: ChatSessionManager): string {
    const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'openrouter-sonnet' })
    if (!created.ok) throw new Error(created.error)
    return created.session.id
  }

  /** Let the driver's stream loop and the pull promises drain. */
  async function flush(rounds = 6): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  async function waitForCondition(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const started = Date.now()
    while (!condition()) {
      if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  const keyPulls = (fetchCalls: Array<{ url: string }>) =>
    fetchCalls.filter((call) => call.url.endsWith('/api/v1/key')).length

  test('a pull with meters, then a pull with zero meters: the provider shows no meters', async () => {
    let pulls = 0
    const { manager, usage, fetchCalls } = await createPullHarness({
      '/api/v1/key': () => {
        pulls += 1
        return pulls === 1 ? jsonResponse(OR_KEY_BODY) : jsonResponse(OR_UNCAPPED_BODY)
      },
    })
    const id = startSession(manager)
    expect(await manager.start(id)).toEqual({ ok: true })
    await flush()
    expect(usage[0]!.providerId).toBe('openrouter')
    expect(usage[0]!.report?.windows.map((window) => window.key)).toEqual(['openrouter:key_limit'])

    // The refresh tick answers with the uncapped key.
    await waitForCondition(() => keyPulls(fetchCalls) >= 2)
    await flush()
    expect(usage).toHaveLength(2)
    expect(usage[1]!.providerId).toBe('openrouter')
    expect(usage[1]!.report).toBeNull()
    expect(manager.getSnapshot(id)!.usage).toBeNull()
  })

  test.each([
    ['a refused pull', () => jsonResponse({ error: 'bad key' }, 401)],
    ['a failed pull', () => new Error('offline')],
  ])('a pull with meters, then %s: the held meters stay', async (_name, fail) => {
    let pulls = 0
    const { manager, usage, fetchCalls } = await createPullHarness({
      '/api/v1/key': () => {
        pulls += 1
        return pulls === 1 ? jsonResponse(OR_KEY_BODY) : fail()
      },
    })
    const id = startSession(manager)
    expect(await manager.start(id)).toEqual({ ok: true })
    await flush()
    expect(usage[0]!.report?.windows.map((window) => window.key)).toEqual(['openrouter:key_limit'])

    await waitForCondition(() => keyPulls(fetchCalls) >= 2)
    await flush()
    // Failed and refused pulls keep today's behavior: no new push, and the
    // snapshot still renders the held meters.
    expect(usage).toHaveLength(1)
    expect(manager.getSnapshot(id)!.usage?.windows.map((window) => window.key)).toEqual([
      'openrouter:key_limit',
    ])
  })

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
