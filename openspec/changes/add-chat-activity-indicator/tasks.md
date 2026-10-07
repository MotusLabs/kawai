# Tasks

## 1. Contract and reducer

- [x] 1.1 Add `ChatActivityPhase` and `ChatActivity` to `src/shared/chat.ts` and the `chat-activity` server message plus `chat-snapshot.activity: ChatActivity | null` to `src/shared/types.ts` (design D1, D2); verify `bun run typecheck` passes
- [x] 1.2 Add `src/server/chat/chatActivity.ts` with a header comment and the pure `reduceActivity` plus a projection-to-`ChatActivity` helper covering every row of the design D3 table. Include unresolved-tool ordering (oldest name and count), `redacted_thinking` → thinking, unknown status and block types ignored, the clock restarting on `request_resolved`, and a new phase start time only when the projection changes. Verify with a new `src/server/__tests__/chatActivity.test.ts` that drives each transition, using frame shapes copied from a real wire capture

## 2. Driver and manager

- [x] 2.1 Feed the reducer from `ChatSessionDriver`: `content_block_start` in `handlePartial`, `status`/`api_retry` in `handleSystem`, and the existing `turn_started`, `tool_call`, `tool_result`, `request_resolved`, turn-end, and `markDead` points. Skip frames with a non-null `parent_tool_use_id`, and call a new `onActivity` option only on change. Verify in `chatSessionDriver.test.ts` that a scripted turn produces the expected sequence of activities ending in `null`, that subagent frames don't change the phase, and that `thinking_delta`/`thinking_tokens` frames produce no calls
- [ ] 2.2 Store the current activity and its phase start per session in `ChatSessionManager`, include `activity` with a computed `elapsedMs` in `getSnapshot`, and clear it on stop, archive, kill, and driver death. Verify in `chatSessionManager.test.ts` that a snapshot taken mid-phase reports a non-zero `elapsedMs`, and that an idle, archived, or restarted session reports `null`
- [ ] 2.3 Add `publishActivity` to `ChatConnections`. Keep the latest value per connection and session, and send it in the scheduled flush after that session's event batch (design D5). Verify in `chatConnections.test.ts` that activity follows the `tool_call` it describes, that multiple changes in one tick collapse to the last, and that unsubscribed connections receive nothing
- [ ] 2.4 Add fixture turns to `developmentFixture.ts` for thinking, tool input plus a running tool, and an API retry (design D7), and verify in `chatDevelopmentFixture.test.ts` that each keyword emits the expected frames

## 3. Client

- [ ] 3.1 Add `activity` to `ChatTranscript` in `chatStore.ts`, a `setActivity` action anchoring `phaseStartedAt = Date.now() - elapsedMs`, snapshot handling, and clearing on `turn_completed`/`turn_interrupted`. Route `chat-activity` in `App.tsx`. Verify in `chatStore.test.ts` covering anchoring, snapshot restore, and the turn-end clear
- [ ] 3.2 Add `src/client/components/chat/ChatActivityRow.tsx` (pulsing dot, the phase labels from design D6, a 1 s ticking `Ns`/`Mm Ss` timer) and render it after `ChatMessages` in `ChatView.tsx`. Hide it for `responding`, when requests are pending, and for archived chats. Verify in `chatComponents.test.tsx` that each label renders, the elapsed time advances with fake timers, and the three hiding cases render no row
- [ ] 3.3 Update header comments of touched files and the chat bullet in `CLAUDE.md` to mention the activity row, then verify `bun run lint && bun run typecheck && bun run test` pass

## 4. Integration check

- [ ] 4.1 Use the `dev-browser` skill against `bun run dev` with the development fixture. Confirm the row shows "Waiting for model…", "Thinking…", "Running <tool>…", and "Retrying (…)…" with a ticking timer, hides while text streams, survives a page reload mid-phase with roughly the right elapsed time, and is gone after the turn completes. Save screenshots as evidence
