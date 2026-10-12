// Log-content reading for the session preview: byte-cursor windows for large
// transcripts, an mtime-keyed line cache for hibernated logs (LogLineCache,
// one instance per server boot, built in the composition root), and a
// streaming fallback for older beforeLine requests.
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createInterface } from 'node:readline'

interface LogLineWindow {
  totalLines: number | null
  startLine: number
  endLine: number
  hasMoreBefore: boolean
  lines: string[]
  lineKeys?: string[]
  startByte?: number
  endByte?: number
}

// Hibernated session logs are static (the session is no longer writing to them),
// so the parsed line array is cached and re-sliced for pagination instead of
// re-scanning the whole file on every "Load earlier" request. Entries are keyed
// by size+mtime so a rewritten log self-invalidates, and the cache is byte-bounded
// so it can't grow without limit.
interface CachedLogLines {
  size: number
  mtimeMs: number
  lines: string[]
}
// Logs larger than this are streamed with a bounded window instead of cached, so
// a pathologically large file never lands in memory whole.
const MAX_CACHEABLE_LOG_BYTES = 4 * 1024 * 1024
// Total budget across all cached logs; oldest entries are evicted past this.
const MAX_LOG_CACHE_BYTES = 16 * 1024 * 1024

function selectLineWindow(
  lines: string[],
  limit: number,
  beforeLine: number
): LogLineWindow {
  const totalLines = lines.length
  const requestedEndLine = Number.isFinite(beforeLine)
    ? Math.max(0, Math.trunc(beforeLine))
    : totalLines
  const endLine = Math.min(totalLines, requestedEndLine)
  const startLine = Math.max(0, endLine - limit)
  return {
    totalLines,
    startLine,
    endLine,
    hasMoreBefore: startLine > 0,
    lines: lines.slice(startLine, endLine),
  }
}

async function readAllLogLines(logPath: string): Promise<string[]> {
  const lines: string[] = []
  const fileStream = createReadStream(logPath, { encoding: 'utf8' })
  const reader = createInterface({ input: fileStream, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      lines.push(line)
    }
  } finally {
    // close() ends the readline interface; destroy() releases the fd even when
    // iteration aborts early (e.g. EIO mid-read), which close() alone won't do.
    reader.close()
    fileStream.destroy()
  }
  return lines
}

// Streaming fallback for compatibility with older beforeLine requests. This still
// scans the whole file, so byte cursors are used for large-log pagination below.
async function streamLogLineWindow(
  logPath: string,
  limit: number,
  beforeLine: number
): Promise<LogLineWindow> {
  const requestedEndLine = Number.isFinite(beforeLine)
    ? Math.max(0, Math.trunc(beforeLine))
    : Number.POSITIVE_INFINITY
  const selectedLines: string[] = []
  let totalLines = 0

  const fileStream = createReadStream(logPath, { encoding: 'utf8' })
  const reader = createInterface({ input: fileStream, crlfDelay: Infinity })

  try {
    for await (const line of reader) {
      if (totalLines < requestedEndLine) {
        selectedLines.push(line)
        if (selectedLines.length > limit) {
          selectedLines.shift()
        }
      }
      totalLines += 1
    }
  } finally {
    reader.close()
    fileStream.destroy()
  }

  const endLine = Math.min(totalLines, requestedEndLine)
  const startLine = Math.max(0, endLine - selectedLines.length)
  return {
    totalLines,
    startLine,
    endLine,
    hasMoreBefore: startLine > 0,
    lines: selectedLines,
  }
}

// Large transcripts should open at the end without counting every preceding
// line. Read backwards in chunks until we have the requested complete lines, then
// return byte cursors so the client can page earlier without a linear scan.
async function readLogLineWindowFromEnd(
  logPath: string,
  stats: { size: number },
  limit: number,
  beforeByte: number
): Promise<LogLineWindow> {
  const endByte = Math.max(0, Math.min(stats.size, Math.trunc(beforeByte)))
  if (endByte === 0) {
    return {
      totalLines: null,
      startLine: 0,
      endLine: 0,
      hasMoreBefore: false,
      lines: [],
      startByte: 0,
      endByte: 0,
    }
  }

  const handle = await fs.open(logPath, 'r')
  const chunkSize = 64 * 1024
  const chunks: Buffer[] = []
  let cursor = endByte
  let newlineCount = 0
  let sawNonEmptyContent = false

  try {
    while (cursor > 0 && newlineCount <= limit) {
      const readSize = Math.min(chunkSize, cursor)
      const start = cursor - readSize
      const buffer = Buffer.allocUnsafe(readSize)
      const { bytesRead } = await handle.read(buffer, 0, readSize, start)
      if (bytesRead <= 0) break
      const chunk = buffer.subarray(0, bytesRead)
      chunks.unshift(chunk)
      for (const byte of chunk) {
        if (byte === 0x0a) newlineCount += 1
        if (byte > 0x20) sawNonEmptyContent = true
      }
      cursor = start
    }
  } finally {
    await handle.close()
  }

  const buffer = Buffer.concat(chunks)
  let contentEnd = buffer.length
  if (contentEnd > 0 && buffer[contentEnd - 1] === 0x0a) {
    contentEnd -= 1
  }

  const lineStarts = [0]
  for (let index = 0; index < contentEnd; index += 1) {
    if (buffer[index] === 0x0a) {
      lineStarts.push(index + 1)
    }
  }

  const selectedStarts = lineStarts.slice(-limit)
  const selectedLines = selectedStarts.map((startOffset, index) => {
    const nextStart = selectedStarts[index + 1]
    let endOffset = nextStart === undefined ? contentEnd : nextStart - 1
    if (endOffset > startOffset && buffer[endOffset - 1] === 0x0d) {
      endOffset -= 1
    }
    return buffer.subarray(startOffset, endOffset).toString('utf8')
  })

  if (contentEnd === 0 && !sawNonEmptyContent) {
    return {
      totalLines: null,
      startLine: 0,
      endLine: 0,
      hasMoreBefore: cursor > 0,
      lines: [],
      startByte: endByte,
      endByte,
    }
  }

  const selectedStartByte = selectedStarts[0] ?? contentEnd
  const startByte = Math.max(0, cursor + selectedStartByte)
  const lineKeys = selectedStarts.map((startOffset) => `b:${cursor + startOffset}`)

  return {
    totalLines: null,
    startLine: 0,
    endLine: selectedLines.length,
    hasMoreBefore: startByte > 0,
    lines: selectedLines,
    lineKeys,
    startByte,
    endByte,
  }
}

export class LogLineCache {
  /** logPath -> parsed lines; Map order is recency (first = least recent). */
  readonly entries = new Map<string, CachedLogLines>()
  private totalBytes = 0

  /** Bytes currently accounted to cached logs. */
  get bytes(): number {
    return this.totalBytes
  }

  async readLogLineWindow(
    logPath: string,
    stats: { size: number; mtimeMs: number },
    limit: number,
    beforeLine: number,
    beforeByte?: number
  ): Promise<LogLineWindow> {
    // Don't cache oversized logs; stream a bounded window so memory stays in check.
    if (stats.size > MAX_CACHEABLE_LOG_BYTES) {
      if (beforeByte !== undefined && Number.isFinite(beforeByte)) {
        return readLogLineWindowFromEnd(logPath, stats, limit, beforeByte)
      }
      if (!Number.isFinite(beforeLine)) {
        return readLogLineWindowFromEnd(logPath, stats, limit, stats.size)
      }
      return streamLogLineWindow(logPath, limit, beforeLine)
    }

    const cached = this.entries.get(logPath)
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
      // Refresh recency: re-inserting moves the key to the end of the Map.
      this.entries.delete(logPath)
      this.entries.set(logPath, cached)
      return selectLineWindow(cached.lines, limit, beforeLine)
    }

    const lines = await readAllLogLines(logPath)
    // Reconcile byte accounting against the CURRENT entry (re-read after the await,
    // not the pre-await `cached`) so two concurrent misses for the same path can't
    // double-count and skew the cache budget.
    const prior = this.entries.get(logPath)
    if (prior) {
      this.entries.delete(logPath)
      this.totalBytes -= prior.size
    }
    this.entries.set(logPath, { size: stats.size, mtimeMs: stats.mtimeMs, lines })
    this.totalBytes += stats.size
    this.enforceBudget()
    return selectLineWindow(lines, limit, beforeLine)
  }

  /**
   * Test hook: insert line-less entries of the given sizes (then enforce the
   * budget) so eviction can be driven without 16MB fixtures.
   */
  seedForTest(entries: Array<{ key: string; size: number; mtimeMs: number }>): void {
    for (const entry of entries) {
      this.entries.delete(entry.key)
      this.entries.set(entry.key, { size: entry.size, mtimeMs: entry.mtimeMs, lines: [] })
      this.totalBytes += entry.size
    }
    this.enforceBudget()
  }

  private enforceBudget(): void {
    // Map preserves insertion order, so the first key is the least-recently-used.
    while (this.totalBytes > MAX_LOG_CACHE_BYTES) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) break
      const evicted = this.entries.get(oldestKey)
      this.entries.delete(oldestKey)
      if (evicted) this.totalBytes -= evicted.size
    }
  }
}
