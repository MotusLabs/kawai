import { describe, expect, test } from 'bun:test'
import { createReleaseFeed, type LatestRelease } from '../updates/releaseFeed'

const releaseBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: 'v1.2.0-7',
  html_url: 'https://github.com/MotusLabs/kawai/releases/tag/v1.2.0-7',
  assets: [
    { name: 'agentboard-linux-x64.tar.gz', browser_download_url: 'https://example.com/agentboard-linux-x64.tar.gz' },
    { name: 'SHA256SUMS', browser_download_url: 'https://example.com/SHA256SUMS' },
  ],
  ...overrides,
})

/** fetch double that records requests and answers from a script. */
function fakeFetch(script: Array<{ status: number; body?: unknown; etag?: string } | Error>) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = []
  let call = 0
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: (init?.headers as Record<string, string>) ?? {},
    })
    const step = script[Math.min(call, script.length - 1)]!
    call += 1
    if (step instanceof Error) throw step
    return new Response(step.body === undefined ? null : JSON.stringify(step.body), {
      status: step.status,
      headers: {
        ...(step.etag ? { etag: step.etag } : {}),
        ...(step.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    })
  }) as typeof fetch
  return { impl, requests }
}

describe('releaseFeed', () => {
  test('a successful fetch returns the parsed release', async () => {
    const { impl, requests } = fakeFetch([{ status: 200, body: releaseBody(), etag: 'W/"abc"' }])
    const feed = createReleaseFeed({ fetchImpl: impl })
    const release = await feed.latest()
    expect(release).toEqual({
      tag: 'v1.2.0-7',
      htmlUrl: 'https://github.com/MotusLabs/kawai/releases/tag/v1.2.0-7',
      assets: [
        { name: 'agentboard-linux-x64.tar.gz', url: 'https://example.com/agentboard-linux-x64.tar.gz' },
        { name: 'SHA256SUMS', url: 'https://example.com/SHA256SUMS' },
      ],
    } satisfies LatestRelease)
    expect(requests[0]!.url).toBe('https://api.github.com/repos/MotusLabs/kawai/releases/latest')
    expect(requests[0]!.headers.Accept).toBe('application/vnd.github+json')
    expect(requests[0]!.headers['If-None-Match']).toBeUndefined()
  })

  test('a cached ETag rides the next request and a 304 returns the cache', async () => {
    const { impl, requests } = fakeFetch([
      { status: 200, body: releaseBody(), etag: 'W/"abc"' },
      { status: 304 },
    ])
    const feed = createReleaseFeed({ fetchImpl: impl })
    const first = await feed.latest()
    const second = await feed.latest()
    expect(requests[1]!.headers['If-None-Match']).toBe('W/"abc"')
    expect(second).toEqual(first)
  })

  test('an HTTP error returns null without throwing', async () => {
    const { impl } = fakeFetch([{ status: 500, body: { message: 'server error' } }])
    const feed = createReleaseFeed({ fetchImpl: impl })
    expect(await feed.latest()).toBeNull()
  })

  test('an offline rejection returns null without throwing', async () => {
    const { impl } = fakeFetch([new Error('fetch failed')])
    const feed = createReleaseFeed({ fetchImpl: impl })
    expect(await feed.latest()).toBeNull()
  })

  test('a body that is not JSON returns null', async () => {
    const impl = (async () => new Response('<html>rate limit</html>', { status: 200 })) as unknown as typeof fetch
    const feed = createReleaseFeed({ fetchImpl: impl })
    expect(await feed.latest()).toBeNull()
  })

  test('a body without a tag_name returns null', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { assets: [] } }])
    const feed = createReleaseFeed({ fetchImpl: impl })
    expect(await feed.latest()).toBeNull()
  })

  test('an error after a success leaves the ETag cache usable', async () => {
    const { impl, requests } = fakeFetch([
      { status: 200, body: releaseBody(), etag: 'W/"abc"' },
      { status: 500 },
      { status: 304 },
    ])
    const feed = createReleaseFeed({ fetchImpl: impl })
    await feed.latest()
    expect(await feed.latest()).toBeNull()
    // The cached ETag still conditions the retry, and the 304 still resolves
    // to the last known release.
    const recovered = await feed.latest()
    expect(requests[2]!.headers['If-None-Match']).toBe('W/"abc"')
    expect(recovered?.tag).toBe('v1.2.0-7')
  })
})
