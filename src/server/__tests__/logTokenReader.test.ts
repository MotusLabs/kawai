// Witness WE (bounded-log-reads D2/D3): token evidence rows E1–E11 through
// the real token reader and enrichment, with the all-API observer. Expected
// counts come from the generated layout (words per message line and line
// offsets), never from the reader.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { enrichLogEntry, type KnownSession } from '../logPollData'
import { readLogTokenEvidence } from '../logmatch'
import { TOKEN_WINDOW_BYTES } from '../logmatch/tokenReader'
import type { TokenEvidence } from '../logTokenEvidence'
import {
  assistantLine, claudeLogPath, fillerLine, FsObserver, userLine, WitnessEnv, writeChunked, type Part,
} from './helpers/logTokenHarness'

const W = TOKEN_WINDOW_BYTES
const KiB = 1024
const META = { sessionId: '00000000-0000-4000-8000-000000000001', cwd: '/tmp/kawai-token-witness' }

let env: WitnessEnv
let seq = 0

beforeEach(() => {
  env = new WitnessEnv()
})

afterEach(() => {
  env.dispose()
})

/** `n` distinct lowercase words: their token count is exactly `n`. */
function words(n: number, tag = 'w'): string {
  return Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ')
}

function log(parts: Part[]): { logPath: string; size: number } {
  const logPath = claudeLogPath(`we-${seq++}`)
  return { logPath, size: writeChunked(logPath, parts) }
}

function read(logPath: string, setup?: (o: FsObserver) => void, opts = {}): { evidence: TokenEvidence; observer: FsObserver } {
  const observer = new FsObserver().start()
  setup?.(observer)
  try {
    return { evidence: readLogTokenEvidence(logPath, { agentType: 'claude', ...opts }), observer }
  } finally {
    observer.stop()
  }
}

/** The generation the reader must report, built from bigint stats here. */
function statGeneration(logPath: string) {
  const s = fs.statSync(logPath, { bigint: true })
  return { dev: String(s.dev), ino: String(s.ino), size: Number(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) }
}

/** One descriptor: open, fstat, positioned reads, fstat, close; no whole-file API. */
function expectBoundedOps(observer: FsObserver, logPath: string, reads: Array<{ position: number; length: number }>) {
  expect(observer.wholeFileCalls()).toEqual([])
  expect(observer.for(logPath).map((op) => op.api)).toEqual(['open', 'fstat', ...reads.map(() => 'read'), 'fstat', 'close'])
  expect(observer.for(logPath).filter((op) => op.api === 'read').map(({ position, length }) => ({ position, length }))).toEqual(reads)
  expect(observer.bytesRead(logPath)).toBeLessThanOrEqual(2 * W + 1)
}

describe('WE: token evidence through the real reader', () => {
  // @covers: terminal-streaming › Token evidence distinguishes complete from partial observations › Small log read completely
  test('E1/E2: a stable small log is complete with the exact count, zero included', () => {
    const e1 = log([userLine(words(5), META), assistantLine(words(7)), ...fillerLine(500)])
    const r1 = read(e1.logPath)
    expect(r1.evidence).toEqual({ kind: 'complete', count: 12, generation: statGeneration(e1.logPath), readKey: 'claude|assistant-user|w=204800|lines=2000' })
    expectBoundedOps(r1.observer, e1.logPath, [{ position: 0, length: e1.size }])

    const e2 = log([`${JSON.stringify({ type: 'summary', ...META })}\n`, ...fillerLine(4 * KiB)])
    const r2 = read(e2.logPath)
    expect(r2.evidence).toMatchObject({ kind: 'complete', count: 0, generation: statGeneration(e2.logPath) })
    // An empty file is a complete zero with no read at all.
    const empty = log([])
    const r3 = read(empty.logPath)
    expect(r3.evidence).toMatchObject({ kind: 'complete', count: 0 })
    expectBoundedOps(r3.observer, empty.logPath, [])
  })

  test('declared modes and role filtering are preserved', () => {
    const { logPath } = log([userLine(words(3, 'u'), META), assistantLine(words(4, 'a'))])
    expect(read(logPath, undefined, { mode: 'user' }).evidence).toMatchObject({ kind: 'complete', count: 3 })
    expect(read(logPath, undefined, { mode: 'assistant' }).evidence).toMatchObject({ kind: 'complete', count: 4 })
    // 'all' counts whitespace-separated tokens of each raw line.
    const raw = [userLine(words(3, 'u'), META), assistantLine(words(4, 'a'))]
    const expected = raw.reduce((sum, line) => sum + line.trim().split(/\s+/).length, 0)
    expect(read(logPath, undefined, { mode: 'all' }).evidence).toMatchObject({ kind: 'complete', count: expected })
  })

  // @covers: terminal-streaming › Token enrichment reads bounded windows › Large log read in windows
  test('E3/E4: a large log with message text in the tail or the head only is partial with that count', () => {
    // One read (size ≤ 2W + 1): the tail's lines count.
    const tailOne = log([...fillerLine(300 * KiB), userLine(words(5), META)])
    const r1 = read(tailOne.logPath)
    expect(r1.evidence).toMatchObject({ kind: 'partial', count: 5, generation: statGeneration(tailOne.logPath) })
    expectBoundedOps(r1.observer, tailOne.logPath, [{ position: 0, length: tailOne.size }])
    // Two reads: the head window and the tail window with one lookbehind byte.
    const tailTwo = log([...fillerLine(700 * KiB), userLine(words(6), META)])
    const r2 = read(tailTwo.logPath)
    expect(r2.evidence).toMatchObject({ kind: 'partial', count: 6 })
    expectBoundedOps(r2.observer, tailTwo.logPath, [{ position: 0, length: W }, { position: tailTwo.size - W - 1, length: W + 1 }])
    expect(r2.observer.bytesRead(tailTwo.logPath)).toBe(2 * W + 1)
    const head = log([userLine(words(7), META), ...fillerLine(700 * KiB)])
    expect(read(head.logPath).evidence).toMatchObject({ kind: 'partial', count: 7 })
  })

  // @covers: terminal-streaming › Token evidence distinguishes complete from partial observations › Message only outside the windows
  test('E5: no message text inside either window is P(0), never C(0)', () => {
    const none = log([...fillerLine(300 * KiB), ...fillerLine(300 * KiB)])
    expect(read(none.logPath).evidence).toMatchObject({ kind: 'partial', count: 0 })
    const between = log([...fillerLine(300 * KiB), userLine(words(9), META), ...fillerLine(300 * KiB)])
    expect(read(between.logPath).evidence).toMatchObject({ kind: 'partial', count: 0 })
  })

  test('overlapping windows count each line once', () => {
    // size 300 KiB: one read; the message line lies in both the head
    // (ends before W) and the tail (starts at or after size − W).
    const { logPath } = log([...fillerLine(150 * KiB), userLine(words(8), META), ...fillerLine(150 * KiB)])
    expect(read(logPath).evidence).toMatchObject({ kind: 'partial', count: 8 })
  })

  test('E6: a short read or a generation change with nothing observed is P(0)', () => {
    const { logPath } = log([...fillerLine(2 * KiB)])
    const short = read(logPath, (o) => { o.onRead = (_fd, op) => (op.length ?? 0) - 1 })
    expect(short.evidence).toMatchObject({ kind: 'partial', count: 0 })
    const changed = read(logPath, (o) => { o.onRead = () => { writeChunked(logPath, fillerLine(100), 'a'); return null } })
    expect(changed.evidence).toEqual({ kind: 'partial', count: 0, generation: null, readKey: 'claude|assistant-user|w=204800|lines=2000' })
  })

  // @covers: terminal-streaming › Token evidence distinguishes complete from partial observations › Positive then change
  test('E7: a positive observed, then a short read or a generation change, is P(n), never C(n)', () => {
    const { logPath } = log([userLine(words(3, 'a'), META), userLine(words(3, 'b'), META)])
    // The short read drops the final newline: only the first line is complete.
    const short = read(logPath, (o) => { o.onRead = (_fd, op) => (op.length ?? 0) - 1 })
    expect(short.evidence).toMatchObject({ kind: 'partial', count: 3 })
    const changed = read(logPath, (o) => { o.onRead = () => { writeChunked(logPath, [userLine(words(2, 'c'), META)], 'a'); return null } })
    expect(changed.evidence).toMatchObject({ kind: 'partial', count: 6, generation: null })
    expect(read(logPath).evidence).toMatchObject({ kind: 'complete', count: 8 })
  })

  test('E8: a logical gap in a small log is partial', () => {
    // 2,100 one-word lines: the 2,000-line tail limit drops 100 of them.
    const many = log(Array.from({ length: 2100 }, (_, i) => userLine(`x${i}`)))
    expect(many.size).toBeLessThanOrEqual(W)
    expect(read(many.logPath).evidence).toMatchObject({ kind: 'partial', count: 2000 })
    // Exactly at the limit nothing is dropped.
    const atLimit = log(Array.from({ length: 2000 }, (_, i) => userLine(`x${i}`)))
    expect(read(atLimit.logPath).evidence).toMatchObject({ kind: 'complete', count: 2000 })
    // An unparseable unterminated final line is partial; a valid one counts.
    const broken = log([userLine(words(4), META), '{"type":"user","message":{"role":"us'])
    expect(read(broken.logPath).evidence).toMatchObject({ kind: 'partial', count: 4 })
    const unterminated = log([userLine(words(4), META), userLine(words(2, 'z')).trimEnd()])
    expect(read(unterminated.logPath).evidence).toMatchObject({ kind: 'complete', count: 6 })
    // The early-exit gap has no counterpart: the reader always finishes both windows.
  })

  // @covers: terminal-streaming › Token enrichment reads bounded windows › Tail starting at a line boundary
  test('E9: a tail starting exactly at a line start counts that line; one byte earlier it is cut', () => {
    const line = userLine(words(11), META)
    const len = Buffer.byteLength(line)
    const at = log([...fillerLine(300 * KiB), line, ...fillerLine(W - len)])
    expect(at.size - W).toBe(300 * KiB)
    expect(read(at.logPath).evidence).toMatchObject({ kind: 'partial', count: 11 })
    const before = log([...fillerLine(300 * KiB), line, ...fillerLine(W - len + 1)])
    // The line now starts at size − W − 1: the lookbehind byte itself.
    expect(before.size - W - 1).toBe(300 * KiB)
    expect(read(before.logPath).evidence).toMatchObject({ kind: 'partial', count: 0 })
  })

  // @covers: terminal-streaming › Token evidence distinguishes complete from partial observations › Missing log
  test('E10: a missing, unreadable, non-file, or unstattable log is unavailable and the descriptor closes', () => {
    const missing = read(path.join(env.root, 'missing.jsonl'))
    expect(missing.evidence).toEqual({ kind: 'unavailable' })
    expect(missing.observer.ops.filter((op) => op.api === 'read')).toEqual([])

    const dir = path.join(env.root, 'dir.jsonl')
    fs.mkdirSync(dir)
    const directory = read(dir)
    expect(directory.evidence).toEqual({ kind: 'unavailable' })
    expect(directory.observer.for(dir).map((op) => op.api)).toEqual(['open', 'fstat', 'close'])

    const { logPath } = log([userLine(words(3), META)])
    const failing = read(logPath, (o) => { o.mapFstat = () => { throw new Error('EIO') } })
    expect(failing.evidence).toEqual({ kind: 'unavailable' })
    expect(failing.observer.for(logPath).map((op) => op.api)).toEqual(['open', 'fstat', 'close'])
    // A failure after the reads (the second stat) still closes.
    let stats = 0
    const late = read(logPath, (o) => { o.mapFstat = (s) => { if (++stats === 2) throw new Error('EIO'); return s } })
    expect(late.evidence).toMatchObject({ kind: 'partial', count: 3, generation: null })
    expect(late.observer.for(logPath).at(-1)?.api).toBe('close')

    if (process.getuid?.() !== 0) {
      fs.chmodSync(logPath, 0o000)
      expect(read(logPath).evidence).toEqual({ kind: 'unavailable' })
      fs.chmodSync(logPath, 0o644)
    }
  })

  test('E11: a known session skips enrichment: K and no content read', () => {
    const { logPath } = log([userLine(words(5), META)])
    const known: KnownSession = {
      logFilePath: logPath, sessionId: META.sessionId, projectPath: META.cwd, slug: 'kept', agentType: 'claude', isCodexExec: false,
    }
    const observer = new FsObserver().start()
    try {
      const entry = enrichLogEntry(logPath, 1, 1, 10, new Map([[logPath, known]]))
      expect(entry.tokenEvidence).toEqual({ kind: 'known' })
    } finally {
      observer.stop()
    }
    expect(observer.for(logPath)).toEqual([])
  })

  test('read plan boundaries around W and 2W + 1', () => {
    const cases: Array<[number, Array<{ position: number; length: number }>, 'complete' | 'partial']> = []
    for (const size of [W - 1, W, W + 1, 2 * W, 2 * W + 1, 2 * W + 2]) {
      const reads = size <= 2 * W + 1 ? [{ position: 0, length: size }] : [{ position: 0, length: W }, { position: size - W - 1, length: W + 1 }]
      cases.push([size, reads, size <= W ? 'complete' : 'partial'])
    }
    for (const [size, reads, kind] of cases) {
      const parts: Part[] = size > 100 * KiB ? [...fillerLine(size - 100 * KiB), ...fillerLine(100 * KiB)] : fillerLine(size)
      const made = log(parts)
      expect(made.size).toBe(size)
      const r = read(made.logPath)
      expect(r.evidence.kind).toBe(kind)
      expectBoundedOps(r.observer, made.logPath, reads)
    }
  })

  test('a throwing close neither escapes nor replaces the evidence, and is attempted once', () => {
    const { logPath } = log([userLine(words(4), META), assistantLine(words(2))])
    const observed = read(logPath).evidence
    expect(observed).toMatchObject({ kind: 'complete', count: 6 })
    const realOpen = fs.openSync.bind(fs)
    const realClose = fs.closeSync.bind(fs)
    const realFstat = fs.fstatSync.bind(fs)
    // Each descriptor the reader opens (fd numbers are reused, so tracked per
    // open): every close attempt is counted, at most one reaches the OS, and
    // every attempt then throws.
    const opens: Array<{ fd: number; attempts: number; forwarded: boolean }> = []
    let failStat = false
    const spies = [
      spyOn(fs, 'openSync').mockImplementation(((...args: unknown[]) => {
        const fd = (realOpen as (...a: unknown[]) => number)(...args)
        opens.push({ fd, attempts: 0, forwarded: false })
        return fd
      }) as typeof fs.openSync),
      spyOn(fs, 'closeSync').mockImplementation(((fd: number) => {
        const owner = opens.findLast((o) => o.fd === fd)
        if (owner) owner.attempts++
        if (owner && !owner.forwarded) {
          owner.forwarded = true
          realClose(fd)
        }
        throw new Error('EIO on close')
      }) as typeof fs.closeSync),
      spyOn(fs, 'fstatSync').mockImplementation(((...args: unknown[]) => {
        if (failStat) throw new Error('EIO on fstat')
        return (realFstat as (...a: unknown[]) => unknown)(...args)
      }) as typeof fs.fstatSync),
    ]
    let succeeded: TokenEvidence | undefined
    let failed: TokenEvidence | undefined
    try {
      // A successful observation keeps its evidence.
      succeeded = readLogTokenEvidence(logPath, { agentType: 'claude' })
      expect(opens.map((o) => o.attempts)).toEqual([1])
      // An already-failed read keeps its unavailable evidence.
      failStat = true
      failed = readLogTokenEvidence(logPath, { agentType: 'claude' })
      expect(opens.map((o) => o.attempts)).toEqual([1, 1])
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(succeeded).toEqual(observed)
    expect(failed).toEqual({ kind: 'unavailable' })
    // One attempt per owned descriptor, each forwarded to the OS exactly once.
    expect(opens.map(({ attempts, forwarded }) => ({ attempts, forwarded }))).toEqual([
      { attempts: 1, forwarded: true }, { attempts: 1, forwarded: true },
    ])
    // The reader stays usable with the real close.
    const later = read(logPath)
    expect(later.evidence).toEqual(observed)
    expect(later.observer.for(logPath).map((op) => op.api)).toEqual(['open', 'fstat', 'read', 'fstat', 'close'])
  })
})
