# Proposal

## Why

The navigator has no way to put a chat away: the only chat action is Kill, which permanently deletes the session and its debug log, so finished chats either clog their worktree sections or are destroyed. Closed terminal sessions already appear to be "put away" under `Remote`, but only by accident — local agent sessions always carry the server's host label, so the client treats every hibernating and historical local session as remote, mixing them with live sessions on other hosts.

## What Changes

- Add an archived state for chat sessions, between running and killed. Archiving stops the agent process (interrupting an in-flight turn and cancelling pending requests) but keeps the session record, its conversation ID, its transcript, and its debug log. Archiving a chat with a turn in flight asks for confirmation first.
- Let users archive a chat from the chat view header and from the chat row in the navigator, and restore an archived chat from the same places.
- Show an archived chat as a read-only replay of its conversation with a Restore action. Opening an archived chat MUST NOT start an agent process. Kill remains available for archived chats.
- Archived chats are not subject to the history lookback window; they stay until restored or killed.
- Add an `Archive` section, docked at the bottom of the navigator like `Workspace` and `Remote`, holding hibernating and historical terminal sessions and archived chats, newest first, collapsed by default.
- Fix remote classification at its root: hibernating and historical agent sessions are recorded by this server and are local, so they are no longer placed in `Remote`. `Remote` holds only live sessions on other hosts.
- **BREAKING (navigation):** hibernating and historical sessions move out of their change, worktree, and `Workspace` sections into `Archive`. The existing spec placed them in those sections; in practice they appeared under `Remote`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: chat sessions gain archive and restore, a read-only archived view that starts no process, and exemption from history lookback; kill remains the only permanent removal.
- `workspace-navigation`: section grouping, ordering, collapse, and docked-pane sizing gain the `Archive` section; hibernating and historical sessions are placed there instead of in change, worktree, or `Workspace` sections; `Remote` holds only live sessions on other hosts.

## Impact

- Server: `src/server/db.ts` (nullable `archived_at` on `chat_sessions` with migration), `src/server/chat/ChatSessionManager.ts` (archive/restore, no driver for archived chats), `src/server/index.ts` (WebSocket handlers), `src/server/agentSessions.ts` or the session payload (local vs remote classification).
- Shared: `src/shared/types.ts` (archived flag on chat sessions, archive/restore client messages), `src/shared/workspace.ts` (archive section key).
- Client: `src/client/utils/workspaceView.ts`, `src/client/components/SessionList.tsx` and the fallback pane, `SessionRow.tsx` (row action), `src/client/components/chat/ChatView.tsx` (header action, read-only mode), settings store (archive pane fraction).
- No new dependencies. Existing chat rows migrate as not archived. Follow-up `add-chat-slash-commands` depends on this change for `/clear`.
