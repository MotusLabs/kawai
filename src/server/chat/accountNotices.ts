// Account notices for chat sessions (notification strip design D2): the
// login-expiry warning the interactive Claude CLI draws as a REPL startup
// banner, reproduced server-side so chat users see it too. The rule mirrors
// what we observed in Claude Code 2.1.296: the banner shows only for
// first-party provider setups that authenticate with the stored claude.ai
// OAuth login, when `claudeAiOauth.refreshTokenExpiresAt` is a number whose
// distance to now is within (0, 3 days], and `expiresAt` does not outlive it
// by more than 3 days. SDK-free and side-effect free: the pure check takes a
// parsed credentials value, and the store below adds the file read and cache.
import fs from 'node:fs'
import path from 'node:path'
import type { ChatNotification } from '../../shared/chat'
import { CLI_CREDENTIALS_FILE, claudeConfigDir } from './chatAuth'

/** Days ahead of the refresh-token expiry the CLI starts warning at. */
const EXPIRY_WARN_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

/** Stable key for the login-expiry notice (close/collapse targets it). */
export const LOGIN_EXPIRY_KEY = 'login-expiry'

/** The renewal hint; /login is terminal-bound and hidden in chat. */
const LOGIN_EXPIRY_HINT = 'run /login in a Claude terminal to renew'

/** Structural slice of the credentials file's claudeAiOauth (SDK-free). */
interface CredentialsOauthSlice {
  /** Epoch-ms expiry of the access token. */
  expiresAt?: number
  /** Epoch-ms expiry of the refresh token. */
  refreshTokenExpiresAt?: number
}

/** Structural slice of the credentials file (SDK-free). */
export interface CredentialsSlice {
  claudeAiOauth?: CredentialsOauthSlice | null
}

/**
 * The credentials file path an environment's stored login lives in, or null
 * when the environment makes the session ineligible for a login notice: a
 * cloud provider (Bedrock, Vertex, Foundry) never uses the stored login, and
 * an explicit API key, auth token, or OAuth token authenticates instead of
 * it. Evaluated against the same effective environment the SDK process
 * receives, so the notice and the spawn never disagree.
 */
export function credentialsPathFor(
  env: Record<string, string | undefined>
): string | null {
  if (env.CLAUDE_CODE_USE_BEDROCK) return null
  if (env.CLAUDE_CODE_USE_VERTEX) return null
  if (env.CLAUDE_CODE_USE_FOUNDRY) return null
  if (env.ANTHROPIC_API_KEY?.trim()) return null
  if (env.ANTHROPIC_AUTH_TOKEN?.trim()) return null
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return null
  return path.join(claudeConfigDir(env), CLI_CREDENTIALS_FILE)
}

/**
 * The CLI's login-expiry rule (design D2, observed in Claude Code 2.1.296):
 * a warning notice while the stored refresh token expires within the next
 * 3 days, unless the access token outlives it by more than 3 days — the CLI
 * shows nothing then, and nothing once the refresh token has passed. Days
 * are rounded up (1.4 days left reads "2 days"). Any unknown shape yields
 * null, never an error: a schema change must not break chat sessions.
 */
export function loginExpiryNotice(
  credentials: CredentialsSlice | null | undefined,
  now: number = Date.now()
): ChatNotification | null {
  const oauth = credentials?.claudeAiOauth
  const refreshTokenExpiresAt = oauth?.refreshTokenExpiresAt
  const expiresAt = oauth?.expiresAt
  if (typeof refreshTokenExpiresAt !== 'number' || !Number.isFinite(refreshTokenExpiresAt)) {
    return null
  }
  // Both expiries must be known: the CLI compares them, and a file missing
  // either field is an unknown shape.
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return null
  }
  if (expiresAt - refreshTokenExpiresAt > EXPIRY_WARN_WINDOW_MS) return null
  const remainingMs = refreshTokenExpiresAt - now
  if (remainingMs <= 0 || remainingMs > EXPIRY_WARN_WINDOW_MS) return null
  const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000))
  return {
    key: LOGIN_EXPIRY_KEY,
    source: 'account',
    severity: 'warning',
    priority: 'high',
    text: `Your login expires in ${days} ${days === 1 ? 'day' : 'days'}`,
    hint: LOGIN_EXPIRY_HINT,
    receivedAt: new Date(now).toISOString(),
  }
}

/** Notified with the latest notice (or null) whenever a path's result changes. */
export type AccountNoticeListener = (
  credentialsPath: string,
  notice: ChatNotification | null
) => void

/**
 * Latest login-expiry notice per credentials path, in memory only: each
 * `check` is one synchronous file read, and listeners fire only when the
 * result changes — null, or a new `text` (the day count). An unchanged
 * result keeps the previous object, so its `receivedAt` stays stable and
 * clients see no churn. Missing, unreadable, or malformed files read as no
 * notice, never an error.
 */
export class AccountNoticeStore {
  private readonly latest = new Map<string, ChatNotification | null>()
  private readonly listeners = new Set<AccountNoticeListener>()

  constructor(
    /** File reader; injected so tests need no disk. Defaults to readFileSync. */
    private readonly readFile: (path: string) => string = (p) => fs.readFileSync(p, 'utf8')
  ) {}

  /** Subscribe to result changes; returns an unsubscribe function. */
  subscribe(listener: AccountNoticeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The latest result for a path without re-reading the file. */
  get(credentialsPath: string): ChatNotification | null {
    return this.latest.get(credentialsPath) ?? null
  }

  /**
   * Read and evaluate a credentials file, caching the result. Returns the
   * current notice (or null) and notifies subscribers only when it changed.
   */
  check(credentialsPath: string, now: number = Date.now()): ChatNotification | null {
    const next = loginExpiryNotice(this.readCredentials(credentialsPath), now)
    const previous = this.latest.get(credentialsPath)
    // An unchanged day count keeps the earlier object (stable receivedAt).
    if (previous !== undefined && (previous?.text ?? null) === (next?.text ?? null)) {
      return previous
    }
    this.latest.set(credentialsPath, next)
    for (const listener of this.listeners) {
      listener(credentialsPath, next)
    }
    return next
  }

  /** Parse the credentials file; any read or parse failure reads as absent. */
  private readCredentials(credentialsPath: string): CredentialsSlice | null {
    let raw: string
    try {
      raw = this.readFile(credentialsPath)
    } catch {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as CredentialsSlice) : null
    } catch {
      return null
    }
  }
}
