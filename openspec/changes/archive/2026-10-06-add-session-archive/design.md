# Design

## Context

See proposal.md for motivation; requirements are in `specs/chat-sessions` and `specs/workspace-navigation`.

- Chat sessions are `Session` rows with `kind: 'chat'`, listed through the session registry alongside tmux sessions. Their durable record is the `chat_sessions` table; the agent process lives in a `ChatSessionDriver` that `ChatSessionManager.ensureDriver` creates lazily on the first send. `ChatSessionManager.kill` stops the driver and deletes the row and the protocol log.
- A chat snapshot (`chat-snapshot`) is built from transcript replay plus live events, so prior conversation can be shown without a driver.
- Hibernating and historical terminal sessions are `AgentSession` rows from the `agent_sessions` table, delivered in the `agent-sessions` message. `toAgentSession` always sets `host` to the server's host label, and `workspaceView.ts` treats `host != null` as remote, which is why they currently land in `Remote`. Remote hosts never contribute agent sessions.
- `Workspace` and `Remote` are docked fallback panes with per-pane height fractions in the settings store and collapse state keyed by stable section keys in `src/shared/workspace.ts`.

## Goals / Non-Goals

**Goals:** a durable archived state for chats that never starts an agent while archived; one `Archive` pane for everything that is no longer running; correct local/remote classification.

**Non-Goals:** archiving live terminal (tmux) sessions — Kill and "Move to History" already cover them; bulk archive or auto-archive by age; changing history lookback for terminal sessions; slash commands (follow-up `add-chat-slash-commands`).

## Decisions

### 1. Archived is a timestamp on the chat record, not a session status

Add nullable `archived_at` to `chat_sessions` and an optional `archivedAt` to the shared `Session`. Status stays `waiting` while archived, so status derivation, attention badges, and the session-update path are unchanged.

Alternatives: a new `SessionStatus` value would leak into every status consumer (badges, sorting, terminal-only code paths) for a concept that is about placement, not activity. Converting archived chats into `AgentSession` history rows would reuse the Archive placement but would lose chat-specific selection, snapshot, and kill handling.

### 2. Archive stops the driver; nothing may recreate it while archived

`ChatSessionManager.archive(id)` stops and forgets the driver through the same path kill uses for the process (interrupt, settle pending requests as cancelled, terminate), but keeps the record, conversation ID, live-event history, and protocol log, then writes `archived_at` and publishes the updated session. `ensureDriver` refuses archived sessions, so every path that would spawn — send, and the attach-time start planned in `add-chat-slash-commands` — is guarded in one place. A send to an archived session returns an error message. `restore(id)` clears `archived_at`; the driver is created again lazily with the stored conversation ID, exactly as after a server restart.

Kill keeps its current behavior and works with or without a driver.

### 3. Confirmation is a client concern

The client asks for confirmation when the session status is `working` or `permission`; the server archive operation itself is unconditional. This keeps the protocol to two idempotent messages, `chat-archive` and `chat-restore`, and avoids a server-side confirmation handshake. A race where a turn starts after an idle archive click is acceptable: the archive interrupts it.

### 4. Read-only view is the existing chat view without input

`ChatView` renders the snapshot as today and, when `archivedAt` is set, replaces the composer and Stop with a Restore bar and hides request actions (there are none: archiving cancels them). Attach and debug subscriptions keep working, since they read snapshots and logs and do not need a driver.

### 5. Placement: the Archive section takes everything that is not running

In `workspaceView.ts`, hibernating and history `AgentSession`s and chats with `archivedAt` go to a new `archive` fallback section; live sessions keep the current placement, where `remote` comes only from live `Session.remote`. The `host != null` check on agent sessions is removed rather than worked around, since agent sessions are always local. Archive rows sort by `archivedAt ?? lastActivity`, newest first. Existing row components are reused: hibernating rows keep "Move to History", history rows keep resume, archived chat rows offer Restore and Kill.

Alternative: keep history in worktree sections and add only archived chats to Archive. Rejected because the user's goal is an uncluttered navigator, and history in sections is what clutters it today (or would, once the remote bug is fixed).

### 6. Third docked pane, generalized

Generalize the two fallback panes into an ordered list `[workspace, remote, archive]` with `archivePaneFraction` added to the settings store and the same sizing, resize, and collapse logic. The archive section key is `fallback::archive`. First-use collapse: when the stored collapse state has never recorded the archive key, treat it as collapsed; expanding records it as expanded.

### 7. Lookback needs no special case

The history lookback filters `agent_sessions` queries only. Archived chats come from `chat_sessions`, so they are unaffected by construction; the spec scenario is covered by a test, not new logic.

## Risks / Trade-offs

- [History leaves change sections] Users who resumed work from a change section now look in Archive. → The section is one click away and keeps resume actions; the move is called out as breaking in the proposal.
- [Large Archive pane] Many closed sessions could fill a pane. → Collapsed by default, independently scrollable, resizable; existing history pagination and lookback still apply to terminal history.
- [Archive racing a send] A send arriving between archive and the client update could recreate a driver. → `ensureDriver` checks `archived_at` under the same in-flight guard that prevents duplicate drivers.
- [Follow-up dependency] `add-chat-slash-commands` starts drivers on attach. → It must go through `ensureDriver`, which already refuses archived sessions.

## Migration Plan

Add `archived_at` with an `ALTER TABLE` guarded by `PRAGMA table_info`, as done for `profile_id`. Existing rows are not archived. Rollback to older code ignores the column, so archived chats reappear as normal chats; no data is lost.
