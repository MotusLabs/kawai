// Witness WC (bounded-log-reads D3): the two empty caches — the poller's
// emptyLogCache and the token reader's own — through the real poller, the
// real match worker, and the real reader. Each row asserts the cache states
// themselves: the poller map directly, the reader cache by whether a further
// read reads content (a reuse opens and stats but reads nothing).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { readLogTokenEvidence } from '../logmatch'
import { handleMatchWorkerRequest } from '../logMatchWorker'
import type { MatchWorkerRequest } from '../logMatchWorkerTypes'
import { assistantLine, claudeLogPath, fillerLine, FsObserver, matchMessage, PROJECT, WitnessEnv, writeChunked, type Part } from './helpers/logTokenHarness'

const KiB = 1024
const SESSION = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const READ_KEY = 'claude|assistant-user|w=204800|lines=2000'
const MTIME = 1_800_000_000

let env: WitnessEnv

beforeEach(() => {
  env = new WitnessEnv()
})

afterEach(() => {
  env.dispose()
})

const meta = (n: number) => `${JSON.stringify({ type: 'summary', sessionId: SESSION(n), cwd: PROJECT })}\n`
/** Exactly matchable through a non-role field that counts no tokens. */
const findable = (message: string) => `${JSON.stringify({ type: 'progress', content: message })}\n`

/**
 * Reads `logPath` under the observer; `reused` when no content was read by
 * any API: no positioned read of it and no whole-file or streaming call.
 */
function probe(logPath: string, opts = {}, setup?: (o: FsObserver) => void) {
  const observer = new FsObserver().start()
  setup?.(observer)
  try {
    const evidence = readLogTokenEvidence(logPath, { agentType: 'claude', ...opts })
    const reads = observer.for(logPath).filter((op) => op.api === 'read')
    return { evidence, reused: reads.length === 0 && observer.wholeFileCalls().length === 0, bytes: observer.bytesRead(logPath), wholeFile: observer.wholeFileCalls() }
  } finally {
    observer.stop()
  }
}

/** A C(0) log rejected and cached by one production poll. */
async function cachedZero(n: number) {
  const message = matchMessage(`cache${n}x`)
  const { tmuxWindow } = env.showWindow(n, message)
  const logPath = claudeLogPath(`wc-${n}`)
  const size = writeChunked(logPath, [meta(n), findable(message), ...fillerLine(500)])
  fs.utimesSync(logPath, MTIME, MTIME)
  const ctx = env.poller()
  await ctx.poller.pollOnce()
  expect(env.db.getSessionByLogPath(logPath)).toBeNull()
  const key = ctx.emptyLogCache.get(logPath)
  expect(key).toEndWith(`|${READ_KEY}`)
  expect(probe(logPath).reused).toBe(true)
  return { ...ctx, logPath, tmuxWindow, message, size, key: key as string }
}

/** The C(1) layout of the same size as `cachedZero`'s. */
function positiveSameSize(n: number, message: string): Part[] {
  const ok = assistantLine('ok')
  return [meta(n), findable(message), ok, ...fillerLine(500 - Buffer.byteLength(ok))]
}

describe('WC: empty-cache composition through the real poller and reader', () => {
  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › No session id yet
  test('WC1: a log with no session id writes no cache entry and is reconsidered once its id appears', async () => {
    const message = matchMessage('noid')
    const { tmuxWindow } = env.showWindow(1, message)
    const small = claudeLogPath('wc1-small')
    writeChunked(small, [findable(message), ...fillerLine(500)])
    const large = claudeLogPath('wc1-large')
    writeChunked(large, [findable(matchMessage('noidlarge')), ...fillerLine(300 * KiB), ...fillerLine(300 * KiB)])
    const { poller, emptyLogCache } = env.poller()
    await poller.pollOnce()
    for (const logPath of [small, large]) {
      expect(env.db.getSessionByLogPath(logPath)).toBeNull()
      expect(emptyLogCache.has(logPath)).toBe(false)
    }
    // Not counted without an id: the reader never ran, so it holds nothing.
    expect(probe(small).reused).toBe(false)

    // The id appears with appended content that makes the log partial.
    writeChunked(small, [meta(1), ...fillerLine(300 * KiB), ...fillerLine(300 * KiB), ...fillerLine(200)], 'a')
    await poller.pollOnce()
    expect(env.db.getSessionByLogPath(small)?.sessionId).toBe(SESSION(1))
    expect(env.db.getSessionByLogPath(small)?.currentWindow).toBe(tmuxWindow)
    expect(emptyLogCache.has(small)).toBe(false)
  })

  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Same-size rewrite
  test('WC2: a same-size rewrite with the mtime restored is re-read, not reused', async () => {
    const zero = await cachedZero(2)
    const before = fs.statSync(zero.logPath, { bigint: true })
    expect(writeChunked(zero.logPath, positiveSameSize(2, zero.message))).toBe(zero.size)
    fs.utimesSync(zero.logPath, MTIME, MTIME)
    const after = fs.statSync(zero.logPath, { bigint: true })
    expect([after.size, after.mtimeNs, after.ino]).toEqual([before.size, before.mtimeNs, before.ino])
    expect(after.ctimeNs).not.toBe(before.ctimeNs)

    const reread = probe(zero.logPath)
    expect(reread.reused).toBe(false)
    expect(reread.evidence).toMatchObject({ kind: 'complete', count: 1 })
    await zero.poller.pollOnce()
    expect(env.db.getSessionByLogPath(zero.logPath)?.currentWindow).toBe(zero.tmuxWindow)
    expect(zero.emptyLogCache.has(zero.logPath)).toBe(false)
  })

  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Same-size rewrite
  test('WC3: a replacement at the same path is re-read even with identical bytes and mtime', async () => {
    const zero = await cachedZero(3)
    const ino = fs.statSync(zero.logPath).ino
    const staged = `${zero.logPath}.tmp`
    writeChunked(staged, [meta(3), findable(zero.message), ...fillerLine(500)])
    fs.utimesSync(staged, MTIME, MTIME)
    fs.renameSync(staged, zero.logPath)
    expect(fs.statSync(zero.logPath).ino).not.toBe(ino)

    await zero.poller.pollOnce()
    // Still a complete zero, now under the new identity: re-admitted, not reused.
    const key = zero.emptyLogCache.get(zero.logPath)
    expect(key).toBeDefined()
    expect(key).not.toBe(zero.key)
    expect(key).toContain(`:${fs.statSync(zero.logPath).ino}:`)
    expect(env.db.getSessionByLogPath(zero.logPath)).toBeNull()
  })

  test('WC4: a cached zero is not reused under another mode or other options', async () => {
    const zero = await cachedZero(4)
    expect(probe(zero.logPath, { mode: 'user' }).reused).toBe(false)
    expect(probe(zero.logPath, { logRead: { lineLimit: 10 } }).reused).toBe(false)
    expect(probe(zero.logPath, { agentType: 'codex' }).reused).toBe(false)
    // Back under the poller's key: re-read once, then reused again.
    expect(probe(zero.logPath).reused).toBe(false)
    expect(probe(zero.logPath).reused).toBe(true)
    // The poller's entry carries the full read key, so it is mode- and option-specific too.
    expect(zero.key).toEndWith(`|${READ_KEY}`)
  })

  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Complete zero
  test('WC5: a cached zero is C(0) for the current gate: it passes at minimum 0, no unconditional skip', async () => {
    const zero = await cachedZero(5)
    const observer = new FsObserver().start()
    let response
    try {
      response = await handleMatchWorkerRequest({
        id: 'wc5', windows: env.registry.getAll() as MatchWorkerRequest['windows'], maxLogsPerPoll: 50, sessions: [],
        scrollbackLines: 25, minTokensForMatch: 0,
      })
    } finally {
      observer.stop()
    }
    if (response.type !== 'result') throw new Error('worker error')
    expect(response.entries?.find((e) => e.logPath === zero.logPath)?.tokenEvidence).toMatchObject({ kind: 'complete', count: 0 })
    // Served from the reader cache: the token reader's generation stat ran
    // once (a content read stats before and after), so it read nothing.
    expect(observer.for(zero.logPath).filter((op) => op.bigint)).toHaveLength(1)
    expect(response.matches).toContainEqual({ logPath: zero.logPath, tmuxWindow: zero.tmuxWindow })
    // At the production minimum the same cached zero is rejected again.
    await zero.poller.pollOnce()
    expect(env.db.getSessionByLogPath(zero.logPath)).toBeNull()
  })

  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Complete positive below a generic minimum
  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Partial evidence stays eligible
  test('WC6: C(1) rejected at minimum 2, and P(n), are held by neither cache', async () => {
    const one = claudeLogPath('wc6-one')
    writeChunked(one, positiveSameSize(6, matchMessage('wcsix')))
    env.showWindow(6, matchMessage('wcsix'))
    const partial = claudeLogPath('wc6-partial')
    writeChunked(partial, [meta(7), findable(matchMessage('wcseven')), ...fillerLine(300 * KiB), ...fillerLine(300 * KiB)])
    const response = await handleMatchWorkerRequest({
      id: 'wc6', windows: env.registry.getAll() as MatchWorkerRequest['windows'], maxLogsPerPoll: 50, sessions: [],
      scrollbackLines: 25, minTokensForMatch: 2,
    })
    if (response.type !== 'result') throw new Error('worker error')
    expect(response.matches ?? []).toEqual([])
    expect(probe(one).reused).toBe(false)
    expect(probe(partial).reused).toBe(false)
    const { poller, emptyLogCache } = env.poller()
    await poller.pollOnce()
    expect(emptyLogCache.size).toBe(0)
    expect(env.db.getSessionByLogPath(partial)?.sessionId).toBe(SESSION(7))
    expect(probe(partial).reused).toBe(false)
  })

  test('WC7: an unestablishable generation is neither cached nor reused, and every read stays bounded', async () => {
    const zero = await cachedZero(8)
    const invalid = (o: FsObserver) => {
      o.mapFstat = (stats) => (typeof stats.size === 'bigint'
        ? Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { ino: 0n })
        : stats)
    }
    for (let i = 0; i < 2; i++) {
      const r = probe(zero.logPath, {}, invalid)
      expect(r.reused).toBe(false)
      expect(r.evidence).toEqual({ kind: 'partial', count: 0, generation: null, readKey: READ_KEY })
      expect(r.bytes).toBeLessThanOrEqual(409_601)
      expect(r.wholeFile).toEqual([])
    }
    // The invalid read dropped the entry: a valid read re-reads, then re-admits.
    expect(probe(zero.logPath).reused).toBe(false)
    expect(probe(zero.logPath).reused).toBe(true)

    // Through the poller: never written, and the partial log stays eligible.
    zero.emptyLogCache.clear()
    const observer = new FsObserver().start()
    invalid(observer)
    try {
      await zero.poller.pollOnce()
    } finally {
      observer.stop()
    }
    expect(zero.emptyLogCache.has(zero.logPath)).toBe(false)
    expect(env.db.getSessionByLogPath(zero.logPath)?.currentWindow).toBe(zero.tmuxWindow)
  })
})
