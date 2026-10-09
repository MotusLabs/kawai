// Replay of an SDK transcript (JSONL under CLAUDE_CONFIG_DIR/projects) into
// read-only ChatEvents for chat history. Best-effort parser per design D5:
// unknown lines are ignored, a missing or unparseable file degrades to a
// "history unavailable" notice, and tool_use blocks with no tool_result —
// the only marker of a request that died with the process — are replayed as
// request pairs that history immediately marks cancelled (design D7).
import fs from 'node:fs'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import { getClaudeConfigDir } from '../logDiscovery'
import {
  ASK_USER_QUESTION_TOOL,
  parseQuestions,
  toolResultText,
} from './contentBlocks'

export type TranscriptReplayStatus = 'ok' | 'missing' | 'unparseable'

/** Recorded `<command-name>` markup (both CLI generations, any tag order). */
const COMMAND_NAME_TAG = /<command-name>\s*([^<]*?)\s*<\/command-name>/
const COMMAND_ARGS_TAG = /<command-args>([\s\S]*?)<\/command-args>/
const LOCAL_COMMAND_STDOUT_TAG = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/

/**
 * A user record Claude Code writes for a typed slash command, mapped back to
 * what the user typed: `/name` plus trimmed `<command-args>` when present.
 * Null when the text carries no `<command-name>` markup (unknown shapes fall
 * back to current rendering).
 */
function parseCommandMarkup(text: string): string | null {
  const name = COMMAND_NAME_TAG.exec(text)?.[1]?.replace(/^\/+/, '')
  if (!name) return null
  const args = COMMAND_ARGS_TAG.exec(text)?.[1]?.trim() ?? ''
  return `/${name}${args ? ` ${args}` : ''}`
}

/**
 * Inner text of a recorded `<local-command-stdout>` block; null when the
 * record carries no stdout markup or it is empty (nothing to replay).
 */
function parseLocalCommandStdout(text: string): string | null {
  const inner = LOCAL_COMMAND_STDOUT_TAG.exec(text)?.[1]
  return inner && inner.trim() ? inner : null
}

export interface TranscriptReplay {
  status: TranscriptReplayStatus
  /**
   * Replayed history events, or a single "history unavailable" notice when
   * the transcript is missing/unparseable. Events carry `sequence: 0` (order
   * is the array order) and stable ids derived from the transcript, so
   * re-parses of the same file produce the same ids.
   */
  events: ChatEvent[]
}

export interface ParsedTranscript {
  events: ChatEvent[]
  /** tool_use ids with no matching tool_result in this transcript. */
  unmatchedToolCallIds: string[]
  /** Lines that were not valid JSON (truncated tail, corruption). */
  invalidLines: number
}

/**
 * Locate `<sdkSessionId>.jsonl` under the Claude config's projects dir.
 * Searched by filename rather than an encoded project path: the encoding of
 * the session's cwd is not ours to reconstruct (worktree dirs encode with a
 * doubled separator), while the file name is exactly the SDK session id.
 */
export function findTranscriptPath(sdkSessionId: string): string | null {
  const name = `${sdkSessionId}.jsonl`
  const root = path.join(getClaudeConfigDir(), 'projects')
  return findNewestFile(root, name, 3)
}

function findNewestFile(
  root: string,
  fileName: string,
  maxDepth: number
): string | null {
  // Mutable holder: the walk is recursive and TS cannot see those writes.
  const best = { path: null as string | null, mtime: -1 }
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1)
      } else if (entry.isFile() && entry.name === fileName) {
        const mtime = fs.statSync(full).mtimeMs
        if (mtime > best.mtime) {
          best.path = full
          best.mtime = mtime
        }
      }
    }
  }
  walk(root, 0)
  return best.path
}

/**
 * Parse transcript JSONL content into read-only events. Tolerant: lines that
 * are not valid JSON and lines of an unknown kind are skipped. `unmatchedToolCallIds`
 * lists tool uses that never got a result — see `withCancelledRequests`.
 */
export function parseTranscriptContent(content: string): ParsedTranscript {
  const events: ChatEvent[] = []
  const resultToolCallIds = new Set<string>()
  const unmatchedCandidates: string[] = []
  let invalidLines = 0
  let turnCounter = 0
  let lineIndex = 0

  for (const rawLine of content.split('\n')) {
    lineIndex += 1
    const line = rawLine.trim()
    if (!line) continue
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object') {
        invalidLines += 1
        continue
      }
      record = parsed as Record<string, unknown>
    } catch {
      // Truncated last line or corruption: skip, the caller decides if the
      // file as a whole is unparseable.
      invalidLines += 1
      continue
    }
    if (record.isMeta === true || record.isSidechain === true) continue
    const type = record.type
    const lineUuid =
      typeof record.uuid === 'string' && record.uuid
        ? record.uuid
        : `line-${lineIndex}`
    const at =
      typeof record.timestamp === 'string' && record.timestamp
        ? record.timestamp
        : new Date().toISOString()
    const message = asRecord(record.message)
    const contentValue = message?.content

    if (type === 'system') {
      if (record.subtype === 'compact_boundary') {
        events.push({
          id: `hist-${lineUuid}`,
          sequence: 0,
          at,
          type: 'notice',
          text: 'Context compacted',
        })
      } else if (
        record.subtype === 'local_command' &&
        typeof record.content === 'string'
      ) {
        const output = parseLocalCommandStdout(record.content)
        if (output !== null) {
          events.push({
            id: `hist-${lineUuid}`,
            sequence: 0,
            at,
            type: 'command_output',
            turnId: `hist-turn-${turnCounter}`,
            text: output,
          })
        }
      }
      // Other system subtypes are informational; ignored.
      continue
    }
    if (type === 'user' || type === 'assistant') {
      if (typeof contentValue === 'string') {
        if (type === 'user') {
          const typed = parseCommandMarkup(contentValue) ?? contentValue
          if (typed.length > 0) {
            turnCounter += 1
            events.push({
              id: `hist-${lineUuid}`,
              sequence: 0,
              at,
              type: 'user_message',
              turnId: `hist-turn-${turnCounter}`,
              text: typed,
            })
          }
        } else {
          // Assistant lines carry blocks, not plain text; tolerate a string
          // form if the writer ever produces one.
          events.push({
            id: `hist-${lineUuid}`,
            sequence: 0,
            at,
            type: 'assistant_text',
            turnId: `hist-turn-${turnCounter}`,
            messageId: stringField(message, 'id') ?? lineUuid,
            text: contentValue,
          })
        }
        continue
      }
      const blocks = Array.isArray(contentValue) ? contentValue : []
      let blockIndex = 0
      for (const block of blocks) {
        blockIndex += 1
        const blockRecord = asRecord(block)
        if (!blockRecord) continue
        const blockId = `hist-${lineUuid}-${blockIndex}`
        const turnId = `hist-turn-${turnCounter}`
        const blockType = blockRecord.type
        if (blockType === 'text' && typeof blockRecord.text === 'string') {
          if (type === 'user') {
            const typed = parseCommandMarkup(blockRecord.text) ?? blockRecord.text
            if (typed.length > 0) {
              turnCounter += 1
              events.push({
                id: blockId,
                sequence: 0,
                at,
                type: 'user_message',
                turnId: `hist-turn-${turnCounter}`,
                text: typed,
              })
            }
          } else {
            events.push({
              id: blockId,
              sequence: 0,
              at,
              type: 'assistant_text',
              turnId,
              messageId: stringField(message, 'id') ?? lineUuid,
              text: blockRecord.text,
            })
          }
        } else if (blockType === 'tool_use') {
          const toolCallId =
            typeof blockRecord.id === 'string' ? blockRecord.id : ''
          if (!toolCallId) continue
          unmatchedCandidates.push(toolCallId)
          events.push({
            id: blockId,
            sequence: 0,
            at,
            type: 'tool_call',
            turnId,
            toolCallId,
            tool:
              typeof blockRecord.name === 'string' ? blockRecord.name : 'tool',
            input: blockRecord.input,
          })
        } else if (blockType === 'tool_result') {
          const toolCallId =
            typeof blockRecord.tool_use_id === 'string'
              ? blockRecord.tool_use_id
              : ''
          if (!toolCallId) continue
          resultToolCallIds.add(toolCallId)
          events.push({
            id: blockId,
            sequence: 0,
            at,
            type: 'tool_result',
            turnId,
            toolCallId,
            output: toolResultText(blockRecord.content),
            ...(blockRecord.is_error === true ? { isError: true } : {}),
          })
        }
        // thinking and other block kinds are not surfaced in history.
      }
      continue
    }
    // Unknown line types (mode, cost-state, file-history, ...) are ignored.
  }

  return {
    events,
    unmatchedToolCallIds: unmatchedCandidates.filter(
      (id) => !resultToolCallIds.has(id)
    ),
    invalidLines,
  }
}

/**
 * Splice a request pair after each still-unmatched tool_call: the request the
 * process died holding, immediately marked cancelled. A live driver's
 * in-flight tool ids can be excluded — those are covered by live events.
 */
export function withCancelledRequests(
  events: ChatEvent[],
  unmatchedToolCallIds: string[],
  options?: { excludeToolCallIds?: Set<string> }
): ChatEvent[] {
  const pending = new Set(
    unmatchedToolCallIds.filter(
      (id) => !options?.excludeToolCallIds?.has(id)
    )
  )
  if (pending.size === 0) return events
  const result: ChatEvent[] = []
  for (const event of events) {
    result.push(event)
    if (event.type !== 'tool_call' || !pending.has(event.toolCallId)) continue
    pending.delete(event.toolCallId)
    const requestEvent = cancelledRequestEvent(event)
    result.push(requestEvent, {
      id: `hist-cancel-${event.toolCallId}`,
      sequence: 0,
      at: event.at,
      type: 'request_resolved',
      requestId: event.toolCallId,
      outcome: 'cancelled',
    })
  }
  return result
}

function cancelledRequestEvent(
  event: Extract<ChatEvent, { type: 'tool_call' }>
): ChatEvent {
  const questions =
    event.tool === ASK_USER_QUESTION_TOOL && isRecord(event.input)
      ? parseQuestions(event.input)
      : null
  if (questions) {
    return {
      id: `hist-ask-${event.toolCallId}`,
      sequence: 0,
      at: event.at,
      type: 'question_request',
      turnId: event.turnId,
      requestId: event.toolCallId,
      questions,
    }
  }
  return {
    id: `hist-ask-${event.toolCallId}`,
    sequence: 0,
    at: event.at,
    type: 'approval_request',
    turnId: event.turnId,
    requestId: event.toolCallId,
    tool: event.tool,
    input: event.input,
  }
}

/**
 * Replay a transcript file into history events. `filePath: null` counts as
 * missing. A missing or unreadable/unparseable file yields the
 * "history unavailable" notice; the caller decides whether resume is still
 * allowed (design D5: an existing-but-unparseable transcript may resume —
 * the SDK reads the file itself — while a missing one may not).
 */
export function replayTranscriptFile(
  filePath: string | null,
  options?: { excludeToolCallIds?: Set<string> }
): TranscriptReplay {
  if (!filePath) return historyUnavailable('missing')
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return historyUnavailable(code === 'ENOENT' ? 'missing' : 'unparseable')
  }
  try {
    const parsed = parseTranscriptContent(content)
    // Content that produced no events at all but failed to parse is a parser
    // failure; an empty or bookkeeping-only file is simply an empty history.
    if (parsed.events.length === 0 && parsed.invalidLines > 0) {
      return historyUnavailable('unparseable')
    }
    return {
      status: 'ok',
      events: withCancelledRequests(
        parsed.events,
        parsed.unmatchedToolCallIds,
        options
      ),
    }
  } catch {
    return historyUnavailable('unparseable')
  }
}

function historyUnavailable(
  status: 'missing' | 'unparseable'
): TranscriptReplay {
  return {
    status,
    events: [
      {
        id: 'hist-unavailable',
        sequence: 0,
        at: new Date().toISOString(),
        type: 'notice',
        text:
          status === 'missing'
            ? 'History unavailable — the conversation transcript was not found. Restore it or create a new chat session to start over.'
            : 'History unavailable — the conversation transcript could not be parsed.',
      },
    ],
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null
}

function stringField(
  record: Record<string, unknown> | null,
  key: string
): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value ? value : null
}
