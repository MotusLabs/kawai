// Codex results, measurements, authentication and events through the public
// driver (R02, R07-R09; the Codex part of 4.5): failure categories from the
// protocol's codexErrorInfo, limit and quota facts, token and context usage,
// unknown values as null, the structural login check, and ordered
// serializable events with a fresh stream per driver.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasCodexLogin } from '../src/codex/index.js'
import type { LimitEvent, QuotaReport, ContextUsage } from '../src/usage/types.js'
import { codexDriver, codexRoot, refusal, stopDrivers } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

describe('Codex failure categories (R02)', () => {
  const rows: Array<[string, string, string]> = [
    ['"unauthorized"', 'authentication', 'unauthorized'],
    ['{"responseStreamConnectionFailed":{"httpStatusCode":401}}', 'authentication', 'responseStreamConnectionFailed'],
    ['"usageLimitExceeded"', 'quota', 'usageLimitExceeded'],
    ['"rateLimitExceeded"', 'rate-limit', 'rateLimitExceeded'],
    ['{"httpConnectionFailed":{"httpStatusCode":503}}', 'transport', 'httpConnectionFailed'],
    ['"contextWindowExceeded"', 'provider', 'contextWindowExceeded'],
    ['"other"', 'provider', 'other'],
  ]
  for (const [info, category, code] of rows) {
    // @covers: agent-runtime › Codex authentication errors are distinguishable › Login shape and refusal
    test(`R02: a turn failed with ${info} is ${category}`, async () => {
      const h = codexDriver()
      await h.driver.start()
      const result = await (await h.driver.send(`/fail ${info}`)).result
      expect(result).toMatchObject({ outcome: 'failed', finalText: null, error: { category, code } })
      expect(h.events.find((e) => e.type === 'turn_completed')).toMatchObject({ isError: true, terminalReason: code })
      expect(h.events.filter((e) => e.type === 'error')).toEqual([expect.objectContaining({ error: expect.objectContaining({ category }) })])
    })
  }

  test('R02: a turn/start refused with unauthorized fails the turn as authentication', async () => {
    const h = codexDriver()
    await h.driver.start()
    const result = await (await h.driver.send('/rpcfail "unauthorized"')).result
    expect(result).toMatchObject({ outcome: 'failed', error: { category: 'authentication' } })
    expect(h.driver.state).toBe('idle')
  })
})

describe('Codex measurements (R04, R08)', () => {
  test('R08: a turn with no reported tokens has usage null, zero counts and the thread model', async () => {
    const h = codexDriver()
    await h.driver.start()
    const result = await (await h.driver.send('plain')).result
    expect(result).toMatchObject({ usage: null, toolCallCount: 0, compactionCount: 0, model: 'fake-model' })
  })

  test('R04/R05: tokens, context, quota and limit facts belong to the turn and the session login', async () => {
    const limits: LimitEvent[] = []
    const quotas: QuotaReport[] = []
    const contexts: Array<ContextUsage | null> = []
    const compactions: unknown[] = []
    const h = codexDriver({ callbacks: { onLimitEvent: (e) => void limits.push(e), onQuotaReport: (q) => void quotas.push(q), onContextUsage: (c) => void contexts.push(c), onCompaction: (c) => void compactions.push(c) } })
    await h.driver.start()
    const result = await (await h.driver.send('/facts')).result
    expect(result.usage).toEqual({ inputTokens: 60, outputTokens: 50, cacheReadTokens: 40, cacheCreationTokens: null })
    expect(contexts).toEqual([expect.objectContaining({ usedTokens: 150, thresholdTokens: 1000, percentage: 15, thresholdApproximate: true })])
    expect(quotas).toEqual([
      expect.objectContaining({
        status: 'limited', source: 'push', accountScope: 'session',
        windows: [
          { key: 'codex:primary', label: '5-hour', percentUsed: 100, resetsAt: new Date(1900000000 * 1000).toISOString(), periodMs: 300 * 60_000 },
          { key: 'codex:secondary', label: 'weekly', percentUsed: 12, resetsAt: new Date(1900500000 * 1000).toISOString(), periodMs: 10080 * 60_000 },
        ],
      }),
    ])
    expect(limits).toEqual([{ type: 'failure', kind: 'rateLimitExceeded', final: false, status: null, message: 'slow down', resetsAt: new Date(1900000000 * 1000).toISOString(), window: null }])
    expect(compactions).toEqual([{ boundaryId: 'cmp-1', turnId: result.turnId, preTokens: null }])
    expect(h.events.filter((e) => e.type === 'notice')).toHaveLength(1)
  })

  test('R02/R05: a final usage-limit failure reports one final limit event', async () => {
    const limits: LimitEvent[] = []
    const h = codexDriver({ callbacks: { onLimitEvent: (e) => void limits.push(e) } })
    await h.driver.start()
    await (await h.driver.send('/fail "usageLimitExceeded"')).result
    expect(limits).toEqual([expect.objectContaining({ type: 'failure', kind: 'usageLimitExceeded', final: true })])
  })
})

describe('Codex login (R09)', () => {
  const home = (auth?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-codex-auth-'))
    mkdirSync(dir, { recursive: true })
    if (auth !== undefined) writeFileSync(join(dir, 'auth.json'), auth)
    return dir
  }
  const rows: Array<[string, string | undefined, boolean]> = [
    ['missing', undefined, false],
    ['malformed', '{not json', false],
    ['an array', '[]', false],
    ['empty', '{}', false],
    ['an empty key', '{"OPENAI_API_KEY":""}', false],
    ['a non-string token', '{"tokens":{"access_token":7}}', false],
    ['an API key', '{"OPENAI_API_KEY":"sk-SECRET-VALUE"}', true],
    ['ChatGPT tokens', '{"tokens":{"access_token":"SECRET-ACCESS"}}', true],
  ]
  for (const [name, auth, expected] of rows) {
    test(`R09: a home with ${name} auth reads ${expected} and returns only a boolean`, () => {
      const result = hasCodexLogin(home(auth))
      expect(result).toBe(expected)
    })
  }

  test('R09: a relative or non-string home is no login and reads no host default', () => {
    expect(hasCodexLogin('relative/home')).toBe(false)
    expect(hasCodexLogin(undefined as unknown as string)).toBe(false)
  })
})

describe('Codex events (R07, R11)', () => {
  // @covers: agent-runtime › Events are ordered serializable values › JSONL and resumed stream
  test('R07: events round-trip through JSONL with unique ids and increasing sequence; a resumed driver starts a new stream', async () => {
    const root = codexRoot()
    const first = codexDriver({ root })
    await first.driver.start()
    await (await first.driver.send('one')).result
    await first.driver.shutdown()
    const jsonl = first.events.map((e) => JSON.stringify(e)).join('\n')
    expect(jsonl.split('\n').map((line) => JSON.parse(line))).toEqual(first.events)
    expect(new Set(first.events.map((e) => e.id)).size).toBe(first.events.length)
    expect(first.events.map((e) => e.sequence)).toEqual(first.events.map((_, i) => i + 1))
    const second = codexDriver({ root, resume: first.checkpoints[0]! })
    await second.driver.start()
    await (await second.driver.send('two')).result
    expect(second.events[0]!.streamId).not.toBe(first.events[0]!.streamId)
    expect(second.events.map((e) => e.sequence)[0]).toBe(1)
  })

  test('R11: a throwing onEvent never stops result settlement; the throw is owned by the stop', async () => {
    const boom = new Error('event sink failed')
    const h = codexDriver({ callbacks: { onEvent: () => { throw boom } } })
    await h.driver.start()
    expect((await (await h.driver.send('ok')).result).outcome).toBe('success')
    expect(h.results).toHaveLength(1)
    expect((await refusal(h.driver.kill())).causes.filter((c) => c === boom).length).toBeGreaterThan(0)
  })
})
