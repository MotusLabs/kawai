# Design

## Context

The motivation is in proposal.md (Why). The requirements are in `specs/plans`, `specs/plan-approval`, and the `specs/team-tasks` delta. This section covers only the current state that shapes the approach.

- **Strategy module.** `product-strategy` (landed) already solved this shape for strategies. `src/server/strategy/` holds:
  - schema DDL (`strategySchema.ts`) and the store (`strategyStore.ts`);
  - a policy layer (`StrategyService.ts`) that refuses agent callers on human paths;
  - agent tools (`strategyTools.ts`) and human WebSocket actions (`strategyConnections.ts`).

  It uses immutable numbered revisions, drafts keyed by draft id and saved with `expected_base_revision`/`expected_draft_hash`, and approval bound to an exact revision and hash. Its idempotency is a database fact: `UNIQUE(strategy_id, command_id)`. `canonicalJson` in `src/shared/productStrategy.ts` gives stable-key serialization. `strategy_repo_bindings` maps a team's git common dir to its product's strategy, one product per team.
- **Tasks.** `TaskStore`/`TaskService` own `team_tasks`. `task_create` checks every reference first (parent, worktree, change), and `parent_id` is fixed at creation. Columns added later go through `migrateTable`'s `ALTER TABLE` (`request_key` is the precedent). `taskContext.ts` builds the delivered task context at delivery time.
- **Groups.** `groupFile.ts` parses strict booleans (`canCreateTasks`, `releaseOnTaskClose`, `worktreeScoped`, `canReleaseMembers`). An invalid value rejects the file.
- **Human connections.**
  - They address a team by `teamPath` through the shared team-scope resolver (`team-workspace-pages` task 1.2, on master).
  - Every new client message type must be listed in `CHAT_CONNECTION_TYPES` (`src/server/chat/chatConnectionTypes.ts`), which `ws/messageRouter.ts` consults.
  - Team views are host-agnostic and keyed by team key.
  - Today the side slot hosts them. Once `team-workspace` and `team-workspace-pages` land (the human's stream; both partly or not yet implemented), a Team page will host them at `#/team/<key>/<tab>`.
- **Wave B2** (`task-assignment` on master; `task-revision-publication` and `task-results-handoffs` land before this change implements) gives tasks assignments, results, and acceptance that closes a task `done`. This change reads only task statuses, so it depends on no B2 internals.
- **Strategy revision 2 overrides the UX doc where they differ:**
  - no grant or runtime-enforcement layer (P4);
  - landing is acceptance, so the UX doc's separate Accepted plan state collapses into Completed (P5);
  - a fixed check floor that plans only add to (P6);
  - the owner is the only human, and one repository per plan.

## Goals / Non-Goals

**Goals:**
- A plan record that mirrors the proven strategy module, so implementers copy known patterns.
- A content template the later Wave C changes consume unchanged.
- One approval path, with its preconditions as an explicit extension point.
- Named contracts (D13) that the later changes bind to without reopening this design.

**Non-Goals** (beyond the proposal's):
- plan or task execution attempt records (`plan-execution`);
- validation reports, artifact pins, and typed relations between changes (`plan-validation`, D3);
- the UX doc's risk register, policy reference, topology proposal, and contract revisions. Strategy revision 2 does not require them, so the Validate Plan table's Contracts and Scope-and-relations rows have no plan content to read until a later strategy revision asks for it;
- exporting plans to repository files (the UX doc's open "Plan storage/export" decision; SQLite stays the authority);
- revisable plan titles;
- a generic reviewed-document store shared with strategy (a later refactor, if ever).

## Decisions

### D1. A `src/server/plans/` module with four tables

The module mirrors strategy's layout: `planSchema.ts`, `planStore.ts`, `PlanService.ts`, `planPreconditions.ts`, `planTools.ts`, and `planConnections.ts`. Each file stays under 500 LOC, and the shared logic lives in `src/shared/plans.ts`.

```sql
plans (
  id TEXT PRIMARY KEY,                 -- 'plan-<uuid>'
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  lifecycle TEXT NOT NULL,             -- 'open' | 'completed' | 'cancelled' (D8)
  current_approved_revision INTEGER,
  creator_kind TEXT NOT NULL,          -- 'human' | 'agent'
  creator_session TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX plans_team ON plans (team_id, created_at);

plan_revisions (
  plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
  status TEXT NOT NULL,                -- in_review | approved | superseded | withdrawn
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,          -- canonical {content, pin} (D2)
  strategy_id TEXT, strategy_revision INTEGER, strategy_hash TEXT,  -- the pin; all null = unassessed
  author_kind TEXT NOT NULL, author_session TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, revision)
);
CREATE UNIQUE INDEX plan_revisions_one_approved ON plan_revisions (plan_id) WHERE status = 'approved';

plan_drafts (
  plan_id TEXT NOT NULL, draft_id TEXT NOT NULL,
  base_revision INTEGER,
  author_kind TEXT NOT NULL, author_session TEXT,
  content_json TEXT NOT NULL, content_hash TEXT NOT NULL,   -- canonical content only
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, draft_id)
);

plan_events (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- created | submitted | approved | withdrawn | draft-discarded
                                       -- | completed | cancelled | reopened  (D8; later changes add kinds)
  revision INTEGER, content_hash TEXT,
  actor_kind TEXT NOT NULL,            -- 'human' | 'agent' ('system' reserved for plan-execution)
  actor_session TEXT,
  reason TEXT,
  command_id TEXT,                     -- human commands; null for agent tool events
  payload_json TEXT,                   -- the command payload, compared on replay (D7)
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, command_id)
);
```

`team_tasks` gains nullable `plan_id` and `plan_change` columns through `migrateTable`, plus an index on `plan_id` created after the `ALTER`, as `request_key`'s note prescribes (D9).

The partial unique index makes "at most one approved revision" a database fact, the same way strategy relies on its constraints. Two racing approvals cannot both commit, even if the service-level stale check were bypassed.

*Alternative:* store plans in strategy's tables with a `kind` column. Rejected: strategy revisions carry claims and evidence rows plans do not have, and both modules are small enough that a parallel layout is cheaper than a shared abstraction.

### D2. The content template, normalized and canonically hashed

`src/shared/plans.ts` defines the content:

```ts
type PlanContent = {
  goal: string                       // intent: the outcome and why
  successCriteria: string[]
  nonGoals: string[]
  approach: string                   // the implementation strategy
  alignment: { statement: string; refs: string[] }   // claimed contribution; refs into the pinned strategy
  changes: PlanChange[]              // ordered; order = preference
  acceptanceRules: string[]          // plan-wide, beyond each change's own OpenSpec acceptance
  extraChecks: PlanCheck[]           // plan-wide, above the floor (D4)
  landing: { mode: 'direct' } | { mode: 'integration-branch'; branch: string }
  roles: Array<{ group: string; profiles: string[] }>  // profiles in preference order; [] = the group's own routing
  reviewGroup: string | null         // gives the floor's reviewer verdict unless a change overrides it
}
type PlanChange = {
  change: string                     // OpenSpec change name, kebab-case
  dependsOn: string[]                // other changes of this plan
  group: string | null               // implementing group
  reviewGroup: string | null         // overrides the plan's
  acceptance: string[]
  extraChecks: PlanCheck[]
  guidance: string                   // pins for the implementer
}
type PlanCheck = { name: string; description: string; command: string | null }
```

`normalizePlanContent(input)` drops unknown fields and defaults missing ones. So a field meant to switch something off (for example a `skipFloor`) cannot survive a save, and the spec's "no field can disable the floor" scenario holds by construction. A new draft defaults to `landing: { mode: 'direct' }`.

The draft hash is `sha256(canonicalJson(content))`. The revision hash is `sha256(canonicalJson({ content, pin }))`, so approving an exact hash binds the strategy pin too. `canonicalJson` is reused from `productStrategy.ts`; if importing it would couple the modules, it moves to a small shared helper.

### D3. Structure is checked at save; completeness at submission

`planStructureErrors(content)` runs on every save and returns every violation, as `strategyContentErrors` does:
- a malformed (non-kebab) or duplicate change name;
- a dependency on itself, on a change outside the plan, or listed twice;
- a dependency cycle, reported as its path (`a → b → a`; depth-first search with an explicit stack);
- a malformed or duplicate check name in its scope, a check name that reuses a floor name, or a change check that repeats a plan-wide name;
- a malformed integration branch: it must match `^[A-Za-z0-9._/-]+$` and contain no `..`, no leading `-` or `/`, and no trailing `/` or `.lock`;
- a duplicate role group, or a duplicate profile within a role;
- a change's `group` or `reviewGroup`, or the plan's `reviewGroup`, that is not among the roles;
- a duplicate alignment reference.

`planSubmitErrors(content)` adds completeness:
- a non-empty goal;
- at least one success criterion;
- at least one change;
- every change has a `group`;
- every change has an effective review group (its own, or the plan's).

Checks against the environment run only at validation (`plan-validation`): whether the named OpenSpec changes exist, whether the groups and profiles are known, and whether the branch is free. A plan legitimately names changes still being proposed, and the environment changes between save and execution.

Artifact pins and typed relations are validation inputs, not plan content:
- An artifact pin is the revision or hash of each change's proposal, design, and tasks.
- A typed relation is, for example, a UI change consuming an API change's contract.

`plan-validation` reads both from the OpenSpec artifacts and records them in its report. `dependsOn` stays an untyped ordering edge, and C1 needs no field for either.

### D4. The check floor is a constant, never content

```ts
export const PLAN_CHECK_FLOOR = ['lint', 'typecheck', 'unit-tests', 'ci-e2e', 'review'] as const
```

The Plans view renders the floor first and the extra checks after it. Its names are reserved (D3). Strategy P6 ("plans may add checks but never remove the floor") becomes structural: no field exists to remove a floor check, and normalization drops any attempt to add one.

*Alternative:* store the floor in each revision as a policy snapshot. Rejected for now: a stored snapshot invites editing, and a floor change is a Kawai release, not a plan decision. `plan-execution` may record the floor version it gated with.

### D5. Drafts: per draft id, CAS-guarded, and continuable

Drafts mirror strategy:
- The draft id defaults to the caller's session id.
- `expected_base_revision` and `expected_draft_hash` must match the stored draft. When either differs, the write is refused and the stored draft is returned.

Any team agent may save to any draft id of its team's plans, so a replacement lead continues its predecessor's draft by id (strategy P9). CAS keeps two writers from silently overwriting each other. `plan_create` inserts the plan, the creator's draft (the given content, or the normalized empty template), and a `created` event in one transaction. Discarding a draft (human only) deletes its row and records `draft-discarded` with the draft id and its last hash.

### D6. Submission pins the strategy on the server and deduplicates

`plan_submit_for_review(plan_id, draft_id?)` runs in one transaction:
1. Refuse if the plan is not `open`.
2. Normalize the draft and run D3's checks.
3. Resolve the team's strategy through `strategy_repo_bindings` and read its current approved revision and hash. With no strategy record, or no approved revision, the pin is empty.
4. Refuse alignment references that the pinned revision does not define. The defined refs are the use-case, principle, success-measure, and decision refs. Claims are evidence rather than direction, and `needsOutcomes` is prose without refs, so neither can be cited. With an empty pin, every ref is refused.
5. Compute the revision hash. If an `in_review` or `approved` revision of the plan already has that hash, return its number and write nothing (a retried submit is a no-op).
6. Otherwise insert revision `max + 1` as `in_review` and record a `submitted` event.

The draft stays as it was, so the author keeps iterating toward the next revision.

The pin is server-derived because a pin to an unapproved, withdrawn, or invented strategy revision must be impossible, not merely refused. `docs/product-strategy.md` requires exercising "unapproved draft bindings" and "Withdrawn references". *Alternative:* let the author choose a pin and validate it. Rejected: it adds a refusal path and test surface for no use case. Keeping an old pin on purpose is a disposition, which `strategy-revision-impact` owns.

### D7. Approval: one transaction, named preconditions, replay by command id

The human sends `team-plan-approve { teamPath, planId, revision, contentHash, expectedApprovedRevision, commandId }`. `PlanService.approve` refuses non-human actors first. Then, in one SQLite transaction:

1. **Replay.** Look up `plan_events` by `(plan_id, command_id)`. With the same payload, return the stored outcome. With a different payload, refuse naming the first differing field. The compared payload is the command name plus that command's own fields (see the end of this section).
2. **Preconditions.** Evaluate `APPROVAL_PRECONDITIONS` from `planPreconditions.ts`, in order. Each entry is `{ name, check(ctx) → string | null }`; `ctx` holds the plan, the revision (if any), the request, the team's current approved strategy revision and hash, and `pinDisposition(planId, revision)`. Every entry runs; every failing entry contributes `{ name, message }`. Any failure refuses the request and writes nothing. The shipped list:
   - `plan-open`: the plan is `open`.
   - `revision-in-review`: the revision exists and is `in_review`.
   - `hash-matches`: its `content_hash` equals the request's.
   - `approved-revision-unchanged`: `current_approved_revision` equals `expectedApprovedRevision`, or both are null.
   - `strategy-pin-current`: the pin equals the team's current approved strategy revision and hash (both empty counts as equal), or `pinDisposition` returns a recorded disposition. In this change `pinDisposition` always returns null.
3. **Commit.** Mark the previously approved revision `superseded` and this one `approved`, set `current_approved_revision`, and insert the `approved` event carrying the command id and payload. If the write hits `plan_revisions_one_approved` (another approval committed first), the transaction rolls back and the request is refused as `approved-revision-unchanged`. The constraint error never reaches the client raw.

Withdraw (`team-plan-withdraw { revision | draftId, commandId }`), close (`team-plan-close { outcome, reason, commandId }`), and reopen (`team-plan-reopen { commandId }`) follow the same replay rule. The compared payload per command, stored in `payload_json`:
- `approve`: `revision`, `contentHash`, `expectedApprovedRevision`;
- `withdraw`: `revision` or `draftId`;
- `close`: `outcome` and `reason`. The reason is compared after the same trimming the store applies, so a resend replays instead of wedging the dialog, and a reused command id with another outcome is refused naming `outcome`.
- `reopen`: the command name alone.

The dialogs re-mint their command id only when this compared payload changes (D12), so the set is part of the contract, not an implementation detail.

Approval writes nothing outside the plan tables, which `plan-approval`'s "grants and triggers nothing else" requires. Snapshot pushes are a view refresh, not a side effect.

The precondition list and the `pinDisposition` lookup are the extension points. `plan-validation` appends `validation-current`. `strategy-revision-impact` supplies `pinDisposition`. Neither edits the shipped entries.

### D8. Stored lifecycle, derived display state, and closing

Only `open`, `completed`, and `cancelled` are stored. The displayed state (Draft, Ready, In progress, Completed, Cancelled) derives at read time from the lifecycle, `current_approved_revision`, and whether any task links to the plan (the `plans` spec).

Closing is human-only in this change:
- **Complete** requires an approved revision. When any change of that revision is not done (D10), it also requires a reason, which the `completed` event records.
- **Cancel** always requires a reason.
- **Reopen** returns to `open` from either closed state.

Closing never touches linked tasks: they have their own creators and closing rights, and a plan closing them would cross the `team-tasks` rules. *Why no reopen restriction:* strategy P3 favors forward fixes, and reopening to add a revision is the UX doc's "extension with unchanged intent". `plan-execution` will complete plans as `system` when every change lands, in either landing mode, since landing is acceptance (P5).

### D9. The plan-change link lives on the task and is fixed at creation

`task_create` gains optional `plan_id` and `plan_change`, which must be given together. The human task form gains plan and change pickers fed by `team-task-targets`, which adds open plans with an approved revision and those revisions' change names. `TaskService.create` checks the link with its other references and refuses, naming the reference, when:
- the plan is not of the caller's team (reported as not found);
- the plan is not open;
- the plan has no approved revision;
- the change is absent from that revision.

The link is immutable afterwards, like `parent_id`, and amending a task does not touch it.

`TeamTaskSummary` and `TeamTaskDetail` carry `planId`, `planChange`, and `planTitle`. `taskContext.ts` adds `plan: { id, title, revision, change }` to the envelope metadata. `revision` is the current approved revision at delivery, matching the context's "built at delivery" rule. A header line reads `Plan: <title> (revision N), change <name>`. Unlinked tasks keep the old shape exactly.

*Alternative:* a `plan_tasks` join table, allowing several plans per task. Rejected: the UX doc starts with exclusive ownership ("Start with exclusive active ownership of a canonical Change revision"), and two columns keep queries and the envelope trivial.

### D10. Progress is a pure derivation over linked tasks

`planProgress(content, linkedTasks)` in `src/shared/plans.ts` returns, for each change in content order, its linked tasks and a status:
- `not-started`: no linked task;
- `in-progress`: any linked task is open, active, or blocked;
- otherwise `done` if at least one is done, else `cancelled`.

It also returns `waitsOn`: the change's dependencies that are not `done`. A `cancelled` dependency deliberately keeps its dependents waiting: proceeding without it takes a new plan revision that drops or replaces the dependency, which the owner approves. Linked tasks whose `plan_change` is absent from the current revision are returned separately as `outsideRevision`.

The function is pure and runs on the server (plan detail, `plan_get`) and on the client (live updates from task pushes). Nothing is stored, so no subscriber can drift. The view labels a change's `done` as "tasks done", not "landed". Landing facts arrive with `plan-execution`, which replaces the proxy for the plans it executes. It owns the landing-fact record and system completion for both landing modes; `integration-candidates` is the mechanism it calls for `integration-branch`.

### D11. Agent tools, the creation right, and the prompt note

`planTools.ts` adds `plan_list({ status? })`, `plan_get({ plan_id })`, `plan_create({ title, content? })`, `plan_save_draft({ plan_id, content, draft_id?, expected_base_revision?, expected_draft_hash? })`, and `plan_submit_for_review({ plan_id, draft_id? })`. They join `TEAM_ALLOWED_TOOLS`, so they run without approval cards. Identity is bound to the calling session, and another team's ids read as not found.

`plan_create` checks the caller's current group file for `canCreatePlans: true`. The flag is a new strict boolean in `groupFile.ts`, default false, parsed exactly like `canCreateTasks`.

The structural boundary is that no approve, withdraw, close, or reopen tool exists, and `PlanService` refuses agent actors on those paths anyway (defense in depth, as `StrategyService` does). `teamPrompt.ts` adds a plan note:
- the tools and the creation right;
- that only the owner approves, in the Plans view;
- that the approved revision is the direction, and drafts and in-review revisions are not;
- how to link tasks with `task_create`.

### D12. Human protocol and the Plans view

- **Messages.** `team-plans-open`/`close` (the list, pushed as `team-plans-snapshot`), `team-plan-open`/`close` (a detail, pushed as `team-plan-detail`), `team-plan-approve`, `team-plan-withdraw`, `team-plan-close`, and `team-plan-reopen`, each answered by `team-plan-result`.
- **Addressing.** Every message carries `teamPath` and is resolved by the shared team-scope resolver. Every type is listed in `CHAT_CONNECTION_TYPES`.
- **Pushes.** They follow every committed plan write and every change to a task linked to an open subscribed plan. The task service's existing change notification is the hook, filtered by `plan_id`.
- **Client store.** `teamPlanStore.ts` is keyed by team key. Every store method that applies server state has a WS dispatch caller.
- **Command ids.** The approve and close dialogs each mint one command id when they open. They re-mint only when the payload changes after a lost result, so a lost result can never wedge `busy`.
- **View.** `TeamPlansView.tsx` (list and detail) composes section components:
  - `PlanIntentSection`, `PlanChangesSection` (order, dependencies, groups, checks, guidance, linked tasks, progress, waits), `PlanPolicySection` (floor beside the extra checks, landing, roles), and `PlanRevisionsSection` (in-review revisions with a diff summary, Approve and Withdraw, drafts, history).
  - The diff summary lists changed sections, plus added, removed, and reordered changes compared with the approved revision.
- **Host.** If the Team page route (`useTeamLocation`) is on master when this change implements, the view mounts as its `plans` tab (`#/team/<key>/plans[/<id>]`). Otherwise it mounts as a `plans` side-slot panel beside Strategy. Either way the view stays host-agnostic, so a later move is a mount change.

### D13. Contracts published for the later Wave C changes

| Contract | What it fixes | Bound by |
| --- | --- | --- |
| C1 `PlanContent` | D2 template, normalization, `planStructureErrors`/`planSubmitErrors`, hashing | `plan-validation` (adds environment checks; artifact pins and relations stay in its report, D3), `plan-execution` (reads changes, dependencies, groups, checks, landing, roles), `integration-candidates` (landing mode and branch), `revision-control` (compares the revisions it publishes to running work) |
| C2 Strategy pin | Per-revision `{strategyId, revision, hash}` or empty; `PlanStore.revisionsPinnedTo(strategyId)` and `openPlans(teamId)` reads | `strategy-revision-impact`, `plan-validation` (alignment), `revision-control` (the pin a published revision carries) |
| C3 Lifecycle and `PlanService` | D8 stored and displayed states; `PlanService` as the only writer, with command ids and CAS | `plan-execution` (system completion in both landing modes, execution records keyed by plan and revision), `plan-supervision`, `strategy-revision-impact` (closed plans are historical), `execution-safety-recovery` (recovers executions against the stored lifecycle) |
| C4 Approval preconditions | D7 ordered list and the `pinDisposition` lookup | `plan-validation` (`validation-current`), `strategy-revision-impact` (dispositions) |
| C5 Plan-change link and progress | D9 columns and checks; D10 `planProgress` | `plan-execution` (creates linked tasks; owns landing facts in both modes, calling `integration-candidates` for `integration-branch`), `plan-supervision` |
| C6 `plan_events` | Append-only kinds; later changes add kinds and never redefine shipped ones | all, in particular `revision-control` (publication events), `execution-safety-recovery` (audit), and `strategy-revision-impact` |
| C7 `PLAN_CHECK_FLOOR` | D4 names | `plan-execution`'s gate, `plan-supervision` |

Each of the seven later changes binds to at least one named row, so none has to reopen this design to find its inputs.

## Risks / Trade-offs

- [Parallel code with the strategy module] → Deliberate (D1). Only hashing is shared. A generic reviewed-document abstraction waits until a third consumer exists.
- [Change progress is a proxy until `plan-execution`] → It is labeled "tasks done", never "landed", and is derived rather than stored, so the later landing facts replace it without a migration.
- [The owner cannot edit plan content directly] → By design for planning mode (strategy UC1: the owner plans with the Lead). The view shows every draft and diff, and the owner can withdraw, discard, and approve. A human editor is a later change if the owner asks for one.
- [A strategy approval forces a resubmission of plans in review] → Resubmitting is one tool call that re-pins. `strategy-revision-impact` adds a recorded disposition for keeping an old pin. Refusing silently-stale pins is the S15 requirement ("no silent latest substitution").
- [The view's host depends on the human's Team page stream] → The view is host-agnostic, and D12's mount rule decides at implementation time.
- [`canCreatePlans` needs a group-file edit] → The human sets it on the lead group. The lead never edits `.kawai/groups/*.md` unasked. AGENTS.md documents the flag.

## Migration Plan

The migration is additive. `CREATE TABLE IF NOT EXISTS` adds the four plan tables, and `migrateTable` adds the two nullable `team_tasks` columns and their index. There is no backfill: existing tasks stay unlinked, and no plan or strategy provenance is invented for them. An older build ignores the new tables and columns. A rollback leaves plans unreadable but loses nothing.

## Open Questions

- Should plan titles become revisable (moving into content or gaining a rename event)? This can be deferred: nothing in the specs depends on it.
- Should a review export of plans be written into the repository (the UX doc's "Plan storage/export")? This can be deferred: SQLite stays the authority either way.
