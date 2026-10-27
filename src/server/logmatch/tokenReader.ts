// Bounded token evidence for one agent log (bounded-log-reads D2/D3): one
// descriptor, a 200 KiB head and a 200 KiB tail window (plus one lookbehind
// byte), fstat generations before and after, complete lines only, and the
// reader's own empty cache that admits only a complete stable zero.
import fs from 'node:fs'
import {
  emptyCacheKey,
  generationKey,
  generationOf,
  UNAVAILABLE_EVIDENCE,
  type LogGeneration,
  type TokenEvidence,
} from '../logTokenEvidence'
import { countTokens, extractTextFromEntry, type LogTextMode } from './logText'

export const TOKEN_WINDOW_BYTES = 200 * 1024
const DEFAULT_TAIL_LINE_LIMIT = 2000
const DEFAULT_MODE: LogTextMode = 'assistant-user'

export interface TokenReadOptions {
  mode?: LogTextMode
  /** `byteLimit` sizes both windows (at most 200 KiB); `lineLimit` caps the tail's lines (0: none). */
  logRead?: { lineLimit?: number; byteLimit?: number }
  /** Part of the cache key: the same bytes may be judged per agent. */
  agentType?: string | null
}

interface ReadSpan {
  start: number
  bytes: Buffer
}

interface Line {
  start: number
  /** Offset of the terminating newline, or the file size for a final unterminated line. */
  end: number
  text: string
}

// Complete zeros, keyed by path -> generation|readKey (D3 cache rules).
const zeroTokenLogCache = new Map<string, string>()

/**
 * Token evidence for `logPath`, never throwing. Reads at most
 * 2 × window + 1 bytes (409,601 by default) through one descriptor with
 * explicit offsets; no whole-file read API on any branch.
 */
export function readLogTokenEvidence(
  logPath: string,
  { mode = DEFAULT_MODE, logRead = {}, agentType = null }: TokenReadOptions = {}
): TokenEvidence {
  const window = resolveWindow(logRead.byteLimit)
  const lineLimit = logRead.lineLimit ?? DEFAULT_TAIL_LINE_LIMIT
  const readKey = `${agentType ?? '-'}|${mode}|w=${window}|lines=${lineLimit}`

  let fd: number
  try {
    fd = fs.openSync(logPath, 'r')
  } catch {
    return UNAVAILABLE_EVIDENCE
  }
  try {
    const before = statGeneration(fd)
    if (!before) return UNAVAILABLE_EVIDENCE
    const { size, generation } = before

    const cached = zeroTokenLogCache.get(logPath)
    if (cached !== undefined) {
      if (generation && cached === `${generationKey(generation)}|${readKey}`) {
        return { kind: 'complete', count: 0, generation, readKey }
      }
      zeroTokenLogCache.delete(logPath)
    }

    const spans: ReadSpan[] = []
    let shortRead = false
    for (const { start, length } of planReads(size, window)) {
      const buffer = Buffer.alloc(length)
      const bytesRead = fs.readSync(fd, buffer, 0, length, start)
      if (bytesRead < length) shortRead = true
      spans.push({ start, bytes: buffer.subarray(0, Math.max(0, bytesRead)) })
    }

    const after = statGeneration(fd)
    const stable = Boolean(
      generation &&
      after?.generation &&
      generationKey(generation) === generationKey(after.generation)
    )
    const tally = countWindows(spans, size, window, lineLimit, mode)
    const evidence: TokenEvidence =
      size <= window && !shortRead && stable && tally.whole && generation
        ? { kind: 'complete', count: tally.count, generation, readKey }
        : { kind: 'partial', count: tally.count, generation: stable ? generation : null, readKey }
    const key = emptyCacheKey(evidence)
    if (key) zeroTokenLogCache.set(logPath, key)
    return evidence
  } catch {
    return UNAVAILABLE_EVIDENCE
  } finally {
    fs.closeSync(fd)
  }
}

function resolveWindow(byteLimit: number | undefined): number {
  if (!byteLimit || byteLimit <= 0) return TOKEN_WINDOW_BYTES
  return Math.min(Math.floor(byteLimit), TOKEN_WINDOW_BYTES)
}

function statGeneration(
  fd: number
): { size: number; generation: LogGeneration | null } | null {
  try {
    const stats = fs.fstatSync(fd, { bigint: true })
    if (!stats.isFile() || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return { size: Number(stats.size), generation: generationOf(stats) }
  } catch {
    return null
  }
}

/**
 * The head `[0, window)` and the tail `[size − window, size)` with one
 * lookbehind byte, as one read when they overlap or adjoin.
 */
export function planReads(size: number, window: number): Array<{ start: number; length: number }> {
  if (size <= 0) return []
  if (size <= 2 * window + 1) return [{ start: 0, length: size }]
  const tailStart = size - window - 1
  return [
    { start: 0, length: window },
    { start: tailStart, length: size - tailStart },
  ]
}

/**
 * Complete lines of the read spans: a line counts only when it starts at
 * offset 0 or right after a newline inside the read bytes, and ends at a
 * newline inside them — or is the final unterminated line at the file's end
 * that parses as JSON. Returns the counted lines' tokens and whether they
 * account for the whole logical input.
 */
function countWindows(
  spans: ReadSpan[],
  size: number,
  window: number,
  lineLimit: number,
  mode: LogTextMode
): { count: number; whole: boolean } {
  const lines: Line[] = []
  let partialFinal = false
  for (const { start, bytes } of spans) {
    let lineStart = start === 0 ? 0 : bytes.indexOf(0x0a) + 1
    if (start !== 0 && lineStart === 0) continue
    while (lineStart < bytes.length) {
      const newline = bytes.indexOf(0x0a, lineStart)
      if (newline === -1) {
        if (start + bytes.length === size) {
          const text = bytes.subarray(lineStart).toString('utf8').trim()
          if (text && parseJson(text) === undefined) partialFinal = true
          else if (text) lines.push({ start: start + lineStart, end: size, text })
        }
        break
      }
      const text = bytes.subarray(lineStart, newline).toString('utf8').trim()
      if (text) lines.push({ start: start + lineStart, end: start + newline, text })
      lineStart = newline + 1
    }
  }

  // One window when the file fits: it is the tail, under the line limit.
  // Otherwise the head's complete lines plus the tail's newest lines, each
  // line once even where the windows overlap.
  const tailStart = Math.max(0, size - window)
  const tail = lines.filter((line) => line.start >= tailStart)
  const kept = lineLimit > 0 ? tail.slice(-lineLimit) : tail
  const counted = new Map<number, Line>()
  if (size > window) {
    for (const line of lines) if (line.end < window) counted.set(line.start, line)
  }
  for (const line of kept) counted.set(line.start, line)

  let count = 0
  for (const line of counted.values()) count += countLineTokens(line.text, mode)
  return { count, whole: !partialFinal && kept.length === tail.length && tail.length === lines.length }
}

function countLineTokens(text: string, mode: LogTextMode): number {
  if (mode === 'all') return countTokens(text)
  const entry = parseJson(text)
  if (entry === undefined) return 0
  return countTokens(extractTextFromEntry(entry, mode).join('\n'))
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
