# Tasks

## 1. Shared contract and pure matcher

- [ ] 1.1 Add `src/shared/sessionSearch.ts` (header comment) with `SessionSearchResponse` (`query`, `results`, `truncated`, `unsearchable`), `SessionSearchResult` (`sessionId`, `name`, `projectPath`, `matchCount`, `nameMatch`, `lastMatchAt`, `snippets`), `SessionSearchSnippet` (`eventId`, `anchorId`, `kind`, `at`, `text`, `ranges`), and the 2–200 character `normalizeSearchQuery` guard shared by client and server; verify with `bun run typecheck` and a unit test of the guard (trim, too short, too long)
- [ ] 1.2 Add `src/server/chat/sessionSearch.ts` with the pure `searchEvents(events, query)` from design D2 (searchable text per kind, `assistant_delta` skipped, `tool:<toolCallId>` anchors for tool events, newest-three snippets, ±60-character excerpt with `…` and match ranges, literal case-insensitive matching); verify with `src/server/chat/__tests__/sessionSearch.test.ts` covering the spec scenarios (tool input, tool result URL, peer body, literal `fix(chat):`, case folding, 20,000-character result excerpt, five matches → count 5 with three snippets)

## 2. Server walker and route

- [ ] 2.1 Add a read-only `ChatSessionManager` accessor that yields the non-archived local chat records with their searchable events: memo plus live events when loaded, otherwise a transient `replayTranscriptFileAsync` result that is never stored in `snapshotHistory` and has no cwd catch-up; verify with a manager test that searching an unloaded session leaves `snapshotHistory`, its status, and its driver untouched, and that a missing transcript is reported as unsearchable
- [ ] 2.2 Implement `searchActiveSessions` (concurrency 4, name match, ordering by newest match, 50-group cap with `truncated`, `unsearchable` count); verify with unit tests for ordering, cap, name-only match, and archived exclusion
- [ ] 2.3 Add `src/server/routes/chatSearch.ts` (`GET /api/chat/search?q=`, 400 outside 2–200 characters) and register it in `src/server/bootstrap.ts`; verify with a route test (Hono `app.request`) for 200 and 400 responses

## 3. Client search UI

- [ ] 3.1 Add `src/client/stores/sessionSearchStore.ts` (250 ms debounce, `AbortController` abort of superseded fetches, accept only a response whose `query` matches the current one, clear); verify with store tests that use fake timers for debounce, the out-of-order `#14`/`#147` responses, and clear
- [ ] 3.2 Add `SessionSearchBox` to the `SessionList.tsx` filter bar and a `SessionSearchResults` list that replaces the navigator body while the query is searchable (loading, error, empty "No active chat matches", grouped results with highlighted snippets, truncated/unsearchable notes); Escape and an empty box restore the sections; verify with component tests that filters and collapsed sections are unchanged after clearing and that results survive opening a chat
- [ ] 3.3 Bind `[modifier]+K` in `src/client/App.tsx` to focus and select the search box; verify with an App keyboard test

## 4. Jump to the matched entry

- [ ] 4.1 Add `data-anchor-id` to every transcript row in `src/client/components/chat/ChatMessages.tsx` (event id, or `tool:<toolCallId>` for tool, task, and worker rows); verify with a render test asserting the anchors
- [ ] 4.2 Add `pendingReveal` to `chatStore` and handle it in `ChatView.tsx` (scroll into view, about 2 s highlight class, no stick-to-bottom on that render, silent drop when the anchor is absent after the snapshot); wire snippet clicks to select the session and set the reveal, while header clicks only select; verify with ChatView tests for the found and missing anchor cases

## 5. Docs and verification

- [ ] 5.1 Add a navigator search bullet to the `CLAUDE.md` "How It Works" list (scope, REST endpoint, `[mod]+K`, transient replay); verify by reading the diff
- [ ] 5.2 Run `bun run lint && bun run typecheck && bun run test` and confirm all pass
- [ ] 5.3 In the running app (dev-browser), search a PR number that an active chat printed, confirm the chat is found, and confirm that clicking the snippet opens the chat scrolled to the highlighted tool entry; take a screenshot
