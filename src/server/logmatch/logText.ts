// Agent JSONL log reading: tail and backward-line primitives, role-filtered
// text extraction, token counting, and last-message/timestamp extraction.
// Bounded token evidence lives in tokenReader.ts.
import fs from 'node:fs'
import { normalizeAgentLogEntry } from '../../shared/eventTaxonomy'
import { stripAnsi } from '../terminal/tmuxText'
import {
  extractActionFromUserAction,
  extractCommandInvocation,
  isToolNotificationText,
} from './promptExtract'

export type LogTextMode = 'all' | 'assistant' | 'user' | 'assistant-user'

interface LogReadOptions {
  lineLimit: number
  byteLimit: number
  maxByteLimit?: number
}

const DEFAULT_LOG_READ_OPTIONS: LogReadOptions = {
  lineLimit: 2000,
  byteLimit: 200 * 1024,
}

export const DEFAULT_LOG_TAIL_BYTES = 96 * 1024

export function readLogTail(logPath: string, byteLimit = DEFAULT_LOG_TAIL_BYTES): string {
  if (byteLimit <= 0) return ''
  try {
    const stats = fs.statSync(logPath)
    const size = stats.size
    if (size <= 0) return ''
    const start = Math.max(0, size - byteLimit)
    if (start === 0) {
      return fs.readFileSync(logPath, 'utf8')
    }

    const fd = fs.openSync(logPath, 'r')
    try {
      const length = size - start
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, start)
      let text = buffer.toString('utf8')
      const firstNewline = text.indexOf('\n')
      if (firstNewline >= 0) {
        text = text.slice(firstNewline + 1)
      }
      return text
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

const BACKWARD_READ_CHUNK_BYTES = 64 * 1024
// Safety valve for pathological files (e.g. a multi-GB line with no newlines).
// A single log entry larger than this aborts the backward scan.
const MAX_BACKWARD_LINE_BYTES = 16 * 1024 * 1024

/**
 * Iterate the complete lines of a file from the end toward the start (newest
 * first). Reads fixed-size chunks backward from EOF and only assembles whole
 * lines, so a jumbo line (a user message with a large paste can exceed 1MB as
 * a single JSONL line) costs one pass over that line instead of repeated
 * expanding tail reads that keep decapitating it at the tail boundary.
 *
 * `maxScanBytes` bounds how far back the scan goes, checked at line
 * boundaries: a line that straddles the budget is still completed and
 * yielded, so the budget caps scan depth without capping line size — the
 * true worst-case read is maxScanBytes + maxLineBytes. Splitting on \n is
 * UTF-8 safe (0x0A never appears inside a multi-byte sequence), so buffers
 * are only decoded once a line is complete. An in-progress line is kept as
 * a list of chunk slices and concatenated once at its newline, so assembling
 * a jumbo line is linear, not quadratic. The scan aborts (stops yielding) on
 * any line over maxLineBytes and on a short read (file changed underneath).
 */
export function* iterateLogLinesBackward(
  logPath: string,
  {
    maxScanBytes = Number.POSITIVE_INFINITY,
    chunkBytes = BACKWARD_READ_CHUNK_BYTES,
    maxLineBytes = MAX_BACKWARD_LINE_BYTES,
  }: { maxScanBytes?: number; chunkBytes?: number; maxLineBytes?: number } = {}
): Generator<string> {
  if (maxScanBytes <= 0) return
  let fd: number
  let size: number
  try {
    fd = fs.openSync(logPath, 'r')
  } catch {
    return
  }
  try {
    try {
      size = fs.fstatSync(fd).size
    } catch {
      return
    }
    if (size <= 0) return

    let position = size
    // Pieces of the in-progress line (file order); its earlier bytes live in
    // chunks not yet read. Concatenated only once, at the line's newline.
    let carry: Buffer[] = []
    let carrySize = 0
    let scanned = 0
    let budgetExhausted = false

    const finishLine = (piece: Buffer): string | null => {
      const buf = carry.length > 0 ? Buffer.concat([piece, ...carry]) : piece
      carry = []
      carrySize = 0
      if (buf.length > maxLineBytes) return null
      return buf.toString('utf8').trim()
    }

    while (position > 0) {
      // While budget remains, never read past it in one chunk — lines inside
      // a chunk are emitted unconditionally, so an oversized read would leak
      // lines from beyond the budget. Once exhausted (mid-line), full chunks
      // are fine: emission stops at the first completed line.
      const remaining = budgetExhausted
        ? chunkBytes
        : Math.max(1, Math.min(chunkBytes, maxScanBytes - scanned))
      const readLength = Math.min(remaining, position)
      const start = position - readLength
      const chunk = Buffer.alloc(readLength)
      const bytesRead = fs.readSync(fd, chunk, 0, readLength, start)
      if (bytesRead !== readLength) return
      position = start
      scanned += readLength

      // Walk newlines from the end of the chunk; the segment after each
      // newline is a complete line. The first (newest) one also absorbs the
      // carry accumulated from later chunks.
      let end = chunk.length
      let carryConsumed = false
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] !== 0x0a) continue
        const piece = chunk.subarray(i + 1, end)
        end = i
        let line: string | null
        if (carryConsumed) {
          line = piece.length > maxLineBytes ? null : piece.toString('utf8').trim()
        } else {
          line = finishLine(piece)
          carryConsumed = true
        }
        if (line === null) return
        if (line) {
          yield line
          // Once past the budget we only finish the straddling line.
          if (budgetExhausted) return
        }
      }
      if (end > 0) {
        carry.unshift(chunk.subarray(0, end))
        carrySize += end
      }

      if (carrySize > maxLineBytes) return
      if (scanned >= maxScanBytes) {
        // At a line boundary the budget is a clean stop; mid-line, keep
        // reading just far enough to complete the line in progress.
        if (carrySize === 0) return
        budgetExhausted = true
      }
    }

    if (carrySize > 0) {
      const line = finishLine(Buffer.alloc(0))
      if (line) yield line
    }
  } finally {
    fs.closeSync(fd)
  }
}

interface ConversationPair {
  user: string
  assistant: string
}

export function normalizeText(text: string): string {
  const cleaned = stripAnsi(text)
    // eslint-disable-next-line no-control-regex -- strip control characters
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .toLowerCase()
  return cleaned.replace(/\s+/g, ' ').trim()
}

function resolveLogReadOptions(
  overrides: Partial<LogReadOptions> = {}
): LogReadOptions {
  return {
    lineLimit: overrides.lineLimit ?? DEFAULT_LOG_READ_OPTIONS.lineLimit,
    byteLimit: overrides.byteLimit ?? DEFAULT_LOG_READ_OPTIONS.byteLimit,
  }
}

export function countTokens(text: string): number {
  const normalized = normalizeText(text)
  if (!normalized) return 0
  return normalized.split(/\s+/).filter(Boolean).length
}

export function extractTextFromEntry(entry: unknown, mode: LogTextMode): string[] {
  const roleText = extractRoleTextFromEntry(entry)
  return roleText
    .filter(({ role }) => shouldIncludeRole(role, mode))
    .map(({ text }) => text)
    .filter((chunk) => chunk.trim().length > 0)
}

function shouldIncludeRole(role: string, mode: LogTextMode): boolean {
  if (mode === 'all') {
    return true
  }
  if (!role) {
    return false
  }
  if (mode === 'assistant-user') {
    return role === 'assistant' || role === 'user'
  }
  return role === mode
}

/**
 * Process user message text - filters tool notifications and extracts actions from user_action blocks.
 * Returns the processed text or null if it should be skipped.
 */
function processUserMessageText(text: string): string | null {
  // Strip ANSI first so marker checks see clean text — guards against future
  // log entries that wrap markers in ANSI (e.g., `\x1b[2m<task-notification>...`).
  const cleaned = stripAnsi(text)
  if (!cleaned.trim()) return null
  // Slash-command invocations come through as user messages wrapped in
  // <command-message>/<command-name>/<command-args>. Extract a readable
  // "/cmd args" form before the generic marker filter would discard them.
  const invocation = extractCommandInvocation(cleaned)
  if (invocation) return invocation
  if (isToolNotificationText(cleaned)) return null
  const action = extractActionFromUserAction(cleaned)
  if (action) return action
  return cleaned
}

function extractRoleTextFromEntry(
  entry: unknown
): Array<{ role: string; text: string }> {
  const normalized = normalizeAgentLogEntry(entry)
  const chunks: Array<{ role: string; text: string }> = []

  for (const item of normalized) {
    if (item.kind !== 'message') {
      continue
    }
    if (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'system') {
      continue
    }
    if (item.role === 'user') {
      const processed = processUserMessageText(item.text)
      if (processed) chunks.push({ role: 'user', text: processed })
    } else if (item.text.trim()) {
      chunks.push({ role: item.role, text: item.text })
    }
  }

  return chunks
}

/**
 * Claude Code mirrors each submitted prompt into a tiny `last-prompt` entry
 * (~200 chars, pre-truncated) written right after the full user entry. It is
 * the cheap fallback when the real user entry cannot be recovered — larger
 * than the line-size cap, or beyond the scan budget. Codex has no equivalent.
 */
function extractLastPromptText(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const record = entry as Record<string, unknown>
  if (record.type !== 'last-prompt') return null
  if (typeof record.lastPrompt !== 'string') return null
  return processUserMessageText(record.lastPrompt)
}

function extractLastConversationFromLog(
  logPath: string,
  logRead: Partial<LogReadOptions> = {}
): ConversationPair {
  const resolvedRead = resolveLogReadOptions(logRead)
  const initialByteLimit = Math.max(0, resolvedRead.byteLimit)
  if (initialByteLimit <= 0) {
    return { user: '', assistant: '' }
  }
  const maxScanBytes = Math.max(
    initialByteLimit,
    typeof logRead.maxByteLimit === 'number' ? logRead.maxByteLimit : initialByteLimit
  )
  const lineLimit = resolvedRead.lineLimit

  let lastUser = ''
  let lastAssistant = ''
  let lastPromptFallback = ''
  let linesScanned = 0

  for (const line of iterateLogLinesBackward(logPath, { maxScanBytes })) {
    if (lineLimit > 0 && ++linesScanned > lineLimit) break
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!lastPromptFallback) {
      lastPromptFallback = extractLastPromptText(entry) ?? ''
    }
    const roleText = extractRoleTextFromEntry(entry)
    for (const { role, text } of roleText) {
      if (!lastAssistant && role === 'assistant' && text.trim()) {
        lastAssistant = text.trim()
      }
      if (!lastUser && role === 'user' && text.trim()) {
        lastUser = text.trim()
      }
    }
    if (lastUser && lastAssistant) break
  }

  if (!lastUser && lastPromptFallback) {
    lastUser = lastPromptFallback
  }
  return { user: lastUser, assistant: lastAssistant }
}

export function extractLastUserMessageFromLog(
  logPath: string,
  logRead: Partial<LogReadOptions> = {}
): string | null {
  const { user } = extractLastConversationFromLog(logPath, logRead)
  return user && user.trim() ? user.trim() : null
}

/**
 * Extract the timestamp from the last entry in a log file.
 * Returns an ISO timestamp string, or null if not found.
 */
export function extractLastEntryTimestamp(
  logPath: string,
  tailBytes = 32 * 1024
): string | null {
  const raw = readLogTail(logPath, tailBytes)
  if (!raw) return null

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  // Iterate from the end to find the last entry with a timestamp
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i])
      if (entry && typeof entry.timestamp === 'string') {
        // Validate timestamp is parseable before returning
        if (!Number.isNaN(Date.parse(entry.timestamp))) {
          return entry.timestamp
        }
      }
    } catch {
      // Skip malformed lines
    }
  }
  return null
}
