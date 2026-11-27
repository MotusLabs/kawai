// F7 of provider-credential-store: a live session keeps the route its agent
// was admitted with. A store edit that makes the profile ineligible (a
// non-empty launch-env transport pin, A1's refusal) must never re-resolve or
// throw on a running chat's live paths — the provider usage refresh timer,
// the post-turn pull scheduling, and agent usage reports — while the next
// admission and the next spawn (resume) still refuse, naming only the key.
// Composed as bootstrap does (createServerCredentials + credentialManagerOptions)
// over a real database and a disposable HOME, with a fake SDK and a mocked
// OpenRouter usage endpoint; no request leaves the test.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { createServerCredentials, credentialManagerOptions } from '../chat/credentialComposition'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { closeDispatchers, type FakeHandle, fakeQueryFactory, flush, initMessage, installManagerCleanup, managedManager, spawned, waitForCondition, writeTranscript } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

const KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'HOME', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'HTTPS_PROXY', 'PCS_LR_TOKEN'] as const
const original = Object.fromEntries(KEYS.map(key => [key, process.env[key]]))
const PROXY = 'http://zq-live-proxy.example.internal:3128'

let tempDir: string
let db: SessionDatabase

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-live-')))
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
  process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  process.env.HOME = tempDir
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'HTTPS_PROXY', 'PCS_LR_TOKEN'] as const) delete process.env[key]
  fs.mkdirSync(path.join(tempDir, '.kawai'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(tempDir, '.kawai', 'providers.json'), JSON.stringify({
    openrouter: {
      label: 'OpenRouter', authTokenEnv: 'PCS_LR_TOKEN',
      env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' },
      models: { 'openrouter-sonnet': {} },
    },
  }))
})

afterEach(() => {
  closeDispatchers()
  for (const key of KEYS) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

/** A successful costed result, so the turn schedules the post-turn pull. */
function costedResult(): SDKMessage {
  return {
    uuid: crypto.randomUUID(), type: 'result', subtype: 'success', is_error: false, num_turns: 1,
    total_cost_usd: 0.02, result: 'done', duration_ms: 10, duration_api_ms: 5,
    usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], stop_reason: null,
  } as unknown as SDKMessage
}

describe('F7 — a live session keeps its admitted route', () => {
  test('a store pin change while a routed chat is live must not throw in its usage refresh timer', async () => {
    const credentials = createServerCredentials({ db, seed: {}, homeDir: tempDir })
    await credentials.store.set('PCS_LR_TOKEN', 'zq-admitted-token', 'secret-source')
    const calls: { path: string; auth: string | undefined }[] = []
    const providerUsageFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname, auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
      return Response.json({ data: { limit: null, limit_remaining: null, budgets: [], is_management_key: false } })
    }) as unknown as typeof fetch
    const handles: FakeHandle[] = []
    const manager = await managedManager({
      isDirectory: () => true, registry: new SessionRegistry(), db, onEvent: () => {},
      queryFactory: fakeQueryFactory(handles), profileCatalogHome: tempDir, providerUsageFetch,
      providerUsageRefreshMs: 25,
      ...credentialManagerOptions(credentials.composition),
    })
    const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'openrouter-sonnet' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    expect((await manager.send(id, 'hello')).ok).toBe(true)
    await spawned(handles, 0)
    handles[0]!.push(initMessage('sdk-live'))
    await waitForCondition(() => calls.length > 0, 3000)

    // The store edit a running chat must survive: a non-empty launch-env transport pin.
    await credentials.store.set('HTTPS_PROXY', PROXY, 'launch-env')
    const before = calls.length
    // Several real interval ticks, each pulling the admitted route.
    await waitForCondition(() => calls.length >= before + 3, 3000)
    expect(calls.slice(before).every(call => call.path === '/api/v1/key' && call.auth === 'Bearer zq-admitted-token')).toBe(true)
    // The post-turn path (keepsOwnEndpointPullsOnly) and the usage report path run on the live chat too.
    handles[0]!.push(costedResult())
    await flush(20)
    expect(manager.getSnapshot(id)).not.toBeNull()

    // A fresh admission refuses, naming the key and no value.
    const refused = await manager.createAvailableSession({ projectPath: '/tmp/proj', claudeProfileId: 'openrouter-sonnet' })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error).toContain('HTTPS_PROXY')
    expect(refused.error).not.toContain(PROXY)
    // The next spawn of the same chat (resume) refuses the same way.
    writeTranscript('sdk-live', '')
    expect(manager.archive(id).ok).toBe(true)
    expect(manager.restore(id).ok).toBe(true)
    const restarted = await manager.start(id)
    expect(restarted.ok).toBe(false)
    if (restarted.ok) return
    expect(restarted.error).toContain('HTTPS_PROXY')
    expect(restarted.error).not.toContain(PROXY)
    // A stopped chat makes no pull: its admitted route ended with the agent.
    const stopped = calls.length
    await Bun.sleep(100)
    expect(calls.length).toBe(stopped)
    manager.shutdown()
  }, 20_000)
})
