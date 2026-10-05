# Tasks

## 1. Shared wire-frame contract

- [x] 1.1 Add `ChatWireDirection` and `ChatWireFrame` to `src/shared/chat.ts` (header comment updated) and verify `bun run typecheck` passes
- [x] 1.2 Add additive `chat-debug-open`, `chat-debug-page`, `chat-debug-close` client messages and the `chat-debug-frames` server message to `src/shared/types.ts`, and verify `bun run typecheck` passes with existing message switches unchanged

## 2. Wire tap spawner

- [x] 2.1 Implement a UTF-8-safe line splitter in `src/server/chat/wireTap.ts` and verify unit tests cover multi-chunk lines, multi-byte characters split across chunks, verbatim line content (a `\r` is kept, only `\n` delimits), and trailing partial-line flush on end
- [x] 2.2 Implement `createWireTappedSpawn(recorder)` per design D1 (spawn/exit/error lifecycle frames without `env`, tapped `stdin` Writable with callback passthrough, `stdout` Transform, drained `stderr`, delegated `kill`/`exitCode`/`killed`/`signalCode`/`on`/`once`/`off`) and verify a unit test spawning a small Bun echo script records `out`, `in`, `stderr`, spawn, and exit frames in order while the bytes read back equal the bytes written
- [x] 2.3 Verify by unit test that a spawn with a credential in `env` produces no frame containing the credential, and that spawning a missing executable records an `error` lifecycle frame and emits the child `error` event

## 3. Per-session frame log

- [x] 3.1 Implement `ChatWireLog` in `src/server/chat/ChatWireLog.ts` (synchronous `seq` assignment, batched serialized async append, `0700` dir / `0600` files) and verify unit tests that frames recorded in one tick land on disk in `seq` order
- [x] 3.2 Add rotation at a configurable size bound (16 MiB default) to `<id>.1.jsonl` and verify a unit test with a small bound keeps only the newest frames and continues recording after rotation
- [x] 3.3 Add `seq` resume from the file tail (current, then `.1`) and verify a unit test that a new `ChatWireLog` for an existing session continues after the last recorded `seq`
- [x] 3.4 Add `readPage({ beforeSeq, limit })` across both generations plus unflushed frames with `hasOlder`, and verify unit tests for newest page, older page, no gaps/duplicates across the rotation boundary, and empty log
- [x] 3.5 Make write failures non-fatal (logged once per session, frames dropped) and verify a unit test with an unwritable directory where `record` never throws
- [x] 3.6 Implement `ChatWireLogs` registry in `src/server/chat/ChatWireLogs.ts` (`get`, `delete`, `pruneOrphans`, `subscribe`) and verify unit tests for live fan-out to listeners, unsubscribe, deletion of both generations, and orphan pruning

## 4. Driver, manager, and fixture integration

- [x] 4.1 Add `wire?: ChatWireRecorder` to `ChatSessionDriverOptions` and `ChatQueryFactory` params; pass `spawnClaudeCodeProcess: createWireTappedSpawn(wire)` in `spawnQuery()` and verify `chatSessionDriver.test.ts` asserts the option is present on first spawn and on respawn after a crash, and absent when no recorder is given
- [x] 4.2 Give `ChatSessionManager` a `wireLogs` option, hand each driver its session recorder, delete logs in `kill`, prune orphans after `restorePersisted`, and verify `chatSessionManager.test.ts` covers recorder wiring, kill deletion, and pruning (keep the file under 500 lines; extract helpers if needed)
- [x] 4.3 Build `ChatWireLogs` in `src/server/index.ts` from the DB directory (`dirname` of the resolved DB path) and verify the server starts with `bun run dev` and creates `chat-wire/` after a chat turn
- [x] 4.4 Make `fixtureQueryFactory` record synthetic `out` frames for prompts and permission answers and `in` frames for emitted `SDKMessage`s and permission requests, and verify a unit test that a fixture approval turn records request and response frames

## 5. WebSocket debug subscriptions

- [x] 5.1 Handle `chat-debug-open` / `chat-debug-page` / `chat-debug-close` in `ChatConnections` (subscribe before the async page read, page size 200, unknown-session error) and route them from `src/server/index.ts`, and verify `chatConnections.test.ts` covers open returning the newest page with `hasOlder`, paging, close, and unknown session
- [x] 5.2 Batch live frames per connection on the existing zero-delay flush and drop debug subscriptions on `disconnect`, and verify tests that only debug-open connections receive frames, frames recorded during an in-flight open are delivered, and a disconnected connection receives nothing

## 6. Client debug panel

- [x] 6.1 Add `src/client/stores/chatDebugStore.ts` (seq-merge with dedupe and sort, `hasOlder`, `loadingOlder`, 5,000-frame cap) and route `chat-debug-frames` in `App.tsx`, and verify `chatDebugStore.test.ts` covers overlap between page and live frames, out-of-order arrival, and the cap
- [x] 6.2 Add a frame type-label helper (`type`, `subtype`, `request.subtype`, `event.type` for `stream_event`, raw-text fallback) and verify unit tests for each SDK frame shape and non-JSON lines
- [ ] 6.3 Add the Debug toggle to `ChatView` (sends open/close, re-opens on `connectionEpoch` change while open) and verify `chatComponents.test.tsx` asserts the messages sent on toggle and on reconnect
- [ ] 6.4 Implement `ChatDebugPanel.tsx` (desktop split / mobile replace, direction badge, time, seq, type label, expand to pretty JSON, Copy copies `raw`, Load older, tail-follow only at bottom, empty state) and verify component tests for expand, copy, load-older, and empty state
- [ ] 6.5 Update `CLAUDE.md` Structure notes for the chat debug modules and the `chat-wire/` data directory, and verify the listed paths exist

## 7. End-to-end verification

- [ ] 7.1 Extend `tests/e2e/chat.spec.ts` (fixture) to toggle Debug, see request/response frames for an approval turn, expand a frame, load older, toggle off, and reload with frames still present, and verify the suite passes with `AGENTBOARD_CHAT_FIXTURE=1`
- [ ] 7.2 Run a real-SDK chat turn (`chat-real.spec.ts` or the `dev-browser` skill) with Debug open and verify `initialize`, user, `stream_event`, `can_use_tool` control request/response, and `result` frames appear and the chat behaves as before; capture screenshots at desktop and mobile widths
- [ ] 7.3 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate add-chat-debug-mode --strict`, and verify all pass
