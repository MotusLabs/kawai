// Account-notice tests (notification strip design D2/D3): every scenario of
// the spec's "Expiring logins produce an account notice per profile"
// requirement, the store's change-only notification, and the env gate that
// decides which sessions are eligible for a stored-login check at all.
import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import {
  AccountNoticeStore,
  credentialsPathFor,
  loginExpiryNotice,
  type CredentialsSlice,
} from '../chat/accountNotices'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-12T12:00:00.000Z')

/** Credentials with a refresh token expiring `daysFromNow`, access token 1h older. */
function credentials(
  daysFromNow: number,
  accessOffsetMs = -60 * 60 * 1000
): CredentialsSlice {
  const refreshTokenExpiresAt = NOW + daysFromNow * DAY
  return { claudeAiOauth: { refreshTokenExpiresAt, expiresAt: refreshTokenExpiresAt + accessOffsetMs } }
}

/** A minimal usable environment (no overrides). */
const BASE_ENV: Record<string, string | undefined> = { HOME: '/home/tester' }

describe('credentialsPathFor', () => {
  test('resolves the default config dir from HOME', () => {
    expect(credentialsPathFor(BASE_ENV)).toBe(path.join('/home/tester', '.claude', '.credentials.json'))
  })

  test('CLAUDE_CONFIG_DIR overrides the location per environment', () => {
    expect(credentialsPathFor({ ...BASE_ENV, CLAUDE_CONFIG_DIR: '/opt/alt-config' })).toBe(
      path.join('/opt/alt-config', '.credentials.json')
    )
  })

  test.each([
    ['ANTHROPIC_API_KEY', 'sk-provider'],
    ['ANTHROPIC_AUTH_TOKEN', 'gateway-token'],
    ['CLAUDE_CODE_OAUTH_TOKEN', 'oauth-token'],
    ['CLAUDE_CODE_USE_BEDROCK', '1'],
    ['CLAUDE_CODE_USE_VERTEX', '1'],
    ['CLAUDE_CODE_USE_FOUNDRY', '1'],
  ])('%s suppresses the stored-login check', (name, value) => {
    expect(credentialsPathFor({ ...BASE_ENV, [name]: value })).toBeNull()
  })

  test('blank auth variables do not suppress the check', () => {
    expect(credentialsPathFor({ ...BASE_ENV, ANTHROPIC_API_KEY: '  ' })).not.toBeNull()
  })
})

describe('loginExpiryNotice', () => {
  test('1.4 days left reads "2 days" with the renewal hint', () => {
    const notice = loginExpiryNotice(credentials(1.4), NOW)
    expect(notice).toMatchObject({
      key: 'login-expiry',
      source: 'account',
      severity: 'warning',
      priority: 'high',
      text: 'Your login expires in 2 days',
      hint: 'run /login in a Claude terminal to renew',
      receivedAt: new Date(NOW).toISOString(),
    })
  })

  test('5 hours left reads "1 day" (singular)', () => {
    expect(loginExpiryNotice(credentials(5 / 24), NOW)?.text).toBe('Your login expires in 1 day')
  })

  test('exactly 3 days left still warns; beyond 3 days does not', () => {
    expect(loginExpiryNotice(credentials(3), NOW)?.text).toBe('Your login expires in 3 days')
    expect(loginExpiryNotice(credentials(3 + 1 / 24), NOW)).toBeNull()
  })

  test('an already-expired refresh token yields no notice, matching the CLI', () => {
    expect(loginExpiryNotice(credentials(-0.5), NOW)).toBeNull()
  })

  test('an access token outliving the refresh window yields no notice', () => {
    expect(loginExpiryNotice(credentials(1.4, 3.5 * DAY), NOW)).toBeNull()
  })

  test('missing, malformed, or field-less credentials yield no notice and no error', () => {
    expect(loginExpiryNotice(null, NOW)).toBeNull()
    expect(loginExpiryNotice({}, NOW)).toBeNull()
    expect(loginExpiryNotice({ claudeAiOauth: null }, NOW)).toBeNull()
    expect(loginExpiryNotice({ claudeAiOauth: {} }, NOW)).toBeNull()
    expect(loginExpiryNotice({ claudeAiOauth: { refreshTokenExpiresAt: 'soon' as unknown as number } }, NOW)).toBeNull()
    // A refresh expiry without an access expiry is an unknown shape.
    expect(loginExpiryNotice({ claudeAiOauth: { refreshTokenExpiresAt: NOW + DAY } }, NOW)).toBeNull()
    expect(
      loginExpiryNotice({ claudeAiOauth: { refreshTokenExpiresAt: Number.NaN, expiresAt: NOW } }, NOW)
    ).toBeNull()
  })
})

describe('AccountNoticeStore', () => {
  /** A store over an in-memory file map; unreadable paths are absent. */
  function store(files: Record<string, string>) {
    return new AccountNoticeStore((p) => {
      const entry = files[p]
      if (entry === undefined) throw new Error('ENOENT')
      return entry
    })
  }

  const credentialsJson = (daysFromNow: number): string =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: NOW + daysFromNow * DAY - 3_600_000,
        refreshTokenExpiresAt: NOW + daysFromNow * DAY,
      },
    })

  test('an unchanged day count publishes nothing and keeps the earlier object', () => {
    const files: Record<string, string> = { '/creds': credentialsJson(1.4) }
    const notices = new AccountNoticeStore((p) => files[p]!)
    const events: Array<string | null> = []
    notices.subscribe((_p, notice) => events.push(notice?.text ?? null))

    const first = notices.check('/creds', NOW)
    files['/creds'] = credentialsJson(1.4)
    const second = notices.check('/creds', NOW + 60_000)
    expect(events).toEqual(['Your login expires in 2 days'])
    // Same object: stable identity between checks with the same day count.
    expect(second).toBe(first)
  })

  test('a new day count publishes the updated notice', () => {
    const files: Record<string, string> = { '/creds': credentialsJson(1.4) }
    const notices = new AccountNoticeStore((p) => files[p]!)
    const events: Array<string | null> = []
    notices.subscribe((_p, notice) => events.push(notice?.text ?? null))
    notices.check('/creds', NOW)
    // Hours pass; the same file now reads one day left.
    notices.check('/creds', NOW + 0.5 * DAY)
    expect(events).toEqual(['Your login expires in 2 days', 'Your login expires in 1 day'])
  })

  test('a renewed login publishes null', () => {
    const files: Record<string, string> = { '/creds': credentialsJson(1.4) }
    const notices = new AccountNoticeStore((p) => files[p]!)
    const events: Array<string | null> = []
    notices.subscribe((_p, notice) => events.push(notice?.text ?? null))
    expect(notices.check('/creds', NOW)?.text).toBe('Your login expires in 2 days')
    files['/creds'] = credentialsJson(30)
    expect(notices.check('/creds', NOW)).toBeNull()
    expect(events).toEqual(['Your login expires in 2 days', null])
  })

  test('a first check that finds nothing primes the cache silently', () => {
    const files: Record<string, string> = { '/far': credentialsJson(30) }
    const notices = new AccountNoticeStore((p) => files[p]!)
    const events: Array<string | null> = []
    notices.subscribe((_p, notice) => events.push(notice?.text ?? null))
    expect(notices.check('/far', NOW)).toBeNull()
    expect(events).toEqual([])
    // A notice appearing later still publishes.
    files['/far'] = credentialsJson(1.4)
    expect(notices.check('/far', NOW)?.text).toBe('Your login expires in 2 days')
    expect(events).toEqual(['Your login expires in 2 days'])
  })

  test('a missing or malformed file reads as no notice, without error', () => {
    const notices = store({ '/malformed': '{not json' })
    expect(notices.check('/missing')).toBeNull()
    expect(notices.check('/malformed')).toBeNull()
    // A later well-formed file still produces the notice.
    const files: Record<string, string> = { '/creds': credentialsJson(2) }
    const healing = new AccountNoticeStore((p) => files[p]!)
    expect(healing.check('/creds', NOW)?.text).toBe('Your login expires in 2 days')
  })

  test('different paths hold independent results', () => {
    const notices = store({ '/a': credentialsJson(1.4), '/b': credentialsJson(30) })
    expect(notices.check('/a', NOW)?.text).toBe('Your login expires in 2 days')
    expect(notices.check('/b', NOW)).toBeNull()
    expect(notices.get('/a')?.text).toBe('Your login expires in 2 days')
    expect(notices.get('/b')).toBeNull()
  })

  test('a cached result is returned by get without re-reading', () => {
    let reads = 0
    const files: Record<string, string> = { '/creds': credentialsJson(1.4) }
    const notices = new AccountNoticeStore((p) => {
      reads += 1
      return files[p]!
    })
    notices.check('/creds', NOW)
    expect(reads).toBe(1)
    expect(notices.get('/creds')?.text).toBe('Your login expires in 2 days')
    expect(reads).toBe(1)
  })
})
