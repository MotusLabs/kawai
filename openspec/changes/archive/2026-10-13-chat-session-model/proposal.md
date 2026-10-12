# Proposal

## Why

A chat session runs under a Claude profile whose effective model is resolved by
the CLI (profile `model` config, the CLI default, or a mid-session `/model`
switch) — none of which the chat view shows. The user cannot tell which model a
chat is actually answering with, which matters when comparing answers, watching
cost/plan usage, or verifying a `/model` change took effect.

## What Changes

- The chat session driver captures the model string reported by the SDK's
  `system/init` frame (emitted at the start of every turn, so `/model` changes
  appear on the next turn).
- The current model becomes slow session state like context usage: held in
  memory by the session manager, persisted with the chat session, restored in
  the `chat-snapshot`, and pushed to subscribed clients through an additive
  `chat-model` message when it changes.
- The chat view header shows the model beside the session status (same spot as
  the context meter). Before the first init frame the badge is absent — no
  placeholder.
- Archived chats show their last reported model as inert text; a restored chat
  shows the stored model until the next turn refreshes it.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `chat-sessions`: adds requirements for the header model display — the model
  comes from the agent's init frame, is absent until the agent reports it,
  follows mid-session model changes, and survives restart, resume, archive, and
  restore like the context reading.

## Impact

- `src/shared/chat.ts` / `src/shared/types.ts`: snapshot field and `chat-model`
  wire message (both additive).
- `src/server/chat/ChatSessionDriver.ts`: capture `model` from the init frame,
  new `onModel` driver callback.
- `src/server/chat/ChatSessionManager.ts`: model state, snapshot assembly,
  change push.
- `src/server/chat/ChatConnections.ts`: coalesced `chat-model` fan-out.
- `src/server/db.ts`: `chat_sessions` model column (migration).
- `src/client/stores/chatStore.ts` + `src/client/components/chat/ChatView.tsx`:
  state and header rendering.
- No new dependencies; no breaking wire changes (older clients ignore the new
  message and field).
