// Chat session search contract (chat-session-search): the REST response of
// GET /api/chat/search, the query bounds the client and server share, and the
// snippet label. SDK-independent so the client imports it freely.

/** Query length bounds, applied after trimming. */
export const SEARCH_QUERY_MIN = 2
export const SEARCH_QUERY_MAX = 200

/** Snippets returned per session, and sessions returned per search. */
export const SEARCH_SNIPPETS_PER_SESSION = 3
export const SEARCH_MAX_SESSIONS = 50

/** The trimmed query when it is searchable, else null. */
export function normalizeSearchQuery(raw: string): string | null {
  const query = raw.trim()
  return query.length >= SEARCH_QUERY_MIN && query.length <= SEARCH_QUERY_MAX ? query : null
}

/** Which kind of transcript entry a snippet came from. */
export type SearchEntryKind =
  | 'user'
  | 'assistant'
  | 'peer'
  | 'tool_input'
  | 'tool_result'
  | 'approval'
  | 'command_output'
  | 'notice'
  | 'error'

/** Half-open `[start, end)` character range inside a snippet's `text`. */
export interface SearchRange {
  start: number
  end: number
}

export interface SessionSearchSnippet {
  eventId: string
  /** DOM anchor of the rendered row: the event id, or `tool:<toolCallId>`. */
  anchorId: string
  kind: SearchEntryKind
  /** Tool name for tool input/result and approval entries. */
  tool?: string
  /** ISO timestamp of the entry. */
  at: string
  /** Excerpt around the first occurrence, whitespace collapsed. */
  text: string
  /** Every occurrence of the query inside `text`. */
  ranges: SearchRange[]
}

export interface SessionSearchResult {
  sessionId: string
  name: string
  projectPath: string
  matchCount: number
  /** The chat's name contains the query. */
  nameMatch: boolean
  /** ISO time of the newest match (the session's activity time for a name-only match). */
  lastMatchAt: string
  snippets: SessionSearchSnippet[]
}

export interface SessionSearchResponse {
  query: string
  results: SessionSearchResult[]
  /** More sessions matched than `SEARCH_MAX_SESSIONS`. */
  truncated: boolean
  /** Active chats whose transcript could not be read. */
  unsearchable: number
}

const KIND_LABELS: Record<Exclude<SearchEntryKind, 'tool_input' | 'tool_result' | 'approval'>, string> = {
  user: 'You',
  assistant: 'Assistant',
  peer: 'Team message',
  command_output: 'Command output',
  notice: 'Notice',
  error: 'Error',
}

/** Label shown at the start of a snippet: `Tool result · Bash`, `You`, … */
export function snippetLabel(kind: SearchEntryKind, tool?: string): string {
  if (kind === 'tool_input' || kind === 'tool_result' || kind === 'approval') {
    const base = kind === 'tool_input' ? 'Tool input' : kind === 'tool_result' ? 'Tool result' : 'Approval'
    return tool ? `${base} · ${tool}` : base
  }
  return KIND_LABELS[kind]
}
