// Regression test for the orphan-judgment bug in hydrateSessionsWithAgentSessions.
//
// Symptom observed in production: when the tmux-query path that produces the
// `sessions` argument transiently returns an empty array (e.g. the tmux server
// is briefly unresponsive or a parse path returns []), every active session in
// the DB is treated as orphaned because `windowSet.size === 0` and none of the
// DB-recorded `currentWindow` values can match. The post-orphan branch then
// calls `sessionManager.killWindow(currentWindow)` for each, deleting all of
// the user's working tmux windows in one pass.
//
// This test reproduces that case with directly-constructed dependencies (no
// server boot): a real temp DB seeded with active sessions pointing at tmux
// windows, a stub sessionManager that records kill-window calls, and a call to
// hydrateSessionsWithAgentSessions with an empty `sessions` array.
//
// Expected behaviour: no kill-window call is issued.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { hydrateSessionsWithAgentSessions } from '../refresh/hydrateSessions'
import type { HydrateSessionsDeps } from '../refresh/hydrateSessions'
import type { SessionManager } from '../SessionManager'
import type { ServerMessage } from '../../shared/types'

const killWindowCalls: string[] = []
const broadcastCalls: ServerMessage[] = []

function makeDeps(dbPath: string): HydrateSessionsDeps {
  return {
    db: initDatabase({ path: dbPath }),
    sessionManager: {
      killWindow: (window: string) => {
        killWindowCalls.push(window)
      },
    } as unknown as SessionManager,
    broadcast: (message) => {
      broadcastCalls.push(message)
    },
    updateDormantAgentSessions: () => {},
    updateActiveAgentSessions: () => {},
  }
}

describe('hydrateSessionsWithAgentSessions — empty windowSet guard', () => {
  let tempDir: string
  let tempDbPath: string
  let deps: HydrateSessionsDeps

  function closeDeps() {
    ;(deps.db as unknown as { db: { close: () => void } }).db.close()
  }

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-hydrate-empty-guard-'))
    tempDbPath = path.join(tempDir, 'agentboard.db')
    deps = makeDeps(tempDbPath)
  })

  afterAll(() => {
    closeDeps()
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  beforeEach(() => {
    // Reopen a fresh handle so each test starts from a known state.
    closeDeps()
    deps = makeDeps(tempDbPath)
    ;(deps.db as unknown as { db: { exec: (sql: string) => void } })
      .db.exec('DELETE FROM agent_sessions')
    killWindowCalls.length = 0
    broadcastCalls.length = 0
  })

  function seedActiveSession(sessionId: string, currentWindow: string, displayName: string) {
    const now = new Date('2026-05-19T07:11:00.000Z').toISOString()
    const logPath = path.join(tempDir, `${sessionId}.jsonl`)
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, '')
    }
    deps.db.insertSession({
      sessionId,
      logFilePath: logPath,
      projectPath: path.join(tempDir, sessionId),
      slug: null,
      agentType: 'claude',
      displayName,
      createdAt: now,
      lastActivityAt: now,
      lastUserMessage: null,
      currentWindow,
      isPinned: false,
      lastResumeError: null,
      wakeStartedAt: null,
      lastKnownLogSize: null,
      isCodexExec: false,
      launchCommand: null,
    })
  }

  test('does NOT call killWindow when sessions=[] but DB has active sessions', () => {
    expect(typeof hydrateSessionsWithAgentSessions).toBe('function')

    // Seed: 5 active sessions, each currently bound to a live tmux window.
    for (let i = 1; i <= 5; i++) {
      seedActiveSession(`test-session-${i}`, `target:@${100 + i}`, `proj-${i}`)
    }

    // Sanity: confirm the SUT can see the seeded rows.
    expect(deps.db.getActiveSessions()).toHaveLength(5)

    // Simulate the transient tmux-query failure that motivated this regression:
    // listWindows() returned an empty Session[] even though the DB still has
    // multiple active sessions pointing at live tmux windows.
    const result = hydrateSessionsWithAgentSessions(deps, [])

    expect(killWindowCalls).toHaveLength(0)
    expect(broadcastCalls).toHaveLength(0)
    expect(result).toEqual([])

    // DB rows must be preserved: a future regression could skip the kill but
    // still call db.orphanSession() and clear current_window. Pin both.
    const activeAfter = deps.db.getActiveSessions()
    expect(activeAfter).toHaveLength(5)
    const windowsAfter = activeAfter.map((s) => s.currentWindow).sort()
    expect(windowsAfter).toEqual(
      Array.from({ length: 5 }, (_, i) => `target:@${100 + i + 1}`).sort()
    )
  })

  test('does NOT skip or kill when both sessions=[] and DB is empty (negative case)', () => {
    // DB starts empty (beforeEach deletes everything). hydrate([]) should
    // proceed normally: no kill calls, no warn, no orphaning. This pins the
    // contract that the guard only fires when activeSessions > 0 — otherwise
    // an empty-DB / empty-input call could regress into accidentally skipping
    // legitimate empty refreshes.
    const result = hydrateSessionsWithAgentSessions(deps, [])

    expect(killWindowCalls).toHaveLength(0)
    expect(result).toEqual([])
  })
})
