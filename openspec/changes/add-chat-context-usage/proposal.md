# Proposal

## Why

A chat session can fill its whole context window without the user noticing,
and then auto-compaction silently replaces the conversation with a summary —
often mid-task, with no warning that it was coming. Claude Code's own
terminal UI shows "Context left until auto-compact"; kawai's chat view shows
nothing at all.

The window is also not a constant. Profiles already configure it through
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` (GLM requests 1,000,000 where the model
default is 200,000), so a fixed "x / 200k" label would be wrong for exactly
the sessions that need the meter most.

## What Changes

- The chat view header shows a quiet context meter beside the session status:
  used tokens against the window as a percentage, with `used / window` token
  counts for scale. It is chrome alongside the existing status and profile
  lines, not a new panel.
- The meter tracks real window occupancy, not lifetime token traffic. Each
  assistant frame already carries the usage of the API request that produced
  it (`input + cache_read + cache_creation + output`); `ChatSessionDriver`
  reads that frame's content today and discards the usage. The per-request
  figure is the window as of that request and becomes the meter's source, so
  the meter also moves during a long turn rather than only at turn end.
- Compaction is reflected immediately. `compact_boundary` already reaches the
  driver as a `'Context compacted'` notice, and its `compact_metadata` carries
  `pre_tokens` and `post_tokens`. The meter adopts `post_tokens` at that
  moment so it visibly falls alongside the notice instead of waiting for the
  next request.
- The denominator is the session's context window, read from the resolved
  model usage (`modelUsage[*].contextWindow`) so GLM's 1M window and mimo's
  200k window each meter against their own scale.
- The latest reading is stored with the chat session and kept across server
  restart, resume, archive, and restore. A restored chat shows its last known
  reading rather than a blank meter; an archived chat shows its final reading
  as history and does not refresh.
- A chat session that has not yet produced a model request shows no meter.
  Inventing `0%` would be a lie.
- Out of scope:
  - The `/context` breakdown card (categories, memory files, MCP tools,
    message breakdown). The stored reading can grow into it later.
  - An active `getContextUsage` control request. The passive stream is the
    source; that request stays available for a later drill-down.
  - Terminal (tmux) sessions. This is Claude Code chat only.
  - A navigator badge on the session list.
  - Token cost accounting. `totalCostUsd` on turn completion is a different
    concern and already renders in the transcript.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: Chat views show a context-window meter sourced from the
  per-request usage already on the stream, reset from compaction metadata,
  and persisted with the session across restarts and archive.

## Impact

- `src/shared/chat.ts`: a `ChatContextUsage` value type (used tokens, window
  tokens, percentage, measured-at).
- `src/shared/types.ts`: `chat-snapshot` carries the current reading beside
  `activity`.
- `src/server/chat/ChatSessionDriver.ts`: `handleAssistant` keeps
  `message.message.usage`; `handleSystem` reads `compact_metadata` on
  `compact_boundary` in addition to today's notice. Both feed a new
  `onContextUsage` callback.
- `src/server/chat/ChatSessionManager.ts`: holds the latest reading, patches
  it through `updateChatSession`, and includes it in `getSnapshot`.
- `src/server/db.ts`: `chat_sessions` gains columns for the reading, with the
  same additive-migration pattern used for `archived_at` and
  `approval_policy`.
- `src/client/components/chat/ChatView.tsx`: renders the meter in the header.
- `src/client/stores/chatStore.ts`: holds the reading on the transcript entry
  so the header updates without a round trip.
- Tests follow the existing driver and component suites
  (`chatSessionDriver.test.ts`, `chatComponents.test.tsx`).
- No dependency changes. No wire-protocol change beyond the additive snapshot
  field older clients already ignore.
