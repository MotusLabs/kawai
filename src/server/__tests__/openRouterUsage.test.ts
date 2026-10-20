import { describe, expect, test } from 'bun:test'
import {
  OPENROUTER_CREDITS_PATH,
  OPENROUTER_KEY_PATH,
  fetchOpenRouterUsage,
  isOpenRouterBaseUrl,
  isOpenRouterHost,
  openRouterUrl,
  parseOpenRouterCredits,
  parseOpenRouterKey,
  type OpenRouterKeySlice,
} from '../chat/openRouterUsage'

const BASE = 'https://openrouter.ai/api'
const RECEIVED = '2026-10-20T00:00:00.000Z'

/** The spike's capped-key capture: a $0.05 key_limit budget with $0.04 left. */
const CAPPED_KEY: OpenRouterKeySlice = {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A fetch impl answering per URL, recording every request it saw. */
function fetchByPath(
  responses: Record<string, Response | Error>
): { impl: typeof fetch; calls: Array<{ url: string; auth?: string }> } {
  const calls: Array<{ url: string; auth?: string }> = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization })
    const path = new URL(url).pathname
    const next = responses[path]
    if (!next) throw new Error(`unexpected request to ${path}`)
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('endpoint selection and URLs', () => {
  test.each(['openrouter.ai', 'OPENROUTER.AI', 'api.openrouter.ai', 'openrouter.ai:443'])(
    'selects host %s', host => {
      expect(isOpenRouterHost(host)).toBe(true)
    }
  )

  test.each(['notopenrouter.ai', 'openrouter.ai.example.internal', 'openrouter.example.internal', '', 'zai.test'])(
    'does not select host %s', host => {
      expect(isOpenRouterHost(host)).toBe(false)
    }
  )

  test.each([
    'https://openrouter.ai/api',
    'https://api.openrouter.ai/api/v1',
    'http://openrouter.ai:8080/api',
  ])('selects the base URL %s', baseUrl => {
    expect(isOpenRouterBaseUrl(baseUrl)).toBe(true)
  })

  test.each([
    'https://openrouter.ai.example.internal/api',
    'https://zai.test/api/anthropic',
    'not a url',
  ])('does not select the base URL %s', baseUrl => {
    expect(isOpenRouterBaseUrl(baseUrl)).toBe(false)
  })

  test('builds the endpoint URLs at the origin, dropping the model path, query and fragment', () => {
    expect(openRouterUrl(`${BASE}/?route=x#m`, OPENROUTER_KEY_PATH)).toBe('https://openrouter.ai/api/v1/key')
    expect(openRouterUrl(`${BASE}/?route=x#m`, OPENROUTER_CREDITS_PATH)).toBe('https://openrouter.ai/api/v1/credits')
    expect(openRouterUrl('http://openrouter.ai:8080/api/v1', OPENROUTER_KEY_PATH)).toBe('http://openrouter.ai:8080/api/v1/key')
  })
})

describe('parseOpenRouterKey', () => {
  test('Capped key: one key_limit meter with $0.04 left, 20% used, no reset, no period', () => {
    const parsed = parseOpenRouterKey(CAPPED_KEY, RECEIVED)
    expect(parsed).not.toBeNull()
    if (!parsed) return
    expect(parsed.report.status).toBe('allowed')
    expect(parsed.report.source).toBe('provider')
    expect(parsed.report.windows).toEqual([
      {
        key: 'openrouter:key_limit',
        label: 'Key cap · $0.04 left',
        percentUsed: 20,
        resetsAt: null,
      },
    ])
    expect(parsed.remainingUsd).toBe(0.04)
  })

  test('Daily budget: a 24-hour period and the reported reset; weekly carries 7 days', () => {
    const parsed = parseOpenRouterKey(
      {
        budgets: [
          {
            scope: 'daily',
            limit_usd: 5,
            spend_usd: 1,
            remaining_usd: 4,
            reset_interval: 'daily',
            resets_at: '2026-10-21T00:00:00.000Z',
          },
          {
            scope: 'weekly',
            limit_usd: 20,
            spend_usd: 5,
            remaining_usd: 15,
            reset_interval: 'weekly',
            resets_at: '2026-10-26T00:00:00.000Z',
          },
        ],
      },
      RECEIVED
    )
    expect(parsed?.report.windows).toEqual([
      {
        key: 'openrouter:daily',
        label: 'Daily budget · $4.00 left',
        percentUsed: 20,
        resetsAt: '2026-10-21T00:00:00.000Z',
        periodMs: 24 * 60 * 60 * 1000,
      },
      {
        key: 'openrouter:weekly',
        label: 'Weekly budget · $15.00 left',
        percentUsed: 25,
        resetsAt: '2026-10-26T00:00:00.000Z',
        periodMs: 7 * 24 * 60 * 60 * 1000,
      },
    ])
  })

  test('Monthly and non-resetting budgets carry no period, never a guess', () => {
    const parsed = parseOpenRouterKey(
      {
        budgets: [
          { scope: 'monthly', limit_usd: 50, spend_usd: 5, remaining_usd: 45, reset_interval: 'monthly', resets_at: '2026-11-01T00:00:00.000Z' },
          { scope: 'key_limit', limit_usd: 0.05, spend_usd: 0.01, remaining_usd: 0.04, reset_interval: null, resets_at: null },
        ],
      },
      RECEIVED
    )
    for (const window of parsed?.report.windows ?? []) expect(window.periodMs).toBeUndefined()
  })

  test('Unknown budget scope: the raw scope value labels the meter', () => {
    const parsed = parseOpenRouterKey(
      { budgets: [{ scope: 'team_pool', limit_usd: 10, spend_usd: 2.5, remaining_usd: 7.5, reset_interval: null }] },
      RECEIVED
    )
    expect(parsed?.report.windows[0]).toMatchObject({ key: 'openrouter:team_pool', label: 'team_pool · $7.50 left' })
  })

  test('Budget and guardrail ids suffix the meter key so rows never collide', () => {
    const parsed = parseOpenRouterKey(
      {
        budgets: [
          { scope: 'daily', budget_id: 'b-1', limit_usd: 5, spend_usd: 1, remaining_usd: 4 },
          { scope: 'daily', guardrail_id: 'g-2', limit_usd: 5, spend_usd: 0, remaining_usd: 5 },
        ],
      },
      RECEIVED
    )
    expect(parsed?.report.windows.map(window => window.key)).toEqual([
      'openrouter:daily:b-1',
      'openrouter:daily:g-2',
    ])
  })

  test('Without budgets, a set limit renders as one bare key cap', () => {
    const parsed = parseOpenRouterKey({ limit: 10, limit_remaining: 2.5, budgets: null }, RECEIVED)
    expect(parsed?.report.windows).toEqual([
      { key: 'openrouter:key_limit', label: 'Key cap · $2.50 left', percentUsed: 75, resetsAt: null },
    ])
    expect(parsed?.remainingUsd).toBe(2.5)
  })

  test('Uncapped key: no budgets and a null limit produce no meter', () => {
    const parsed = parseOpenRouterKey({ limit: null, limit_remaining: null, budgets: [] }, RECEIVED)
    expect(parsed?.report.windows).toEqual([])
    expect(parsed?.report.status).toBe('allowed')
    expect(parsed?.remainingUsd).toBeNull()
  })

  test('Cap spent: remaining 0 reports a limited status', () => {
    const parsed = parseOpenRouterKey(
      { budgets: [{ scope: 'key_limit', limit_usd: 0.05, spend_usd: 0.05, remaining_usd: 0, reset_interval: null, resets_at: null }] },
      RECEIVED
    )
    expect(parsed?.report.status).toBe('limited')
    expect(parsed?.remainingUsd).toBe(0)
  })

  test('remainingUsd is the smallest remaining over the meters', () => {
    const parsed = parseOpenRouterKey(
      {
        budgets: [
          { scope: 'key_limit', limit_usd: 1, spend_usd: 0.5, remaining_usd: 0.5 },
          { scope: 'daily', limit_usd: 5, spend_usd: 4.75, remaining_usd: 0.25 },
        ],
      },
      RECEIVED
    )
    expect(parsed?.remainingUsd).toBe(0.25)
    expect(parsed?.report.status).toBe('allowed')
  })

  test.each([
    ['not an object', 'nope'],
    ['an array', []],
    ['budgets not an array', { budgets: {} }],
    ['a budget that is not an object', { budgets: [7] }],
  ])('malformed body (%s) records no data', (_name, body) => {
    expect(parseOpenRouterKey(body as unknown as OpenRouterKeySlice, RECEIVED)).toBeNull()
  })

  test('a budget with unusable numbers is skipped, not guessed', () => {
    const parsed = parseOpenRouterKey(
      {
        budgets: [
          { scope: 'key_limit', limit_usd: 0, spend_usd: 0, remaining_usd: 0 },
          { scope: 'daily', limit_usd: 5, spend_usd: 1, remaining_usd: 4 },
        ],
      },
      RECEIVED
    )
    expect(parsed?.report.windows.map(window => window.key)).toEqual(['openrouter:daily'])
  })

  test('management-key capture: empty budgets and a null limit yield no meter', () => {
    const parsed = parseOpenRouterKey({ limit: null, limit_remaining: null, budgets: [], is_management_key: true, expires_at: '2027-01-01T00:00:00.000Z' }, RECEIVED)
    expect(parsed?.report.windows).toEqual([])
  })

  test('the documented data wrapper parses exactly like the bare body', () => {
    // OpenRouter's docs declare GET /api/v1/key as { data: { … } }, like
    // /credits; the spike's bare capture stays accepted beside it.
    expect(parseOpenRouterKey({ data: CAPPED_KEY }, RECEIVED)).toEqual(
      parseOpenRouterKey(CAPPED_KEY, RECEIVED)
    )
  })

  test('a wrapped foreign body records no data', () => {
    expect(parseOpenRouterKey({ data: { hello: true } } as unknown as OpenRouterKeySlice, RECEIVED)).toBeNull()
  })
})

describe('parseOpenRouterCredits', () => {
  test('Management key configured: $40 purchased, $15.57 used → Credits · $24.43 left at ~39%', () => {
    const meter = parseOpenRouterCredits({ data: { total_credits: 40, total_usage: 15.57 } })
    expect(meter?.window).toEqual({
      key: 'openrouter:credits',
      label: 'Credits · $24.43 left',
      percentUsed: expect.closeTo(38.92, 1),
      resetsAt: null,
    })
    expect(meter?.remainingUsd).toBeCloseTo(24.43, 2)
  })

  test.each([
    ['no data wrapper', {}],
    ['null data', { data: null }],
    ['total_credits missing', { data: { total_usage: 1 } }],
    ['total_credits not positive', { data: { total_credits: 0, total_usage: 0 } }],
    ['total_usage negative', { data: { total_credits: 40, total_usage: -1 } }],
  ])('malformed credits body (%s) records no meter', (_name, body) => {
    expect(parseOpenRouterCredits(body as never)).toBeNull()
  })

  test('credits spent to zero report a limited meter', () => {
    const meter = parseOpenRouterCredits({ data: { total_credits: 5, total_usage: 5 } })
    expect(meter?.window.percentUsed).toBe(100)
    expect(meter?.remainingUsd).toBe(0)
  })
})

describe('fetchOpenRouterUsage', () => {
  test('pulls /api/v1/key with the session token as a bearer and merges the credits meter', async () => {
    const { impl, calls } = fetchByPath({
      [OPENROUTER_KEY_PATH]: jsonResponse(CAPPED_KEY),
      [OPENROUTER_CREDITS_PATH]: jsonResponse({ data: { total_credits: 40, total_usage: 15.57 } }),
    })
    const pull = await fetchOpenRouterUsage(BASE, 'tok-session', 'tok-balance', impl)
    expect(pull.ok).toBe(true)
    if (!pull.ok) return
    expect(calls).toEqual([
      { url: 'https://openrouter.ai/api/v1/key', auth: 'Bearer tok-session' },
      { url: 'https://openrouter.ai/api/v1/credits', auth: 'Bearer tok-balance' },
    ])
    expect(pull.report.windows.map(window => window.key)).toEqual(['openrouter:key_limit', 'openrouter:credits'])
    expect(pull.report.status).toBe('allowed')
    expect(pull.credits.outcome).toBe('ok')
    expect(pull.remainingUsd).toBeCloseTo(0.04, 2)
  })

  test('without a balance key the credits endpoint is never requested', async () => {
    const { impl, calls } = fetchByPath({ [OPENROUTER_KEY_PATH]: jsonResponse(CAPPED_KEY) })
    const pull = await fetchOpenRouterUsage(BASE, 'tok-session', undefined, impl)
    expect(pull.ok).toBe(true)
    if (!pull.ok) return
    expect(calls).toHaveLength(1)
    expect(pull.credits.outcome).toBe('skipped')
    expect(pull.report.windows.map(window => window.key)).toEqual(['openrouter:key_limit'])
  })

  test('credits spent to zero make the merged report limited', async () => {
    const { impl } = fetchByPath({
      [OPENROUTER_KEY_PATH]: jsonResponse(CAPPED_KEY),
      [OPENROUTER_CREDITS_PATH]: jsonResponse({ data: { total_credits: 5, total_usage: 5 } }),
    })
    const pull = await fetchOpenRouterUsage(BASE, 'tok-session', 'tok-balance', impl)
    expect(pull.ok).toBe(true)
    if (!pull.ok) return
    expect(pull.report.status).toBe('limited')
    expect(pull.remainingUsd).toBe(0)
  })

  test('a 403 from the credits endpoint drops only the credits meter and reports the refusal', async () => {
    const { impl, calls } = fetchByPath({
      [OPENROUTER_KEY_PATH]: jsonResponse(CAPPED_KEY),
      [OPENROUTER_CREDITS_PATH]: jsonResponse({ error: 'Only management keys' }, 403),
    })
    const pull = await fetchOpenRouterUsage(BASE, 'tok-session', 'tok-balance', impl)
    expect(pull.ok).toBe(true)
    if (!pull.ok) return
    expect(calls).toHaveLength(2)
    expect(pull.report.windows.map(window => window.key)).toEqual(['openrouter:key_limit'])
    expect(pull.credits).toEqual({ outcome: 'refused', reason: 'HTTP 403 from openrouter.ai' })
  })

  test.each([
    ['401 refusal', jsonResponse({ error: 'bad key' }, 401), 'refused' as const],
    ['403 refusal', jsonResponse({ error: 'no' }, 403), 'refused' as const],
    ['404', jsonResponse({ error: 'no route' }, 404), 'failed' as const],
    ['server error', jsonResponse({ error: 'boom' }, 500), 'failed' as const],
    ['a body without the key shape', jsonResponse({ hello: true }), 'failed' as const],
    ['a transport error', new Error('offline'), 'failed' as const],
  ])('a failing key pull (%s) fails the whole pull', async (_name, response, outcome) => {
    const { impl, calls } = fetchByPath({ [OPENROUTER_KEY_PATH]: response })
    const pull = await fetchOpenRouterUsage(BASE, 'tok-session', 'tok-balance', impl)
    expect(pull.ok).toBe(false)
    if (pull.ok) return
    expect(pull.outcome).toBe(outcome)
    // The credits endpoint is never asked when the key pull failed.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.auth).toBe('Bearer tok-session')
  })

  test('failure reasons name the host and status, never the key', async () => {
    const { impl } = fetchByPath({ [OPENROUTER_KEY_PATH]: jsonResponse({ error: 'x' }, 401) })
    const pull = await fetchOpenRouterUsage(BASE, 'tok-secret-value', undefined, impl)
    expect(pull.ok).toBe(false)
    if (pull.ok) return
    expect(pull.reason).toBe('HTTP 401 from openrouter.ai')
    expect(pull.reason.includes('tok-secret-value')).toBe(false)
  })
})
