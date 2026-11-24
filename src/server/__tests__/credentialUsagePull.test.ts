// PW5 of provider-credential-store: the provider usage pull
// (claimProviderUsagePull → providerUsageTarget) reads the resolution
// composition, so a balance key and a token that live only in the credential
// store reach the OpenRouter credits and key pulls — through the real
// ChatSessionManager composed as bootstrap does (createServerCredentials +
// credentialManagerOptions). Mutant: the manager's provider env is the raw
// seed, so the store-only balance key never reaches the credits pull.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ChatSessionManager, type ChatQueryFactory } from '../chat/ChatSessionManager'
import { createServerCredentials, credentialManagerOptions } from '../chat/credentialComposition'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'

/** A stream that never yields: the pull runs at start, before any turn. */
function idleQueryFactory(): ChatQueryFactory {
  return (_input: { options: Options }) => {
    let close: (() => void) | null = null
    const stream = async function* (): AsyncGenerator<SDKMessage, void> {
      await new Promise<void>((resolve) => { close = resolve })
    }
    return Object.assign(stream(), {
      interrupt: () => Promise.resolve(undefined),
      close: () => close?.(),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.resolve({ rate_limits_available: false }),
    }) as unknown as Query
  }
}

const KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'HOME', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'PCS_OR_TOKEN', 'PCS_OR_BALANCE'] as const
const original = Object.fromEntries(KEYS.map(key => [key, process.env[key]]))

describe('PW5 — provider usage pulls read the store', () => {
  let tempDir: string
  let db: SessionDatabase
  let manager: ChatSessionManager | null = null

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-pull-')))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
    for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'PCS_OR_TOKEN', 'PCS_OR_BALANCE'] as const) delete process.env[key]
    fs.mkdirSync(path.join(tempDir, '.kawai'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(tempDir, '.kawai', 'providers.json'), JSON.stringify({
      openrouter: {
        label: 'OpenRouter', authTokenEnv: 'PCS_OR_TOKEN', balanceKeyEnv: 'PCS_OR_BALANCE',
        env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' },
        models: { 'openrouter-sonnet': {} },
      },
    }))
  })

  afterEach(() => {
    if (manager) {
      manager.dispatcher.close()
      manager.observations.stop()
      manager.shutdown()
      manager = null
    }
    for (const key of KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('PW5: a provider pull reads a store-only balance key and token', async () => {
    const credentials = createServerCredentials({ db, seed: { PCS_SEED_ONLY: 'seed' }, homeDir: tempDir })
    await credentials.store.set('PCS_OR_TOKEN', 'store-or-token', 'secret-source')
    await credentials.store.set('PCS_OR_BALANCE', 'store-or-balance', 'secret-source')
    const calls: { path: string; auth: string | undefined }[] = []
    const providerUsageFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname, auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
      const body = url.pathname.endsWith('/credits')
        ? { data: { total_credits: 10, total_usage: 4 } }
        : { data: { limit: null, limit_remaining: null, budgets: [], is_management_key: false } }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    manager = new ChatSessionManager({
      isDirectory: () => true, registry: new SessionRegistry(), db, onEvent: () => {},
      queryFactory: idleQueryFactory(), profileCatalogHome: tempDir, providerUsageFetch,
      providerUsageRefreshMs: 60_000,
      ...credentialManagerOptions(credentials.composition),
    })
    await manager.whenRestored()
    const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'openrouter-sonnet' })
    if (!created.ok) throw new Error(created.error)
    expect(await manager.start(created.session.id)).toEqual({ ok: true })
    const started = Date.now()
    while (!calls.some(call => call.path.endsWith('/credits')) && Date.now() - started < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(calls).toContainEqual({ path: '/api/v1/credits', auth: 'Bearer store-or-balance' })
    expect(calls).toContainEqual({ path: '/api/v1/key', auth: 'Bearer store-or-token' })
  })
})
