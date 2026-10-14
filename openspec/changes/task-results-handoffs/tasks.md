# Tasks

## 1. Data model

- [ ] 1.1 Add `team_task_results` and `team_task_findings` per design D1 through the additive PRAGMA-check migration pattern, and the nullable `handoff_kind`/`result_id`/`expected_response` columns on `team_task_assignments` (that table belongs to `task-assignment`, which has landed by now — extend, never rebuild it); verify migration tests cover a pre-existing database, plain assignments reading with null handoff fields, and reopen/restart round-trips.
- [ ] 1.2 Implement the result/findings store beside `taskStore.ts`: insert-result (setting `supersedes_result_id` to the previous outstanding result inside the transaction, so only one is ever outstanding), insert-findings, mark-accepted, list-by-task newest-outstanding-first, and outstanding-result lookups; verify store tests cover first result, supersession chains preserving earlier rows, findings bound per result, acceptance marking one row, and persistence across reopen.
- [ ] 1.3 Derive the needs-re-evaluation label at read time per design D6: the revision-published contract's row comparison (`result.task_revision < task.revision`, `task-revision-publication` design D8) in the store's mappers — never stored, no `onRevisionPublished` subscription; verify tests cover the label after an amendment bump, no label at the current revision, the label surviving further revisions, and nothing but the revision number moving it.

## 2. Result submission

- [ ] 2.1 Implement submission on the new `TaskResultService`: any team member of the task's team, `summary` plus at least one of `commit`/`diff` required, server pins `task_revision` and `worktree` (task's worktree, else the submitting session's resolved worktree) and appends the submitter-authored journal note; verify service tests cover missing-reference refusals, pinning at the current revision, the journal entry, and that task status is untouched.
- [ ] 2.2 Add `task_submit_result` to `taskTools.ts` (schemas, descriptions, handlers bound to the calling session) so it joins `TASK_TOOL_NAMES` and thus `TEAM_ALLOWED_TOOLS` — allowed without an approval card; verify tool tests cover the refusal paths and a successful submission round-trip.

## 3. Handoffs

- [ ] 3.1 Extend the assignment dispatch path `task-assignment` lands (its design D3 transaction) with the handoff columns — kind, referenced result, expected response — and their inclusion in request-key payload identity at both comparison sites on the merged `feat/task-assignment`: `payloadDiff` in `assignmentStore.ts` and the payload build in `AssignmentService.ts`; verify tests cover handoff and plain dispatches coexisting, replay of a handoff request key returning the prior assignment, a replay whose result reference differs (review of A retried as B) refused naming the changed field, and payload-mismatch refusal naming any changed handoff field.
- [ ] 3.2 Add the `task_handoff` tool (task, kind, result, target group, instructions, optional expected response) validating task and result of the caller's team and a catalog group, dispatching with a fresh server-minted key per call (design D3); verify tool tests cover every refusal, the recorded handoff fields, and that the instruction mail carries the task header as ordinary task mail.
- [ ] 3.3 Add the human handoff actions to `taskConnections.ts` (`team-task-handoff` with a client request key, answered by `team-task-result`) and whitelist the message in `src/server/ws/messageRouter.ts`; verify connection tests cover dispatch, replay idempotency, cross-team refusal, and assignment-state updates reaching subscribers.

## 4. Findings

- [ ] 4.1 Implement findings submission on `TaskResultService`: `task_id` + `result_id` (of that task) + kind + verdict + text, open to any member, storing `handoff_id` when the caller's outstanding handoff for the task matches the result; verify service tests cover a wrong-task result refused, findings attached per result, and the handoff link recorded.
- [ ] 4.2 Add the `task_submit_findings` tool beside the others; verify tool tests cover refusals and the stored binding, and store/service tests that a newer result has no findings until new ones are submitted (E07's no-inheritance assertion).

## 5. Acceptance

- [ ] 5.1 Implement **Accept result** on `TaskResultService` per design D5: evaluate the closing right first (the exact `setStatus` rule — a contributor is refused with nothing written: no `accepted_*`, no journal entry, no status change), then commit `accepted_*`, the acceptance journal entry, and the `done` status in one transaction; guardrails — reason required and journaled when the result is labeled Needs re-evaluation or child tasks are not done/cancelled; verify service tests cover contributor refusal writing nothing (E10), human accept closing atomically, reason enforcement and journaling, acceptance criteria shown in the result payload, and that a child's acceptance never changes its parent.
- [ ] 5.2 Add the human action `team-task-accept-result` in `taskConnections.ts` and the messageRouter whitelist entry; verify connection tests cover accept, refusal rendering, and the refreshed snapshot.

## 6. Release worktree and hand off

- [ ] 6.1 Implement the release action per design D7 on `TaskResultService` (or a sibling module if the file grows past the size budget): validate the review request, collect the task's live spawned members (`spawned` + pinned `task_id`), readiness-check every member first with `team-member-release`'s rule plus no live background workers (`ChatWorker.live` — `MailRecipient.idle` is only `status === 'waiting'`), refusing with the member and the blocking fact before anything is archived, then archive through `ChatSessionManager.archive`, append the system-authored release journal entry with this action's reason, and dispatch the review handoff; verify tests cover every refusal reason (including a live background worker on an idle member) with nothing archived or dispatched (E08), the happy path archiving once and dispatching once (E07), dispatch failure after archive surfacing without re-archiving on retry, and manual (human-created) sessions in the worktree never being archived.
- [ ] 6.2 Add the `team-task-release` action (review target group, instructions, expected response) in `taskConnections.ts` and the whitelist; its confirmation data — sessions to archive, other live sessions resolved in the worktree, outstanding result — comes with the task detail; verify connection tests cover the dialog payload, refusal reasons rendered inline, and the freed worktree letting the review handoff spawn in a later pass.

## 7. UI

- [ ] 7.1 Add `TaskResultsSection.tsx` for `TeamTaskDetail.tsx` (keeping the parent component's size): newest outstanding result first, superseded results readable beneath, each with summary, commit/diff reference, worktree, tests with outcomes labeled **claimed**, limitations, pinned revision, submitter, needs-re-evaluation badge, findings with kind/verdict/author, and the **Accept result** control (enabled for the human or the task's creator agent, otherwise disabled naming why); verify component tests cover the claimed labeling, the badge, supersession display, accept enablement, and disabled controls while disconnected.
- [ ] 7.2 Add the handoff form (**Request review** / **Request QA** / **Return for fixes**: role picker, instructions, expected response) and the **Release worktree and hand off** confirmation (sessions to archive, other live sessions in the worktree with the concurrent-edit caveat, review request) to the task detail, with request keys held in `teamTaskStore.ts` per intent like `task-assignment`'s dispatch draft; verify store/component tests cover key reuse across reconnect, refusal retaining input, and the release dialog listing both live-session sets.
- [ ] 7.3 Badge the outstanding result on task list rows (`TeamTasksPanel.tsx`) from the summary presence added with the wire types; verify component tests for submitted/flagged/unsubmitted rows.
- [ ] 7.4 Document results, handoffs, acceptance guardrails, the claimed label, needs re-evaluation, and release-and-hand-off in the CLAUDE.md How It Works section; verify the documented rules match the service tests and rendered labels.

## 8. Verification

- [ ] 8.1 Verify E07 headlessly: a spawned dev submits a result in its occupied worktree; a review handoff queues with the occupancy waiting reason; release-and-hand-off archives the dev, keeps the result and transcript, and delivers the result reference to one reviewer; findings on the old result and a new result demonstrate no inherited approval.
- [ ] 8.2 Verify E08 headlessly: release refused with actionable reasons while the dev is mid-turn and while it awaits an approval, nothing archived or dispatched; after resolution and turn end, exactly one release and one dispatch.
- [ ] 8.3 Verify E10 headlessly: a contributor's result on a human-created task leaves the task open and its accept action refused; the human accepts with open child work requiring a journaled reason; an amendment flags the earlier result Needs re-evaluation; a finished child never closes its parent; restart preserves results, findings, and acceptance.
- [ ] 8.4 Add the E07/E08/E10 browser walkthroughs to `tests/e2e/chat-teams.spec.ts` (deterministic SDK-free agents, isolated repository with a linked worktree) following the existing fixture patterns; verify DOM assertions on the Results section, handoff states, release refusal and success, and the accept flow, with screenshots for the results section and the release confirmation.
- [ ] 8.5 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate task-results-handoffs --strict`; verify everything is green.

## Workflow follow-up

- `task-assignment` and `team-member-release` must be merged before implementation starts; this change extends the former's table and dispatch and calls the latter's readiness, archive, and journal-entry paths without respecifying either.
- The needs-re-evaluation label is bound to `task-revision-publication`'s revision-published contract (its design D8): durable `team_task_revisions` rows, `TaskService.onRevisionPublished` for in-process consumers, row comparison for missed events. This change uses only the row comparison and subscribes to no event, so it is correct before and after that change lands, with no ordering between them; their D8 leaves the label and its rules here and blocks on nothing in this change.
- Keep `TeamTaskDetail.tsx` and any new server module under the file-size budget; extract rather than grow.
- Archive after implementation, syncing `task-results` into main specs.
