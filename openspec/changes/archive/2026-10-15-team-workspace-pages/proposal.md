# Proposal

## Why

The chat header's Tasks, Mailbox, Messages, and Strategy panels show the whole team's state, yet they live inside one chat. They need a selected chat to open, they reset when the selection changes, and they squeeze into a 24rem side column. A repository with no live chat cannot show its tasks or strategy at all. `team-workspace` adds a repository-level Team page, but it keeps those panels as chat shortcuts (its Q11). It puts strategy in a band above the tabs (Q2) and leaves the text-heavy Mailbox unchanged. The human has asked for the opposite on all three: team views leave the chat, Strategy gets its own page, and Mailbox, Messages, and Tasks become full views with search and collapse.

## What Changes

- **BREAKING (UI): team panels leave the chat.** The header's Tasks / Mailbox / Messages / Strategy switcher is replaced by one **Team** button. It opens the Team page for the chat's team on the last tab used. The task chip opens that task on the Team page. Debug stays in the session menu and becomes the only side-slot panel. This overrides `team-workspace` Q11 (shortcuts stay) and D3's thin side-slot wrappers.
- **Strategy is a page.** **Strategy** becomes the Team page's first tab, replacing D2's band above the tabs. It holds four full-width sub-views: direction overview, revision review (diff beside findings, with the approve controls underneath), draft editor (section list beside the form), and history. A one-line strategy status (approved revision, any revision in review) stays in the Team page header and links to the tab, so direction is still visible from every tab. This overrides `team-workspace` Q2.
- **Mailbox is a tab.** The tab strip becomes **Strategy | Tasks | Messages | Mailbox | Members**. Mailbox keeps every delivery operation and its waiting reasons, laid out for scanning instead. Sections that need action (Held for review, Dead letters, Parked) come first and start expanded; the others start collapsed. Rows are one line and expand to the full body. Empty sections can be hidden, and routing is its own collapsible section. This overrides "the Mailbox SHALL NOT be restyled".
- **Search and collapse everywhere.** Tasks, Messages, and Mailbox each get a search box and per-item expand/collapse. Tasks shows a collapsible parent/subtask tree, and each task-detail section collapses on its own. Messages groups rows by thread, with **Expand all** / **Collapse all**, and long bodies are clamped until expanded. Search on Messages runs on the server over the whole history, not only the loaded pages. Each tab remembers its search, filters, and expanded items for as long as the page is open.
- **Addressable pages.** The Team page's repository, tab, and selected item live in the URL hash, so reloads, links, and the browser's Back button work.
- **Team views address a repository, not a chat.** Every human team view (workspace, tasks, messages, mailbox, strategy) is opened by the repository the navigator lists, so it works with no chat selected. The server refuses any path that is not a discovered repository or listed worktree. This replaces D9's "resolve the team from the calling session" for these views. Agent tools are unaffected.

Non-goals: new task, mail, or strategy actions; editing group files; full-text search over task journals or strategy history; a combined search across tabs; any change to delivery, routing, staffing, or approval rules; the Plans tab (still Wave C).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-header`: the side-panel switcher becomes one Team button; the task chip opens the Team page; header compaction and keyboard requirements follow.
- `team-workspace` (introduced by the unarchived `team-workspace` change; this change archives after it): Strategy as a tab with sub-views instead of a band, team views mounted only on the Team page, a Mailbox tab, search and collapse on Tasks/Messages/Mailbox, the URL-addressed location, and repository-addressed team scoping.

## Impact

- Depends on `team-workspace` (stacked on `docs/team-workspace`). Its deltas MODIFY and REMOVE `team-workspace` requirements, so it must be archived after `team-workspace`. It is best implemented after it too, or folded into its implementation.
- Client: `ChatHeader.tsx` + `useHeaderLayout` (Team button instead of the switcher), `sideSlot.ts` (Debug only), `ChatView.tsx` (stops mounting team panels). The `TeamTasksPanel`, `TeamMailboxPanel`, `TeamMessagesPanel`, and `ProductStrategyPanel` side-slot wrappers are removed, and their views move under `src/client/components/team/`. `TeamWorkspaceView.tsx` gains the Strategy and Mailbox tabs and the header strategy status line. A new `useTeamLocation` hook handles the hash. `teamTaskStore`, `teamMessageStore`, `teamMailboxStore`, `strategyStore`, and `teamWorkspaceStore` are keyed by team instead of session, with per-tab search, filter, and expansion state.
- Server: the connection classes (`taskConnections.ts`, `messageConnections.ts`, `mailboxConnections.ts`, `strategyConnections.ts`, and `team-workspace`'s `workspaceConnections.ts`) take a repository path, resolve it through `resolveTeam`, and check it against discovered repositories and listed worktrees. `messageQuery.ts` gains a text-search filter.
- Shared: the `team-*`/`strategy-*` client messages in `src/shared/types.ts` carry `teamPath` instead of `sessionId`; `MessageQueryFilters` gains `text`. Client and server ship together, so no compatibility shim is needed.
- Data: none.
- Docs: CLAUDE.md bullets for the chat header, Task UI, Messages view, and Strategy UI.
- Tests: header and side-slot unit tests are rewritten; the panel tests move to the views; there are connection tests for repository addressing and refusal, and a `messageQuery` text-search test. Playwright specs that open team panels from the chat header (`chat-teams`, `chat-team-messages`, `strategy`, `chat-header`) open the Team page instead.
