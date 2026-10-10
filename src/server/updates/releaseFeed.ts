// releaseFeed.ts - GitHub Releases client for update discovery.
// The releases API of the kawai repository is the single source of truth for
// "what is the newest release"; the feed keeps one ETag-cached response per
// process and fails silent on every error — a discovery problem must never
// surface in the UI, so this module never throws.
import { RELEASE_REPO } from './updateConstants'

/** One downloadable asset of a release, as the updater needs it. */
export interface ReleaseAsset {
  name: string
  url: string
}

/** The parts of `GET /repos/{repo}/releases/latest` this feature consumes. */
export interface LatestRelease {
  tag: string
  htmlUrl: string | null
  assets: ReleaseAsset[]
}

export interface ReleaseFeed {
  /** The latest release, or null when the API is unreachable or broken. */
  latest(): Promise<LatestRelease | null>
}

export interface ReleaseFeedOptions {
  repo?: string
  fetchImpl?: typeof fetch
}

export function createReleaseFeed(options: ReleaseFeedOptions = {}): ReleaseFeed {
  const repo = options.repo ?? RELEASE_REPO
  const doFetch = options.fetchImpl ?? fetch
  const endpoint = `https://api.github.com/repos/${repo}/releases/latest`
  let etag: string | null = null
  let cached: LatestRelease | null = null

  const latest = async (): Promise<LatestRelease | null> => {
    let response: Response
    try {
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
      // The conditional request makes the hourly-rate-limited API nearly
      // free: a 304 carries no body.
      if (etag !== null) headers['If-None-Match'] = etag
      response = await doFetch(endpoint, { headers })
    } catch {
      return null
    }
    if (response.status === 304) return cached
    if (!response.ok) return null
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return null
    }
    const release = parseLatest(parsed)
    if (release === null) return null
    const nextEtag = response.headers.get('etag')
    etag = nextEtag
    cached = release
    return release
  }

  return { latest }
}

const parseLatest = (value: unknown): LatestRelease | null => {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.tag_name !== 'string' || record.tag_name === '') return null
  const assets = Array.isArray(record.assets)
    ? record.assets.flatMap((asset) => {
        if (typeof asset !== 'object' || asset === null) return []
        const { name, browser_download_url } = asset as Record<string, unknown>
        if (typeof name !== 'string' || typeof browser_download_url !== 'string') return []
        return [{ name, url: browser_download_url }]
      })
    : []
  return {
    tag: record.tag_name,
    htmlUrl: typeof record.html_url === 'string' ? record.html_url : null,
    assets,
  }
}
