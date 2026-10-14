# Design

## Context

See proposal.md for why. Wave B1 gave Kawai the parts of a team: `team-tasks` stores work, `agent-mailbox`/`profile-routing` deliver it, `team-worktree-staffing` staffs worktrees, `product-strategy` records direction. Wave B2 adds the records that name responsibility and outcome — `task-assignment`, `team-waiting-reasons`, `team-message-threads`, `task-results-handoffs`, `task-revision-publication`, `team-member-release` (all merged as change proposals; D4 binds to their design text). Every one of them is read today through a per-chat side panel (`TeamTasksPanel.tsx`, `TeamMailboxPanel.tsx`, `TeamMessagesPanel.tsx`, `ProductStrategyPanel.tsx` sharing `sideSlot.ts`), so the human supervises one chat at a time and cannot see the team as a whole.

The runtime already holds the facts a workspace needs. `TaskStore.summary` derives participants; `AssignmentService` (sibling) names the accountable party; `waitingReasons.ts`/`teamRoster.ts`/`memberCauses.ts` explain why mail waits and who sits in which worktree; `messageFeed.ts`/`messageQuery.ts` list mail with named participants; `groupCatalog.ts`/`groupFile.ts` hold group settings; `ChatConnections`/`TaskConnections`/`MessageConnections`/`StrategyConnections` already push authoritative snapshots scoped by a session's team. The gap is one view and one read model, not new durable state.

Constraints that shape the approach: the product strategy (revision 2) says review happens inline in progress, Lead decisions arrive later as decision cards with one-click override (P2/D3), and usage is shown rather than budgeted (P8/D4). `team-waiting-reasons` deliberately keeps waiting reasons in memory. Nothing here may grant tools, dispatch, or acceptance — the workspace is inspection plus the human actions that already exist.

## Goals / Non-Goals

**Goals:** one repository-scoped workspace that shows the team's strategy, tasks, attention, and members together; task rows that separate workflow stage from task status; an attention queue whose item shape survives Wave C; a read-only Members inspection that names each setting's source file; a morning summary that never counts a bare finished turn as a result; and mobile/keyboard/team-isolation behaviour that is specified rather than incidental.

**Non-Goals** (beyond the proposal's): any new durable table or column; any new human action — Accept result, Hand off, Approve revision, Cancel/Retry/Discard already exist and are only linked to; changing delivery, routing, staffing, or claim rules; a unified cross-panel search; real-time presence beyond what the session list already shows.

## Decisions

### D1. The workspace is a read model; it owns no tables

`workspaceRead.ts` projects task rows, attention items, member rows, and the summary from stores that already exist (`TaskStore`, `MailboxStore`, `messageQuery`/`messageFeed`, `ChatSessionManager` session records, `groupCatalog`, and the sibling assignment/result stores) plus the in-memory waiting reasons. `workspaceConnections.ts` pushes one snapshot and unfiltered change pushes, the `taskConnections.ts` pattern. *Alternative:* a materialized `team_workspace_state` table — rejected: every field would be a copy of a fact another store owns, and the copies would drift the first time a sibling changed. The cost is that some buckets are runtime-only (D8).

### D2. Layout: strategy band, attention band, then the tab strip

The workspace renders **Product Strategy** as a top band (compact summary of the approved revision — title, status, revision, hash, purpose line — expanding into the full `ProductStrategyView`), the attention queue beneath it, then **Tasks | Messages | Members**. Plans joins the tab strip later as a registered entry; today the strip's registry accepts a future key and renders nothing for it. *Alternative:* Product Strategy as a fourth tab — rejected: the direction and `docs/multi-agent-development-ux.md` §1 place it at product/repository level **above** the tabs so direction is always visible while supervising.

### D3. Reuse by extraction, not by forking — keyed by team id, not by the host chat

`team-message-threads` already made `TeamMessagesView.tsx` host-agnostic for exactly this change, but all three views still key their store state and wire messages by the chat `sessionId` they are mounted in (`useTeamMessageStore`/`useTeamTaskStore`/`useStrategyStore` slices keyed by session, `sessionId` on every message). The workspace cannot inherit that key: switching or losing the host chat would reset "same tab and selection". The extracted views therefore take a **team key** — the repository root, the team id the server resolves for every team connection — as their state key, and the chat `sessionId` becomes transport only: the id stamped on wire messages, any live session of the team equally valid. Extract `TeamTasksView.tsx` from `TeamTasksPanel.tsx` and `ProductStrategyView.tsx` from `ProductStrategyPanel.tsx` on that contract, leaving both panels as thin side-slot wrappers around the view plus a close button. `TeamMailboxPanel.tsx` is not restyled — the workspace links to it as a shortcut from an attention item. *Alternative:* mount the panels directly and thread `onClose`-optional props through — rejected: it makes the side slot's lifetime a hidden dependency of a full-page view.

### D4. Workflow stage is a pure projection over sibling state, never a stored value

`teamTaskStage.ts` maps a task's facts to one display stage through an ordered ladder — first match wins — reading the sibling changes' real contracts (all merged as proposals; still absence-safe because they are not implemented yet):

| # | Stage | Source | Field consumed |
| --- | --- | --- | --- |
| 1 | — (no stage) | the task itself | status `done` or `cancelled` |
| 2 | In review / Ready for QA / Fixes requested | `task-results-handoffs` D3 | an outstanding `team_task_assignments` row with `handoff_kind` `review`/`qa`/`fix` set, plus `result_id` and `expected_response`; its standing is that assignment's own task-assignment D5 state, not a separate entity |
| 3 | Awaiting acceptance | `task-results-handoffs` D1/D5 | the **outstanding result** (newest row nothing supersedes) with `accepted_by_kind`/`accepted_by_session`/`accepted_at` all NULL |
| 4 | Implementing | `task-assignment` D5 | outstanding assignment state `claimed`/`delivered`/`parked`/`forwarded`/`uncertain` |
| 5 | Unstarted | `task-assignment` D5 | otherwise: no outstanding assignment, or one whose derived state is `queued`/`failed`/`superseded` |

Badges render beside the stage and are never stages themselves: **Needs re-evaluation** (`task-results-handoffs` D6, derived at read: `result.task_revision < team_tasks.revision` — never stored) and **Awaiting acknowledgement** (`task-revision-publication` D5: outstanding claimant's `acknowledged revision < task.revision`; notice state (Not notified / Queued / Delivered / Failed / Uncertain) is derived per holder per revision, and "Delivered rev 2 · Acknowledged rev 1" is a normal display).

The order is the semantics: a closed task shows no stage whatever its assignment history says; an outstanding handoff outranks the unaccepted result it refers to; only when neither exists does the assignment's own state name the stage. There is no acceptance enum and acknowledgement is not a notice state. The envelope's `revisionNotice` is `{revision, previousRevision, assignmentId, rationale}` — publication metadata, not a stage input. The stage is never `done`, and a finished agent turn never moves it (product strategy P9/P10). If a sibling field is absent, the row falls back to the assignment-derived stage and the next action says why.

### D5. Attention items: one shape, a kind enum, and a card link

```ts
interface AttentionItem {
  id: string            // `${kind}:${sourceId}` — stable across reconnects
  kind: AttentionKind   // 'approval' | 'question' | 'uncertain-delivery'
                        // | 'staffing-wait' | 'pending-acceptance'
                        // | string  // Wave C: 'plan-hold' | 'stall' | 'lead-decision'
  cause: string         // one line, from the source's own facts
  owner: { kind: 'human' | 'session' | 'group'; id: string | null; label: string }
  impact: { taskId?: string; taskTitle?: string; worktree?: string; groupId?: string }
  nextAction: string    // verb phrase, e.g. "Answer approval", "Retry or discard"
  link: { kind: 'card' | 'task' | 'message' | 'chat'; id: string }
  requiresHuman: boolean
}
```

Sources are a small registry of pure functions over existing state; adding a Wave C source adds a function and a kind, not a shape change. The `link.kind: 'card'` case exists today only so a strategy-P2/D3 Lead decision card can land without a migration of the item type. An unknown kind renders its cause/next action and is never dropped. *Alternative:* a discriminated union per kind — rejected: the queue would need a new render branch per source, which is exactly what the extension point must not require.

### D6. Counts replace; toasts key on identity

The snapshot is authoritative: `teamWorkspaceStore` replaces `items` and the derived counts wholesale. Change pushes are unfiltered and the client filters, matching `team-message-threads`' Messages contract. Toasts fire on an item identity's transition into a human-required state and are remembered in a set of seen identities for the session's lifetime; a reconnect replay is a no-op because the identity is already seen and the count is replaced rather than incremented. This is what E05/E13's "counts converge and toasts do not duplicate" means operationally.

### D7. Members reads the catalog and keeps the file path each group came from

`readGroupDir` in `groupCatalog.ts` already computes `file` per group and then drops it (`groups.set(id, checked)`). Keep it: `GroupCatalog.groups` becomes `Map<string, { group: GroupDefinition; file: string }>` (or a `sources: Map<id, string[]>` beside it) so Members can name the defining file, and when both `~/.kawai/groups/<id>.md` and `<groupsRoot>/.kawai/groups/<id>.md` define the id, both paths with the project layer marked in effect. One file defines a whole group, so "the source file of each setting" is that file — there is no per-key provenance to invent. The row shows `description` (the one-line role description) and never dumps the full `prompt` body: the body is the file, which the human edits in an editor, and the row already links it. *Alternative:* per-key source tracking — rejected: `parseGroupFile` has no provenance channel and the layered-file model makes it redundant.

### D8. The morning summary is a 24-hour window over durable rows plus the runtime ledger

The window is a rolling 24 hours ending at read time, recomputed while the workspace is open. Buckets and their sources: **completed results** (outstanding result rows in the window, each carrying whether `accepted_*` is set — a submitted result is completed work, not accepted work), **capacity waits**, **approvals**, **uncertain deliveries** (`team_message_events` rows of kind `held-uncertain`/`held-for-request` in the window), **finished-turn-without-result** (persisted chat turn-end events in the window with no result row for that session and task). Capacity waits come from the in-memory diagnosis ledger `team-waiting-reasons` keeps, so after a restart that bucket lists only waits the running server has observed — the same contract waiting reasons already have. *Alternatives:* a durable `team_wait_history` table (rejected: a summary does not justify a migration) and a "since last open" window (rejected: it needs hidden per-human state and a second browser would disagree with the first).

### D9. Connections follow the existing team-scoped pattern

`workspaceConnections.ts` resolves the team from the calling session (`loadTeamGroups(session.projectPath).team`) exactly as `TaskConnections`/`MessageConnections`/`StrategyConnections` do, and refuses any id that does not belong to it. The connection and its data are keyed by **team id**: the requesting `sessionId` is transport only, and the server accepts `team-workspace-*` from any session of that team, so the workspace keeps serving "same tab and selection" when the chat whose transport it borrowed is killed — the client re-opens through another live session of the team, or shows a disconnected state when none is left. Requests are `team-workspace-open`/`team-workspace-close` over the chat WebSocket; answers are `team-workspace-snapshot` (authoritative on open and reconnect) and `team-workspace` change pushes. New `ClientMessage` types go in `CHAT_CONNECTION_TYPES` (`src/server/chat/chatConnectionTypes.ts`) — the router whitelist only consults it. Cross-team refusal is server-side and is the E14 guarantee; the client simply never lists another team.

### D10. The navigator Team entry is a view-model row, not a session

`workspaceView.ts` gains a `team` entry per discovered repository (the same repositories `workspace-navigation` already discovers), rendered by `WorkspaceSectionList`/`SessionList` above the change/worktree sections. It is not a `SessionRow`, so session filters and drag-reorder do not apply to it, and selecting it does not change `selectedSessionId`. One entry per repository, never one per worktree.

### D11. Next action is a label plus a link, never a new command

`nextAction` is a verb phrase derived from the same projection that produced the row or item ("Answer approval", "Accept result", "Retry or discard", "Wait for capacity", "Reassign"). Activating it navigates to the link target, where the existing human action lives (`ChatRequests`, `TeamMailboxPanel`'s Cancel/Retry/Discard/Hand off, `TeamTaskDetail`'s **Accept result**, `task-assignment`'s **Assign / send task**). The workspace therefore introduces no write path of its own, which is what keeps it inside the strategy's "show usage, no budget" / inspection posture.

## Risks / Trade-offs

- [`task-results-handoffs` and `task-revision-publication` are merged proposals but not implemented, so D4's fields may still shift during their implementation] → D4 binds to their design text (D3/D5/D6/D8 and D5 respectively) and keeps absence-safe fallbacks; a missing field degrades to the assignment-derived stage rather than blocking this change. If their implementers move a field, the projection is the only place to update.
- [The morning summary's capacity-wait bucket loses history across restart] → stated in the spec as a scenario; the other four buckets are durable. Revisit only if the human needs restart-surviving wait history.
- [Extracting `TeamTasksView`/`ProductStrategyView` touches panels the side slot depends on] → keep the panels' public props unchanged, add the view underneath, and cover both mounts with the existing panel tests.
- [Attention item identity collides across sources] → ids are `kind:sourceId` with source ids already unique per store (request id, message id, task id); a collision is a bug in a source, not a queue behaviour.
- [A read model recomputed on every push could churn] → recompute on the same triggers `team-waiting-reasons` already uses (dispatch passes, session/mailbox/task changes) and diff before pushing, as `messageFeed` does.

## Migration Plan

None. No table, column, or file format changes. The only server change that alters an existing shape is `GroupCatalog` carrying each group's source file (D7), which is additive to a TypeScript object and touches its callers (`teamGroups.ts`, `routes/teamGroups.ts`, `sessionMailbox.ts`, `TaskService.ts`) with an extra field. Rollback is removing the workspace route and the navigator entry.

## Decisions (recorded 2026-10-14)

The human delegated Wave B2 decisions to the lead. Each open question is decided here with its rationale.

- **Q1 — morning summary window: rolling 24 hours** (D8). Predictable, no hidden per-human state, covers an overnight run. "Since last open" was rejected because two browsers would disagree.
- **Q2 — Product Strategy is a band above the tabs, not a tab** (D2). Matches the direction and UX doc §1 literally; direction stays visible while supervising.
- **Q3 — Members shows the role description and the source file, not the prompt body** (D7). The body is long, already at the linked file, and the panel is settings inspection.
- **Q4 — no Plans tab and no placeholder** (D2). The tab registry reserves the key; rendering nothing is the honest extension point.
- **Q5 — "completed results" in the summary means submitted results, with whether `accepted_*` is set shown beside each** (D8). Acceptance is a separate attention item (`pending-acceptance`); conflating them would make an unaccepted result look done.
- **Q6 — the workspace adds no write path** (D11). Every action navigates to the control that already owns it, so this change cannot grant, dispatch, or accept anything.
- **Q7 — capability split: one new `team-workspace` plus a single `workspace-navigation` requirement** (D1/D10). Splitting Members or the attention queue into their own capabilities would create near-duplicates of `agent-teams` and `team-waiting-reasons`.
- **Q8 — stay on base 3620a84's content, merged to current `origin/master`.** The lead's "based on origin/master 3620a84" is the change's origin; the branch is fast-forwarded so the delta is written against what the siblings actually shipped.
- **Q9 — the summary window is a rolling 24 h** (D8). Lead ruling 2026-10-14 under the B2 delegation; the "since last open" alternative is closed.
- **Q10 — Members shows the role description and the source file, not the prompt body** (D7). Lead ruling 2026-10-14; closed.
- **Q11 — the chat-header side-slot buttons stay as shortcuts beside the Team workspace** (D3). Lead ruling 2026-10-14; they are not replaced by it, and D3's extraction keeps both mounts on one view.
