// Unit tests for the wake claim-race branches (sessions/wake.ts), previously
// covered only end-to-end through the booted server. Uses the direct-
// dependency pattern from hydrateSessionsEmptyGuard.test.ts: a real temp DB,
// a stub sessionManager whose createWindow simulates the racing writer
// (LogPoller rematch or concurrent wake) that claims current_window between
// the handler's initial read and its claimCurrentWindow call, and recorders
// for broadcast/send/refresh.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerWebSocket } from 'bun'
import { initDatabase } from '../db'
import type { SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import type { SessionManager } from '../SessionManager'
import type { SessionRefreshLoop } from '../refresh/SessionRefreshLoop'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ServerMessage, TerminalSession, Session } from '../../shared/types'
import type { WSData } from '../ws/wsTypes'
import { handleSessionWake } from '../sessions/wake'
import type { SessionOpsContext } from '../sessions/context'

const baseTimestamp = new Date('2026-06-01T00:00:00.000Z').toISOString()

interface Harness {
  ctx: SessionOpsContext
  registry: SessionRegistry
  sent: ServerMessage[]
  broadcasts: ServerMessage[]
  killCalls: string[]
  refreshCalls: string[]
  createArgs: Array<{ projectPath: string; name?: string; command?: string }>
}

let tempDir: string
let db: SessionDatabase
let harness: Harness

function seedRecord(
  sessionId: string,
  overrides: Partial<Parameters<SessionDatabase['insertSession']>[0]> = {}
) {
  db.insertSession({
    sessionId,
    logFilePath: path.join(tempDir, `${sessionId}.jsonl`),
    projectPath: path.join(tempDir, sessionId),
    slug: null,
    agentType: 'claude',
    displayName: sessionId,
    createdAt: baseTimestamp,
    lastActivityAt: baseTimestamp,
    lastUserMessage: null,
    currentWindow: null,
    isPinned: true,
    lastResumeError: null,
    wakeStartedAt: null,
    lastKnownLogSize: null,
    isCodexExec: false,
    launchCommand: null,
    ...overrides,
  })
}

function makeSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 'created-session',
    name: 'created',
    tmuxWindow: 'agentboard:9',
    projectPath: '/tmp/project',
    status: 'unknown',
    lastActivity: baseTimestamp,
    createdAt: baseTimestamp,
    source: 'managed',
    ...overrides,
  }
}

/**
 * Build the ops context around the shared temp DB. `onCreate` runs inside the
 * sessionManager.createWindow stub — the point where the racing writer is
 * simulated (the handler has no await between its initial DB read and the
 * claim, so the race must be injected synchronously here).
 */
function makeHarness(
  onCreate?: (created: TerminalSession, registry: SessionRegistry) => void
): Harness {
  const registry = new SessionRegistry()
  const sent: ServerMessage[] = []
  const broadcasts: ServerMessage[] = []
  const killCalls: string[] = []
  const refreshCalls: string[] = []
  const createArgs: Array<{ projectPath: string; name?: string; command?: string }> = []

  const sessionManager = {
    createWindow: (projectPath: string, name?: string, command?: string) => {
      createArgs.push({ projectPath, name, command })
      const created = makeSession()
      onCreate?.(created, registry)
      return created
    },
    killWindow: (tmuxWindow: string) => {
      killCalls.push(tmuxWindow)
    },
    listWindows: () => [] as Session[],
  } as unknown as SessionManager

  const refresh = {
    refreshSessions: () => refreshCalls.push('refreshSessions'),
    refreshSessionsSync: () => refreshCalls.push('refreshSessionsSync'),
    updateDormantAgentSessions: () => refreshCalls.push('updateDormantAgentSessions'),
    noteOptimisticMutation: () => refreshCalls.push('noteOptimisticMutation'),
  } as unknown as SessionRefreshLoop

  const ctx: SessionOpsContext = {
    registry,
    db,
    sessionManager,
    refresh,
    chatSessionManager: {} as unknown as ChatSessionManager,
    broadcast: (message) => broadcasts.push(message),
    send: (_ws, message) => sent.push(message),
    runRemoteTmux: () => {
      throw new Error('runRemoteTmux must not be reached by local wake paths')
    },
    remoteSessionNameOverrides: new Map(),
    remoteSessionTombstones: new Map(),
    wakeInFlight: new Set(),
  }

  return { ctx, registry, sent, broadcasts, killCalls, refreshCalls, createArgs }
}

const ws = { data: { connectionId: 'wake-unit' } } as unknown as ServerWebSocket<WSData>

async function wake(sessionId: string) {
  await handleSessionWake(harness.ctx, { type: 'session-wake', sessionId }, ws)
}

function wakeResult() {
  return harness.sent.find((message) => message.type === 'session-wake-result')
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-wake-claim-race-'))
})

beforeEach(() => {
  if (db) {
    ;(db as unknown as { db: { close: () => void } }).db.close()
  }
  db = initDatabase({ path: path.join(tempDir, 'agentboard.db') })
  // Reopen on the shared path: clear rows so each test starts from a known state.
  ;(db as unknown as { db: { exec: (sql: string) => void } }).db.exec('DELETE FROM agent_sessions')
})

afterAll(() => {
  if (db) {
    ;(db as unknown as { db: { close: () => void } }).db.close()
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('handleSessionWake — claim races', () => {
  test('uncontended claim succeeds and broadcasts activation', async () => {
    seedRecord('wake-ok', { displayName: 'resume-me' })
    harness = makeHarness()

    await wake('wake-ok')

    expect(harness.createArgs).toEqual([
      {
        projectPath: path.join(tempDir, 'wake-ok'),
        name: 'resume-me',
        command: 'claude --resume wake-ok',
      },
    ])
    expect(wakeResult()).toMatchObject({
      type: 'session-wake-result',
      sessionId: 'wake-ok',
      ok: true,
      session: expect.objectContaining({
        tmuxWindow: 'agentboard:9',
        agentSessionId: 'wake-ok',
      }),
    })
    expect(harness.broadcasts).toContainEqual(
      expect.objectContaining({ type: 'session-activated', window: 'agentboard:9' })
    )
    expect(harness.killCalls).toEqual([])
    expect(db.getSessionById('wake-ok')).toMatchObject({
      currentWindow: 'agentboard:9',
      wakeStartedAt: null,
      lastResumeError: null,
    })
    expect(harness.registry.getAll()).toMatchObject([
      expect.objectContaining({ id: 'created-session', agentSessionId: 'wake-ok' }),
    ])
  })

  test('keeps the created window when our own rematch claims it mid-flight', async () => {
    seedRecord('wake-own-race')
    // The racing writer (a rematch of this same session) claims exactly the
    // window we just created before our claim runs.
    harness = makeHarness((created) => {
      db.updateSession('wake-own-race', { currentWindow: created.tmuxWindow })
    })

    await wake('wake-own-race')

    expect(harness.killCalls).toEqual([])
    expect(wakeResult()).toMatchObject({
      sessionId: 'wake-own-race',
      ok: true,
      session: expect.objectContaining({ tmuxWindow: 'agentboard:9' }),
    })
    expect(harness.broadcasts).toContainEqual(
      expect.objectContaining({ type: 'session-activated' })
    )
    expect(db.getSessionById('wake-own-race')).toMatchObject({
      currentWindow: 'agentboard:9',
      wakeStartedAt: null,
      lastResumeError: null,
    })
  })

  test('keeps the created window and defers when another session claims it', async () => {
    seedRecord('wake-other-owner')
    seedRecord('other-owner')
    // A different session's wake/rematch claims our freshly created window.
    harness = makeHarness((created) => {
      db.updateSession('other-owner', { currentWindow: created.tmuxWindow })
    })

    await wake('wake-other-owner')

    expect(harness.killCalls).toEqual([])
    expect(wakeResult()).toMatchObject({
      sessionId: 'wake-other-owner',
      ok: false,
      error: {
        code: 'WAKE_IN_PROGRESS',
        message: 'Wake window was claimed by another session; retry shortly',
      },
    })
    // Our wake marker is cleared and the other owner keeps the window.
    expect(db.getSessionById('wake-other-owner')).toMatchObject({
      currentWindow: null,
      wakeStartedAt: null,
    })
    expect(db.getSessionById('other-owner')?.currentWindow).toBe('agentboard:9')
  })

  test('kills the created window and returns the racing live session', async () => {
    seedRecord('wake-lost-race')
    // A rematch claims a DIFFERENT window for this session; our claim fails,
    // the created window is killed, and the racing session is surfaced.
    const raced = makeSession({
      id: 'raced-session',
      tmuxWindow: 'agentboard:55',
      agentSessionId: 'wake-lost-race',
    })
    // The racing session surfaces only AFTER the rematch pass ran with an
    // empty registry (mirroring the end-to-end race), so the handler falls
    // through to createWindow and then loses the claim.
    harness = makeHarness((_created, registry) => {
      db.updateSession('wake-lost-race', { currentWindow: 'agentboard:55' })
      registry.replaceSessions([raced])
    })

    await wake('wake-lost-race')

    expect(harness.killCalls).toEqual(['agentboard:9'])
    expect(wakeResult()).toMatchObject({
      sessionId: 'wake-lost-race',
      ok: true,
      session: expect.objectContaining({ tmuxWindow: 'agentboard:55' }),
    })
    expect(db.getSessionById('wake-lost-race')?.currentWindow).toBe('agentboard:55')
    expect(harness.refreshCalls).toContain('refreshSessionsSync')
  })

  test('kills the created window and errors when the racer is not yet visible', async () => {
    seedRecord('wake-lost-race-hidden')
    harness = makeHarness(() => {
      db.updateSession('wake-lost-race-hidden', { currentWindow: 'agentboard:55' })
    })
    // The registry does not know about the racing window yet.

    await wake('wake-lost-race-hidden')

    expect(harness.killCalls).toEqual(['agentboard:9'])
    expect(wakeResult()).toMatchObject({
      sessionId: 'wake-lost-race-hidden',
      ok: false,
      error: {
        code: 'WAKE_IN_PROGRESS',
        message: 'Wake raced with another claim; retry shortly',
      },
    })
    expect(db.getSessionById('wake-lost-race-hidden')?.currentWindow).toBe('agentboard:55')
  })

  test('claim failure cleans up the created window and persists the error', async () => {
    seedRecord('wake-claim-throws')
    const originalClaim = db.claimCurrentWindow.bind(db)
    db.claimCurrentWindow = () => {
      throw new Error('db locked')
    }

    try {
      harness = makeHarness()
      await wake('wake-claim-throws')
    } finally {
      db.claimCurrentWindow = originalClaim
    }

    expect(harness.killCalls).toEqual(['agentboard:9'])
    expect(wakeResult()).toMatchObject({
      sessionId: 'wake-claim-throws',
      ok: false,
      error: { code: 'WAKE_FAILED', message: 'db locked' },
    })
    expect(db.getSessionById('wake-claim-throws')).toMatchObject({
      currentWindow: null,
      isPinned: true,
      lastResumeError: 'db locked',
    })
  })
})
