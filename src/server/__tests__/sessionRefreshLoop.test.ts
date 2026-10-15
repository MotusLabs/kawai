// Unit tests for the async refresh cycle's error containment (PR #123 CI): a
// hydration/DB error — SQLITE_BUSY from a concurrent seeding connection —
// must end the cycle with a session_refresh_hydrate_failed warning, never
// fall back to the sync tmux listing, and never reject: refreshSessions()
// fires the cycle with void, so an escaping throw was an unhandled rejection
// that killed the server. A worker failure must still fall back.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { logger } from '../logger'
import { SessionRegistry } from '../SessionRegistry'
import { SessionRefreshLoop } from '../refresh/SessionRefreshLoop'
import { SessionRefreshWorkerTimeoutError } from '../sessionRefreshWorkerClient'
import type { SessionRefreshWorkerClient } from '../sessionRefreshWorkerClient'
import type { SessionDatabase } from '../db'
import type { SessionManager } from '../SessionManager'
import type { TerminalSession } from '../../shared/types'
import { isTerminalSession } from '../../shared/types'

const baseTimestamp = new Date('2026-06-01T00:00:00.000Z').toISOString()

interface Recorded {
  workerRefreshCalls: number
  listWindowsCalls: number
}

interface Harness {
  loop: SessionRefreshLoop
  registry: SessionRegistry
  recorded: Recorded
}

function makeTerminalSession(tmuxWindow: string): TerminalSession {
  return {
    id: tmuxWindow,
    name: tmuxWindow,
    tmuxWindow,
    projectPath: '/tmp/project',
    status: 'unknown',
    lastActivity: baseTimestamp,
    createdAt: baseTimestamp,
    source: 'managed',
  }
}

/**
 * Build the loop around stubs: a worker refresh and a sync listWindows that
 * record their calls, and a db whose getActiveSessions (the first statement
 * hydrateSessionsWithAgentSessions runs) either returns [] or throws, which
 * is exactly where the CI SQLITE_BUSY landed.
 */
function makeHarness(options: {
  workerRefresh?: () => Promise<TerminalSession[]>
  dbActiveSessions?: () => ReturnType<SessionDatabase['getActiveSessions']>
} = {}): Harness {
  const registry = new SessionRegistry()
  const recorded: Recorded = { workerRefreshCalls: 0, listWindowsCalls: 0 }

  const db = {
    getActiveSessions: options.dbActiveSessions ?? (() => []),
    getHibernatingSessions: () => [],
    getHistorySessions: () => [],
  } as unknown as SessionDatabase

  const sessionManager = {
    ensureSession: () => {},
    listWindows: () => {
      recorded.listWindowsCalls += 1
      return [makeTerminalSession('agentboard:fallback')]
    },
    killWindow: () => {},
  } as unknown as SessionManager

  const workerRefresh =
    options.workerRefresh ?? (async () => [makeTerminalSession('agentboard:worker')])
  const sessionRefreshWorker = {
    refresh: async () => {
      recorded.workerRefreshCalls += 1
      return workerRefresh()
    },
  } as unknown as SessionRefreshWorkerClient

  const loop = new SessionRefreshLoop({
    db,
    registry,
    sessionManager,
    sessionRefreshWorker,
    lastUserMessageWorker: {} as unknown as SessionRefreshWorkerClient,
    broadcast: () => {},
    mergeRemoteSessions: (sessions) => sessions,
    historyMaxAgeHours: () => 24,
  })

  return { loop, registry, recorded }
}

/** The cycle is private; call it directly so a rejection fails the test. */
function runRefresh(loop: SessionRefreshLoop): Promise<void> {
  return (loop as unknown as { refreshSessionsAsync: () => Promise<void> }).refreshSessionsAsync()
}

function windows(harness: Harness): string[] {
  return harness.registry
    .getAll()
    .map((session) => (isTerminalSession(session) ? session.tmuxWindow : session.id))
}

let warnings: Array<{ event: string; data?: Record<string, unknown> }>
const originalWarn = logger.warn

beforeEach(() => {
  warnings = []
  logger.warn = (event: string, data?: Record<string, unknown>) => {
    warnings.push({ event, data })
  }
})

afterEach(() => {
  logger.warn = originalWarn
})

describe('SessionRefreshLoop.refreshSessionsAsync — error containment', () => {
  test('a hydration DB error on the worker path resolves, warns, and skips the sync fallback', async () => {
    const harness = makeHarness({
      dbActiveSessions: () => {
        throw new Error('database is locked')
      },
    })

    await runRefresh(harness.loop)

    const hydrateWarning = warnings.find((w) => w.event === 'session_refresh_hydrate_failed')
    expect(hydrateWarning?.data).toMatchObject({ source: 'worker', message: 'database is locked' })
    expect(warnings.some((w) => w.event === 'session_refresh_worker_error')).toBe(false)
    expect(harness.recorded.listWindowsCalls).toBe(0)
    expect(harness.registry.getAll()).toEqual([])
  })

  test('a later refresh runs after a failed cycle, so refreshInFlight was reset', async () => {
    let throwOnce = true
    const harness = makeHarness({
      dbActiveSessions: () => {
        if (throwOnce) {
          throwOnce = false
          throw new Error('database is locked')
        }
        return []
      },
    })

    await runRefresh(harness.loop)
    expect(harness.recorded.workerRefreshCalls).toBe(1)

    await runRefresh(harness.loop)
    expect(harness.recorded.workerRefreshCalls).toBe(2)
    expect(windows(harness)).toEqual(['agentboard:worker'])
  })

  test('a worker failure still falls back to the sync listing', async () => {
    const harness = makeHarness({
      workerRefresh: async () => {
        throw new Error('worker exploded')
      },
    })

    await runRefresh(harness.loop)

    expect(warnings.some((w) => w.event === 'session_refresh_worker_error')).toBe(true)
    expect(harness.recorded.listWindowsCalls).toBe(1)
    expect(windows(harness)).toEqual(['agentboard:fallback'])
    expect(warnings.some((w) => w.event === 'session_refresh_hydrate_failed')).toBe(false)
  })

  test('a hydration DB error on the fallback path ends the cycle without throwing', async () => {
    const harness = makeHarness({
      workerRefresh: async () => {
        throw new Error('worker exploded')
      },
      dbActiveSessions: () => {
        throw new Error('database is locked')
      },
    })

    await runRefresh(harness.loop)

    const hydrateWarning = warnings.find((w) => w.event === 'session_refresh_hydrate_failed')
    expect(hydrateWarning?.data).toMatchObject({ source: 'fallback', message: 'database is locked' })
    expect(harness.recorded.listWindowsCalls).toBe(1)
    expect(harness.registry.getAll()).toEqual([])
  })

  test('a worker timeout skips the sync fallback', async () => {
    const harness = makeHarness({
      workerRefresh: async () => {
        throw new SessionRefreshWorkerTimeoutError()
      },
    })

    await runRefresh(harness.loop)

    expect(harness.recorded.listWindowsCalls).toBe(0)
    expect(warnings.some((w) => w.event === 'session_refresh_sync_fallback_skipped')).toBe(true)
    expect(harness.registry.getAll()).toEqual([])
  })

  test('an optimistic mutation during the worker refresh retries once', async () => {
    let first = true
    const harness = makeHarness({
      workerRefresh: async () => {
        if (first) {
          first = false
          harness.loop.noteOptimisticMutation()
        }
        return [makeTerminalSession('agentboard:worker')]
      },
    })

    await runRefresh(harness.loop)

    expect(harness.recorded.workerRefreshCalls).toBe(2)
    expect(windows(harness)).toEqual(['agentboard:worker'])
  })

  test('the fire-and-forget refreshSessions() leaves no unhandled rejection when hydration fails', async () => {
    const harness = makeHarness({
      dbActiveSessions: () => {
        throw new Error('database is locked')
      },
    })
    let unhandled: unknown = null
    const onUnhandled = (reason: unknown) => {
      unhandled = reason
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      harness.loop.refreshSessions()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toBe(null)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
