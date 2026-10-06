# Tasks

## 1. Archived state on the server

- [x] 1.1 Add nullable `archived_at` to `chat_sessions` with a `PRAGMA table_info`-guarded migration and expose it on the record and as `archivedAt` on the shared `Session`; verify with db tests for a fresh database, an existing database without the column, and rows defaulting to not archived
- [x] 1.2 Add `ChatSessionManager.archive` that interrupts, cancels pending requests, stops and forgets the driver, keeps record, conversation ID, history, and protocol log, writes `archived_at`, and publishes the session; verify with manager tests for idle and in-flight archive, cancelled requests reported to subscribers, and the protocol log retained
- [x] 1.3 Make `ensureDriver` refuse archived sessions and return an "archived" error for sends; verify with manager tests that send and concurrent ensureDriver after archive start no driver
- [x] 1.4 Add `ChatSessionManager.restore` that clears `archived_at` so the next send resumes the stored conversation; verify with a manager test that restore then send creates a driver with the stored conversation ID
- [x] 1.5 Verify kill on an archived session removes the row and protocol log and that an archived session reloads as archived after a manager restart, with tests
- [x] 1.6 Add `chat-archive` and `chat-restore` client messages and handlers in `src/server/index.ts` broadcasting the updated session and returning errors for unknown sessions; verify with WebSocket handler tests

## 2. Navigator placement and the Archive pane

- [x] 2.1 Add `FALLBACK_ARCHIVE_SECTION_KEY` and an `archive` fallback section in `workspaceView.ts`; place hibernating and history agent sessions and chats with `archivedAt` there, sorted newest first by `archivedAt ?? lastActivity`, and drop the `host != null` remote check for agent sessions; verify with workspaceView tests for each placement, ordering, filters, attention counts, and visible navigation order
- [x] 2.2 Generalize the docked fallback panes to `[workspace, remote, archive]` with `archivePaneFraction` in the settings store and shared sizing, resize, and collapse logic; verify with SessionList and settings store tests for default sizing, proportional reduction, persistence, and collapsed-pane redistribution with three panes
- [x] 2.3 Treat the Archive section as collapsed until the user has expanded it, retaining the choice across reloads; verify with collapse-state tests for first use and after expanding
- [x] 2.4 Verify the mobile navigator (`SessionDrawer`) shows the Archive pane with the same grouping, collapse, and sizing, with a component test

## 3. Archive and restore in the UI

- [x] 3.1 Add Archive (live chats) and Restore (archived chats) to the chat row menu in the navigator, keeping Kill available; verify with SessionRow tests for both states
- [x] 3.2 Add an Archive button to the chat view header that asks for confirmation when status is `working` or `permission` and sends `chat-archive` otherwise or on confirmation; verify with ChatView tests for idle, working-confirmed, and working-declined
- [x] 3.3 Render archived chats read-only in `ChatView`: transcript shown, composer, Stop, and request actions replaced by a Restore bar; verify with ChatView tests and that attach still requests a snapshot
- [x] 3.4 Update `CLAUDE.md` "How It Works" to describe archived chats and the Archive section; verify the text matches the implemented behavior

## 4. Integration

- [ ] 4.1 Run `bun run lint && bun run typecheck && bun run test` and verify all pass
- [ ] 4.2 With the `dev-browser` skill against `bun run dev`: archive an idle chat, confirm no agent process starts when it is opened, restore it, send a message that continues the conversation, and confirm closed terminal sessions appear in Archive and not in Remote; capture screenshots
