# Tasks

## 1. Shared workspace model

- [x] 1.1 Add `src/shared/teamWorkspace.ts` with `AttentionItem`, `AttentionKind`, `TeamTaskRow`, `TeamMemberRow`, `MorningSummary`, and `TeamWorkspaceSnapshot`, following the `src/shared/teamTasks.ts` style; verify `bun run typecheck` passes and a unit test pins the item id shape `kind:sourceId`.
- [x] 1.2 Add the `team-workspace-snapshot`, `team-workspace` change push, and `team-workspace-open`/`close` messages to `src/shared/types.ts` on the `team-tasks-snapshot` pattern, and register the two client types in `CHAT_CONNECTION_TYPES` (`src/server/chat/chatConnectionTypes.ts`); verify `bun run typecheck` passes and a test asserts the router accepts the new types.

## 2. Group settings read model (Members)

- [x] 2.1 Make `readGroupDir`/`loadGroupCatalog` in `src/server/team/groupCatalog.ts` retain each group's defining file path and, when both layers define the id, both paths with the winning layer marked; update the `GroupCatalog` type and every caller (`teamGroups.ts`, `routes/teamGroups.ts`, `sessionMailbox.ts`, `TeamMailbox.ts`, `sessionTeams.ts`, `TaskService.ts`, `StrategyService.ts`); verify unit tests cover a single-layer group naming one file, a project file overriding a user file, and a skipped file appearing only in `errors`.
- [x] 2.2 Add a Members read model that returns per group: `description`, live membership (name, spawned/manual, profile, status, task), `canCreateTasks`, effective `profiles` with caps and live counts, `approval`, `max`, `strategy`, `onLimit`, `effort`, `warnings`, and the source paths from 2.1; expose it on the workspace snapshot; verify unit tests cover caps with live counts, a warning naming what fell back, and that no field is writable.

## 3. Workflow stage and task rows

- [x] 3.1 Add pure `teamTaskStage.ts` implementing D4's ladder over the Phase 1 sources only — the task's own status (done/cancelled shows no stage) and `task-assignment` D5's derived outstanding-assignment state (Implementing for `claimed`/`delivered`/`parked`/`forwarded`/`uncertain`, Unstarted otherwise); verify unit tests cover every Phase 1 stage, the ladder order (a closed task with a delivered assignment shows no stage), and that a finished turn never yields `done`.
- [x] 3.2 Add `TeamTaskRow` projection (title, status, stage, accountable session or role, worktree, waiting reason from `team-waiting-reasons`, next action) in `src/server/team/workspaceRead.ts`; verify unit tests cover a queued group assignment showing the requested role and no session, a claimed assignment naming the session, and a waiting reason appearing on the row.
- [x] 3.3 Implement the filters (active, blocked, awaiting human, awaiting acceptance, group, worktree) and the default exclusion of done/cancelled with search still finding them; verify unit tests cover each filter and that closed tasks are absent by default but returned by search.

## 4. Attention queue and morning summary

- [x] 4.1 Add the attention source registry in `src/server/team/workspaceRead.ts` — approvals/questions from pending chat requests, uncertain deliveries from `team_message_events`, staffing waits from the `team-waiting-reasons` ledger — each producing `AttentionItem`s with cause, owner, impact, next action, and link; verify unit tests cover one item per source kind, the `requiresHuman` split, and an unrecognized kind rendering rather than being dropped.
- [x] 4.2 Wire count reconciliation and toast identity: replace items/counts from the snapshot, key toasts on `kind:sourceId` transitions into human-required, and suppress toasts for identities already seen in that client session; verify unit tests cover a reconnect converging counts and a replayed snapshot raising no toast.
- [x] 4.3 Add the 24-hour morning summary (capacity waits, approvals, uncertain deliveries, finished-turn-without-result) per D8's sources, with the runtime-only capacity bucket labelled; verify unit tests cover each bucket, that a finished turn with no result never lands in a completion bucket, and that durable buckets survive a simulated restart.

## 5. Workspace connections and team isolation

- [x] 5.1 Add `src/server/team/workspaceConnections.ts` (`team-workspace-open`/`close`, authoritative snapshot on open and reconnect, unfiltered change pushes) on the `TaskConnections` pattern, resolving the team via `loadTeamGroups(session.projectPath).team`; wire it in `ChatSessionManager.ts` beside the existing connections; verify connection tests cover open, change, reconnect, and close, and that a team with no tasks serializes empty lists.
- [x] 5.2 Enforce server-side team scoping: every workspace read is checked against the calling session's team, and a foreign task, message, or strategy named by a link is refused; verify tests cover a second repository staying isolated and a cross-team link returning a refusal with no data.

## 6. Views and the Team workspace UI

- [x] 6.1 Host-agnostic `TeamTasksView.tsx` and `ProductStrategyView.tsx` keyed by the **`teamPath`** team key rather than the chat `sessionId`, following `TeamMessagesView.tsx`. Delivered by `team-workspace-pages` (3.2, 4.2, 5.1): `src/client/components/team/TeamTasksView.tsx` and `ProductStrategyView.tsx` take `teamPath` and key `teamTaskStore`/`strategyStore` by it; the side-slot panels this task would have left as wrappers were deleted instead (pages 4.2), so there are no wrappers to keep. Evidence: `src/client/__tests__/teamTasks.test.tsx`, `productStrategy.test.tsx` (views mounted by `teamPath`) and `teamKeyChatView.test.tsx` (an open view follows its team, never the host chat).
- [x] 6.2 Build `TeamWorkspaceView.tsx` under the `team-workspace-pages` model: the page header shows the one-line strategy status (no strategy band), `TeamAttentionQueue.tsx` and `TeamMorningSummary.tsx` sit beneath it, and the **Strategy | Tasks | Messages | Mailbox | Members** tab strip mounts the views, with the Plans key reserved in the tab registry and rendering nothing; verify a test asserts no Plans placeholder exists and that the attention queue and summary render on every tab.
- [x] 6.3 `src/client/stores/teamWorkspaceStore.ts` is keyed by team key and holds per-tab search, filters, expansion, collapsed sections, and the last-used tab (`team-workspace-pages` 3.3), plus which page bands are open; `teamWorkspaceDataStore.ts` holds the workspace read model and the seen toast identities, fed by `team-workspace-snapshot`/`team-workspace` through `protocol/teamWorkspaceMessages.ts`, opened by `TeamWorkspaceView`, and re-keyed by `teamViewMigration.ts`. Tests: `teamWorkspaceStore.test.ts`, `teamWorkspaceData.test.ts`.
- [x] 6.4 Build `TeamMorningSummary.tsx` and `TeamMembersPanel.tsx` (read-only; each setting names its source file; the prompt-change caveat is stated); verify a component test asserts Members exposes no write control and names both layers when both exist.

## 7. Navigator Team entry

- [x] 7.1 Add a `team` entry per discovered repository to `src/client/utils/workspaceView.ts` and render it in `WorkspaceSectionList.tsx`/`SessionList.tsx` above the change/worktree sections, outside `SessionRow` drag and filter behaviour; verify a test covers one entry per repository across several worktrees, the entry surviving a filter that hides every session, and selecting it not changing `selectedSessionId`.

## 8. Mobile, keyboard, and accessibility

- [ ] 8.1 Implement list/detail panes with an explicit **Back** at narrow viewports (`TeamMobileLayout.tsx` or CSS-level split reusing the existing pane patterns), preserving task selection, filters, and composer drafts across navigation; verify a narrow-viewport test covers filter → open task → **Back** restoring the list unchanged and opening a chat then returning leaving workspace state intact.
- [ ] 8.2 Audit every workspace control for keyboard reachability, visible focus, accessible names, and text state labels beside colour/icons; verify a keyboard-only test resolves one attention item and asserts focus restoration and text labels.

## 9. End-to-end coverage

- [ ] 9.1 Add `tests/e2e/chat-team-workspace.spec.ts` for **E05**: a spawned developer with a pending approval appears as a human-required attention item whose link opens that card; urgent direct mail reports its wait; resolving the approval precedes delivery; urgent group mail leaves a busy agent untouched. Use the `chat-teams.spec.ts` fixture pattern and name the spec in `ci.yml`.
- [ ] 9.2 Extend the spec for **E13**: seed a capacity wait, an approval, an uncertain delivery, and an agent with a finished turn and no result; assert each lands in its bucket; resolve items, reconnect, and assert counts converge with no duplicate toast.
- [ ] 9.3 Extend the spec for **E14**: at a narrow viewport create a task and navigate list/detail/chat/**Back** with drafts and selection surviving; drive one attention item keyboard-only; open a second repository and assert tasks, recipients, messages, attention counts, and worktree choices are team-scoped, with a cross-team link refused by the owning-team check server-side.

## 10. Docs

- [ ] 10.1 Add CLAUDE.md "How It Works" bullets for the Team workspace (strategy status line above the Strategy|Tasks|Messages|Mailbox|Members tabs, Plans extension point), the attention queue (kinds, human vs agent waits, toast identity), read-only Members with source files, and the morning summary buckets; verify the bullets name only shipped behaviour and `bun run lint && bun run typecheck && bun run test` passes.

## 11. Phase 2 — sibling-dependent sources (after `task-results-handoffs` and `task-revision-publication` land)

These tasks add the sources that read the siblings' tables. Phase 1's workspace ships without them: the stage ladder falls through to assignment-derived stages and no pending-acceptance items are produced. No runtime feature detection — these tasks extend the same projection and registries; they do not sniff tables.

- [ ] 11.1 Extend `teamTaskStage.ts` with D4's sibling-dependent ladder orders and badges — an outstanding `handoff_kind` `review`/`qa`/`fix` assignment with `result_id`/`expected_response` (In review / Ready for QA / Fixes requested, outranking the unaccepted result), the outstanding result with `accepted_by_kind`/`accepted_by_session`/`accepted_at` all NULL (Awaiting acceptance), the derived Needs re-evaluation badge (`result.task_revision < team_tasks.revision`, never stored), and `task-revision-publication` D5's Awaiting acknowledgement badge with separate delivered/acknowledged revisions; verify unit tests cover the ladder order (a queued review handoff beats Awaiting acceptance), both badges, and a "Delivered rev 2 · Acknowledged rev 1" display.
- [ ] 11.2 Add the sibling-dependent attention and summary sources: pending acceptance from `task-results-handoffs` (human-required, link to the task) and the completed-results bucket with each result's accepted state shown (D8); verify unit tests cover the item, the bucket, and that a finished turn with no result never lands in completed results.
- [ ] 11.3 Extend `tests/e2e/chat-team-workspace.spec.ts` for the Phase 2 surface: seed a submitted result and an unaccepted one, assert the Awaiting acceptance stage and its pending-acceptance attention item, accept it, and assert the completed-results bucket counts the submission while the finished-turn-without-result agent is never counted completed.
