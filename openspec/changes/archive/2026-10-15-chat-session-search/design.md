# Design

## Context

Conversation content is not stored in SQLite. `chat_sessions` holds metadata only. A chat's full history, including tool inputs and untruncated tool results, lives in the Claude Code transcript JSONL (`<CLAUDE_CONFIG_DIR>/projects/**/<sdkSessionId>.jsonl`).

`ChatSessionManager` keeps two in-memory stores per session:

- `snapshotHistory` memoizes the replayed transcript. It is filled by `loadHistory` on first attach and kept until kill.
- `liveEvents` holds every event the driver emitted since then.

`getSnapshot` serves `[...snapshotHistory, ...liveEvents]`. After a server restart, neither store exists for a session until something attaches to it.

Replayed event ids are deterministic. They are `hist-<line uuid>` or derived from block ids, so two replays of the same file yield the same ids. `ChatMessages.tsx` renders the transcript without virtualization, keyed by `event.id` (tool rows by `tool:<toolCallId>`), but it emits no DOM anchors. The navigator (`SessionList.tsx`) has a filter bar with host and project dropdowns only. `[modifier]+K` is unused in `App.tsx`.

## Goals / Non-Goals

**Goals:**
- One request searches every active chat and returns ids that the chat view can scroll to.
- Search never grows server memory permanently and never starts an agent.
- Pure, unit-testable matching and snippet logic, separate from I/O.

**Non-Goals:**
- A persistent full-text index (FTS5) or incremental indexing.
- Live-updating results while the query stays unchanged.
- Archived chats, terminal sessions, remote hosts, and agent (MCP) access to search.
- Highlighting every occurrence inside the opened transcript. Only the chosen entry is highlighted.

## Decisions

### D1. Scan on demand, with no index
Each search walks the active chats and scans their events in memory. A loaded chat uses `snapshotHistory` plus `liveEvents`, the same array `getSnapshot` serves. An unloaded chat gets a transient `replayTranscriptFileAsync(findTranscriptPathAsync(sdkSessionId))` whose result is discarded, not memoized. That keeps the "no transcript kept in memory" requirement and leaves `loadHistory` semantics unchanged.

*Alternative:* call `loadHistory` for each unloaded chat. It is simpler, but every search would pin every transcript in memory until kill, and `loadHistory` also applies cwd catch-up, which is a side effect.

*Alternative:* an SQLite FTS5 index fed from driver events and a backfill. It is faster at scale, but it adds a schema, a backfill, and consistency work with the transcript. That is not justified at kawai's scale of tens of chats. If profiling shows a need, the scan can be swapped behind the same endpoint later.

Unloaded transcripts are replayed with bounded concurrency (4). Their ids match what a later attach produces, because replay ids are deterministic. Replay's `excludeToolCallIds` matters only for loaded sessions, which take the memo path.

### D2. Pure matcher in `src/server/chat/sessionSearch.ts`
`searchEvents(events, query)` takes a `ChatEvent[]` and a lowercased query. It returns the match count and the newest three `{ eventId, anchorId, kind, at, snippet }`. The searchable text per kind is:

- `user_message.text`, `assistant_text.text`, `command_output.text`, `notice.text`, `error.message`, `tool_result.output`
- `peer_message.body`, plus its task title
- `tool_call`: `tool` plus a compact `JSON.stringify(input)`
- `approval_request`: `tool` plus its input

`assistant_delta` is skipped because the final `assistant_text` carries the same text. Everything else is skipped.

For tool events, `anchorId` is `tool:<toolCallId>`; for other events it is the event id. That is how the client finds the rendered row.

A snippet is about 60 characters either side of the first occurrence in the entry. Whitespace is collapsed and cuts are marked with `…`. The offsets of every occurrence inside the excerpt are returned as `ranges`, so the client highlights without re-matching. Each snippet also carries its `tool` name: `tool_call` and `approval_request` events have it directly, and a `tool_result` looks it up through a `toolCallId → tool` map built in the same pass. The client derives the label from `kind` and `tool`. A query that matches `session.name` sets `nameMatch: true`.

A thin walker `searchActiveSessions(manager, query)` iterates the non-archived local chat records, sorts groups by their newest match's `at`, caps the list at 50 (`truncated: true` beyond that), and counts `unsearchable` chats whose replay returned the `hist-unavailable` notice or threw.

### D3. REST endpoint, not a WebSocket message
`GET /api/chat/search?q=<query>` returns `{ query, results: SessionSearchResult[], truncated, unsearchable }`, with types in `src/shared/sessionSearch.ts`. The route lives in `src/server/routes/chatSearch.ts` and is registered in `bootstrap.ts` beside `/api/chat/profiles`. It returns 400 when the trimmed query is outside 2–200 characters, mirroring the client guard.

The REST endpoint is a natural request/response shape. Superseded requests can be cancelled with `AbortController`. It also avoids the chat router's `chat-*` requirement for a `sessionId` and avoids extending `CHAT_CONNECTION_TYPES`.

*Alternative:* a `session-search` WebSocket message with a request id. It works, but it needs a new router prefix branch plus manual stale-response handling, for no benefit.

### D4. Client: search store and navigator results
A small Zustand store (`sessionSearchStore.ts`) holds `query`, `status` (`idle`/`loading`/`ready`/`error`), the results, and the in-flight `AbortController`. Setting the query debounces for 250 ms, aborts the previous fetch, and accepts a response only if its `query` equals the current query. Both mechanisms are kept: abort saves work, and the equality check guards against races.

`SessionSearchBox` sits in the filter bar. `SessionSearchResults` replaces the navigator body while the query is searchable. Section collapse state and filters are untouched, because the sections are simply not rendered. Escape and an empty query clear the store. `[modifier]+K` in `App.tsx` focuses and selects the box through a ref or event.

### D5. Jump-to-entry via a pending-reveal handshake
Choosing a snippet selects the session as a normal selection would and sets `chatStore.pendingReveal = { sessionId, anchorId }`. Each transcript row gets `data-anchor-id` (the event id, or `tool:<toolCallId>` for tool rows). After a render with events, `ChatView` checks for a pending reveal on its session. It queries `[data-anchor-id="…"]` (escaped with `CSS.escape`), calls `scrollIntoView({ block: 'center' })`, adds a highlight class for about 2 s, and clears the reveal. The reveal suppresses ChatView's stick-to-bottom for that render.

If the snapshot has arrived and the anchor is absent, the reveal is dropped silently. Rows grouped into a single tool card share the tool anchor, so a `tool_call` match and a `tool_result` match land on the same card.

### D6. UI layout and interaction

Navigator while a query is active (default width; `▸` marks the keyboard-active item; `┃` marks the selected chat's header):

```
┌──────────────────────────────────────────┐
│ [Projects ▾]  [🔍 #147               ✕ ] │  ← filter bar (h-10)
├──────────────────────────────────────────┤
│ 3 chats match                            │  ← status line (also the live region text)
│┃middle-dev fix-login        4 · 10m ago  │  ← group header: name, worktree, count, time
│   Tool result · Bash                     │
│   …Creating pull request… https://github │  ← excerpt, ≤2 lines, match in <mark>
│   .com/acme/app/pull/[147]…              │
│ ▸ You                                    │
│   …please review [#147] before merging…  │
│  lead  kawai                 1 · 1h ago  │
│   Team message                           │
│   …dev reports PR [#147] is open…        │
│  reviewer  fix-login         name match  │  ← name-only match, no snippets
│ 1 chat could not be fully searched       │  ← shown only when unsearchable > 0
└──────────────────────────────────────────┘
```

- **Box.** `SessionSearchBox` is `flex-1 min-w-32` after the dropdowns. Its placeholder is `Search chats`. A muted `kbd` hint reading the configured modifier plus `K` shows while the box is empty and unfocused, and a ✕ clear button shows while it has text. The box acts as the combobox (`role="combobox"`, `aria-expanded`, `aria-controls` pointing at the list, `aria-activedescendant` naming the active option). Keys handled in the box: ↑/↓ (clamped, no wrap, `scrollIntoView({ block: 'nearest' })` on the active item), Enter (opens the active item; does nothing when none is active), Escape (clears). Focus never leaves the box on Enter, so the user can keep going down the list.
- **List.** `role="listbox"`. Each header and snippet is a `role="option"` with a stable DOM id (`search-opt-<sessionId>` or `search-opt-<sessionId>-<anchorId>`). The active index is client state in the search store. It resets to none whenever results are replaced, and pointer hover never changes it; click opens directly.
- **Header row.** A single line: the name (`truncate`, `flex-shrink` 3), then the worktree name (`truncate`, `flex-shrink` 1, `title` = full path), then `count · formatRelativeTime(lastMatchAt)` from `src/client/utils/time.ts` (`shrink-0 whitespace-nowrap`). A name-only match shows `name match` in place of the count. The worktree name comes from the client's workspace snapshot: the worktree whose root contains `projectPath`, matching the navigator's section placement, else the path's basename. The selected chat's header reuses the navigator's existing `session-row selected` CSS.
- **Snippet row.** The label is muted on its own line. The excerpt sits below it in `line-clamp-2 break-words`, with `title` = absolute local time. Matches render as `<mark class="search-match">` from `ranges`. There is no horizontal scroll anywhere (`min-w-0`, `overflow-x-hidden` on the list).
- **Colors.** Tailwind `/opacity` modifiers on `var()` colors emit nothing in this project, so highlights are plain CSS classes in `src/client/styles/index.css` with new per-theme variables: `--search-match-bg` and `--search-match-fg`, defined for `:root`, `[data-theme="light"]`, and the chat palette. `.search-match` uses them. `.search-active` is a 2 px inset `var(--accent)` outline for the keyboard-active item. `.chat-reveal` animates the revealed transcript row from `--search-match-bg` to transparent over about 2 s, and honors `prefers-reduced-motion` with a static 2 s highlight that is then removed. Contrast is checked by eye in both themes during the browser verification task.
- **Status line and announcements.** A single `aria-live="polite"` element above the list renders `Searching…`, `N chats match` (`1 chat matches`), `No active chat matches`, or the error. Its text changes once per settled state, which gives the single announcement. Footer notes cover `truncated` ("Showing the 50 most recent chats") and `unsearchable`.

## Risks / Trade-offs

- [A cold search replays every unloaded transcript, which can take seconds with large JSONL files] → Use bounded concurrency, and show the loading state in the navigator. Later searches stay just as cold, which is accepted for now. A short-lived (for example 30 s) per-file cache keyed by mtime is a cheap follow-up if needed.
- [A short query like `14` matches many entries] → The 2-character minimum, the per-session snippet cap, and the 50-group cap bound the payload, and counts still convey breadth.
- [Event ids differ between the replay path and live ids after a restart] → Search and snapshot read the same source at the same moment, and replay ids are deterministic. A stale result only fails to scroll, as the spec allows.
- [Tool inputs and results may contain secrets that now render in navigator snippets] → They are already visible in that chat's transcript on the same client, so no new exposure. Search is local-server only, like the rest of the API.
- [Searching JSON-stringified tool input matches keys such as `"command"`] → Accepted. The snippet shows the context, and the user's queries are content values in practice.

## Migration Plan

This change is additive: no schema or protocol changes. Rolling back removes the route and the UI.
