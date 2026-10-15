// Walks the active chat sessions for a conversation search
// (chat-session-search D2): reads each session's events through a read-only
// source, matches them with the pure matcher, and shapes the grouped
// response. Reading is bounded-concurrent so a cold search over many
// unloaded transcripts does not parse them all at once.

import type { ChatEvent } from '../../shared/chat'
import {
  SEARCH_MAX_SESSIONS,
  type SessionSearchResponse,
  type SessionSearchResult,
} from '../../shared/sessionSearch'
import { literalMatcher, searchEvents } from './sessionSearch'

/** Transcripts replayed at once during a search. */
const READ_CONCURRENCY = 4

/** The slice of ChatSessionManager a search needs. */
export interface SearchSource {
  activeRecords(): Array<{ sessionId: string; name: string; projectPath: string; lastActivityAt: string }>
  searchableEvents(sessionId: string): Promise<{ events: ChatEvent[]; readable: boolean }>
}

/** Search every active chat for the (already normalized) query. */
export async function searchActiveSessions(source: SearchSource, query: string): Promise<SessionSearchResponse> {
  const records = source.activeRecords()
  const results: SessionSearchResult[] = []
  let unsearchable = 0
  let next = 0

  const worker = async () => {
    for (let index = next++; index < records.length; index = next++) {
      const record = records[index]!
      let events: ChatEvent[] = []
      try {
        const read = await source.searchableEvents(record.sessionId)
        events = read.events
        if (!read.readable) unsearchable++
      } catch {
        unsearchable++
      }
      const found = searchEvents(events, query)
      const nameMatch = literalMatcher(query).test(record.name)
      if (found.matchCount === 0 && !nameMatch) continue
      results.push({
        sessionId: record.sessionId,
        name: record.name,
        projectPath: record.projectPath,
        matchCount: found.matchCount,
        nameMatch,
        lastMatchAt: found.lastMatchAt ?? record.lastActivityAt,
        snippets: found.snippets,
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, records.length) }, worker))

  results.sort((a, b) => b.lastMatchAt.localeCompare(a.lastMatchAt) || a.name.localeCompare(b.name))
  return {
    query,
    results: results.slice(0, SEARCH_MAX_SESSIONS),
    truncated: results.length > SEARCH_MAX_SESSIONS,
    unsearchable,
  }
}
