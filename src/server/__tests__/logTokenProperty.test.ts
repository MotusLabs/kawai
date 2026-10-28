// Properties P1/P2 (bounded-log-reads D2/D3): seed 0x6b617761, 200 generated
// logs up to 64 MiB, written in chunks, read by the real token reader under
// the all-API observer. The expected evidence comes from an independent
// reference that classifies the generated layout (line offsets and words)
// against the two windows; it never reads the file. A sparse 1 MiB / 1 GiB
// pair with equal head and tail is used for size independence only.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { getEntriesNeedingMatch } from '../logMatchGate'
import { readLogTokenEvidence } from '../logmatch'
import { TOKEN_WINDOW_BYTES } from '../logmatch/tokenReader'
import type { LogEntrySnapshot } from '../logPollData'
import { tokenGate, type TokenEvidence } from '../logTokenEvidence'
import { assistantLine, claudeLogPath, fillerLine, FsObserver, userLine, WitnessEnv, writeChunked, type Part } from './helpers/logTokenHarness'

const W = TOKEN_WINDOW_BYTES
const MAX_BYTES = 2 * W + 1
const LINE_LIMIT = 2000
const SEED = 0x6b617761
const CASES = 200

/** One generated line: its bytes on disk, counted words, and whether it is a valid terminated record. */
interface GenLine { parts: Part[]; bytes: number; words: number; blank: boolean; terminated: boolean; valid: boolean }

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generate(rand: () => number, caseIndex: number): GenLine[] {
  const logUniform = (lo: number, hi: number) => Math.floor(Math.exp(Math.log(lo) + rand() * (Math.log(hi) - Math.log(lo))))
  // Some cases are many tiny records, to reach the 2,000-line limit.
  const tiny = rand() < 0.15
  const target = logUniform(64, tiny ? 4 * 1024 * 1024 : 64 * 1024 * 1024)
  const lines: GenLine[] = []
  let total = 0
  const push = (parts: Part[], words: number, extra: Partial<GenLine> = {}) => {
    const bytes = parts.reduce((sum, p) => sum + (typeof p === 'string' ? Buffer.byteLength(p) : p.fill), 0)
    lines.push({ parts, bytes, words, blank: false, terminated: true, valid: true, ...extra })
    total += bytes
  }
  while (total < target) {
    const r = rand()
    if (r < 0.3) {
      const k = 1 + Math.floor(rand() * 12)
      const text = Array.from({ length: k }, (_, j) => `c${caseIndex}w${lines.length}x${j}`).join(' ')
      push([rand() < 0.5 ? userLine(text) : assistantLine(text)], k)
    } else if (r < 0.32) {
      push(['\n'], 0, { blank: true })
    } else if (!tiny && r < 0.36) {
      // Giant lines, generated separately, stay within the case's target.
      const room = Math.min(24 * 1024 * 1024, Math.max(64 * 1024 + 1, target - total))
      push(fillerLine(logUniform(64 * 1024, room)), 0)
    } else {
      const body = Math.floor(rand() * (tiny ? 40 : 4000))
      push([`{"type":"progress","data":"${'f'.repeat(body)}"}\n`], 0)
    }
  }
  const last = lines.at(-1)
  const ending = rand()
  if (last && !last.blank && ending < 0.1) {
    // A valid final record without its newline.
    const final = last.parts.at(-1) as string
    last.parts = [...last.parts.slice(0, -1), final.slice(0, -1)]
    last.bytes -= 1
    last.terminated = false
  } else if (ending < 0.15) {
    push(['{"type":"user","message":{"role":"us'], 0, { terminated: false, valid: false })
  }
  return lines
}

/** The reference classification of a layout against the head and tail windows. */
function reference(lines: GenLine[]): { kind: 'complete' | 'partial'; count: number } {
  let offset = 0
  const records: Array<{ start: number; end: number; words: number; terminated: boolean; valid: boolean }> = []
  for (const line of lines) {
    const start = offset
    offset += line.bytes
    if (line.blank) continue
    records.push({ start, end: line.terminated ? offset - 1 : offset, words: line.words, terminated: line.terminated, valid: line.valid })
  }
  const size = offset
  const unparseableFinal = records.some((r) => !r.terminated && !r.valid)
  const complete = records.filter((r) => r.terminated || r.valid)
  const tail = complete.filter((r) => r.start >= size - W)
  const kept = tail.slice(-LINE_LIMIT)
  const counted = new Set(kept)
  if (size > W) for (const r of complete) if (r.terminated && r.end < W) counted.add(r)
  const count = [...counted].reduce((sum, r) => sum + r.words, 0)
  const whole = size <= W && !unparseableFinal && kept.length === complete.length
  return { kind: whole ? 'complete' : 'partial', count }
}

function expectedReads(size: number) {
  if (size === 0) return []
  if (size <= MAX_BYTES) return [{ position: 0, length: size }]
  return [{ position: 0, length: W }, { position: size - W - 1, length: W + 1 }]
}

let env: WitnessEnv

beforeEach(() => {
  env = new WitnessEnv()
})

afterEach(() => {
  env.dispose()
})

function observedRead(logPath: string): { evidence: TokenEvidence; observer: FsObserver } {
  const observer = new FsObserver().start()
  try {
    return { evidence: readLogTokenEvidence(logPath, { agentType: 'claude' }), observer }
  } finally {
    observer.stop()
  }
}

describe('P1/P2: bounded token reads over generated logs', () => {
  // @covers: terminal-streaming › Token enrichment reads bounded windows › Large log read in windows
  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Partial evidence stays eligible
  test(`seed 0x${SEED.toString(16)}, ${CASES} cases`, () => {
    const rand = mulberry32(SEED)
    let maxSize = 0
    const seen = { large: 0, small: 0, complete: 0, partial: 0, limited: 0, withMessages: 0 }
    for (let i = 0; i < CASES; i++) {
      const lines = generate(rand, i)
      const logPath = claudeLogPath(`p1-${i}`)
      const size = writeChunked(logPath, lines.flatMap((l) => l.parts))
      const expected = reference(lines)
      const { evidence, observer } = observedRead(logPath)
      const label = `case ${i} size ${size}`

      // P1: bounded, one descriptor, no whole-file API, equal to the reference.
      expect([label, observer.wholeFileCalls()]).toEqual([label, []])
      expect([label, observer.bytesRead(logPath) <= MAX_BYTES]).toEqual([label, true])
      const ops = observer.for(logPath)
      expect([label, ops.map((op) => op.api)]).toEqual([label, ['open', 'fstat', ...expectedReads(size).map(() => 'read'), 'fstat', 'close']])
      expect([label, ops.filter((op) => op.api === 'read').map(({ position, length }) => ({ position, length }))]).toEqual([label, expectedReads(size)])
      expect([label, evidence.kind, evidence.kind === 'complete' || evidence.kind === 'partial' ? evidence.count : null])
        .toEqual([label, expected.kind, expected.count])

      // P2: message text anywhere is never C(0), and every gate at minimum 1 keeps the log.
      const hasMessages = lines.some((l) => l.words > 0)
      if (hasMessages) {
        seen.withMessages++
        expect([label, evidence.kind === 'complete' && evidence.count === 0]).toEqual([label, false])
        expect([label, tokenGate(evidence, 1)]).toEqual([label, 'pass'])
        const entry: LogEntrySnapshot = {
          logPath, mtime: 1, birthtime: 1, size, sessionId: `p2-${i}`, projectPath: '/tmp/p2', slug: null,
          agentType: 'claude', isCodexSubagent: false, isCodexExec: false, tokenEvidence: evidence,
        }
        expect([label, getEntriesNeedingMatch([entry], [], { minTokens: 1 }).length]).toEqual([label, 1])
      }

      maxSize = Math.max(maxSize, size)
      if (size > W) seen.large++
      else seen.small++
      seen[evidence.kind === 'complete' ? 'complete' : 'partial']++
      if (lines.filter((l) => !l.blank).length > LINE_LIMIT) seen.limited++
      fs.rmSync(logPath)
    }
    // The generator exercised every class it claims.
    for (const [name, n] of Object.entries(seen)) expect([name, n > 0]).toEqual([name, true])
    expect(maxSize).toBeLessThanOrEqual(64 * 1024 * 1024 + 128 * 1024)
  }, 600_000)

  // @covers: terminal-streaming › Token enrichment reads bounded windows › Size independence
  test('a sparse 1 MiB / 1 GiB pair with equal head and tail reads equal bytes and gives equal evidence', () => {
    const rand = mulberry32(SEED ^ 0x5a5a)
    const region = (n: number): string => {
      let out = ''
      for (let i = 0; Buffer.byteLength(out) < 250 * 1024; i++) {
        out += rand() < 0.4 ? userLine(`s${n}w${i} more words here`) : `{"type":"progress","data":"${'d'.repeat(Math.floor(rand() * 900))}"}\n`
      }
      return out
    }
    const head = Buffer.from(region(0))
    const tail = Buffer.from(region(1))
    const results = [1024 * 1024, 1024 * 1024 * 1024].map((size) => {
      const logPath = claudeLogPath(`sparse-${size}`)
      writeChunked(logPath, [])
      const fd = fs.openSync(logPath, 'r+')
      try {
        fs.writeSync(fd, head, 0, head.length, 0)
        fs.writeSync(fd, tail, 0, tail.length, size - tail.length)
      } finally {
        fs.closeSync(fd)
      }
      expect(fs.statSync(logPath).size).toBe(size)
      const { evidence, observer } = observedRead(logPath)
      expect(observer.wholeFileCalls()).toEqual([])
      const reads = observer.for(logPath).filter((op) => op.api === 'read')
      const out = { bytes: observer.bytesRead(logPath), reads: reads.map((op) => op.length), evidence: { ...evidence, generation: null } }
      fs.rmSync(logPath)
      return out
    })
    const [small, large] = results as [(typeof results)[number], (typeof results)[number]]
    expect(small.bytes).toBe(MAX_BYTES)
    expect(large).toEqual(small)
    expect(small.evidence.kind).toBe('partial')
    expect(small.evidence.kind === 'partial' && small.evidence.count > 0).toBe(true)
  })
})
