// Pure matching for chat session search (chat-session-search D2): finds the
// conversation entries of one session that contain a literal,
// case-insensitive query and shapes them into bounded snippets. No I/O — the
// walker in sessionSearchWalker.ts feeds it each session's events.

import type { ChatEvent } from '../../shared/chat'
import { validTime } from '../../shared/chatTime'
import {
  SEARCH_SNIPPETS_PER_SESSION,
  type SearchEntryKind,
  type SessionSearchSnippet,
} from '../../shared/sessionSearch'

/** Characters of context kept either side of the first occurrence. */
const SNIPPET_CONTEXT = 60
const ELLIPSIS = '…'

export interface EventSearchResult {
  /** Entries containing the query. */
  matchCount: number
  /** ISO time of the newest matching entry; null when nothing matched. */
  lastMatchAt: string | null
  /** The newest few matches, newest first. */
  snippets: SessionSearchSnippet[]
}

interface Searchable {
  kind: SearchEntryKind
  tool?: string
  text: string
  anchorId: string
}

/** A literal, case-insensitive, global matcher for the query. */
export function literalMatcher(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
}

function inputText(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    return ''
  }
}

/** The text one event contributes to search, or null when it contributes none. */
function searchableOf(event: ChatEvent, toolByCall: Map<string, string>): Searchable | null {
  switch (event.type) {
    case 'user_message':
      return { kind: 'user', text: event.text, anchorId: event.id }
    case 'assistant_text':
      return { kind: 'assistant', text: event.text, anchorId: event.id }
    case 'peer_message':
      return {
        kind: 'peer',
        text: event.task ? `${event.body}\n${event.task.title}` : event.body,
        anchorId: event.id,
      }
    case 'command_output':
      return { kind: 'command_output', text: event.text, anchorId: event.id }
    case 'tool_call':
      return {
        kind: 'tool_input', tool: event.tool,
        text: `${event.tool} ${inputText(event.input)}`,
        anchorId: `tool:${event.toolCallId}`,
      }
    case 'tool_result':
      return {
        kind: 'tool_result', tool: toolByCall.get(event.toolCallId),
        text: event.output, anchorId: `tool:${event.toolCallId}`,
      }
    case 'approval_request':
      return {
        kind: 'approval', tool: event.tool,
        text: `${event.tool} ${inputText(event.input)}`,
        anchorId: event.id,
      }
    case 'notice':
      // The replay placeholder is not conversation content.
      return event.id === 'hist-unavailable' ? null : { kind: 'notice', text: event.text, anchorId: event.id }
    case 'error':
      return { kind: 'error', text: event.message, anchorId: event.id }
    default:
      // assistant_delta is the final assistant_text before it lands; turn
      // bookkeeping and question cards carry no searchable prose.
      return null
  }
}

/** A bounded excerpt around the first match, with every occurrence's range. */
function excerptOf(text: string, first: RegExpExecArray, matcher: RegExp): Pick<SessionSearchSnippet, 'text' | 'ranges'> {
  const start = Math.max(0, first.index - SNIPPET_CONTEXT)
  const end = Math.min(text.length, first.index + first[0].length + SNIPPET_CONTEXT)
  const window = text.slice(start, end)
  const prefix = start > 0 ? ELLIPSIS : ''
  const ranges: Array<{ start: number; end: number }> = []
  matcher.lastIndex = 0
  for (let m = matcher.exec(window); m; m = matcher.exec(window)) {
    ranges.push({ start: prefix.length + m.index, end: prefix.length + m.index + m[0].length })
  }
  // One whitespace character becomes one space, so the ranges stay valid.
  return {
    text: `${prefix}${window.replace(/\s/g, ' ')}${end < text.length ? ELLIPSIS : ''}`,
    ranges,
  }
}

/** Search one session's events for the (already trimmed) query. */
export function searchEvents(events: readonly ChatEvent[], query: string): EventSearchResult {
  // An empty pattern matches everywhere; callers pass normalized queries.
  if (query === '') return { matchCount: 0, lastMatchAt: null, snippets: [] }
  const toolByCall = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool_call') toolByCall.set(event.toolCallId, event.tool)
  }
  const matcher = literalMatcher(query)
  const snippets: SessionSearchSnippet[] = []
  let matchCount = 0
  let lastMatchAt: string | null = null
  // Newest first: the events array is chronological.
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    const searchable = searchableOf(event, toolByCall)
    if (!searchable) continue
    matcher.lastIndex = 0
    const first = matcher.exec(searchable.text)
    if (!first) continue
    matchCount++
    // Undated history rows (empty `at`) never stand in as the match time.
    if (validTime(event.at)) lastMatchAt ??= event.at
    if (snippets.length >= SEARCH_SNIPPETS_PER_SESSION) continue
    snippets.push({
      eventId: event.id,
      anchorId: searchable.anchorId,
      kind: searchable.kind,
      ...(searchable.tool ? { tool: searchable.tool } : {}),
      at: event.at,
      ...excerptOf(searchable.text, first, matcher),
    })
  }
  return { matchCount, lastMatchAt, snippets }
}
