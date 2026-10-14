# Proposal

## Why

Kawai can run a team — tasks, routed mail, worktree staffing, a product strategy — but the human has no single place to see it. Supervision is stitched together from per-chat side panels, so ownership, what is stuck, and who is waiting on a human answer are only visible one chat at a time. An approval left open overnight, an uncertain delivery, or a task that stopped at a cap is invisible until someone happens to open the right chat. That is baseline P1 "Human can supervise multiple agents" (`docs/multi-agent-development-ux.md` §1, E05/E13/E14), and every Wave B2 sibling — assignment, waiting reasons, message threads, results, revision publication — needs exactly this surface to be useful.

## What Changes

- **A Team workspace at repository level.** A **Team** entry in the navigator opens a full workspace view independent of the selected chat: **Product Strategy** above **Tasks | Messages | Members**. The Plans tab is Wave C — a documented extension point with no placeholder data. The existing chat-side Tasks / Mailbox / Messages / Strategy panels stay as shortcuts and mount the same view components.
- **Task rows carry workflow facts.** Title and task status beside, never merged with, a workflow stage (Implementing / In review / Ready for QA / …) that is projected from handoff and result state and is never inferred from a finished agent turn. Rows also show the accountable session or role, worktree, current waiting reason, and a next action. Filters for active, blocked, awaiting human, awaiting acceptance, group, and worktree; closed tasks stay searchable but are out of the default list.
- **An attention queue.** One list of what needs a human or is waiting on an agent: approvals and questions, uncertain deliveries, staffing waits, and pending acceptance. Each item shows cause, owner, impact scope, next action, and a link to its card, task, or message. Human-required items are separated from agent-owned waits. The item shape has a kind and a card link so Wave C holds, stalls, and Lead decision cards can appear without changing it (product strategy P2/D3).
- **Members is read-only.** Role description, membership, `canCreateTasks`, effective profile and approval policy, `max` and per-profile caps with live counts, routing warnings, and the source file of each setting. Prompt changes affect future starts only and cannot elevate runtime permissions (§9).
- **A morning summary.** Completed results, capacity waits, approvals, uncertain deliveries, and finished-turn-without-result in one band. A turn that ended without a submitted result is never counted as completed (E13).
- **One-handed and safe.** Mobile list/detail navigation with an explicit Back; drafts and selection survive navigation; keyboard access, visible focus, accessible names, and text state labels; every workspace request is team-scoped and cross-team access is refused server-side (E14). Attention counts reconcile after reconnect and an item never raises a second toast (E05).

Consumed, not redefined: `task-assignment` (assignment record and state), `team-waiting-reasons` (waiting reasons and the worktree roster), `team-message-threads` (`team-message-history` Messages read model), `product-strategy` (the strategy panel), `task-results-handoffs` (results, handoff columns on an assignment, **Accept result**, the derived **Needs re-evaluation** label) and `task-revision-publication` (per-holder notice state, separate delivered and acknowledged revisions). Their design texts are the contracts this change reads (design D4); nothing here restates them.

Delivery is two phases. Phase 1 lands beside the B2 server chain from the sources that exist then — assignment, waiting reasons, threads, strategy, approvals/questions, uncertain deliveries. The sibling-dependent sources — handoff stages, results and acceptance, acknowledgements — are the final section of tasks.md, implemented after `task-results-handoffs` and `task-revision-publication` land; until then the stage ladder falls through to assignment-derived stages and no pending-acceptance items are produced. There is no runtime feature detection.

Non-goals: Plans, executions, candidates, holds, and budgets (Wave C `plan-supervision`, `durable-plans`); editing group settings from the UI; the E12 dependency graph; any new staffing rule; re-specifying assignment, waiting-reason, message, result, or revision state.

## Capabilities

### New Capabilities

- `team-workspace`: the repository-level Team view — its tabs and the Plans extension point, task rows with a workflow-stage projection and filters, the attention queue and its reconnect/toast rules, the read-only Members inspection, the morning summary, mobile and keyboard access, and team isolation of every workspace read.

### Modified Capabilities

- `workspace-navigation`: a **Team** entry at repository level in the navigator opens the team workspace for that repository's team.

## Impact

- Client (new): `src/client/components/team/` — `TeamWorkspaceView.tsx` (tabs and layout), `TeamTaskRows.tsx` + `teamTaskStage.ts` (workflow-stage projection and next action), `TeamAttentionQueue.tsx` + `attentionItems.ts`, `TeamMembersPanel.tsx`, `TeamMorningSummary.tsx`, `TeamMobileLayout.tsx`; `src/client/stores/teamWorkspaceStore.ts` (selection, filters, drafts, summary window, attention identities).
- Client (modified): `WorkspaceSectionList.tsx` / `SessionList.tsx` (the repository-level Team entry), `src/client/utils/workspaceView.ts`, `App.tsx` (mount the workspace). Extract host-agnostic `TeamTasksView.tsx` and `ProductStrategyView.tsx` from `TeamTasksPanel.tsx` / `ProductStrategyPanel.tsx` following the `TeamMessagesView.tsx` pattern `team-message-threads` established, with the extracted views and the workspace store keyed by **team id** and the chat `sessionId` as transport only; the side-slot panels stay thin wrappers (`sideSlot.ts` unchanged). `TeamMailboxPanel.tsx` is reused for delivery operations and is not restyled here.
- Server (new): `src/server/team/workspaceRead.ts` (task rows with stage/owner/waiting reason/next action, attention items, the morning summary) and `src/server/team/workspaceConnections.ts` (`team-workspace-open`/`close`, snapshot and change pushes).
- Server (modified): `src/server/team/groupCatalog.ts` retains each group's source file (today `readGroupDir` computes it and drops it) and a groups read model exposes `canCreateTasks`, `max`, `approval`, `strategy`, `onLimit`, `effort`, warnings, and live membership; `src/server/routes/teamGroups.ts` carries it. `ChatSessionManager.ts` wires `workspaceConnections` beside `TaskConnections`/`MessageConnections`/`StrategyConnections`; `src/server/team/taskConnections.ts` and `messageConnections.ts` stay the sources of task and mail facts and are read, not extended.
- Shared: `src/shared/teamWorkspace.ts` (attention item, task row, member row, summary bucket types) and `src/shared/types.ts` (`team-workspace-snapshot`, `team-workspace` change pushes, `team-workspace-open`/`close`), following the `team-tasks-snapshot` pattern.
- Data: none. The workspace is a read model over existing tables plus the in-memory waiting reasons and attention identities; no migration.
- Docs: CLAUDE.md "How It Works" bullets for the Team workspace, the attention queue, and read-only Members.
- Tests: unit coverage for the stage projection, attention item derivation, summary buckets, and the group source-file read model (`src/server/__tests__/team*`); Playwright for E05, E13, and E14 in `tests/e2e/chat-team-workspace.spec.ts`, extending the `chat-teams.spec.ts` fixture pattern.
