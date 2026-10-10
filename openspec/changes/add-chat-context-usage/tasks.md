# Tasks

## 1. Shared contract

- [ ] 1.1 Add a `ChatContextUsage` value type (`usedTokens`, `thresholdTokens`, `percentage`, `at`) to `src/shared/chat.ts`, and verify `src/shared/__tests__/chat.test.ts` constructs it without reaching into SDK types
- [ ] 1.2 Add `contextUsage: ChatContextUsage | null` beside `activity` on `chat-snapshot` in `src/shared/types.ts`, and verify the `chat-snapshot` round-trip test in `src/shared/__tests__/chat.test.ts` carries it alongside `activity` and `pendingRequests`

## 2. Persistence

- [ ] 2.1 Add `context_tokens`, `context_threshold`, `context_pct`, `context_at` columns to `chat_sessions` with the existing additive-migration guard in `src/server/db.ts`, and verify a new `src/server/__tests__/chatContextDb.test.ts` covers both a fresh create and a migration of a pre-existing table
- [ ] 2.2 Map the columns through `ChatSessionRecord` and `updateChatSession` alongside `approvalPolicy`, and verify the same test patches and re-reads a reading including the `null` case

## 3. Driver reads the stream

- [ ] 3.1 Read `message.message.usage` on assistant frames in `src/server/chat/ChatSessionDriver.ts`, keeping the latest `input + cache_read + cache_creation + output` as the used-token count (design D1), and verify `src/server/__tests__/chatSessionDriver.test.ts` covers the reading rising across successive requests and staying within the window when session totals far exceed it
- [ ] 3.2 Skip frames where `isSubagentFrame` is true before reading usage (design D6), and verify a driver test shows a Task subagent's usage does not move the meter
- [ ] 3.3 Publish through a new `onContextUsage` callback, leaving it `null` until the first model request (design D7), and verify a driver test asserts `null` for a session that has not produced a request

## 4. Threshold source

- [ ] 4.1 Resolve the auto-compaction threshold in `src/server/chat/ChatSessionDriver.ts` per design D2: observed `autoCompactThreshold` (else `rawMaxTokens − buffer`) from `getContextUsage` when a live `Query` answers, else the profile's `CLAUDE_CODE_AUTO_COMPACT_WINDOW` when it configures a smaller window, else `modelUsage[*].contextWindow` labelled as an approximation. Wire `getContextUsage` as a light control call on attach and at turn boundaries, following the `interrupt` precedent. Verify `src/server/__tests__/chatSessionDriver.test.ts` covers each resolution step and the fallback order
- [ ] 4.2 Verify the threshold against a real context-usage report rather than assuming `autoCompactThreshold`'s units, and pin the fixture in a test: a 200000-token window with a 33000-token buffer and 157900 used must yield a 167000 threshold and a percentage near 95, not the 79 that the full window gives
- [ ] 4.3 Cover a profile-configured 100000-token window on a 200000-token model, and verify the threshold reflects the configured window rather than the model's

## 5. Driver reads compaction

- [ ] 5.1 On `compact_boundary`, adopt `compact_metadata.post_tokens` as the new reading when it is present and finite, while keeping the existing `'Context compacted'` notice (design D3), and verify a driver test covers `trigger: 'auto'` and `trigger: 'manual'` both dropping the meter to the post-compaction size
- [ ] 5.2 Keep the last reading when `compact_metadata` is absent, when `post_tokens` is absent, or when `post_tokens` is non-finite — never publishing `undefined`, `NaN`, or a zero standing in for "unknown" (design D3), and verify a driver test covers each of those three fallbacks

## 6. Manager and delivery

- [ ] 6.1 Hold the latest reading in `src/server/chat/ChatSessionManager.ts`, prefer it over the stored column in `getSnapshot`, and include `contextUsage` in the snapshot, and verify `src/server/__tests__/chatSessionManager.test.ts` covers the in-memory value winning over a stale stored one
- [ ] 6.2 Persist the reading on `turn_completed`, `compact_boundary`, and driver death only — not on every frame (design D5) — and verify a manager test shows a multi-request turn writes at its boundary rather than per assistant frame
- [ ] 6.3 Coalesce live updates in `src/server/chat/ChatConnections.ts` the way `activityBatches` already does, sending the latest reading per session on the next flush, and verify `src/server/__tests__/chatConnections.test.ts` shows several queued updates collapsing to one message per flush

## 7. Client

- [ ] 7.1 Store the reading on the chat transcript entry in `src/client/stores/chatStore.ts` from `chat-snapshot` and live updates, and verify `src/client/__tests__/chatStore.test.ts` covers both paths and the clearing case
- [ ] 7.2 Render the meter in the `src/client/components/chat/ChatView.tsx` header beside the session status — percentage plus `used / threshold` token counts — and verify `src/client/__tests__/chatComponents.test.tsx` covers the rendered counts and the hidden state when the reading is `null`
- [ ] 7.3 Show the stored reading on an archived chat with no refresh affordance, and verify a component test covers the archived header

## 8. Integration

- [ ] 8.1 Run `bun run lint && bun run typecheck && bun run test` and verify all three pass
- [ ] 8.2 Open a live chat session in the running app via the `dev-browser` skill and verify the meter rises across a multi-tool turn, drops when the transcript shows the compaction notice, and still shows its reading after a server restart — spanning the driver, manager, persistence and client groups

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Verify the archived result.
