# Proposal

## Why

The chat composer's unsubmitted text lives in local `ChatView` component state and is deliberately wiped whenever the selected chat changes (`useEffect(() => setText(''), [session.id])` in `src/client/components/chat/ChatView.tsx`). Because the app renders one shared, unkeyed `ChatView` and swaps the `session` prop, switching to another chat — or to a terminal pane — destroys what the user was typing. Typing a message, checking another session, and switching back finds an empty input. Multi-chat use makes this a routine data-loss annoyance; transcripts already survive switching (they are keyed by session id in `useChatStore`), so the composer is the only per-session state that doesn't.

## What Changes

- The chat composer's input becomes per-session draft state keyed by session id, held in client state outside the `ChatView` component (alongside the per-session transcripts in the chat store), so it survives switching chats and panes.
- Switching between chats (or chat ↔ terminal panes) preserves each chat's unsubmitted draft; each chat's composer shows only its own draft.
- Submitting a message clears that session's draft (unchanged behavior, now per session).
- A killed/removed session's draft is discarded with its transcript.
- Archived chats keep hiding the composer; a pre-archive draft survives archive → restore.
- Remove the clear-on-switch effect and the local `useState` text in `ChatView`.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `chat-sessions`: add a requirement that each chat session's unsubmitted composer input is retained per session while the app is open — preserved across chat/pane switches and WebSocket reconnects, cleared on submit, and discarded when the session is removed.

## Impact

- `src/client/stores/chatStore.ts` — new per-session draft map (`drafts: Record<sessionId, string>`, `setDraft`), with cleanup in the existing `remove()`.
- `src/client/components/chat/ChatView.tsx` — composer reads/writes the store-backed draft; drop local `text` state and the `session.id` clear effect.
- Tests: `src/client/__tests__/chatStore.test.ts`, `src/client/__tests__/chatComponents.test.tsx`.
- Server, wire protocol, and persistence are untouched: drafts are client-side, in-memory view state — they are not sent to the server, not persisted across page reloads, and not synced between browser tabs.
