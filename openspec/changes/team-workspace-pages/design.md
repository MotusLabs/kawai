# Design

## Context

See proposal.md for why. This change is stacked on `team-workspace`, which is proposed but not implemented. It adds a repository-level Team page (`TeamWorkspaceView`, a `team-workspace-open` read model, a navigator Team entry). It also keeps the chat side-slot panels as thin wrappers over host-agnostic views (D3, Q11), with Product Strategy as a band above the tabs (D2, Q2). This change reverses those three rulings at the human's request and builds on everything else in `team-workspace`.

Current state that shapes the approach:

- **The side slot.** `sideSlot.ts` holds five panels: `debug`, `mailbox`, `tasks`, `messages`, `strategy`. Each team panel's store keeps a view per **session id** (`views[sessionId]`). `ChatHeader.tsx` renders the switcher, and `useHeaderLayout` folds it into icons and then into the session menu.
- **Team resolution.** Every human team connection resolves its team from a session: `taskConnections.ts`, `messageConnections.ts`, `mailboxConnections.ts`, and `strategyConnections.ts` all call `manager.teams.resolvedTeamOf(sessionId)`, and subscriptions are keyed `connection -> sessionId -> teamId`. `resolveTeam(path)` in `teamIdentity.ts` already maps any directory to `{ teamId, groupsRoot }`: the canonical git common dir, or the plain directory itself.
- **What each view reads.**
  - The mailbox snapshot (`MailboxStore.listForTeam`) already holds every unsettled row of a team, so it can be searched on the client.
  - The task snapshot (`TeamTaskSummary`) carries `title`, `direction`, and `parentId`, enough for client-side search and the tree.
  - Messages are keyset-paged (`messageQuery.ts`), so client-side search would only see the loaded pages. `team_messages_thread (thread_id)` exists, and `team_session_directory` holds a durable name per session.
- **No router.** The main pane is chosen by `selectedSessionId` alone (ChatView or Terminal).

## Goals / Non-Goals

**Goals:**
- Team views are addressed by team, not by chat, all the way down: wire messages, server subscriptions, client stores, and the URL.
- The side slot shrinks to Debug.
- Strategy, Mailbox, Messages, and Tasks are laid out for a full page, with search, collapse, and kept view state.

**Non-Goals:**
- Changing any read model's facts, or `team-workspace`'s attention queue, stage projection, Members, or morning summary.
- Persisting view state across page reloads (only the URL location survives a reload).
- A router library.
- Ranked or full-text search: a substring match is enough.

## Decisions

### D1. Human team messages carry `teamPath`, not `sessionId`

Every human `team-*` and `strategy-*` client message, plus `team-workspace-open`/`close`, takes `teamPath`: a directory the client already knows, either a repository's main checkout from the workspace snapshot or a chat's `projectPath`. The server resolves it with `resolveTeam`. It then authorizes the result: the `teamId` must equal the team of a discovered workspace repository (its `commonDir`), or the team of a chat session record that is not killed (archived ones included). Otherwise it refuses with `unknown-team`.

Subscriptions become `connection -> teamId`, one per team rather than one per session. Fan-out on change is then a single lookup, and two chats of the same team no longer double-subscribe. Server messages keep carrying `teamId` and drop `sessionId`. Agent tools are untouched; they still bind identity to the calling session.

*Alternatives:*
- Keep `sessionId` and pick any chat of the team. Rejected: a repository with only terminal sessions has no chat to pick, and the page would silently depend on a session's lifetime.
- Send the `teamId` (common dir) directly. Rejected: chats only know their `projectPath`, and canonicalization is the server's job (`resolveTeam` already does it and caches it).

### D2. The client keys team state by a team key that the URL also uses

The client derives a **team key** before any snapshot arrives:

- the main-checkout path of the discovered repository containing the path (`WorkspaceRepository` and its worktrees), or
- the plain directory, for a chat outside any repository.

The navigator Team entry, the header Team button, and the task chip all compute the same key for the same team. That key is the `teamPath` sent in D1, the key of every team store (`teamTaskStore`, `teamMessageStore`, `teamMailboxStore`, `strategyStore`, `teamWorkspaceStore`), and the repository segment of the URL. Snapshots echo the server `teamId`, and the store checks it against the one it first received, so two keys can never alias one team unnoticed. *Alternative:* key stores by server `teamId` only. Rejected: the URL and the first render need a key before the server answers.

### D3. One hash route: `#/team/<key>/<tab>[/<sub>][/<id>]`

`useTeamLocation` parses and writes `location.hash`:

- `tab` is `strategy | tasks | messages | mailbox | members`.
- `sub` is the Strategy sub-view: `overview | review | draft | history`.
- `id` is a task id, a thread id, or a revision number for `review`.

Tab and selection changes `pushState`, so Back and Forward move between them; search and expansion never touch the URL. `App.tsx` renders `TeamWorkspaceView` when the hash is a team route, otherwise ChatView or Terminal. Selecting a session clears the team route, and the Team page leaves `selectedSessionId` alone (`team-workspace` D10). An unknown key or a missing item falls back to the tab's default view with a notice. *Alternative:* React Router. Rejected: one route family does not justify a dependency and a migration of the existing selection model.

### D4. The side slot is Debug only; `sideSlot.ts` goes away

With four of its five entries gone, the slot table has no reason to exist. `ChatView` mounts `ChatDebugPanel` from `chatDebugStore` directly, and the session menu's Debug toggles it. The side-slot wrappers are deleted: `TeamTasksPanel`, `TeamMailboxPanel`, `TeamMessagesPanel`, and `ProductStrategyPanel`. Their views move to `src/client/components/team/`: `TeamTasksView`, `TeamMailboxView`, `TeamMessagesView` (moved), and `ProductStrategyView`. This replaces `team-workspace` D3's "extract and keep thin wrappers": the views are still host-agnostic, but the Team page is their only host.

`useHeaderLayout` keeps its three steps (labelled, icon, in menu) and applies them to the single Team button. *Alternative:* keep the switcher with one entry. Rejected: a one-entry switcher is a button with extra semantics.

### D5. Strategy sub-views reuse the existing editor and history

`ProductStrategyView` routes `overview | review/<n> | draft | history`:

- **Overview** renders the approved revision (or the newest InReview, labelled as not approved) with direction sections open and the rest collapsed.
- **Review** is the existing review block laid out in two columns at `md` and wider (diff | findings), with the approve and withdraw controls in a footer.
- **Draft** wraps `StrategyDraftEditor` with a section list on the left.
- **History** is `StrategyRevisionHistory`.

The draft's unsaved text is already held in the editor's state. It moves into `strategyStore` per team so switching sub-views keeps it; reloads still drop it, as today. The header status line reads the strategy snapshot `strategyStore` already has, so it needs no new wire data. This replaces `team-workspace` D2's band.

### D6. Mailbox and Tasks search on the client

The snapshots already hold every row they need.

- **Mailbox** matches its search case-insensitively against sender and recipient labels, body, and the waiting reason's text, and applies it to every section. Section order is a constant: Held for review, Dead letters, Parked, Starting agent, Queued, Receiving, Scheduled. Default expansion is "the first three". A row's collapsed line uses the reason's immediate blocker from `team-waiting-reasons`.
- **Tasks** matches title and current direction (`TeamTaskSummary.direction`). A matching subtask pulls its ancestors into the result so the tree stays connected.

*Alternative:* server-side search for these tabs too. Rejected: it adds wire messages and round-trips to data the client already holds.

### D7. Messages search is a server filter; threads group on the client

`MessageQueryFilters` gains `text`. `messageQuery.ts` adds a clause that matches it with case-insensitive `LIKE`, after escaping `%`, `_`, and the escape character, against:
- `body`,
- the sender and recipient group ids,
- any `team_session_directory.name` of the sender, recipient, or claimant in the same team.

Paging is unchanged: the keyset cursor runs within the filtered set. `matchesMessageFilters` implements the same match for change pushes, over body, group ids, and the participant labels the client already resolves, so a live row outside the search is dropped (spec scenario). Each list row gains `threadSize` (a correlated `COUNT(*)` over the indexed `thread_id`), so a collapsed thread row can state its size without loading the thread. The client groups loaded rows by `threadId` and shows the newest. Expanding a thread row uses the existing thread read. *Alternative:* SQLite FTS5. Rejected: it adds a virtual table and triggers for a team-sized history where a scan is fast enough. Revisit if a team's history grows past what a scan answers quickly.

### D8. View state lives in `teamWorkspaceStore`, per team and per tab

`teamWorkspaceStore` (introduced by `team-workspace` for selection and filters) holds `{ search, filters, expanded: string[], collapsedSections: string[] }` per team key and tab. Expanded ids are row, thread, or task ids. Detail sections are keyed by section name, so a collapsed Revision history stays collapsed across tasks (spec scenario). The state is memory only, never sent to the server, and survives tab switches, chat visits, and reconnects because nothing resets it on those events.

## Risks / Trade-offs

- [**Stacked on an unimplemented change.** `team-workspace` may still move its view names, store, or connection shape] → This change binds only to its spec headers and to D10's navigator entry. Implement it after `team-workspace`, or fold it into that implementation's last tasks; either way its archive must follow `team-workspace`'s (`openspec validate` reports this).
- [**Removing the side-slot panels breaks muscle memory and e2e specs**] → Use one Team button in the same place, keep the task chip, and update the e2e specs in the same change (`chat-teams`, `chat-team-messages`, `strategy`, `chat-header`).
- [**Paths on the wire become an authorization input**] → Canonicalize with `resolveTeam`, then accept only teams of discovered repositories or of existing chat sessions. That is the same population the navigator and chats already expose, and connection tests cover refusal.
- [**`LIKE` over bodies scans the team's history**] → The scan is bounded by `team_id` and the page size. FTS5 is the escape hatch (D7).
- [**Client and server must change together (BREAKING wire shape)**] → They ship in one build. A browser tab still running the old client gets refusals for its session-addressed team messages until it is reloaded. Chat itself is unaffected. This is acceptable for a single-user tool, and the release notes say to reload.
- [**Overriding a lead ruling (Q2, Q11)**] → The proposal and specs state the override explicitly, and the lead is told when this change is opened.

## Migration Plan

No data migration. Ship the client and server together. Rollback is reverting the change, which restores the side-slot panels and session-addressed messages; no stored state depends on either.
