// Navigator chat search results (chat-session-search D6): a status line that
// doubles as the polite live region, then a listbox of per-chat groups — a
// header (name, worktree, count, newest match time) and up to three snippets
// with the match highlighted. Rows are options of the search box's combobox:
// the box owns the keyboard, so rows only react to clicks (hover never moves
// the active item). Never scrolls horizontally: names truncate, count and
// time stay whole, excerpts clamp to two lines.
import { useEffect, useMemo } from 'react'
import { snippetLabel, type SessionSearchResult, type SessionSearchSnippet } from '@shared/sessionSearch'
import {
  SEARCH_LISTBOX_ID,
  flattenSearchItems,
  useSessionSearchStore,
  type SearchItem,
} from '../stores/sessionSearchStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { openSearchItem } from '../utils/openSearchItem'
import { relativeMatchTime, splitByRanges, worktreeNameFor } from '../utils/searchResultLabels'

interface SessionSearchResultsProps {
  selectedSessionId: string | null
  /** Clock for relative times, refreshed by the navigator. */
  now: number
}

function statusText(status: string, error: string | null, count: number): string {
  if (status === 'loading') return 'Searching…'
  if (status === 'error') return error ?? 'Search failed'
  return count === 0 ? 'No active chat matches' : count === 1 ? '1 chat matches' : `${count} chats match`
}

function Snippet({ snippet, id, active, onOpen }: {
  snippet: SessionSearchSnippet
  id: string
  active: boolean
  onOpen: () => void
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      title={new Date(snippet.at).toLocaleString()}
      onClick={onOpen}
      className={`cursor-pointer py-1 pl-6 pr-3 hover:bg-hover ${active ? 'search-active' : ''}`}
    >
      <div className="text-[10px] text-muted">{snippetLabel(snippet.kind, snippet.tool)}</div>
      <div className="line-clamp-2 break-words text-[11px] text-secondary">
        {splitByRanges(snippet.text, snippet.ranges).map((segment, index) =>
          segment.match
            ? <mark key={index} className="search-match">{segment.text}</mark>
            : <span key={index}>{segment.text}</span>
        )}
      </div>
    </div>
  )
}

export default function SessionSearchResults({ selectedSessionId, now }: SessionSearchResultsProps) {
  const status = useSessionSearchStore(state => state.status)
  const response = useSessionSearchStore(state => state.response)
  const error = useSessionSearchStore(state => state.error)
  const activeIndex = useSessionSearchStore(state => state.activeIndex)
  const snapshot = useWorkspaceStore(state => state.snapshot)
  const worktreePaths = useMemo(
    () => snapshot?.repositories.flatMap(repository => repository.worktrees.map(worktree => worktree.path)) ?? [],
    [snapshot]
  )
  const items = useMemo(() => flattenSearchItems(response), [response])
  const activeId = items[activeIndex]?.id

  useEffect(() => {
    if (!activeId || typeof document === 'undefined') return
    document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const results: SessionSearchResult[] = response?.results ?? []
  const itemsById = useMemo(() => new Map<string, SearchItem>(items.map(item => [item.id, item])), [items])
  const open = (id: string) => openSearchItem(itemsById.get(id)!)

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="session-search-results">
      <div role="status" aria-live="polite" className="shrink-0 px-3 py-1.5 text-[11px] text-muted">
        {statusText(status, error, results.length)}
      </div>
      <div
        id={SEARCH_LISTBOX_ID}
        role="listbox"
        aria-label="Search results"
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        {results.map(result => {
          const headerId = `search-opt-${result.sessionId}`
          const selected = result.sessionId === selectedSessionId
          return (
            <div key={result.sessionId} className="border-b border-border-subtle">
              <div
                id={headerId}
                role="option"
                aria-selected={activeId === headerId}
                onClick={() => open(headerId)}
                className={`session-row flex min-w-0 cursor-pointer items-baseline gap-2 px-3 py-1.5 ${selected ? 'selected' : ''} ${activeId === headerId ? 'search-active' : ''}`}
              >
                <span className="min-w-0 shrink-[3] truncate text-xs font-medium text-primary" title={result.name}>{result.name}</span>
                <span className="min-w-0 shrink truncate text-[11px] text-muted" title={result.projectPath}>
                  {worktreeNameFor(result.projectPath, worktreePaths)}
                </span>
                <span className="ml-auto shrink-0 whitespace-nowrap text-[10px] text-muted">
                  {result.matchCount === 0 ? 'name match' : (
                    <>
                      <span title={`${result.matchCount} matching entries`}>
                        {result.matchCount}<span className="sr-only"> matches</span>
                      </span>
                      {' · '}{relativeMatchTime(result.lastMatchAt, now)}
                    </>
                  )}
                </span>
              </div>
              {result.snippets.map(snippet => {
                const id = `search-opt-${result.sessionId}-${snippet.eventId}`
                return <Snippet key={snippet.eventId} snippet={snippet} id={id} active={activeId === id} onOpen={() => open(id)} />
              })}
            </div>
          )
        })}
      </div>
      {response?.truncated && (
        <div className="shrink-0 px-3 py-1 text-[10px] text-muted">Showing the 50 most recent chats</div>
      )}
      {response && response.unsearchable > 0 && (
        <div className="shrink-0 px-3 py-1 text-[10px] text-muted">
          {response.unsearchable === 1
            ? '1 chat could not be fully searched'
            : `${response.unsearchable} chats could not be fully searched`}
        </div>
      )}
    </div>
  )
}
