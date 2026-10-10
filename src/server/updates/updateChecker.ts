// updateChecker.ts - periodic update discovery. One checker per process
// polls the release feed on startup and on a long timer (the GitHub API is
// rate-limited to 60 unauthenticated requests per hour), compares base
// versions, and reports changes through `onChange` for broadcast. Every
// failure is silent: an unreachable API leaves the previous state alone and
// never surfaces an error in the UI.
import type { UpdateState } from '@shared/types'
import { BUILD_VERSION } from '../version'
import { createReleaseFeed, type LatestRelease, type ReleaseFeed } from './releaseFeed'
import { baseOf, isNewerBase } from './updateVersions'

/** Startup plus one check every six hours stays far inside the rate limit. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface UpdateCheckerOptions {
  feed?: ReleaseFeed
  currentVersion?: string
  intervalMs?: number
  /** Called only when the client-facing state actually changes. */
  onChange?: (state: UpdateState) => void
}

export interface UpdateChecker {
  /** Runs one discovery pass now. Never throws. */
  check(): Promise<void>
  /** Current client-facing state. */
  getState(): UpdateState
  /**
   * The release behind the current target, with its download assets — what
   * the install verb acts on. Null while no update is reported.
   */
  getRelease(): LatestRelease | null
  stop(): void
}

export function startUpdateChecker(options: UpdateCheckerOptions = {}): UpdateChecker {
  const feed = options.feed ?? createReleaseFeed()
  const current = options.currentVersion ?? BUILD_VERSION
  const intervalMs = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS
  let state: UpdateState = { current, target: null }
  let release: LatestRelease | null = null

  const check = async (): Promise<void> => {
    let latest
    try {
      latest = await feed.latest()
    } catch {
      return
    }
    if (latest === null) return
    const target = isNewerBase(latest.tag, current)
      ? { tag: latest.tag, base: baseOf(latest.tag) ?? latest.tag, htmlUrl: latest.htmlUrl }
      : null
    const next: UpdateState = { current, target }
    release = target === null ? null : latest
    if (sameTarget(next.target, state.target)) return
    state = next
    options.onChange?.(state)
  }

  void check()
  const timer = setInterval(() => void check(), intervalMs)
  // The timer must never hold the process open on shutdown.
  timer.unref?.()

  return {
    check,
    getState: () => state,
    getRelease: () => release,
    stop: () => clearInterval(timer),
  }
}

const sameTarget = (a: UpdateState['target'], b: UpdateState['target']): boolean =>
  a?.tag === b?.tag && a?.base === b?.base && a?.htmlUrl === b?.htmlUrl
