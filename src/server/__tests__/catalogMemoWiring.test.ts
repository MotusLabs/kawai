// Production wiring of the shared catalog memo (catalog-resolution-cache Table
// W, findings-f4b1ebad B2/B3): the manager's read sites resolve through the
// memo, and no consumer changes the catalog the memo hands out. A read site
// is counted by the reads of the project's own catalog file, which every
// resolution reads exactly once: after a fresh key, the first public call
// resolves once (cold) and the next three resolve nothing (warm). The usage
// cadence (W4) also builds the launch environment, which resolves the
// catalog directly on every tick by design (D2), so its exact total is one
// more per tick.
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatUsageReport } from '../../shared/chat'
import type { MergedProvider } from '../chat/catalogMerge'
import { resolvedCatalog, type CatalogEntry } from '../chat/catalogMemo'
import { providerLabelOf, providerOf, resolveProfileCatalog } from '../chat/profileCatalog'
import { initDatabase, type SessionDatabase } from '../db'
import { quotaReadingOf } from '../plans/workspace/workspaceRuntime'
import { SessionRegistry } from '../SessionRegistry'
import { catalogCtx } from '../team/cooldowns'
import type { MailRecipient } from '../team/dispatcher'
import type { SessionMailbox } from '../team/sessionMailbox'
import { closeDispatchers, drainNow, fakeQueryFactory, type FakeHandle, installManagerCleanup, managedManager } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

let root: string
let home: string
let project: string
let marker: string
let db: SessionDatabase
let fetchCalls: Array<{ url: string; auth?: string }>

const REFRESH_MS = 600_000
// Built at runtime so no literal looks like a credential.
const PROVIDER_ENV = { OPENROUTER_API_KEY: ['sk', 'or', 'session-fake'].join('-'), OPENROUTER_MANAGEMENT_KEY: ['sk', 'or', 'mgmt-fake'].join('-') }
const USAGE_BODIES: Record<string, unknown> = {
  '/api/v1/key': { data: { limit: 0.05, limit_remaining: 0.04, limit_reset: null, is_management_key: false } },
  '/api/v1/credits': { data: { total_credits: 40, total_usage: 15.57 } },
}

/** Bumps a file's mtime by whole seconds so its stamp, and so the key, changes. */
function bump(file: string, seconds = 5): void {
  const at = new Date(fs.statSync(file).mtimeMs + seconds * 1000)
  fs.utimesSync(file, at, at)
}

/** Reads of the project's catalog file while `read` runs: one per resolution. */
function markerReads(read: () => unknown): number {
  const spy = spyOn(fs, 'readFileSync')
  try {
    read()
    return spy.mock.calls.filter(call => String(call[0]) === marker).length
  } finally { spy.mockRestore() }
}

/** Alias-free plain data: Maps and Sets become sorted entries, recursively. */
function canon(value: unknown): unknown {
  if (value instanceof Map) return [...value].map(([key, item]) => [String(key), canon(item)]).sort(([a], [b]) => String(a).localeCompare(String(b)))
  if (value instanceof Set) return [...value].map(item => canon(item)).sort()
  if (Array.isArray(value)) return value.map(item => canon(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canon(item)]))
  return value
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-catalog-wiring-')))
  home = path.join(root, 'home')
  project = path.join(root, 'project')
  // A user-level pair replaces the shipped defaults, so no test reads them.
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
    acme: {
      label: 'Acme',
      env: { ANTHROPIC_BASE_URL: 'https://acme.invalid/anthropic' },
      models: { 'acme-m': { label: 'Acme M', model: 'opus', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'acme-s' } } },
    },
    // A provider with its own usage endpoint and a balance key (openrouter-provider D6).
    or: {
      label: 'Or', authTokenEnv: 'OPENROUTER_API_KEY', balanceKeyEnv: 'OPENROUTER_MANAGEMENT_KEY',
      env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' }, models: { 'or-m': {} },
    },
  }))
  fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({ default: { label: 'Default' } }))
  fs.mkdirSync(path.join(project, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), 'Build.')
  marker = path.join(project, '.kawai', 'profiles.json')
  fs.writeFileSync(marker, JSON.stringify({ local: { label: 'Local', model: 'sonnet' } }))
  db = initDatabase({ path: path.join(root, 'test.db') })
  fetchCalls = []
})

afterEach(() => {
  closeDispatchers()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

async function session(profileId = 'acme-m') {
  const handles: FakeHandle[] = []
  const providerUsageFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    fetchCalls.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization })
    const body = USAGE_BODIES[new URL(url).pathname]
    if (!body) throw new Error(`unexpected request to ${url}`)
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const manager = await managedManager({
    db, registry: new SessionRegistry(), onEvent: () => {}, profileCatalogHome: home, authCheck: () => true,
    queryFactory: fakeQueryFactory(handles), getProviderEnv: () => ({ ...PROVIDER_ENV }), providerUsageFetch,
    providerUsageRefreshMs: REFRESH_MS,
  })
  const created = await manager.createAvailableSession({ projectPath: project, groupId: 'devs', claudeProfileId: profileId })
  if (!created.ok) throw new Error(created.error)
  return { manager, sessionId: created.session.id }
}

describe('Table W — production wiring', () => {
  test('W2: providerDefinitionOf resolves through the shared memo, cold once and then warm (kills R11)', async () => {
    const { manager, sessionId } = await session()
    bump(marker)
    let definition: MergedProvider | null = null
    const reads = [0, 1, 2, 3].map(() => markerReads(() => { definition = manager.providerDefinitionOf(sessionId) }))
    expect(reads).toEqual([1, 0, 0, 0])
    // Parity with an independent fresh resolution, compared as plain data.
    const fresh = resolveProfileCatalog(catalogCtx(home, project)).merged.get('acme')
    expect(fresh).toBeDefined()
    expect(definition).not.toBe(fresh!)
    expect(canon(definition)).toEqual(canon(fresh))
  })

  test('W3: startBlockerFor reads the runtime through the shared memo, cold once and then warm', async () => {
    const { manager, sessionId } = await session()
    // A stored runtime the profile does not have makes the runtime fact decide the refusal.
    const record = { ...db.getChatSession(sessionId)!, runtime: 'codex' as const }
    bump(marker)
    const blockers: Array<string | null> = []
    const reads = [0, 1, 2, 3].map(() => markerReads(() => { blockers.push(manager.startBlockerFor(record)) }))
    expect(reads).toEqual([1, 0, 0, 0])
    // Parity with an independent fresh resolution of the profile's runtime.
    const fresh = resolveProfileCatalog(catalogCtx(home, project)).profiles.get('acme-m')!
    const runtime = fresh.runtime === 'codex' ? 'codex' : 'claude'
    expect(runtime).toBe('claude')
    expect(blockers).toEqual(Array(4).fill(
      `Cannot start the agent: this chat's profile changed runtime (codex → ${runtime}) since the chat was created. ` +
      'Create a new chat session with the profile\'s current runtime.'
    ))
  })

  test('W4: the usage cadence reads the balance key through the shared memo; only the direct launch resolution reads per tick', async () => {
    jest.useFakeTimers()
    try {
      const { manager, sessionId } = await session('or-m')
      expect(await manager.start(sessionId)).toEqual({ ok: true })
      await drainNow()
      expect(fetchCalls.map(call => new URL(call.url).pathname)).toEqual(['/api/v1/key', '/api/v1/credits'])
      bump(marker)
      const reads: number[] = []
      for (let tick = 0; tick < 4; tick++) {
        reads.push(markerReads(() => jest.advanceTimersByTime(REFRESH_MS)))
        await drainNow()
      }
      // Each tick resolves the unchanged launch catalog directly (one read);
      // the first tick's provider lookup also warms the shared memo, which
      // the balance-key read then hits. A balance-key bypass reads [3, 2, 2, 2].
      expect(reads).toEqual([2, 1, 1, 1])
      // Parity: every credits pull, the start's and each tick's, carries the
      // value under the balance key name an independent fresh resolution names.
      const keyEnv = resolveProfileCatalog(catalogCtx(home, project)).profiles.get('or-m')!.balanceKeyEnv
      expect(keyEnv).toBe('OPENROUTER_MANAGEMENT_KEY')
      const credits = fetchCalls.filter(call => call.url.endsWith('/api/v1/credits'))
      expect(credits).toEqual(Array(5).fill({ url: 'https://openrouter.ai/api/v1/credits', auth: `Bearer ${PROVIDER_ENV[keyEnv as keyof typeof PROVIDER_ENV]}` }))
    } finally {
      jest.useRealTimers()
    }
  })

  test('W5: no production consumer changes the shared catalog it reads (kills R14 and a nested-field write)', async () => {
    const { manager, sessionId } = await session()
    const mailbox = (manager as unknown as { teamMail: SessionMailbox }).teamMail
    const { recipients } = (mailbox.dispatcher as unknown as { options: { recipients(): MailRecipient[] } }).options
    // The new session joins its team asynchronously (ChatSessionManager's track).
    for (let i = 0; i < 200 && !recipients().some(row => row.sessionId === sessionId); i++) await Bun.sleep(10)
    const ctx = catalogCtx(home, project)
    // The baseline is plain data from its own resolution, sharing nothing
    // with the memo's entry: the nested objects are distinct.
    const own = resolveProfileCatalog(ctx)
    const before = canon(own)
    const entry: CatalogEntry = resolvedCatalog(ctx)
    const shared = entry.catalog.merged.get('acme')!
    expect(own.merged.get('acme')).not.toBe(shared)
    expect(own.merged.get('acme')!.env).not.toBe(shared.env)
    expect(own.merged.get('acme')!.models.get('acme-m')).not.toBe(shared.models.get('acme-m'))
    const record = db.getChatSession(sessionId)
    expect(record?.claudeProfileId).toBe('acme-m')
    const report = { status: 'allowed', windows: [], receivedAt: new Date(0).toISOString(), source: 'pull' } satisfies ChatUsageReport
    // A provider limit makes the sweep's cooldown read the provider and its label too.
    const until = new Date(Date.now() + 3_600_000).toISOString()
    mailbox.limits.record({
      profileId: 'acme-m', sessionId, groupId: 'devs', kind: 'rate_limit', final: true, status: 429,
      message: 'quota', resetsAt: until, providerId: 'acme', window: null,
    })
    // A started session on the usage-endpoint provider makes the usage cadence a consumer too.
    jest.useFakeTimers()
    try {
      const usageSession = await manager.createAvailableSession({ projectPath: project, groupId: 'devs', claudeProfileId: 'or-m' })
      if (!usageSession.ok) throw new Error(usageSession.error)
      expect(await manager.start(usageSession.session.id)).toEqual({ ok: true })
      await drainNow()
      expect(fetchCalls).toHaveLength(2)
      for (let round = 0; round < 2; round++) {
        jest.advanceTimersByTime(REFRESH_MS)
        await drainNow()
        expect(fetchCalls).toHaveLength(4 + 2 * round)
        expect(recipients().find(row => row.sessionId === sessionId)).toMatchObject({
          profileId: 'acme-m', cooldownUntil: until, cooldownProvider: 'acme', cooldownProviderLabel: 'Acme',
        })
        const definition = manager.providerDefinitionOf(sessionId)
        expect(definition).toBe(entry.definitions().get('acme')!)
        expect(quotaReadingOf(report, definition).applicable).toBe(false)
        expect(manager.startBlockerFor(record!)).toBeNull()
        expect(providerOf('acme-m', ctx)).toBe('acme')
        expect(providerLabelOf('acme', ctx)).toBe('Acme')
      }
    } finally {
      jest.useRealTimers()
    }
    expect(resolvedCatalog(ctx)).toBe(entry)
    expect(canon(entry.catalog)).toEqual(before)
    // The lazy projections equal the ones the baseline implies.
    expect(canon(entry.providerByProfile())).toEqual(canon(new Map([...own.profiles].map(([id, profile]) => [id, profile.providerId]))))
    expect(canon(entry.providerLabels())).toEqual(canon(new Map([...own.providers].map(([id, provider]) => [id, provider.label]))))
    expect(canon(entry.definitions())).toEqual(canon(own.merged))
  })
})
