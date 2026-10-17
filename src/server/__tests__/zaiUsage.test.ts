import { describe, expect, test } from 'bun:test'
import { fetchZaiUsage, zaiQuotaUrl } from '../chat/zaiUsage'

/** JSON response helper: the injected fetch returns these verbatim. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Capture the request a fetch impl saw, alongside a canned response. */
function fetchSaying(response: Response): {
  impl: typeof fetch
  calls: Array<{ url: string; init?: RequestInit }>
} {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return response
  }) as unknown as typeof fetch
  return { impl, calls }
}

const BASE = 'https://glm.example.internal'
const CAPTURE = {
  code: 200,
  msg: 'Operation successful',
  data: {
    limits: [
      { type: 'TIME_LIMIT', percentage: 2, nextResetTime: 1793701399997 },
      { type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: 1791845403778 },
    ],
    level: 'pro',
  },
  success: true,
}

describe('zaiQuotaUrl', () => {
  test.each(['', '/', '//', '/api/anthropic', '/api/anthropic/', '/v4', '/api/anthropic/?route=glm#model'])(
    'resolves the quota endpoint from the origin of a base ending in %s', suffix => {
      expect(zaiQuotaUrl(`https://api.z.ai${suffix}`)).toBe('https://api.z.ai/api/monitor/usage/quota/limit')
    }
  )

  test('keeps the scheme and port, but drops URL userinfo and model routing', () => {
    expect(zaiQuotaUrl('http://user:password@gateway.test:8080/api/anthropic/?route=glm#model'))
      .toBe('http://gateway.test:8080/api/monitor/usage/quota/limit')
  })
})

describe('fetchZaiUsage', () => {
  test('sends the raw token as Authorization and parses the capture', async () => {
    const { impl, calls } = fetchSaying(jsonResponse(CAPTURE))
    const pull = await fetchZaiUsage(`${BASE}/api/anthropic/?route=glm#model`, 'sk-glm-token', impl)
    expect(pull.ok).toBe(true)
    if (!pull.ok) return
    expect(pull.report.source).toBe('provider')
    expect(pull.report.windows.map((window) => window.key)).toEqual([
      'zai:time_limit',
      'zai:tokens_limit',
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/api/monitor/usage/quota/limit`)
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: 'sk-glm-token' })
  })

  test('omits the Authorization header when there is no token (gateway-injected keys)', async () => {
    const { impl, calls } = fetchSaying(jsonResponse(CAPTURE))
    const pull = await fetchZaiUsage(BASE, undefined, impl)
    expect(pull.ok).toBe(true)
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })

  test('an invalid base fails without making a request or exposing the input', async () => {
    const { impl, calls } = fetchSaying(jsonResponse(CAPTURE))
    const pull = await fetchZaiUsage('not-a-url?secret=hidden', 'sk-glm-token', impl)
    expect(pull).toEqual({ ok: false, outcome: 'unreachable', reason: 'quota request failed for invalid base URL' })
    expect(calls).toEqual([])
  })

  test('a Z.AI-shaped refusal over HTTP 200 (success:false) is provider-refused', async () => {
    const { impl } = fetchSaying(
      jsonResponse({ code: 1001, msg: 'Authentication parameter not received', success: false })
    )
    const pull = await fetchZaiUsage(BASE, undefined, impl)
    expect(pull).toMatchObject({ ok: false, outcome: 'provider-refused' })
  })

  test.each([
    { body: { code: 401 }, outcome: 'provider-refused' },
    { body: { code: 403 }, outcome: 'provider-refused' },
    { body: { code: 1001 }, outcome: 'provider-refused' },
    { body: { code: 404 }, outcome: 'not-provider' },
    { body: { code: 405 }, outcome: 'not-provider' },
    { body: { code: 500, msg: '404 NOT_FOUND' }, outcome: 'not-provider' },
    { body: { code: 500, msg: ' 404 NOT_FOUND\n' }, outcome: 'not-provider' },
    { body: { code: 500, msg: 'upstream unavailable' }, outcome: 'unreachable' },
    { body: { code: 9999 }, outcome: 'unreachable' },
    { body: {}, outcome: 'unreachable' },
    { body: { code: '401' }, outcome: 'unreachable' },
    { body: { code: 500, msg: 'unrelated text containing 404 NOT_FOUND' }, outcome: 'unreachable' },
  ])('classifies HTTP 200 failure $body as $outcome', async ({ body, outcome }) => {
    const { impl } = fetchSaying(jsonResponse({ success: false, ...body }))
    expect(await fetchZaiUsage(BASE, 'sk-glm-token', impl)).toMatchObject({ ok: false, outcome })
  })

  test.each([401, 403])('HTTP %s is provider-refused', async status => {
    const { impl } = fetchSaying(jsonResponse({ code: status, msg: 'token expired' }, status))
    const pull = await fetchZaiUsage(BASE, 'sk-glm-token', impl)
    expect(pull).toMatchObject({ ok: false, outcome: 'provider-refused' })
  })

  test.each([404, 405])('HTTP %s is not-provider (the endpoint does not exist there)', async status => {
    const { impl } = fetchSaying(new Response('nope', { status }))
    const pull = await fetchZaiUsage(BASE, 'sk-glm-token', impl)
    expect(pull).toMatchObject({ ok: false, outcome: 'not-provider' })
  })

  test('HTTP 5xx is unreachable, so a transient blip keeps the SDK fallback', async () => {
    const { impl } = fetchSaying(new Response('bad gateway', { status: 502 }))
    const pull = await fetchZaiUsage(BASE, 'sk-glm-token', impl)
    expect(pull).toMatchObject({ ok: false, outcome: 'unreachable' })
  })

  test('a 200 with a foreign JSON body is not-provider', async () => {
    const { impl } = fetchSaying(jsonResponse({ error: 'nothing to see here' }))
    const pull = await fetchZaiUsage(BASE, 'sk-glm-token', impl)
    expect(pull).toMatchObject({ ok: false, outcome: 'not-provider' })
  })

  test('a 200 with an HTML body is not-provider', async () => {
    const { impl } = fetchSaying(new Response('<html>dashboard</html>'))
    const pull = await fetchZaiUsage(BASE, 'sk-glm-token', impl)
    expect(pull).toMatchObject({ ok: false, outcome: 'not-provider' })
  })

  test('a network failure is unreachable', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:443')
    }) as unknown as typeof fetch
    const pull = await fetchZaiUsage(BASE, 'sk-glm-token', impl)
    expect(pull).toMatchObject({ ok: false, outcome: 'unreachable' })
  })

  test('failure reasons name only the host, never the token', async () => {
    for (const response of [
      jsonResponse({ success: false }),
      jsonResponse({ success: false, code: 1001, msg: 'response-secret' }),
      jsonResponse({ success: false, code: 500, msg: '404 NOT_FOUND' }),
      jsonResponse({ success: false, code: 500, msg: 'response-secret' }),
      new Response('nope', { status: 404 }),
      new Response('denied', { status: 403 }),
      new Response('busy', { status: 503 }),
      new Response('<html/>'),
    ]) {
      const { impl } = fetchSaying(response)
      const pull = await fetchZaiUsage(`${BASE}/api/anthropic?query-secret=1#fragment-secret`, 'sk-secret-glm-token', impl)
      if (pull.ok) continue
      expect(pull.reason).not.toContain('sk-secret-glm-token')
      expect(pull.reason).not.toMatch(/query-secret|fragment-secret|response-secret|404 NOT_FOUND/)
      expect(pull.reason).toContain('glm.example.internal')
    }
    const impl = (async () => {
      throw new Error('boom with sk-secret-glm-token inside')
    }) as unknown as typeof fetch
    const pull = await fetchZaiUsage(BASE, 'sk-secret-glm-token', impl)
    if (!pull.ok) {
      expect(pull.reason).not.toContain('sk-secret-glm-token')
      expect(pull.reason).not.toContain('boom')
    }
  })
})
