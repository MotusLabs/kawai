# Design

## Context

See proposal.md for motivation and specs/chat-sessions/spec.md for the required behavior.

- `ChatSessionDriver.handleSdkMessage` already receives every frame needed. It forwards only `text_delta` from `stream_event`, only `init` and `compact_boundary` from `system`, and drops thinking blocks (`handleAssistant`).
- Captured wire logs (`~/.agentboard/chat-wire/`) show the frames per turn: `system/status {status:"requesting"}` before each API request, `stream_event message_start` (with `ttft_ms`), `content_block_start` with `thinking`, `text`, or `tool_use {name}`, a flood of `thinking_delta` / `input_json_delta` / `system/thinking_tokens` (about 13k frames each in one log), and `system/api_retry {attempt, max_retries, error_status}`.
- Status (`working`/`permission`/`waiting`) flows driver → `onStatus` → `applyPatch` → session registry, which broadcasts to every navigator client. Conversation events flow driver → `onEvent` → manager live buffer → `ChatConnections.publish`, which batches per connection and flushes on a scheduled tick.
- `chat-snapshot` already carries `pendingRequests` and `status` beside the event log. The client's `chatStore` holds them per session.

## Goals / Non-Goals

**Goals:**
- A small, pure frame-to-activity reducer, independent of the SDK transport, so the direct-CLI driver in `replace-claude-sdk-with-cli` can reuse it.
- Phase-change-only traffic: a handful of messages per turn, no throttling logic.
- Activity never goes out of order with the events it describes.

**Non-Goals:**
- Changing `SessionStatus`, the session registry, or navigator rendering.
- Surfacing thinking text or token estimates (all `*_delta` and `thinking_tokens` frames stay ignored).

## Decisions

### D1. Activity is a separate, unsequenced channel, not a `ChatEvent`

```ts
// src/shared/chat.ts
export type ChatActivityPhase = 'requesting' | 'thinking' | 'responding'
  | 'preparing_tool' | 'running_tools' | 'retrying'
export interface ChatActivity {
  phase: ChatActivityPhase
  /** Milliseconds already spent in this phase when the message was sent. */
  elapsedMs: number
  /** preparing_tool / running_tools: oldest unresolved tool name. */
  tool?: string
  /** running_tools: number of unresolved tool calls (>= 1). */
  count?: number
  /** retrying */
  attempt?: number
  maxRetries?: number
  errorStatus?: number
}
```

New server message `{ type: 'chat-activity'; sessionId; activity: ChatActivity | null }`, plus `activity: ChatActivity | null` on `chat-snapshot`.

*Alternative:* a `ChatEvent` variant. Rejected: events are sequenced, deduplicated, buffered for snapshots, and replayed, while activity is a single current value that must not show up in history. *Alternative:* a field in the session registry. Rejected: every patch is broadcast to all navigator clients, which the spec excludes.

### D2. `elapsedMs` instead of a server timestamp

The server sends how long the phase has lasted (0 on a live change, the actual age in a snapshot). The client anchors `phaseStartedAt = receivedAt - elapsedMs` on its own clock and ticks once per second. This avoids clock skew between server and browser, which matters for remote hosts. Network latency adds at most a fraction of a second of error, which is fine for a seconds display.

### D3. Pure reducer in `src/server/chat/chatActivity.ts`

`reduceActivity(state, input) → state`, where `state` holds the phase, its start time, the ordered unresolved tool calls (`toolCallId → name`), and retry details. Inputs are normalized, not raw frames:

| Input                                  | Result                                                  |
|----------------------------------------|---------------------------------------------------------|
| `turn_started`, `status: requesting`   | `requesting`                                            |
| block start `thinking` / `redacted_thinking` | `thinking`                                        |
| block start `text`                     | `responding`                                            |
| block start `tool_use {name}`          | `preparing_tool` (tool = name)                          |
| `tool_call` emitted                    | add to unresolved; `running_tools`                      |
| `tool_result` emitted                  | remove; stay `running_tools` while any remain           |
| `api_retry {attempt,max,status}`       | `retrying`                                              |
| `request_resolved`                     | restart the current phase's clock                       |
| turn completed / interrupted / dead    | `null`, unresolved set cleared                          |

A new phase start time is set only when the projected `ChatActivity` (phase, tool, count, retry fields) changes. A thinking or preparing phase that follows a running tool doesn't happen within one request, because the next `requesting` comes first.

The driver feeds the reducer from `handlePartial` (`content_block_start`), `handleSystem` (`status`, `api_retry`), and the points where it already emits `turn_started`, `tool_call`, `tool_result`, `request_resolved`, and turn-end events. It calls a new `onActivity(activity | null)` option only when the projection changes. Unknown `status` values and unknown block types are ignored, so they leave the current phase alone.

**Subagent frames:** frames with a non-null `parent_tool_use_id` (a Task subagent's own requests and thinking) are not fed to the reducer. Otherwise a running Task would flicker between "Thinking" and "Running Task". The row stays "Running Task…" for the whole subagent run.

**Approval wait:** a `tool_call` is emitted before `canUseTool`, so the running clock would otherwise include the time the card waited. `request_resolved` restarts it, so "Running Bash… 3s" counts from the approval. Auto-approved tools resolve immediately, so nothing visible changes for them.

### D4. Hiding is a client decision

The server reports `responding` as an ordinary phase and keeps reporting phases while a request is pending. The client hides the row when `phase === 'responding'`, when `pendingRequests.length > 0`, or when the chat is archived. This keeps the server reducer free of view rules, and pending requests are already in the client store, so there's no second source of truth.

### D5. Ordering through the existing flush

`ChatConnections` gets `publishActivity(sessionId, activity)`. It stores the latest value per subscribed connection and session, and the scheduled flush sends it **after** that connection's pending event batch for the session. This way "Running Bash" never arrives before the `tool_call` it refers to, and several phase changes within one tick collapse into the last one.

`ChatSessionManager` keeps `activity` and its phase start time per live session, computes `elapsedMs` for `getSnapshot`, and clears both when the driver stops, is archived, or is killed. A restart starts with no activity: the turn didn't survive the restart either.

### D6. Client

- `ChatTranscript` gains `activity: { value: ChatActivity; phaseStartedAt: number } | null`. `snapshot()` and a new `setActivity()` anchor it with `Date.now() - elapsedMs`. `applyChatEvents` clears it on `turn_completed` / `turn_interrupted` as a safety net in case the server's `null` is lost.
- `App.tsx` routes `chat-activity` to `setActivity`.
- New `ChatActivityRow.tsx` renders a pulsing dot, a label (`Waiting for model…`, `Thinking…`, `Writing <tool> input…`, `Running <tool>…` / `Running <n> tools…`, `Retrying (<a>/<m>, <status>)…`), and `Ns` / `Mm Ss`. The 1 s interval runs only while the row is mounted. `ChatView` renders it after `ChatMessages` and applies the D4 hiding rules.

### D7. Development fixture

`developmentFixture.ts` gets keyword-triggered turns that push `status: requesting`, a thinking block start with a delay, a `tool_use` block start plus `assistant` tool_use and `user` tool_result with a delay, and an `api_retry` frame. That lets the dev-browser check and the unit tests exercise every phase without a model.

## Risks / Trade-offs

- [`status`, `api_retry`, and `thinking_display` are Claude Code stream-JSON details, not stable SDK API, and may change between CLI versions] → The reducer ignores unknown values. If a frame is missing, the indicator falls back to coarser phases (for example, "Waiting for model…" for the whole request), never to an error. Reducer tests pin frame shapes copied from real wire captures.
- [Providers that never send thinking blocks (or send redacted ones)] → `redacted_thinking` maps to thinking. Otherwise the phase just stays at `requesting` until text or a tool starts.
- [Hiding during `responding` means a long pause mid-text shows nothing] → Accepted: the streaming text is visible progress. It can be revisited if it turns out to matter.
- [A lost `null` (dropped connection) could leave a stale row] → Reconnect always delivers a fresh snapshot with `activity`, and the client also clears the row on turn-end events.

## Migration Plan

Additive only: older clients ignore `chat-activity` and the extra snapshot field. Nothing is persisted. To roll back, revert the change.
