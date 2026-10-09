# Design

## Context

`App.tsx` renders a single unkeyed `<ChatView session={selectedSession} …/>` and swaps the `session` prop when the user switches chats. The composer's text is local `useState` in `ChatView` (`src/client/components/chat/ChatView.tsx`), and an effect clears it whenever `session.id` changes — a guard against one chat's input leaking into another's composer, at the cost of destroying drafts. Per-session transcript state already survives switching because `useChatStore` keeps `sessions: Record<sessionId, ChatTranscript>` and `App.tsx` calls `remove(sessionId)` on `session-removed`. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**

- Draft state keyed by session id that outlives `ChatView` prop swaps (chat → chat, chat → terminal → chat).
- Reuse the existing per-session cleanup path so killed sessions don't leave drafts behind.
- No wire-protocol, server, or persistence changes.

**Non-Goals:**

- Persisting drafts to the server or storage (page reload discards them — spec boundary).
- Syncing drafts between browser tabs or clients.
- Draft recovery for the terminal paste modal or any non-chat input.
- Input history / recall of previously submitted messages.

## Decisions

**D1 — Drafts live as a top-level map in `useChatStore`, not inside `ChatTranscript`.**
Add `drafts: Record<string, string>` with `setDraft(sessionId, text)` (deleting the key when `text` is empty, so the map stays tidy) next to `sessions`, and clear the entry in the existing `remove()`.
- *Why not inside `ChatTranscript`:* `snapshot()` replaces the whole transcript object on every attach, so a switch back to a chat would wipe the draft; transcripts are also purely event-derived, and view state would muddy that invariant.
- *Why not a separate store:* `chatStore` already owns per-session client state and its `remove()` is already invoked from `App.tsx` on `session-removed`; a second store would need its own cleanup wiring for one map.
- *Why not localStorage/sessionStorage:* the spec bounds drafts to the open page; storage would add serialization and stale-entry cleanup for behavior nobody asked for.

**D2 — `ChatView` reads and writes the store-backed draft.**
`const text = useChatStore(state => state.drafts[session.id] ?? '')`; `onChange` calls `setDraft(session.id, value)`; submit sends the trimmed text and calls `setDraft(session.id, '')`. Delete the local `text` state and the `useEffect(() => setText(''), [session.id])` clear — per-session keying replaces that guard (each chat's selector resolves to its own draft, so nothing leaks across chats). The selector returns a string, so default Zustand equality is sufficient.

**D3 — Archive needs no draft handling.**
Archived chats already stop rendering the composer (read-only Restore bar). The draft map entry is simply untouched; when the chat is restored the composer remounts and reads the pre-archive draft from the store. Deliberately no clearing on archive.

## Risks / Trade-offs

- [Draft map grows with session count] → Bounded by open/known sessions; entries are deleted on submit (empty string) and on `session-removed`. Acceptable for a single-user dashboard.
- [Two tabs on the same server hold divergent drafts] → Accepted: drafts are per-client view state by spec, like scroll position.
- [A future `snapshot`-like replacement could clobber drafts if moved into transcripts] → Mitigated by D1's placement outside `ChatTranscript`; noted here as the reason the map stays top-level.

## Migration Plan

Client-only change with no schema, wire, or API impact: deploy and roll back by reverting. Drafts begin empty on first load after deploy; no data migration applies.
