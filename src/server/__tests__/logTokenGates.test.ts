// Witness WG (bounded-log-reads D3 rows G0–G6): every evidence kind through
// the three real token gates — the worker's getEntriesNeedingMatch, the
// orphan gate, and the poller insert gate — with the state of both empty
// caches after each. The worker gates run at the generic minimums 0, 1, 2;
// the poller insert gate only at its fixed production minimum 1, where G6 is
// unreachable. Each row's log is exactly matchable through a non-role
// `content` field the token count ignores, so the gate alone decides.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { readLogTokenEvidence } from '../logmatch'
import { handleMatchWorkerRequest } from '../logMatchWorker'
import type { MatchWorkerRequest } from '../logMatchWorkerTypes'
import type { KnownSession } from '../logPollData'
import { assistantLine, claudeLogPath, fillerLine, FsObserver, matchMessage, PROJECT, WitnessEnv, writeChunked, type Part } from './helpers/logTokenHarness'

type Row = 'U' | 'K' | 'P0' | 'P1' | 'C0' | 'C1'
const ROWS: Row[] = ['U', 'K', 'P0', 'P1', 'C0', 'C1']
const KiB = 1024
const SESSION = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

let env: WitnessEnv
let logs: Record<Row, { logPath: string; tmuxWindow: string; sessionId: string }>

/** Evidence each row's reader observes, and the U row's injected stat failure. */
const EVIDENCE: Record<Row, { kind: string; count?: number }> = {
  U: { kind: 'unavailable' }, K: { kind: 'known' }, P0: { kind: 'partial', count: 0 },
  P1: { kind: 'partial', count: 1 }, C0: { kind: 'complete', count: 0 }, C1: { kind: 'complete', count: 1 },
}

function layout(row: Row, n: number, message: string): Part[] {
  const meta = `${JSON.stringify({ type: 'summary', sessionId: SESSION(n), cwd: PROJECT })}\n`
  const findable = `${JSON.stringify({ type: 'progress', content: message })}\n`
  switch (row) {
    case 'C0': return [meta, findable]
    case 'U': case 'K': case 'C1': return [meta, findable, assistantLine('ok')]
    case 'P0': return [meta, ...fillerLine(300 * KiB), findable, ...fillerLine(300 * KiB), ...fillerLine(200)]
    case 'P1': return [meta, ...fillerLine(300 * KiB), findable, ...fillerLine(300 * KiB), assistantLine('ok')]
  }
}

beforeEach(() => {
  env = new WitnessEnv()
  logs = {} as typeof logs
  ROWS.forEach((row, i) => {
    const n = i + 1
    const message = matchMessage(`gate${row.toLowerCase()}x`)
    const { tmuxWindow } = env.showWindow(n, message)
    const logPath = claudeLogPath(`wg-${row}`)
    writeChunked(logPath, layout(row, n, message))
    logs[row] = { logPath, tmuxWindow, sessionId: SESSION(n) }
  })
})

afterEach(() => {
  env.dispose()
})

/** Runs `fn` with the U row's bigint fstat (the token reader's) failing. */
async function withUnavailableRow<T>(fn: () => Promise<T>): Promise<T> {
  const observer = new FsObserver().start()
  observer.mapFstat = (stats, file) => {
    if (file === logs.U.logPath && typeof stats.size === 'bigint') throw new Error('EIO')
    return stats
  }
  try {
    return await fn()
  } finally {
    observer.stop()
  }
}

/** The reader cache holds `logPath` iff a further read returns without reading content. */
function readerCacheHolds(logPath: string): boolean {
  const observer = new FsObserver().start()
  try {
    readLogTokenEvidence(logPath, { agentType: 'claude' })
  } finally {
    observer.stop()
  }
  return !observer.for(logPath).some((op) => op.api === 'read')
}

async function worker(request: Partial<MatchWorkerRequest>) {
  const response = await withUnavailableRow(() => handleMatchWorkerRequest({
    id: 'wg', windows: env.registry.getAll() as MatchWorkerRequest['windows'], maxLogsPerPoll: 50, sessions: [], scrollbackLines: 25, ...request,
  }))
  if (response.type !== 'result') throw new Error(`worker error: ${JSON.stringify(response)}`)
  return response
}

const pathsOf = (matches: Array<{ logPath: string }> | undefined) => new Set((matches ?? []).map((m) => m.logPath))

function expectMatched(matched: Set<string>, rows: Row[], expected: Row[]) {
  for (const row of rows) expect([row, matched.has(logs[row].logPath)]).toEqual([row, expected.includes(row)])
}

describe('WG: the worker gates at generic minimums', () => {
  const PASSING: Record<number, Row[]> = { 2: ['K', 'P0', 'P1'], 1: ['K', 'P0', 'P1', 'C1'], 0: ['K', 'P0', 'P1', 'C0', 'C1'] }

  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Partial evidence stays eligible
  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Complete zero
  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Complete positive below a generic minimum
  test('getEntriesNeedingMatch: G0 U never, G1 K as today, G2 P always, G3–G6 C by minimum', async () => {
    const known: KnownSession = {
      logFilePath: logs.K.logPath, sessionId: logs.K.sessionId, projectPath: PROJECT, slug: 'kept', agentType: 'claude', isCodexExec: false,
    }
    // G6 first: C(1) rejected at 2; the same unchanged file then passes at 1.
    for (const minimum of [2, 1, 0]) {
      const response = await worker({ minTokensForMatch: minimum, knownSessions: [known] })
      const evidence = new Map((response.entries ?? []).map((e) => [e.logPath, e.tokenEvidence]))
      for (const row of ROWS) expect([row, evidence.get(logs[row].logPath)]).toMatchObject([row, EVIDENCE[row]])
      expectMatched(pathsOf(response.matches), ROWS, PASSING[minimum] as Row[])
      // Reader cache: only the stable complete zero, at every minimum.
      for (const row of ROWS) expect([row, minimum, readerCacheHolds(logs[row].logPath)]).toEqual([row, minimum, row === 'C0'])
    }
  })

  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Partial evidence stays eligible
  test('orphan gate: a recorded orphan is re-read (never K) and gated by the same rows', async () => {
    const orphanRows: Row[] = ['U', 'P0', 'P1', 'C0', 'C1']
    const orphanCandidates = orphanRows.map((row) => ({
      sessionId: logs[row].sessionId, logFilePath: logs[row].logPath, projectPath: PROJECT, agentType: 'claude' as const, currentWindow: null,
    }))
    const PASSING: Record<number, Row[]> = { 2: ['P0', 'P1'], 1: ['P0', 'P1', 'C1'], 0: ['P0', 'P1', 'C0', 'C1'] }
    for (const minimum of [2, 1, 0]) {
      const response = await worker({
        minTokensForMatch: minimum, forceOrphanRematch: true, orphanCandidates,
        // No collected entries: only the orphan gate can admit a log.
        preFilteredPaths: [claudeLogPath('absent')],
      })
      expect(response.entries ?? []).toEqual([])
      const admitted = new Map((response.orphanEntries ?? []).map((e) => [e.logPath, e.tokenEvidence]))
      expectMatched(new Set(admitted.keys()), orphanRows, PASSING[minimum] as Row[])
      for (const evidence of admitted.values()) expect(evidence.kind).not.toBe('known')
      expectMatched(pathsOf(response.orphanMatches), orphanRows, PASSING[minimum] as Row[])
      for (const row of orphanRows) expect([row, readerCacheHolds(logs[row].logPath)]).toEqual([row, row === 'C0'])
    }
  })
})

describe('WG: the poller insert gate at the production minimum 1', () => {
  // @covers: terminal-streaming › Token evidence distinguishes complete from partial observations › Missing log
  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Complete zero
  test('U waits a poll, K stays as today, P and C(1) insert, C(0) is rejected as empty and cached', async () => {
    const now = '2026-10-28T00:00:00.000Z'
    env.db.insertSession({
      sessionId: logs.K.sessionId, logFilePath: logs.K.logPath, projectPath: PROJECT, slug: null, agentType: 'claude',
      displayName: 'known', createdAt: now, lastActivityAt: now, lastUserMessage: null, currentWindow: logs.K.tmuxWindow,
      isPinned: false, lastResumeError: null, lastKnownLogSize: 0, isCodexExec: false, launchCommand: null,
    })
    const { poller, emptyLogCache } = env.poller()
    await withUnavailableRow(() => poller.pollOnce())

    const inserted = (row: Row) => env.db.getSessionByLogPath(logs[row].logPath)
    // G0: no insert this poll; G1: the known row is neither re-inserted nor moved.
    expect(inserted('U')).toBeNull()
    expect(inserted('K')?.sessionId).toBe(logs.K.sessionId)
    expect(inserted('K')?.currentWindow).toBe(logs.K.tmuxWindow)
    // G2 and G4: eligible, exact-matched, inserted.
    for (const row of ['P0', 'P1', 'C1'] as Row[]) {
      expect([row, inserted(row)?.sessionId, inserted(row)?.currentWindow]).toEqual([row, logs[row].sessionId, logs[row].tmuxWindow])
    }
    // G5: rejected as empty.
    expect(inserted('C0')).toBeNull()
    // Both caches hold exactly the complete zero.
    expect([...emptyLogCache.keys()]).toEqual([logs.C0.logPath])
    for (const row of ROWS) expect([row, readerCacheHolds(logs[row].logPath)]).toEqual([row, row === 'C0'])

    // The unavailable log is reconsidered once readable; the cached zero
    // stays rejected by the current gate.
    await poller.pollOnce()
    expect(inserted('U')?.currentWindow).toBe(logs.U.tmuxWindow)
    expect(inserted('C0')).toBeNull()
    expect([...emptyLogCache.keys()]).toEqual([logs.C0.logPath])
    expect(fs.existsSync(logs.C0.logPath)).toBe(true)
  })
})
