# Tasks

## 1. Window function (server, pure)

- [x] 1.1 Add `src/server/chat/historyWindow.ts` with `HISTORY_WINDOW_MS = 24h` and `historyWindow(events, opts)` per design D1 (turn-start cut points, unit time with undated inheritance, newest-event anchor, at-least-one-turn, `fromId`, `beforeId`, `throughId` incl. `tool:<callId>` anchors, `hasOlder`, `startId`); verify with `src/server/__tests__/historyWindow.test.ts` covering: 5-day history → last 24 h only, idle-3-days chat → its last day, turn straddling the cutoff kept whole, short chat → `hasOlder: false`, empty-gap page still returns one turn, undated units, no dated events → whole list, unknown `fromId`/`beforeId`.

## 2. Wire contract and server wiring

- [x] 2.1 Extend `src/shared/types.ts`: optional `historyFrom` on `chat-attach`, `historyHasOlder` on `chat-snapshot`, `chat-history-page` client and server messages (design D2); add the client type to `CHAT_CONNECTION_TYPES` in `src/server/chat/chatConnectionTypes.ts`; verify with `bun run typecheck` and the whitelist test.
- [x] 2.2 Make `ChatSessionManager.getSnapshot(sessionId, { historyFrom })` apply `historyWindow` to `memo + live` (pending requests, activity, rosters, notices, `throughSequence` unchanged) and add `getHistoryPage(sessionId, beforeId, throughId)` returning `{ events, hasOlder, stale }`; verify with manager tests that a snapshot carries only the window, an old pending approval still appears in `pendingRequests`, and archived sessions window too.
- [x] 2.3 In `ChatConnections`, pass `historyFrom` from `chat-attach` and handle `chat-history-page` (await `loadHistory`, require a subscription, never start an agent, reply `stale` when `beforeId` is unknown); verify in `src/server/__tests__/chatConnections.test.ts`: attach → window + `historyHasOlder`, page → preceding day, reconnect with `historyFrom` → same span with live events neither lost nor duplicated, page on an archived chat starts nothing.

## 3. Client store and protocol

- [x] 3.1 Add `historyHasOlder`, `historyLoading`, `historyStartId`, `historyExpanded` to `ChatTranscript`; `snapshot` adopts the first three; add `requestOlder(sessionId, throughId?)` and `applyHistoryPage(message)` that folds the page alone, prepends it de-duplicated by `seen`, and sets `historyExpanded` (design D3); route `chat-history-page` in `src/client/protocol/chatMessages.ts`; verify with `chatStore` tests: prepend order, a page containing live (sequence > 0) events is not dropped, `stale` triggers a plain re-attach, loading flag clears on reply and on disconnect.
- [x] 3.2 In `ChatView`'s attach effect, send `historyFrom = historyStartId` on a re-run for the same session (reconnect) and on a new session only when `historyExpanded` is set (design D3); verify with `ChatView` tests: reconnect sends `historyFrom`, reopening an unexpanded chat sends none, reopening an expanded one sends it, and live events appended while shown are never trimmed.

## 4. Load-earlier control

- [x] 4.1 Render the top-of-transcript **Load earlier messages** button / "Beginning of conversation" marker in `ChatMessages.tsx` (disabled while disconnected or loading, styled in the chat palette), preserving the first visible row's on-screen offset across a prepend (design D4); verify with a component test for states and a `dev-browser` check on a fixture chat with multi-day history that the viewed row does not move after loading.

## 5. Search reveal

- [ ] 5.1 Extend `useRevealRow`: when the anchor is not rendered and older history exists, send one page request with `throughId = anchor`, resolve the reveal after it lands, else fall back to the existing no-error behavior (design D5); verify with a `useRevealRow` test for an old tool anchor and for an anchor that is never found (exactly one request).

## 6. Docs and checks

- [ ] 6.1 Update `CLAUDE.md`/`AGENTS.md` "How It Works" (attach sends a 24 h window; `chat-history-page`; `historyFrom` on reconnect) and the header comments of touched files; verify `bun run lint && bun run typecheck && bun run test` pass and `openspec validate chat-history-window --strict` is valid.
