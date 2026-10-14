# Tasks

Implement after Wave B2 (`task-revision-publication`, `task-results-handoffs`) has landed. Every file stays under 500 LOC. Tests that spawn git use `cleanGitEnv`.

## 1. Shared content model

- [x] 1.1 Create `src/shared/plans.ts` with the D2 types, `normalizePlanContent`, `PLAN_CHECK_FLOOR`, the draft hash, and the revision hash over canonical `{content, pin}`, reusing `canonicalJson` (or moving it to a small shared helper). Verify with unit tests:
  - unknown fields are dropped;
  - missing fields are defaulted;
  - a new draft defaults to direct landing;
  - two key orders hash equally;
  - changing only the pin changes the revision hash.
- [x] 1.2 Implement `planStructureErrors` and `planSubmitErrors` per D3, both returning every violation. Verify with one test per rule:
  - change names, dependencies, the cycle reported as its path, check-name scope and floor reservation, branch format, roles, groups outside the roles, and alignment duplicates;
  - completeness gaps listed together;
  - an incomplete draft passing the structure checks.
- [x] 1.3 Implement `planProgress` per D10. Verify with tests covering:
  - not started, in progress, done (one done plus one cancelled), and cancelled;
  - `waitsOn` clearing when a dependency is done;
  - a cancelled dependency keeping its dependents waiting;
  - `outsideRevision` for a change dropped by a newer revision;
  - content order preserved.

## 2. Plan store

- [x] 2.1 Add `src/server/plans/planSchema.ts` with the D1 DDL, including the partial unique index. Add `plan_id`/`plan_change` to `team_tasks` through `migrateTable`, with the index created after the `ALTER`. Verify with migration tests on a fresh database and on a pre-existing one whose `team_tasks` lacks the columns: existing tasks read back unlinked, and a reopen round-trips.
- [x] 2.2 Implement `planStore.ts`: plan rows, draft upsert with CAS inputs, revision insert and status updates, event insert keyed by command id, and the reads (team list, full plan, `revisionsPinnedTo(strategyId)`, `openPlans(teamId)`, linked tasks of a plan). Verify with store tests:
  - the partial index refuses a second `approved` row;
  - a duplicate command id is refused at the database;
  - every row survives a reopen.
- [x] 2.3 Add the AGENTS.md How It Works bullet for plan records: tables, revisions and hashing, drafts, the strategy pin, and the fixed check floor. Verify by reading it against D1–D6.

## 3. Drafting and submission

- [ ] 3.1 Implement `PlanService` create and save-draft per D5:
  - create writes the plan, the creator's draft, and a `created` event in one transaction;
  - save checks `expected_base_revision`/`expected_draft_hash`, runs the structure checks, and returns the stored draft on a CAS mismatch.

  Verify with service tests:
  - a concurrent save refused with the first writer's draft returned;
  - a replacement author continuing a draft by id;
  - a structure refusal leaving the draft unchanged;
  - saving touches no revision, task, or mail row.
- [ ] 3.2 Implement submission per D6: closed-plan refusal, completeness checks, the server-derived pin through `strategy_repo_bindings`, alignment-reference checks against the pinned revision, deduplication against `in_review`/`approved` hashes, and the `submitted` event. Verify with service tests:
  - the pin is the current approved strategy revision, whatever the draft says;
  - no strategy record, and a strategy without an approved revision, both give an empty pin;
  - an unknown reference is refused, as is any reference without a pin;
  - a decision ref is accepted, and a claim ref is refused;
  - an unchanged resubmission returns the existing number;
  - a cancelled plan refuses submission.
- [ ] 3.3 Add the strict boolean `canCreatePlans` (default false) to `groupFile.ts` beside `canCreateTasks`. Document it in the AGENTS.md group-settings bullet. Verify with parse tests: true, false, missing, and an invalid value rejecting the file.

## 4. Approval and lifecycle

- [ ] 4.1 Add `planPreconditions.ts` with the ordered `APPROVAL_PRECONDITIONS` list (`plan-open`, `revision-in-review`, `hash-matches`, `approved-revision-unchanged`, `strategy-pin-current`) and the `pinDisposition` lookup, which returns null in this change. Verify with tests:
  - each precondition failing alone, with its name and message;
  - several failing together, all named;
  - a stale strategy pin, including one from an unpinned submission followed by a strategy approval;
  - a disposition stub that lets a stale pin pass, proving the extension point.
- [ ] 4.2 Implement `PlanService.approve` per D7: agent actors refused first, then replay by command id, the preconditions, and the commit (supersede, approve, set current, record the event) in one transaction. Verify with tests:
  - hash mismatch, withdrawn revision, and stale expected revision are each refused;
  - two approvals interleaved on one database leave exactly one `approved`, and the losing one is refused as `approved-revision-unchanged`, including when the partial unique index is what refuses it;
  - the same command id and payload returns the prior result;
  - a changed payload is refused naming the field;
  - row counts of tasks, assignments, messages, and spawns are unchanged by approval.
- [ ] 4.3 Implement withdraw and discard, then complete, cancel, and reopen per D8, each with command-id replay over D7's per-command payload and its event. Cover the reason rules (cancel always; complete when any change of the approved revision is not done) and the closed-plan refusals of submission and approval. Verify with service tests, including:
  - approved and superseded revisions cannot be withdrawn;
  - closing never touches linked tasks;
  - a same-payload resend replaying for withdraw, close, and reopen;
  - a close reusing a command id with another outcome refused naming `outcome`;
  - a close resend whose reason differs only in surrounding whitespace replaying.
- [ ] 4.4 Add the AGENTS.md bullet for plan approval and lifecycle: human-only approval, preconditions, idempotency, "grants and triggers nothing else", closing, and reopening. Verify by reading it against D7–D8.

## 5. Plan-change link on tasks

- [ ] 5.1 Extend `TaskService.create`, `task_create` (`plan_id`, `plan_change`), and `team-task-targets` (open plans with approved revisions and their changes) per D9. Add `planId`/`planChange`/`planTitle` to the task summary and detail types. Verify with tests:
  - a valid link is recorded;
  - giving only one of the pair is refused;
  - a plan without an approved revision is refused;
  - an unknown change is refused;
  - another team's plan reads as not found;
  - amending a task leaves its link unchanged.
- [ ] 5.2 Add the plan reference to `taskContext.ts` per D9: metadata `plan: { id, title, revision, change }` with the revision read at delivery, plus the header line. Verify with envelope tests:
  - a linked task's mail shows the plan line;
  - approving a new revision between send and delivery shows the new revision;
  - an unlinked task's envelope is byte-identical to the old shape.
- [ ] 5.3 Add the AGENTS.md task-link bullet and extend the task-mail bullet with the plan reference. Verify by reading it against D9.

## 6. Agent tools and prompt

- [ ] 6.1 Add `planTools.ts` per D11 (`plan_list`, `plan_get`, `plan_create`, `plan_save_draft`, `plan_submit_for_review`) joining `TEAM_ALLOWED_TOOLS`, with identity bound to the calling session and `canCreatePlans` read from the caller's current group file at each call. Verify with tool tests:
  - refusals: right missing, other team's id read as not found, CAS mismatch returning the stored draft;
  - a create → save → submit round trip;
  - `plan_get` returning progress;
  - the tool list containing no approve, withdraw, close, or reopen tool.
- [ ] 6.2 Add the plan note to `teamPrompt.ts`: tools, the creation right, owner-only approval, the approved revision as the direction, and linking tasks. Verify with a prompt test asserting the rights text and that it never claims an agent can approve.
- [ ] 6.3 Add the AGENTS.md agent-tools bullet for plans. Verify by reading it against D11.

## 7. Human protocol

- [ ] 7.1 Add the D12 messages to `src/shared/types.ts`, list every new client type in `CHAT_CONNECTION_TYPES`, and implement `planConnections.ts` on the shared team-scope resolver. The list and detail subscriptions push on every plan write and on every change to a task linked to an open subscribed plan. Verify with connection tests:
  - open by repository path and by worktree path (same team);
  - unknown path refused;
  - another team's plan id refused with no data;
  - approve, withdraw, close, and reopen round trips;
  - a linked task's status change pushing the open detail;
  - a test asserting every new type is listed in `CHAT_CONNECTION_TYPES`.

## 8. Client

- [ ] 8.1 Add `teamPlanStore.ts` keyed by team key, with WS dispatch for every store method that applies server state (grep the join). Approve and close dialogs mint one command id per dialog, reuse it while the payload is unchanged, and re-mint after a payload change following a lost result. Verify with store tests:
  - snapshot and detail application;
  - reconnect replacing state;
  - key reuse and re-mint;
  - a lost result never leaving `busy` set.
- [ ] 8.2 Build `TeamPlansView.tsx` with `PlanIntentSection`, `PlanChangesSection`, `PlanPolicySection`, and `PlanRevisionsSection` per D12. The view shows:
  - list and detail;
  - the claimed alignment label, and Alignment unassessed;
  - progress, waits, and tasks outside the revision;
  - the floor beside the extra checks;
  - the diff summary;
  - Approve and Withdraw, draft discard, history, and close and reopen with reasons;
  - controls disabled while disconnected, and refusals inline.

  Verify with component tests for each of these states, keyboard focus and labels, and the mobile list/detail/back flow.
- [ ] 8.3 Mount the view per D12's host rule (the Team page `plans` tab when `useTeamLocation` is on master, else a `plans` side-slot panel beside Strategy). Add plan and change pickers to the task form. Verify with tests:
  - the mount opens from the host;
  - the pickers list only approved changes;
  - creating a linked task sends `plan_id`/`plan_change`.
- [ ] 8.4 Add the AGENTS.md Plans view bullet and the Structure entries for the new files. Verify by reading it against D12.

## 9. Integration walkthrough

- [ ] 9.1 Add `tests/e2e/chat-plans.spec.ts` and name it in `.github/workflows/ci.yml`. Seed only prerequisites: a plan with an in-review revision written through the agent tool path. Then drive the rest through the UI:
  1. open Plans and inspect the floor and pin;
  2. approve the revision and see Ready;
  3. create a linked task from the form and see In progress;
  4. mark the task done and see the change done;
  5. complete the plan.

  Also cover a stale approval from a second tab being refused inline. Run it locally as the only spec, after `bun run build`, on a spare `E2E_PORT`; never `bun run test:e2e`. Afterwards http://localhost:4040/ must still answer.
- [ ] 9.2 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate durable-plans --strict`. Verify all are green on the final head.
