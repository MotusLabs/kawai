# Tasks

Implement after `team-workspace` (or as its final tasks); file and store names below follow its design.

## 1. Team-addressed wire protocol and connections

- [x] 1.1 In `src/shared/types.ts`, replace `sessionId` with `teamPath` on every human `team-*`/`strategy-*` client message and on `team-workspace-open`/`close`, and drop `sessionId` from their server replies, which keep `teamId`. Add the `unknown-team` refusal. Verify with `bun run typecheck`, and add a test asserting `CHAT_CONNECTION_TYPES` still lists every type.
- [x] 1.2 Add a shared team-scope resolver under `src/server/team/`. It runs `resolveTeam(teamPath)`, then accepts the team only if it is the team of a discovered workspace repository (its `commonDir`) or of a non-killed chat session record. Verify with unit tests: a main checkout, a linked worktree, a plain-directory chat, and an archived chat's directory are accepted; an unrelated directory and a killed-only directory are refused.
- [x] 1.3 Move `taskConnections.ts`, `messageConnections.ts`, `mailboxConnections.ts`, and `strategyConnections.ts` onto the resolver, with `connection -> teamPath` subscriptions fanned out by `teamId`. Verify by rewriting their connection tests (`src/server/__tests__/team*Connections.test.ts`, `strategyConnections.test.ts`) to cover: open by repository path with no chat, open from a worktree path that lands on the same team, fan-out to each subscription of the team, cross-team ids still refused, and an unknown path refused with no data.
- [ ] 1.4 Move `team-workspace`'s `workspaceConnections.ts` onto the same resolver and `teamPath` addressing once that change has added it. Verify by extending its connection tests the same way as 1.3.

## 2. Messages text search and thread size

- [ ] 2.1 Add `text` to `MessageQueryFilters`. In `messageQuery.ts`, add the escaped, case-insensitive `LIKE` clause over body, sender and recipient group ids, and `team_session_directory` names of sender, recipient, or claimant. Add `threadSize` to each list row. Verify with `messageQuery` tests: an old message is found past the first page, `%` and `_` match literally, search combines with priority, keyset paging stays within the results, and `threadSize` counts the whole thread.
- [ ] 2.2 Extend `matchesMessageFilters` with the same `text` match over body, group ids, and caller-supplied participant labels. Verify with a shared test: a change push outside the search is dropped and one inside is kept.

## 3. Client team key, stores, and URL location

- [x] 3.1 Add a team-key helper that turns a path into the main-checkout path of its discovered repository, or the plain directory, and use it for every chat's team panels. Verify with unit tests: a worktree chat and the main checkout yield the same key, and a non-repository chat yields its directory.
- [x] 3.2 Re-key `teamTaskStore`, `teamMessageStore`, `teamMailboxStore`, and `strategyStore` by team key, and route replies by their echoed `teamPath`. Until the Team page exists, the side slot keys team panels by the chat's team key and Debug by session, showing Debug first when both are open. Verify by updating the store and side-slot tests to cover two chats of one team sharing one view, two teams kept apart, Debug's precedence, and reconnect replacing state.
- [ ] 3.5 Use the team key from the navigator Team entry, the header Team button, and the task chip, and key `teamWorkspaceStore` by it, once `team-workspace` adds them. Verify that a worktree chat's Team button and the repository's Team entry open the same Team page view.
- [ ] 3.3 Add per-team, per-tab view state (`search`, `filters`, `expanded`, `collapsedSections`) to `teamWorkspaceStore`, kept in memory only. Verify with store tests: state survives tab switches, a chat visit, and reconnect, and is not shared between teams.
- [ ] 3.4 Add `useTeamLocation`, which parses and writes `#/team/<key>/<tab>[/<sub>][/<id>]` with `pushState` for tab and selection changes. In `App.tsx`, render `TeamWorkspaceView` for a team route and clear the route when a session is selected. Verify with hook tests (reload restores, Back and Forward, unknown key, missing item opens with a notice) and an `App` test that selecting a session shows the chat and Back returns to the same tab and task.

## 4. Chat header and side slot

- [ ] 4.1 Replace the panel switcher in `ChatHeader.tsx` with the **Team** button (last tab used per team, Tasks the first time). Point the task chip at the Team page's Tasks tab with that task. Apply `useHeaderLayout`'s labelled, icon, and in-menu steps to the Team button. Verify by updating `ChatHeader` and `useHeaderLayout` tests: no team switcher entries, Team at each width step, the icon-only accessible name, the task chip opening the task, and Team present for archived and plain-directory chats.
- [ ] 4.2 Delete `sideSlot.ts` and the side-slot wrappers (`TeamTasksPanel`, `TeamMailboxPanel`, `TeamMessagesPanel`, `ProductStrategyPanel`). `ChatView` mounts `ChatDebugPanel` directly from `chatDebugStore`. Verify that a ChatView test confirms Debug toggles from the session menu and that no team view mounts in a chat, and that `bun run lint && bun run typecheck && bun run test` pass.

## 5. Team page tabs

- [ ] 5.1 Move the views to `src/client/components/team/` (`TeamTasksView`, `TeamMailboxView`, `TeamMessagesView`, `ProductStrategyView`, with their helpers). Mount Strategy | Tasks | Messages | Mailbox | Members in `TeamWorkspaceView` in that order, with the Plans key still reserved, and add the strategy status line in the page header. Verify with `TeamWorkspaceView` tests: the tab order, the status line for approved, in-review, and no-record cases with its link target, and no Plans placeholder.
- [ ] 5.2 Build the Strategy sub-views in `ProductStrategyView`: an overview with direction open and other sections collapsed, a two-column review with an Approve and Withdraw footer, the draft editor with a section list (unsaved text held per team in `strategyStore`), and history. Verify with component tests: the overview section order, the review layout and approve controls bound to the exact revision and hash, draft text surviving a switch to History and back, and capture offered with no record.
- [ ] 5.3 Build `TeamMailboxView`: the fixed section order with the first three expanded and counts on the others, one-line rows with the immediate blocker that expand to the full body, constraints, and handoff detail, search across every section, hide-empty, and routing as its own collapsible section, keeping every existing action. Verify by moving the mailbox panel tests over and adding cases for section order and default expansion, row expand and collapse, search narrowing the counts, hiding empty sections, and Retry, Discard, Cancel, and Hand off still sending their messages.
- [ ] 5.4 Build thread grouping in `TeamMessagesView`: one row per thread with its newest message and `threadSize`, expansion through the existing thread read, clamped bodies with show-full, Expand all and Collapse all, and a search box sending `text`. Verify by moving the Messages view tests over and adding cases for a six-message thread collapsing to one row, clamping, Expand all and Collapse all, and search re-opening the list with `text`.
- [ ] 5.5 Build search and collapse in `TeamTasksView`: search over title and direction with marked matches and ancestors kept, a collapsible parent/subtask tree, and independently collapsible detail sections that stay collapsed across tasks. Verify by moving the task panel tests over and adding cases for search with a matching subtask, parent collapse showing the subtask count, and section collapse persisting across tasks.

## 6. End-to-end, docs, and CI

- [ ] 6.1 Update `tests/e2e/chat-teams.spec.ts`, `chat-team-messages.spec.ts`, `strategy.spec.ts`, and `chat-header.spec.ts` to reach the views through the Team button and Team entry instead of header panels. Add a spec case: open a terminal-only repository's Team page, search Mailbox, open a chat from a row, press Back, and assert the same search and expanded rows; then reload and assert the tab and selected task. Verify that the specs pass locally on a spare `E2E_PORT` after `bun run build`, and that any new spec file is named in `ci.yml`.
- [ ] 6.2 Update the CLAUDE.md "How It Works" bullets: the chat header (Team button, Debug as the only side slot), Task UI, Messages view, Strategy UI, and the Team page's tabs, search, collapse, and URL. Each bullet should name only shipped behaviour. Verify with `bun run lint && bun run typecheck && bun run test`.

## Workflow follow-up

- Archive only after `team-workspace` is archived: this change's `team-workspace` delta MODIFIES and REMOVES requirements that change introduces.
- Tell the lead that this change overrides `team-workspace` Q2 (strategy band) and Q11 (chat-side shortcuts) at the human's request.
