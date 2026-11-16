// Resolve only the session ids referenced by the rendered view, batched per frame.
import { useEffect, useMemo } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { requestSessionRows, useArchiveRowsStore } from '../stores/archivedChatRows'

export function sessionReferences(value: unknown): string[] {
  const ids = new Set<string>(), seen = new Set<object>()
  function visit(entry: unknown, key = ''): void {
    if (typeof entry === 'string') {
      if (/sessionId$|^(claimedBy|ownerSession)$/i.test(key)) ids.add(entry)
      return
    }
    if (!entry || typeof entry !== 'object' || seen.has(entry)) return
    seen.add(entry)
    for (const [childKey, child] of Object.entries(entry)) visit(child, childKey)
  }
  visit(value)
  return [...ids]
}
export function useReferencedSessions(references: unknown) {
  const live = useSessionStore(state => state.sessions)
  const archived = useSessionStore(state => state.archivedChats)
  const generation = useArchiveRowsStore(state => state.generation)
  const ids = JSON.stringify(sessionReferences(references))
  useEffect(() => { requestSessionRows(JSON.parse(ids)) }, [ids, generation])
  return useMemo(() => [...live, ...archived.values()], [live, archived])
}
