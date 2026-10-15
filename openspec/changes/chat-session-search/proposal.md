# Proposal

## Why

With many chat sessions running at once (a lead, several devs, reviewers), the user often knows *what* happened but not *which* session did it, for example which session opened PR #147. Today the only way to find out is to open sessions one by one and scroll, because nothing in kawai searches conversation content. The navigator filters by project and host only.

## What Changes

- A search box in the navigator's filter bar searches the conversation content of every active chat session: local and not archived, whether or not its agent is running.
- Matching is a case-insensitive literal substring. A query of `#147`, `pull/147`, or `147` finds the `gh pr create` output, the assistant text, or the peer message that mentions the PR. Searched text covers user and peer messages, assistant text, tool inputs, tool results, command output, notices, and errors. The session name also counts as a match.
- Results are grouped by session. Each group shows the session name, its project or worktree, the match count, and up to three highlighted snippets. Groups are ordered by the most recent matching event.
- Choosing a snippet selects that session, opens its chat, then scrolls to the matched transcript entry and briefly highlights it. Choosing the session header only opens the session.
- `[modifier]+K` focuses the search box. Escape clears the search and restores the normal navigator.
- Results are labeled and keyboard-driven:
  - Each snippet is labeled with its entry kind, such as `Tool result · Bash`.
  - Each group shows its worktree name and the relative time of its newest match.
  - Excerpts are clamped to two lines.
  - ↑/↓ move through the results and Enter opens one, while focus stays in the box.
  - The open chat's group is marked like a selected row.
  - Screen readers get the box's name, the active option, and the result count.
  - Rows truncate rather than scroll in a narrow navigator.
- The server answers searches through a new read-only REST endpoint. It searches each session's already-loaded history and reads the transcripts of unloaded sessions without caching them, so a search never makes every transcript stay in memory.
- Transcript rows get stable event-id anchors in the DOM so the chat view can scroll to a given event.

Out of scope (assumptions recorded in design.md): archived chats, terminal (tmux) sessions, sessions on remote hosts, regex or fuzzy matching, a persistent full-text index, and agent-facing (MCP) search.

## Capabilities

### New Capabilities
- `chat-session-search`: searching conversation content across active chat sessions, covering the query rules, which text is searched, how results are shaped, and how a user jumps from a result to the matched entry in the transcript.

### Modified Capabilities
- `workspace-navigation`: the navigator's filter bar gains the search box and its keyboard shortcut. While a query is active, search results replace the section list. The results are navigable from the box, mark the open chat, are accessible, and fit a narrow navigator. Clearing the query restores the sections with the existing project, host, and selection behavior unchanged.

## Impact

- **Server:** a new `src/server/chat/sessionSearch.ts` with pure matching and snippet extraction over `ChatEvent[]`, plus a session walker. A new `GET /api/chat/search` route in `src/server/routes/` is registered in `bootstrap.ts`. `ChatSessionManager` gains a read-only accessor that returns a session's loaded events, or replays its transcript without caching.
- **Shared:** search request and result types in `src/shared/`.
- **Client:**
  - A search input and results list in the navigator (`SessionList.tsx` plus new components) and a small search store.
  - `[mod]+K` in `App.tsx`.
  - `data-anchor-id` anchors with scroll-to-and-highlight in `ChatMessages.tsx`/`ChatView.tsx`.
  - Per-theme highlight variables and classes in `src/client/styles/index.css`.
- No database schema, WebSocket protocol, or dependency changes.
