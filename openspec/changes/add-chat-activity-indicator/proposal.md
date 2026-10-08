# Proposal

## Why

During a chat turn the transcript goes silent between the user's message and the first visible text or tool card — often 7–25 s to the first token plus any extended-thinking time — and a tool card looks the same whether its tool is still running or long finished. The only sign of life is the coarse `working` label in the header, so a thinking model, a long-running tool, and an API retry loop are indistinguishable from a hang. Claude Code already streams the frames that say what is happening (`system/status`, thinking/text/tool_use block starts, `system/api_retry`); the driver drops them.

## What Changes

- Derive a live **activity** for each in-flight chat turn from protocol frames the driver currently ignores: waiting for the model, thinking, preparing a tool's input, running one or more tools, and retrying an API request (attempt, maximum, error status).
- Show that activity as a single muted row at the end of the chat transcript with a phase label and a client-ticked elapsed timer (e.g. `Thinking… 14s`, `Running Bash… 40s`, `Retrying (2/10, 504)… 3s`). The row hides while assistant text is streaming, while an approval/question card awaits the user, when no turn is in flight, and in archived/read-only chats.
- Deliver activity over a new additive `chat-activity` WebSocket message, sent only on phase changes, and include the current activity in `chat-snapshot` so a reconnect mid-turn restores the row. Activity is ephemeral: it is not a `ChatEvent`, is not sequenced, persisted, or replayed, and is not part of the session-list status broadcast.
- Extend the development fixture so the thinking, tool-input, tool-running, and retry phases can be exercised without a real model.

Non-goals: thinking text in the transcript, token-count estimates, and activity in the navigator/session list.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: adds a requirement that an in-flight turn's live activity is shown at the end of the chat transcript and restored on reconnect, without changing the existing working/permission/waiting status requirement.

## Impact

- Server: `src/server/chat/ChatSessionDriver.ts` (forward thinking/tool_use block starts, `status`, and `api_retry` frames), a new frame-to-activity module in `src/server/chat/`, `ChatSessionManager.ts` (hold current activity, include it in snapshots), `ChatConnections.ts` (fan out `chat-activity`), `developmentFixture.ts`.
- Shared: `src/shared/chat.ts` (activity type), `src/shared/types.ts` (`chat-activity` message, `chat-snapshot.activity`). Both additive; older clients ignore the new message and field.
- Client: `src/client/stores/chatStore.ts`, `src/client/App.tsx` message wiring, a new activity row component under `src/client/components/chat/`, `ChatView.tsx`.
- No database, dependency, or provider-profile changes. The mapping consumes the same frames the direct-CLI transport in `replace-claude-sdk-with-cli` would receive, so that change can reuse it.
