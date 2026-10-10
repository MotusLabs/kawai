// updateChecker.ts - periodic update discovery. One checker per process
// polls the release feed on startup and on a long timer (the GitHub API is
// rate-limited to 60 unauthenticated requests per hour), compares base
// versions, and reports changes through `onChange` for broadcast. Every
// failure is silent: an unreachable API leaves the previous state alone and
// never surfaces an error in the UI.
import type { UpdateState } from '@shared/types'
import { BUILD_VERSION } from '../version'
import { createReleaseFeed, type ReleaseFeed } from './releaseFeed'
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
  stop(): void
}

export function startUpdateChecker(options: UpdateCheckerOptions = {}): UpdateChecker {
  const feed = options.feed ?? createReleaseFeed()
  const current = options.currentVersion ?? BUILD_VERSION
  const intervalMs = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS
  let state: UpdateState = { current, target: null }

  const check = async (): Promise<void> => {
    let release
    try {
      release = await feed.latest()
    } catch {
      return
    }
    if (release === null) return
    const target = isNewerBase(release.tag, current)
      ? { tag: release.tag, base: baseOf(release.tag) ?? release.tag, htmlUrl: release.htmlUrl }
      : null
    const next: UpdateState = { current, target }
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
    stop: () => clearInterval(timer),
  }
}

const sameTarget = (a: UpdateState['target'], b: UpdateState['target']): boolean =>
  a?.tag === b?.tag && a?.base === b?.base && a?.htmlUrl === b?.htmlUrl
