// Candidate search for window→log matching: flexible-text pattern predicates,
// ripgrep-based candidate discovery, and ordered-message scoring with
// tail-first fast paths.
import { performance } from 'node:perf_hooks'
import { normalizeAgentLogEntry } from '../../shared/eventTaxonomy'
import {
  MIN_EXACT_MATCH_LENGTH,
  runCommandAsync,
  type ExactMessageSearchOptions,
  type ExactMatchSearchOptions,
} from './common'
import { DEFAULT_LOG_TAIL_BYTES, readLogTail } from './logText'

const RG_COMMAND_TIMEOUT_MS = 10000
const MIN_TAIL_MATCH_COUNT = 2

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Convert a user message to a regex pattern that matches with flexible whitespace.
 * This handles cases where tmux and log files have different whitespace representations.
 * Also handles JSON-escaped quotes since logs store text in JSON format where " becomes \".
 */
function messageToFlexiblePattern(message: string): string {
  // Normalize to single spaces first
  const normalized = message.replace(/\s+/g, ' ').trim()
  // Escape regex special chars, then replace spaces with \s+ for flexible matching
  // Replace quotes with pattern matching: nothing, ", or \" (JSON-escaped)
  return escapeRegex(normalized)
    .replace(/ /g, '\\s+')
    .replace(/"/g, '(?:\\\\?")?')
}

const MAX_MESSAGE_MATCH_PREFIX = 1000
const TOOL_RESULT_TYPES = new Set(['tool_result', 'custom_tool_call_output'])
const TOOL_RESULT_KEYS = new Set(['toolUseResult'])
const MESSAGE_VALUE_KEYS = new Set(['text', 'message', 'content'])

function matchesMessageWithPrefixLimit(text: string, pattern: RegExp): boolean {
  const index = text.search(pattern)
  return index >= 0 && index <= MAX_MESSAGE_MATCH_PREFIX
}

function hasMessageInParsedJson(value: unknown, pattern: RegExp): boolean {
  if (value === null || value === undefined) return false

  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasMessageInParsedJson(item, pattern)) return true
    }
    return false
  }

  if (typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>
  const typeValue = record.type
  if (typeof typeValue === 'string' && TOOL_RESULT_TYPES.has(typeValue)) {
    return false
  }

  for (const [key, child] of Object.entries(record)) {
    if (TOOL_RESULT_KEYS.has(key)) continue

    if (MESSAGE_VALUE_KEYS.has(key) && typeof child === 'string') {
      if (matchesMessageWithPrefixLimit(child, pattern)) {
        return true
      }
      continue
    }

    if (child && typeof child === 'object') {
      if (hasMessageInParsedJson(child, pattern)) return true
    }
  }

  return false
}

/**
 * Check if log content has the message in a valid user message context.
 *
 * This filters out false positives where the message appears inside tool_result
 * content (e.g., terminal captures from another session observing this window).
 *
 * Valid contexts:
 *   - "text" field: {"type":"text","text":"user message"}
 *   - "message" field: {"message":"user message"}
 *   - "content" field NOT in tool_result: {"role":"user","content":"user message"}
 *
 * Invalid contexts:
 *   - Tool result content: {"type":"tool_result","content":"❯ captured terminal"}
 */
export function hasMessageInValidUserContext(
  logContent: string,
  userMessage: string,
  { userOnly = false }: { userOnly?: boolean } = {}
): boolean {
  const basePattern = messageToFlexiblePattern(userMessage)
  const baseRegex = new RegExp(basePattern, 'm')
  const lines = logContent.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    try {
      const parsed = JSON.parse(trimmed)
      const normalized = normalizeAgentLogEntry(parsed)
      if (
        normalized.some((event) => {
          if (event.kind === 'tool_result') return false
          if (userOnly && event.role !== 'user') return false
          if (!event.text) return false
          return matchesMessageWithPrefixLimit(event.text, baseRegex)
        })
      ) {
        return true
      }
      if (hasMessageInParsedJson(parsed, baseRegex)) {
        return true
      }
      continue
    } catch {
      // Fall back to regex matching for non-JSON lines.
    }

    // Check for "text" or "message" fields - always valid
    const textMessagePattern = new RegExp(
      `"(?:text|message)"\\s*:\\s*"[^"]{0,1000}?${basePattern}`,
      'm'
    )
    if (textMessagePattern.test(line)) {
      return true
    }

    const hasToolResultType = /"type"\s*:\s*"tool_result"/.test(line)
    const hasCustomToolOutputType = /"type"\s*:\s*"custom_tool_call_output"/.test(
      line
    )
    const hasToolUseResultKey = /"toolUseResult"\s*:/.test(line)

    // Check for "content" field only when not in a tool-result context.
    if (!hasToolResultType && !hasCustomToolOutputType && !hasToolUseResultKey) {
      const contentPattern = new RegExp(
        `"content"\\s*:\\s*"[^"]{0,1000}?${basePattern}`,
        'm'
      )
      if (contentPattern.test(line)) {
        return true
      }
    }
  }

  return false
}

const MAX_PROGRESSIVE_TAIL_BYTES = 2 * 1024 * 1024

/**
 * Check if a log file contains a message in a valid user context, using progressive
 * tail reading. Starts with a small tail and expands up to maxTailBytes if needed.
 * This handles cases where logs have lots of assistant output after the last user message.
 */
function hasMessageInValidUserContextProgressive(
  logPath: string,
  userMessage: string,
  initialTailBytes = DEFAULT_LOG_TAIL_BYTES,
  maxTailBytes = MAX_PROGRESSIVE_TAIL_BYTES,
  { userOnly = false }: { userOnly?: boolean } = {}
): boolean {
  let tailBytes = initialTailBytes
  while (tailBytes <= maxTailBytes) {
    const tail = readLogTail(logPath, tailBytes)
    if (!tail) return false
    if (hasMessageInValidUserContext(tail, userMessage, { userOnly })) {
      return true
    }
    if (tailBytes >= maxTailBytes) break
    tailBytes = Math.min(tailBytes * 4, maxTailBytes)
  }
  return false
}

export async function findLogsWithExactMessageAsync(
  userMessage: string,
  logDirs: string | string[],
  {
    minLength = MIN_EXACT_MATCH_LENGTH,
    logPaths,
    tailBytes,
    rgThreads,
    profile,
    userOnly,
  }: ExactMessageSearchOptions = {}
): Promise<string[]> {
  if (!userMessage || userMessage.length < minLength) {
    return []
  }

  const candidatePaths = (logPaths ?? []).filter(Boolean)
  if (candidatePaths.length > 0) {
    return findLogsWithExactMessageInPathsAsync(userMessage, candidatePaths, {
      minLength,
      tailBytes,
      rgThreads,
      profile,
      userOnly,
    })
  }

  const dirs = Array.isArray(logDirs) ? logDirs : [logDirs]
  const allMatches: string[] = []
  const flexiblePattern = messageToFlexiblePattern(userMessage)

  for (const logDir of dirs) {
    const args = ['rg', '-l', '-e', flexiblePattern]
    if (rgThreads && rgThreads > 0) {
      args.push('--threads', String(rgThreads))
    }
    args.push('--glob', '**/*.jsonl', logDir)
    const start = performance.now()
    const result = await runCommandAsync(args, { timeoutMs: RG_COMMAND_TIMEOUT_MS })
    if (profile) {
      profile.rgListRuns += 1
      profile.rgListMs += performance.now() - start
    }

    if (result.exitCode === 0) {
      const matches = result.stdout.trim().split('\n').filter(Boolean)
      allMatches.push(...matches)
    }
  }

  const uniqueMatches = Array.from(new Set(allMatches))
  const validMatches = uniqueMatches.filter((logPath) =>
    hasMessageInValidUserContextProgressive(
      logPath,
      userMessage,
      tailBytes ?? DEFAULT_LOG_TAIL_BYTES,
      undefined,
      { userOnly }
    )
  )

  return validMatches.length > 0 ? validMatches : []
}

export async function findLogsWithExactMessageInPathsAsync(
  userMessage: string,
  logPaths: string[],
  {
    minLength = MIN_EXACT_MATCH_LENGTH,
    tailBytes = DEFAULT_LOG_TAIL_BYTES,
    rgThreads,
    profile,
    userOnly,
  }: ExactMessageSearchOptions = {}
): Promise<string[]> {
  if (!userMessage || userMessage.length < minLength) {
    return []
  }
  const uniquePaths = Array.from(new Set(logPaths)).filter(Boolean)
  if (uniquePaths.length === 0) return []

  const flexiblePattern = messageToFlexiblePattern(userMessage)

  const tailMatches: string[] = []
  if (tailBytes > 0) {
    for (const logPath of uniquePaths) {
      const start = performance.now()
      const tail = readLogTail(logPath, tailBytes)
      if (profile) {
        profile.tailReads += 1
        profile.tailReadMs += performance.now() - start
      }
      if (!tail) continue
      if (hasMessageInValidUserContext(tail, userMessage, { userOnly })) {
        tailMatches.push(logPath)
      }
    }
  }

  if (tailMatches.length === 1) {
    return tailMatches
  }

  const args = ['rg', '-l', '-e', flexiblePattern]
  if (rgThreads && rgThreads > 0) {
    args.push('--threads', String(rgThreads))
  }
  args.push(...uniquePaths)
  const start = performance.now()
  const result = await runCommandAsync(args, { timeoutMs: RG_COMMAND_TIMEOUT_MS })
  if (profile) {
    profile.rgListRuns += 1
    profile.rgListMs += performance.now() - start
  }
  if (result.exitCode !== 0) {
    return tailMatches.length > 0 ? tailMatches : []
  }
  const rgMatches = result.stdout.trim().split('\n').filter(Boolean)
  const validMatches = rgMatches.filter((logPath) =>
    hasMessageInValidUserContextProgressive(logPath, userMessage, tailBytes, undefined, {
      userOnly,
    })
  )

  return validMatches.length > 0 ? validMatches : tailMatches
}

export interface OrderedMatchScore {
  matchedCount: number
  matchedLength: number
  source?: 'tail' | 'rg'
}

async function getRgMatchLinesAsync(
  pattern: string,
  logPath: string,
  search: ExactMatchSearchOptions = {}
): Promise<number[]> {
  const args = ['rg', '--json', '-e', pattern]
  if (search.rgThreads && search.rgThreads > 0) {
    args.push('--threads', String(search.rgThreads))
  }
  args.push(logPath)
  const start = performance.now()
  const result = await runCommandAsync(args, { timeoutMs: RG_COMMAND_TIMEOUT_MS })
  if (search.profile) {
    search.profile.rgJsonRuns += 1
    search.profile.rgJsonMs += performance.now() - start
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return []
  }

  return parseRgMatchLines(result.stdout)
}

function parseRgMatchLines(output: string): number[] {
  const lines: number[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    const record = entry as { type?: string; data?: { line_number?: number } }
    if (record.type !== 'match') continue
    const lineNumber = record.data?.line_number
    if (typeof lineNumber === 'number') {
      lines.push(lineNumber)
    }
  }

  return lines.toSorted((a, b) => a - b)
}

function scoreOrderedMessageMatchesInText(
  text: string,
  messages: string[]
): OrderedMatchScore {
  let matchedCount = 0
  let matchedLength = 0
  let cursor = 0

  for (const message of messages) {
    if (!message) continue
    const pattern = messageToFlexiblePattern(message)
    const regex = new RegExp(pattern, 'g')
    regex.lastIndex = cursor
    const match = regex.exec(text)
    if (!match) {
      continue
    }
    matchedCount += 1
    matchedLength += message.length
    cursor = match.index + match[0].length
  }

  return { matchedCount, matchedLength }
}

export async function scoreOrderedMessageMatchesWithRgAsync(
  logPath: string,
  messages: string[],
  search: ExactMatchSearchOptions = {}
): Promise<OrderedMatchScore> {
  let matchedCount = 0
  let matchedLength = 0
  let lastLine = 0

  for (const message of messages) {
    if (!message) continue
    const pattern = messageToFlexiblePattern(message)
    const matchLines = await getRgMatchLinesAsync(pattern, logPath, search)
    if (matchLines.length === 0) {
      continue
    }
    const nextLine = matchLines.find((line) => line > lastLine)
    if (nextLine === undefined) {
      continue
    }
    matchedCount += 1
    matchedLength += message.length
    lastLine = nextLine
  }

  return { matchedCount, matchedLength }
}

export async function scoreOrderedMessageMatchesAsync(
  logPath: string,
  messages: string[],
  search: ExactMatchSearchOptions = {}
): Promise<OrderedMatchScore> {
  const { tailBytes = DEFAULT_LOG_TAIL_BYTES, profile } = search
  if (messages.length === 0) {
    return { matchedCount: 0, matchedLength: 0, source: 'rg' }
  }

  if (tailBytes > 0) {
    const tailStart = performance.now()
    const tail = readLogTail(logPath, tailBytes)
    if (profile) {
      profile.tailReads += 1
      profile.tailReadMs += performance.now() - tailStart
    }
    if (tail) {
      const start = performance.now()
      const tailScore = scoreOrderedMessageMatchesInText(tail, messages)
      if (profile) {
        profile.tailScoreRuns += 1
        profile.tailScoreMs += performance.now() - start
      }
      const minTailMatches = Math.min(messages.length, MIN_TAIL_MATCH_COUNT)
      if (tailScore.matchedCount >= minTailMatches) {
        return { ...tailScore, source: 'tail' }
      }
    }
  }

  const rgStart = performance.now()
  const fullScore = await scoreOrderedMessageMatchesWithRgAsync(
    logPath,
    messages,
    search
  )
  if (profile) {
    profile.rgScoreRuns += 1
    profile.rgScoreMs += performance.now() - rgStart
  }
  return { ...fullScore, source: 'rg' }
}

export function compareOrderedScores(a: OrderedMatchScore, b: OrderedMatchScore): number {
  if (a.matchedCount !== b.matchedCount) {
    return b.matchedCount - a.matchedCount
  }
  return b.matchedLength - a.matchedLength
}
