# Design

## Context

See proposal.md for why. The specs are the requirements; this design is how they are met.

What this change builds on:
- **`durable-plans`** (unarchived): `PlanContent` (C1), `PlanService` as the only plan writer with command-id replay in `plan_events` (C3, C6), the plan-change link on tasks and `planProgress` (C5), and `PLAN_CHECK_FLOOR = ['lint', 'typecheck', 'unit-tests', 'ci-e2e', 'review']` (C7). Its D8 keeps closing a plan from touching linked tasks.
- **`plan-validation`** (unarchived): `prepareStanding` and the input hash (V1), the report's `carriedConditions` with `resolve-condition` decisions targeting `<assessment>#<n>` (V2), relations (V3), the OpenSpec adapter (V4), and the `validation-current` entry (V5).
- **`strategy-revision-impact`** (unarchived): `ImpactService.gate(planId, revision)` (C-I1).
- **Shipped team machinery**:
  - `AssignmentService.dispatch(caller, input)` writes the assignment row and its mail in one transaction under a request key;
  - `TaskResultService` covers `submit`, `submitFindings`, `handoff` (review, qa, fix; a handoff supersedes the outstanding stage through the stop branch), and `accept`, which only the human or the creator may call;
  - `MemberRelease` (`readiness`, `releaseNow`, `transitionHook`);
  - worktree staffing, routing (`buildCandidates` with `excludeProfile`), limits (park, release, forward), waiting reasons;
  - `TeamCaps` reads `~/.kawai/teams.json`.
- **Actors.** `TeamActor` is `human | agent`. `JournalAuthor` adds `system` for journal entries only, and its comment records member-release design D4: "the system is never a sender or task creator". The existing system mail (parking resumes, handoff notes) is stored as sent by its own recipient. No CHECK constraint guards `creator_kind` or `from_kind`.
- **Git and GitHub.** `runGitAsync` runs argument-array git with a timeout and bounded output. `createChangeWorktree` branches `.worktrees/<change>` from the main worktree's HEAD, seeds untracked change artifacts with a commit, and adopts an unassigned existing branch. Nothing in `src/` pushes, merges, or runs `gh`.
- **Security rules.** Agents and Kawai send data only to model providers, the GitHub remote, and internal cluster services. Outbound actions are recorded, not blocked.

### Reconciliation with the merged changes (task 1.1)

These names were read on master `cf3ec663`, after `durable-plans`, `strategy-revision-impact`, and `plan-validation` had merged.
- **Unchanged:**
  - `PlanContent`, `PlanService`, `plan_events`, `planProgress`, `PLAN_CHECK_FLOOR`, `team-plan-result`, and `team-plan-detail` (durable-plans);
  - `ValidationService.prepareStanding(planId, revision)`, the `resolve-condition` decision kind, and the `validation-current` precondition, appended last by `planComposition.ts` (plan-validation);
  - `ImpactService.gate(planId, revision)`, which returns `ImpactGate | null` (strategy-revision-impact).
- **Where the names live:**
  - `carriedConditions` is a field of the report's `readiness` (`PlanValidationReport.readiness.carriedConditions`). Each entry is `{ target, text, gate: 'start' | 'acceptance', resolved }`. `target` is `<alignment assessment id>#<condition index>`, and `resolved` is already derived from the `resolve-condition` decisions. D4 and D13 read `resolved` from a standing recomputed at the time, not from the stored report.
  - `PlanEvent.actor` already admits `{ kind: 'system' }`, so `completed` by `system` needs no type change. `PlanService`'s own caller type is `PlanCaller` (`agent | human`) and stays so. `completeBySystem` takes no caller.
  - Replay runs through `runPlanCommand` (`planCommands.ts`). Its `CommandPayload.command` gains `execution-start`, `execution-stop`, `change-retry`, and `complete-by-system`.
  - The task system caller is added to `TaskCaller` in `src/server/team/TaskService.ts`, beside `agent` and `human`.
- **Migration.** D3's tables and column arrive as the next numbered entry of `MIGRATIONS` (`src/server/dbSafety/migrations.ts`, execution-safety-recovery D13), named `plan-execution`, and never as a baseline edit. Its version is the next free one when PR A is cut. `executionSchema.ts` holds the SQL. Stores never create tables; tests use `schemaDb()`.

## Goals / Non-Goals

**Goals:**
- One writer per record. Every transition is a SQLite transaction, and every external step is an effect row written before it runs.
- The executor is a function of stored state, so a restart resumes it without chat memory.
- Execution reuses the shipped primitives: tasks, assignments, handoffs, results, findings, acceptance, member release, staffing, and routing. It adds no parallel delivery path.
- The pure derivations (CI evaluation, the flaky rule, verdicts, progress) live in one place, so the server, `plan_get`, and the view agree.

**Non-Goals:**
- A general workflow engine or step plugins. The only extension point for landing is `LandingMechanism` (D13).
- GitHub webhooks. Kawai exposes no inbound endpoint and polls instead.
- Using the OpenSpec adapter (V4) to apply or archive changes. Applying is the implementer's own workflow from its instruction. Archiving stays with the Lead.
- Running project commands such as dependency installs or tests on the host. Implementers run them in their worktrees.

## Decisions

### D1. Module layout and ownership

- `src/server/plans/execution/`:
  - `executionSchema.ts` and `executionStore.ts`: the tables (D3) and their transitions. The store is the only SQL writer of execution rows.
  - `ExecutionService.ts`: the human commands (preview, Start, Stop, Retry). It refuses agent callers, and it is the only place that mints the system caller (D2).
  - `startPreconditions.ts`: `START_PRECONDITIONS` (D4).
  - `executor.ts` and `executionPlanner.ts`: the tick loop, and a pure `planSteps(snapshot, now)` that returns the transitions and effects due (D5).
  - `executionDispatch.ts` and `instructions.ts`: task creation, dispatches, handoffs, the release before review, and the instruction texts (D7, D11).
  - `executionOwnership.ts`: the narrow interface team services consult (D7, D9).
  - `executionConnections.ts`: the WebSocket handlers (D17).
- `src/server/plans/landing/`:
  - `ghCommand.ts`: argument-array `gh` with a timeout and bounded output, modeled on `gitCommand.ts`.
  - `gitRemote.ts`: fetch, `ls-remote`, push, worktree add and remove, ancestry, and `merge-tree`.
  - `github.ts`: pull requests, checks, reruns, branch updates, and merges through `gh`.
  - `landingProbe.ts`, `directLanding.ts` (the direct `LandingMechanism`), `effects.ts` (the runner and inspectors, D14), and `landingFacts.ts`.
- `src/shared/planExecution.ts`: the view and tool types, plus the pure functions `evaluateCi`, `reviewVerdict`, `splitExtraChecks`, `fixRoundOutcome`, and `executionProgress`.

Each file stays under 500 lines. The plan connections module gains only the routing of the new message types to `executionConnections.ts`.

### D2. Kawai becomes a system actor, reversing member-release D4

Execution tasks need an author that is neither the human nor an agent session. Their creator, dispatcher, and sender must survive session churn, and must not be mistaken for the owner.

- **Types.** `src/shared/team.ts` adds `SystemActor = { kind: 'system'; sessionId: null }`. `TeamActor` stays `human | agent`, so every human-only or agent-only path keeps rejecting `system` at the type level. Three fields widen to `TeamActor | SystemActor`: the task creator (`TaskCreator`), the assignment dispatcher, and the message sender. `from_kind` gains `'system'`. `JournalAuthor` and the mailbox `StoreActor` already have it.
- **Caller.** `TaskCaller` gains `{ kind: 'system'; team: TeamIdentity; executionId: string }`. Only `ExecutionService` constructs it, through a function the module does not export. Tools and connections build only `agent` and `human` callers, and a test asserts that no tool or connection path yields `system`.
- **Rights.** Through a system caller, Kawai may:
  - create a task, only with an execution link;
  - set `done` or `cancelled` on its own tasks as their creator;
  - dispatch, hand off, and accept;
  - release members.

  Every human-only path keeps checking `kind === 'human'` and so refuses it. These paths include publishing a revision, the human's Release, plan approval and closing, strategy actions, and validation decisions.
- **Exhaustive branches.** Several services branch in two: `agent` versus everything else, read as the human. One example is `AssignmentService.dispatch`, which builds its creator and sender that way. Every such branch in the touched services becomes an exhaustive `switch` with a `never` check, so a system caller can never be recorded as the human (tasks 2.x).
- **Rendering and storage.** "Kawai" appears wherever a creator, dispatcher, sender, or journal author shows, and it is never a link. The existing text columns store `'system'` with a null session. Kawai's mail has `from_session` and `from_group` null and `origin_path` set to the team's main checkout. Its threads use the default hop limit.

*Alternatives rejected:*
- **Act as the human.** It misattributes the owner, makes owner-only paths reachable by automation, and the audit could no longer tell owner actions from Kawai's.
- **A pseudo-session row for Kawai.** Rosters, staffing counts, receipts, and replies would all treat it as a member.
- **Keep sending as the recipient**, as resume mail does. The developer would appear to instruct itself, replies would loop back, and the task's dispatcher would be a developer.

D4's protection held while every action had a human or agent author. Execution adds an author that is neither, so the vocabulary has to say so.

### D3. Records

An additive migration in `executionSchema.ts`:

```sql
CREATE TABLE plan_executions (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL, content_hash TEXT NOT NULL,
  report_id TEXT NOT NULL, input_hash TEXT NOT NULL,
  landing_mode TEXT NOT NULL, base_branch TEXT NOT NULL, base_commit TEXT NOT NULL,
  floor_json TEXT NOT NULL,          -- { version, map: { lint: ['ci'], ... } }
  max_parallel INTEGER NOT NULL, merge_method TEXT NOT NULL,
  state TEXT NOT NULL,               -- running | finished
  outcome TEXT, stop_reason TEXT,    -- completed | stopped; the human's reason
  started_at TEXT NOT NULL, finished_at TEXT
);
CREATE UNIQUE INDEX plan_executions_one_running ON plan_executions(plan_id) WHERE state = 'running';

CREATE TABLE plan_execution_changes (
  execution_id TEXT NOT NULL, change TEXT NOT NULL, team_id TEXT NOT NULL, position INTEGER NOT NULL,
  state TEXT NOT NULL,   -- waiting | provisioning | implementing | gating | landing | landed | stopped | cancelled
  step TEXT,             -- sub-step of gating or landing, e.g. awaiting-ci, releasing, conditions, updating, merging
  stop_reason TEXT, stop_detail_json TEXT,
  task_id TEXT, worktree TEXT, branch TEXT, baseline_commit TEXT,
  pr_number INTEGER, pr_url TEXT, pr_opened_by_kawai INTEGER,
  fix_rounds INTEGER NOT NULL DEFAULT 0,  -- consecutive failed fix rounds
  owns INTEGER NOT NULL DEFAULT 1,        -- cleared once landed, cancelled, or the execution finishes
  passed_at TEXT, generation INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, change)
);
CREATE UNIQUE INDEX plan_execution_changes_owner ON plan_execution_changes(team_id, change) WHERE owns = 1;

CREATE TABLE plan_landing_slots (     -- one row while the team's landing slot is held
  team_id TEXT PRIMARY KEY,
  holder_kind TEXT NOT NULL,          -- change; a landing mechanism may add kinds (X6)
  holder_id TEXT NOT NULL,            -- for a change: '<execution_id>:<change>'
  since TEXT NOT NULL
);

CREATE TABLE plan_execution_attempts (
  id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, change TEXT NOT NULL, number INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- implement | fix | update
  assignment_id TEXT, manifest_json TEXT NOT NULL, manifest_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (execution_id, change, number)
);

CREATE TABLE plan_execution_rounds (
  id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, change TEXT NOT NULL, attempt_id TEXT NOT NULL,
  number INTEGER NOT NULL, result_id TEXT NOT NULL, commit_sha TEXT NOT NULL,
  fix_round INTEGER NOT NULL, carried_from TEXT,   -- the round a clean base merge carried; a carried round
                                                   -- keeps that round's attempt, result, and fix_round
  pushed_at TEXT, ci_window_from TEXT, ci_json TEXT, rerun_at TEXT,
  review_assignment_id TEXT, verdict_findings_id TEXT, extra_json TEXT,
  outcome TEXT, outcome_detail_json TEXT, decided_at TEXT,  -- pass | fail | superseded
  UNIQUE (execution_id, change, number)
);

CREATE TABLE plan_execution_effects (
  id TEXT PRIMARY KEY, execution_id TEXT NOT NULL,
  change TEXT,          -- null for an execution-level effect; direct landing has none (X3)
  round_id TEXT,
  kind TEXT NOT NULL,   -- provision | push | open-pr | rerun | update-branch | merge | remove-worktree;
                        -- append-only, and a mechanism may add execution-level kinds (X3)
  effect_key TEXT NOT NULL UNIQUE, command_json TEXT NOT NULL,
  state TEXT NOT NULL,  -- pending | running | done | failed | unknown | cancelled
  tries INTEGER NOT NULL DEFAULT 0, next_at TEXT, outcome_json TEXT, error TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);

CREATE TABLE plan_change_landings (
  plan_id TEXT NOT NULL, change TEXT NOT NULL, execution_id TEXT NOT NULL, team_id TEXT NOT NULL,
  mechanism TEXT NOT NULL, pr_number INTEGER, pr_url TEXT,
  head_sha TEXT NOT NULL,      -- the head whose round passed or was carried
  base_sha TEXT NOT NULL,      -- the base head that head was verified against
  merge_sha TEXT NOT NULL, landed_at TEXT NOT NULL,
  tree_verified INTEGER NOT NULL,  -- 1 when merge_sha's tree is head_sha's tree
  post_ci_json TEXT,    -- base-branch CI on the merge commit: evidence only
  PRIMARY KEY (plan_id, change)
);

ALTER TABLE team_messages ADD COLUMN allowed_profiles TEXT;  -- JSON array in the role's order (D15)
```

The human commands are `plan_events` kinds under C6: `execution-started`, `execution-stopped`, and `change-retried`. `PlanService` stays the only writer of `plan_events` (C3): `PlanService.recordExecutionEvent(planId, event, within)` appends these kinds inside the execution's transaction, and `ExecutionService` never writes that table itself. Each kind replays by `(plan_id, command_id)` with durable-plans' compared-payload rule:
- Start compares `revision` and `contentHash`.
- Stop compares `executionId` and the trimmed `reason`.
- Retry compares `executionId` and `change`.

System completion writes `completed` with actor `system`, the payload `{ executionId }`, and the command id `exec:<executionId>:complete`, so a completion retried after a restart replays instead of writing twice (D19).

The database arbitrates the races:
- one running execution per plan, a partial unique index;
- one owner per team and change, even across plans, a partial unique index;
- one landing slot per team, the `plan_landing_slots` primary key. Taking the slot inserts the row; every transition that leaves landing deletes it in the same transaction. Because that is a rule rather than a constraint, `executionStore` also clears an orphan: at startup, and whenever the slot is found taken, a row held by a change that is not in `landing` is deleted and logged. A holder kind a mechanism adds supplies its own liveness check (X6).

A constraint error maps to the named refusal (`one-execution` or `changes-unclaimed`) or to "the slot is taken". It never reaches a client raw.

*Why stored states rather than derived ones, unlike assignments:* round outcomes, stop reasons, slot ownership, and the fix-round count are decisions. No other row holds them. Only "stalled" and "needs attention" are derived, and those belong to `plan-supervision`.

### D4. Start: reads first, then one transaction

The human sends `team-plan-execution-start { teamPath, planId, revision, contentHash, commandId }`. `ExecutionService.start` refuses non-human callers first. Then:

1. **Reads**, writing nothing:
   - `ValidationService.prepareStanding(planId, revision)` (V1);
   - the named groups' current files;
   - the settings snapshot (D16);
   - the landing mechanism's `probe` (D13), which also yields `origin`'s base head and tree;
   - for `changes-on-base`, the git blob ids of each change's validated files and touched base specs, from `git hash-object` without `-w`, compared with that tree.

   These are the same reads as `team-plan-execution-preview`, which the dialog sends when it opens.
2. **One transaction:**
   - **Replay.** A recorded command id returns the prior execution, or is refused naming the first differing field.
   - **Preconditions.** Every entry of `START_PRECONDITIONS` runs, in order. Each entry is `{ name, check(ctx) → string | null }`.
   - **Commit.** Insert the execution, one change row per change in content order, and `execution-started`. A change with a landing fact starts as `landed` with `owns = 0`.
3. **After commit,** the executor is woken for the team.

The list, with what each entry reads:

| Entry | Reads |
| --- | --- |
| `plan-open`, `revision-current` | plan row; current approved revision and hash |
| `validation-current` | V5's entry function and message format, unchanged (R06) |
| `start-conditions-resolved` | the report's `carriedConditions` with gate `start`, and `resolve-condition` decisions |
| `strategy-impact` | `ImpactService.gate(planId, revision)` (C-I1) |
| `one-execution`, `changes-unclaimed` | running executions and owner rows (both also enforced by D3's indexes) |
| `changes-on-base` | the pre-read blob comparison |
| `roles-routable` | the pre-read group files: implementing groups worktree-scoped; role ∩ group profiles non-empty |
| `landing-ready` | the pre-read probe |
| `landing-mode-supported` | the mechanism registry (D13) |

Later changes append entries and never edit shipped ones (X5). The probe's findings can age between the read and the commit. Provisioning's own name check (D6) and the push and pull-request effects (D14) cover that gap, so the probe is not repeated inside the transaction.

### D5. The executor: a stored-state loop, single-flight per team

`ExecutionExecutor.wake(teamId)` schedules one tick per team, and a team never has two ticks at once. Several things wake it:
- a committed command;
- `TaskStore.changed` and result or finding submissions for an owned task;
- mailbox state changes of mail whose task is owned;
- member release and archive events;
- a 60-second timer while the team has a running execution, which drives CI polling, backoffs, and timeouts.

A tick does four things:
1. Loads a snapshot of the team's running executions: rows, owned tasks with their assignments and mail states, results, findings, and effects.
2. Asks the pure `planSteps(snapshot, now)` for due transitions and effects.
3. Applies each transition in its own transaction, guarded by the state it expects (`UPDATE … WHERE state = ? AND generation = ?`).
4. Runs the due effects (D14).

An effect's outcome commits together with the transition it implies.

*Why not the mail dispatcher's `beginCycle`:* a dispatcher pass must stay fast and mail-only, and execution steps run git and `gh`, which take seconds and use the network. The two interact only through rows and change notifications.

*Why poll CI:* Kawai has no public inbound endpoint and must not open one. At plan scale, one read per gating round per minute is enough.

### D6. Provisioning branches from the base on origin

The `provision` effect runs these steps:
1. `git fetch origin <base>`.
2. The name check:
   - `git worktree list --porcelain` for the path and the branch;
   - `git rev-parse --verify refs/heads/<change>`;
   - `git ls-remote --heads origin <change>`.

   A name that exists is accepted only when a `done` provision effect of an execution of the same plan created it. Otherwise the change stops as `name-taken`.
3. A new change runs `git worktree add -b <change> <main>/.worktrees/<change> <origin/base sha>` from the main checkout, never with `--force`. That sha is recorded as the baseline.
4. A change from an earlier execution reuses the worktree when it still exists on its branch. When only the branch remains, Kawai runs `git worktree add <path> <change>`.

The main checkout's HEAD, index, and files are never touched. Fetching updates only remote-tracking refs.

*Why not `createChangeWorktree`:* it branches from the main worktree's HEAD, which is the human's current branch. It also commits copied artifacts and adopts an unassigned existing branch. Execution needs the recorded base and artifacts already on it (`changes-on-base`), and it refuses a foreign name. Its path canonicalization and repository-identity helpers are reused.

### D7. Tasks, dispatch, and the ownership guards

- **Task.** `TaskService.create` takes the system caller and an execution link. The title is `<change> — <plan title>`. The direction starts with "The OpenSpec change `<change>` is the authoritative direction", then lists the change's guidance. The acceptance holds the change's and the plan's acceptance rules. The task carries the worktree, `openspec_change`, and the plan link. For the system caller, the link is checked against the execution's revision instead of the current approved one (the `team-tasks` delta), and nothing new is stored on the task.
- **Envelope.** `taskContext.ts` finds the execution through the change row's `task_id` and adds `execution: { id, revision }` beside durable-plans' `plan`.
- **Dispatch.** The implement attempt goes through `AssignmentService.dispatch(system, …)` to the implementing group under the request key `exec:<execution>:<change>:attempt:<n>:<generation>`. `DispatchInput` gains `allowedProfiles` and `tags`, which are honored for the system caller only. Review, fix, and update stages go through `TaskResultService.handoff(system, …)`: kinds `review` and `fix` (an update attempt is a `fix` handoff), with keys ending in `round:<n>:review` or `attempt:<n>`. Handoff supersession through the stop branch is reused as it is.
- **Guards.** `ExecutionOwnership` offers `ownerOfTask(taskId)`, `ownerOfChange(teamId, change)`, `checkResult(taskId, submission)`, and `isKawaiMessage(messageId)`. These services consult it:
  - `TaskService.create`, to refuse links to an owned change;
  - `AssignmentService.dispatch`, to refuse non-system dispatches onto an owned task;
  - `TaskResultService.handoff` and `TaskRelease.release`, to refuse non-system callers;
  - `TaskResultService.submit` (D9);
  - the reply paths (D18).

  Without the plans module, a null implementation keeps the team services independent.

### D8. Attempts and manifests

```ts
interface AttemptManifest {
  version: 1
  plan: { id: string; revision: number; contentHash: string }
  execution: string
  task: { id: string; revision: number }
  validation: { reportId: string; inputHash: string }
  baseline: string                 // the change's baseline commit
  startCommit: string              // the branch head at dispatch
  artifacts: Record<string, string>  // path → sha256 of `git show <startCommit>:<path>`, V1's digest
  roleProfiles: string[]
  answers?: { resultId: string; roundId: string; failingChecks: CiCheck[]; findingsIds: string[] }
}
```

The manifest is serialized with `canonicalJson` and hashed with sha256. Artifacts are read from the commit rather than the working tree, so a dirty worktree cannot skew them. Manifests live in the attempt row and outlive the worktree.

### D9. Results and rounds

- **Submission check.** Before inserting, `TaskResultService.submit` calls `ownership.checkResult`. For an owned task, it refuses in these cases, each with the fix:
  - the submission has no commit;
  - the commit is not on the change's branch (`git merge-base --is-ancestor <commit> refs/heads/<change>` in the worktree);
  - the commit does not contain the branch's head on `origin` (`ls-remote`, then the ancestry check);
  - Kawai is writing the branch: the change's step is `updating` (its `update-branch` effect exists and the carried round does not yet) or `merging` (its merge effect exists).

  Every other stage accepts a result, including a change that is landing, so a fix attempt dispatched for a new task revision can always submit. The git calls run before the insert. A push that slips in between is caught by the push effect, as non-fast-forward (D14).
- **Rounds.** The executor sees a result newer than the change's current round. In one transaction it:
  - supersedes that round, passed or not, unless its merge has started;
  - returns the change to `gating`, deleting its `plan_landing_slots` row if it held the slot;
  - inserts the next round, where `fix_round` is true when the attempt is `fix` or `update`;
  - enqueues the push.
- **New task revision.** `TaskService.onRevisionPublished` for an owned task wakes the executor. Before a merge starts, that supersedes the current round, releases the slot if the change held it, and dispatches a fix attempt naming the revision. The change returns to `implementing`. A revision published while the change's `update-branch` effect runs is applied once that effect settles, and then it replaces the update's own follow-on:
  - Kawai dispatches only the revision's fix attempt, never also an update attempt;
  - the fix attempt continues from the branch's head on `origin`: the updated head when the clean-merge check passed, the head before the update otherwise;
  - when the update failed, the fix attempt also names the base head and any conflicting files, so one attempt answers both.

  A round whose result is pinned to an older task revision can never pass.

### D10. CI evidence, the floor map, and the flaky rule

- **Reading.** Two reads cover a round's commit: `gh api repos/{o}/{r}/commits/{sha}/check-runs` (paged) and `…/commits/{sha}/status`. They normalize to `CiCheck { name, source, conclusion, link, runId?, startedAt, completedAt }`:
  - `success`, `neutral`, and `skipped` pass;
  - `queued`, `in_progress`, `waiting`, `requested`, and `pending` are pending;
  - every other conclusion fails.

  Several runs of one name keep their history, and the newest decides.
- **`evaluateCi(checks, floorMap, { pushedAt, windowFrom, now, rerun })`** returns `pending`, `pass`, `fail(checks)`, `rerun(runIds)`, or `stop(reason, detail)`:
  - With no checks 30 minutes after the CI window opened, it stops as `ci-missing`.
  - With a check still pending 3 hours after it opened, it stops as `ci-timeout`.
  - When everything has finished and a floor check is uncovered, it stops as `ci-missing`, naming the check.
  - Failures with no rerun yet return `rerun`. A failure that cannot be rerun (a status, or a check run outside Actions) fails at once.
  - After the rerun, a check that passes is flaky and one that fails again fails the round.

  The window opens at the push. Retry moves it (D12).
- **Rerun.** `gh run rerun <runId> --failed` for each Actions workflow run with a failed job.
- **Floor map.** In kawai's own repository, `ci` covers `lint`, `typecheck`, and `unit-tests`, and `e2e` covers `ci-e2e`. On a docs-only commit, `e2e` is skipped, which counts as passing.

### D11. Review and extra checks

A change's extra checks are the running revision's plan-wide checks, then the change's own (`effectiveExtraChecks`; `planChecks` keeps the names disjoint). The instructions, the CI split, the verdict, the round view, and `plan_get` all read that one list.

After CI passes, the review stage runs in these steps:
1. **Release.** When the review group's current file is worktree-scoped, each live spawned member in the worktree is checked with `MemberRelease.readiness`. A ready member is archived with `releaseNow`, journaled as Kawai. One that is not ready holds the step at `releasing`, with that member and reason shown, and is re-checked on member events. Human-created sessions are never released. Staffing's occupancy rules then decide where the review lands.
2. **Handoff.** The review handoff is dispatched to the review group with the role's `allowedProfiles` and `author-profile:<id>` tags (D15). The instruction lists:
   - the result id, commit, and pull-request link;
   - the CI summary;
   - the acceptance rules;
   - the extra checks to attest, with each description and command;
   - the call to make: `task_submit_findings` for this result, `pass` or `fail`.
3. **Verdict.** `reviewVerdict(round, findings, claimant, authors)` counts only a findings row bound to the round's result that also meets all of these:
   - it records the review assignment as its handoff;
   - it was written by that assignment's current claimant, following a forward to its successor;
   - its author is not in the change's result authors.
4. **An author claims the review.** The planner checks the claim before any verdict. As soon as the review assignment has a claimant, following forwards to its successor, and that session is one of the change's result authors, the change stops as `review-unavailable`, naming the session. No findings need exist, so an author who claims and never answers cannot hold the change. `reviewVerdict` returns `author-claimant` for the same input, so a verdict asked about such a claim never counts. Retry dispatches the review handoff again. That supersedes the claimed one through the stop branch, and the review group's routing picks again.

`splitExtraChecks(extra, reportedNames)` separates the checks CI decides from the ones the reviewer attests. The view labels each accordingly.

*Why stop rather than route around authors:* excluding authors in routing would need a session list on the mail, and a forward to a named session would still bypass it. Authors claim reviews only in unusual setups, such as a human-created session in a group that both implements and reviews. A named stop that the owner can clear by archiving that session or changing the group covers the case without new routing state.

### D12. Fix rounds, stop reasons, Retry, and Stop

- **Failed round.** A failed round dispatches a fix attempt. Its handoff carries:
  - the failing checks, with their links and runs;
  - the findings;
  - the count, shown as `n/3`;
  - the commit to continue from: the round's commit, or the merge commit when the round was carried.
- **Count.** `fix_rounds` rises on a failed fix round and resets on a pass and on Retry. At 3, the change stops as `round-limit`. Superseded rounds and CI stops never count. A carried round keeps the `fix_round` value of the round it carries, so a carried round that fails counts exactly as its source would have.
- **Stop reasons (X8):** `round-limit`, `name-taken`, `instruction-failed`, `task-closed`, `review-unavailable`, `effect-failed`, `effect-unknown`, `ci-missing`, `ci-timeout`, and `pr-closed`. Each one carries a detail record. A stage instruction fails when its assignment derives as failed, meaning its mail settled dead, cancelled, or discarded. Only the change's current stage can fail it: an assignment Kawai superseded derives as `superseded`, since `assignmentState` reads `superseded_by` first, so the stop branch cancelling its mail is never `instruction-failed`. A stop releases the landing slot if the change held it.
- **Retry** bumps the change's `generation`, so its request keys and effect keys are new, and records `change-retried`. Then, by reason:
  - `round-limit` dispatches a fix attempt;
  - `effect-unknown` inspects first;
  - `effect-failed` and `pr-closed` run the effect again;
  - the CI stops reopen the CI window;
  - `instruction-failed` and `task-closed` dispatch the stage's instruction again (`task-closed` needs the reopened task);
  - `review-unavailable` dispatches the review handoff again;
  - `name-taken` checks the names again.

  Retry is refused while the change's task is closed. A change stopped as `name-taken` has no task yet, so the refusal never applies to it. A retried change waits for a slot under the parallel limit.
- **Stop** runs one transaction:
  - The execution becomes finished and stopped, with `execution-stopped` recorded.
  - Pending effects become `cancelled`.
  - Each unlanded change becomes `cancelled`, and Kawai cancels its task through `TaskService.setStatus(system, …, 'cancelled')` inside the same transaction (its `alsoWithin` hook). Member release's close hook then dead-letters undelivered worktree-scoped group mail and marks spawned members for release.

  A change whose merge effect is running is left until it settles. It is landed and accepted if the merge completed, and cancelled otherwise.

### D13. Direct landing and the LandingMechanism contract

```ts
interface LandingMechanism {
  mode: 'direct' | 'integration-branch'
  probe(ctx: ProbeContext): Promise<ProbeFinding[]>
  baseFor(execution: ExecutionRow, change: string): { branch: string }  // where it provisions from and merges onto
  nextLandingStep(ctx: LandingContext): LandingStep                     // pure, over stored state
}
```

The registry holds only `direct`. `integration-candidates` registers `integration-branch`, which is what lifts `landing-mode-supported`.

**Base branch.** Throughout the specs and this design, a change's base branch is the branch `baseFor` names: where the change provisions from, where its pull request points, and what it lands on. For `direct`, that is the repository's default branch. Pushes are bounded separately: Kawai pushes only to branches an execution of the plan created, never to the default branch, so a mechanism whose base is a branch Kawai created may write it.

The direct steps after a passing round:
1. **Conditions.** Each `acceptance`-gated condition carried in the execution's report is checked against the `resolve-condition` decisions, read live. Any unresolved condition holds the change at `conditions` without taking the slot.
2. **Slot.** Among the changes ready to merge, the change with the earliest `passed_at` takes the team's slot (the `plan_landing_slots` row).
3. **Up to date.** After a fetch, Kawai checks `git merge-base --is-ancestor origin/<base> <head>`.
   - If the base is missing from the head, `git merge-tree --write-tree --name-only <head> origin/<base>` predicts conflicts without touching any worktree or index.
   - A conflict releases the slot and dispatches an update attempt that names the files.
   - A clean prediction runs the `update-branch` effect: `gh api -X PUT repos/{o}/{r}/pulls/{n}/update-branch -f expected_head_sha=<H>`. Kawai then polls the pull request until its head moves, for at most 10 minutes, after which the effect counts as a transient failure.
   - **The clean-merge check.** The new head H' carries the verdict only when it is a clean base merge. It must meet all three conditions:
     - its parents are exactly `[H, B']`;
     - `origin/<base>` contains B', which may be newer than the base head Kawai read before the update;
     - its tree equals `git merge-tree --write-tree H B'`.

     A passing check inserts a carried round (`carried_from`) whose CI runs on H'. A 422 conflict from GitHub, or a new head that fails the check, releases the slot and dispatches an update attempt that continues from the branch's head on `origin`.
4. **Merge.** Immediately before the merge, Kawai re-reads the base head with `ls-remote`. If the head no longer contains it, the change returns to step 3 while keeping the slot. Otherwise the `merge` effect runs `gh pr merge <n> --merge|--squash|--rebase --match-head-commit <sha>`, then `gh pr view <n> --json state,mergeCommit,headRefOid`.
5. **Fact.** One transaction inserts the landing fact, sets the change to `landed`, and clears `owns` and the slot. The fact records:
   - `base_sha`: the base head re-read in step 4;
   - `tree_verified`: whether the merge commit's tree is the merged head's tree, the tree CI verified (`git rev-parse <sha>^{tree}`, for both commits).

   Kawai merges only a head that contains the base head it re-read, so a clean merge of the two is the head's own tree under every merge method: the merge commit's and the squash commit's tree is that merge, and GitHub refuses a rebase whose result would differ from a merge. The flag is therefore 1 for every landing whose base held still. A base that moves between the re-read and GitHub's merge leaves `tree_verified = 0`, and the view flags the landing. Base-branch CI on the merge commit is then its only evidence. Branch protection's "require branches to be up to date" setting closes that window entirely. `TaskResultService.accept(system, task, result)` follows, keyed on the landing so a retry is idempotent. Its reason names the landing when the result needs re-evaluation. Accepting closes the task, and member release's close hook marks its spawned members for release; they are archived once ready.
6. **Cleanup.** `remove-worktree` runs only when `git -C <path> status --porcelain` is empty and no live session resolves there. It never forces. Base-branch CI on the merge commit is then polled until it finishes and recorded as evidence.

*Why GitHub's branch update rather than a local merge and push:* Kawai authors no commit and writes to no worktree. The clean-merge check proves the update was a clean base merge, which is the only condition that carries a verdict. The tree comparison closes the gap the parents alone leave: a hand-made merge with the same parents but edited content.

*Why no bound on base moves:* each move costs one branch update and one CI run while the change holds the slot. Kawai's own landings are serialized per team, so only pushes made outside Kawai move the base. Stopping after a few moves would need the owner, which is what an unattended execution avoids. `ci-timeout` and Stop remain the exits.

### D14. Effects: recorded before they run, inspected before they repeat

The runner works through due effects one at a time per team:
1. It marks the effect `running` in a transaction.
2. It calls the adapter with an explicit timeout: 120 seconds for network git, 60 seconds for `gh`.
3. It classifies the outcome:
   - **Success** is recorded as `done` together with its follow-on transition.
   - **Transient failures** are network errors, 5xx responses, 429, and GitHub's secondary rate limits. They go back to `pending` with backoffs of 30 seconds, 2 minutes, and 10 minutes, and after 3 tries the change stops as `effect-failed`.
   - **Permanent failures** are a rejected push, a refused merge, and other 4xx responses. They are `failed` at once and stop the change as `effect-failed`, carrying git's or GitHub's message.

At startup, every `running` effect becomes `unknown`. An unknown effect is inspected before anything else for its change runs:

| Effect | Inspection | Found done | Not done |
| --- | --- | --- | --- |
| `provision` | worktree list, local branch | record the head | run again |
| `push` | `ls-remote` head contains the commit | done | run again |
| `open-pr` | `gh pr list --head <change> --base <base> --state all` | record the open PR; a closed one stops as `pr-closed` | run again |
| `rerun` | the run's attempt number | done | run again; GitHub refuses a duplicate harmlessly |
| `update-branch` | PR head moved, with the clean-merge check | carried round; a head that fails the check dispatches the update attempt | run again, still pinned |
| `merge` | PR state and merge commit | landing fact | run again, still pinned |
| `remove-worktree` | worktree list | done | run again |

An inspection that cannot run is retried the same way, and then stops the change as `effect-unknown`. Effect keys are `<execution>:<change>:<kind>:<round or attempt>:<generation>`. An execution-level effect has no change, and its key is `<execution>::<kind>:<n>`, where `<n>` counts that kind's effects within the execution, so a second one of a kind gets a new key. Direct landing records none, but X3 lets a landing mechanism add such kinds, together with their inspectors and the stop rule for a failure.

Every outbound call Kawai makes is a git or `gh` call to `origin`, and each is an effect row. Each row holds the argument vector, with tokens redacted from output, the outcome, and timestamps. That is the audit source `execution-safety-recovery` builds on (X3).

### D15. Role profiles and author tags in routing

- **Recording.** `team_messages.allowed_profiles` holds the role's profiles in the role's order. `EnqueueInput` carries it for system mail only.
- **Candidates.** `buildCandidates` gains `allowedProfiles?: string[]`:
  - A member whose profile is outside the list is excluded with the new `MemberExclusionKind` `outside-role`.
  - Spawn slots are offered only for allowed profiles that the group also allows, in the role's order.
  - `profile-order` ranks execution mail by the role's order.

  Rules receive the candidates already filtered, so the route contract is unchanged.
- **Waiting reason.** The `outside-role` constraint reads "plan role allows only `<profiles>`" in the member-facts block.
- **Forwarding.** `routing/handoff.ts` copies `allowed_profiles` and still sets `excluded_profile`. An empty intersection waits with that reason.
- **Tags.** Review handoffs carry `author-profile:<id>` for each distinct profile of the sessions that submitted the change's results. The profile is read from the session record at submission.

### D16. Settings

`TeamCaps` gains `planExecution(teamId)`, read from `~/.kawai/teams.json` at the top level as a default, and per team:

```json
{ "teams": { "/home/coder/kawai": { "planExecution": {
  "floorChecks": { "lint": ["ci"], "typecheck": ["ci"], "unit-tests": ["ci"], "ci-e2e": ["e2e"] },
  "maxParallelChanges": 3, "mergeMethod": "merge" } } } }
```

- **Validation.** `floorChecks` keys must be the four CI floor names, each mapped to a non-empty list of check names. `maxParallelChanges` must be a positive integer, default 3. `mergeMethod` is `merge`, `squash`, or `rebase`, default `merge`. Malformed values go to the existing error log and fall back to their defaults.
- **Floor map.** It has no default, so a missing mapping refuses Start as `landing-ready`.
- **Snapshot.** Start copies the values into the execution together with `FLOOR_VERSION = 1` from `src/shared/planExecution.ts`.

### D17. Human protocol and the Execution section

- **Messages.**
  - `team-plan-execution-preview { teamPath, planId, revision }` returns the standing.
  - `team-plan-execution-start { …, contentHash, commandId }`.
  - `team-plan-execution-stop { teamPath, executionId, reason, commandId }`.
  - `team-plan-execution-retry { teamPath, executionId, change, commandId }`.

  `team-plan-result` answers each, carrying `execution`. `team-plan-detail` gains `executions: PlanExecutionView[]`. It is pushed after every execution write and every change to an owned task or its mail. Every type is listed in `CHAT_CONNECTION_TYPES`.
- **Store.** `teamPlanStore` holds executions and one command id per open dialog, minted at open and re-minted only when the compared payload changes. Every store method that applies server state has a dispatch caller.
- **Components.**
  - `PlanExecutionSection.tsx`: header, state, starter, and the controls.
  - `PlanExecutionStartDialog.tsx`: the standing, landing, base, floor map, limit, and role profiles.
  - `PlanExecutionChangeRow.tsx`: state and waiting reason, task, instruction holder, PR, counts, CI with flaky marks, verdict, extra checks, landing fact, and expandable effects.
  - `PlanExecutionStopDialog.tsx`: what it cancels and keeps, and the required reason.
  - The task view's **Accept result** dialog says, for a task an execution owns, that accepting stops the change as `task-closed` and merges nothing. The rule itself is unchanged.
- **Progress.** `executionProgress(content, landings, newestExecution)` replaces durable-plans' `planProgress` for any plan with an execution.

### D18. Agent surface

- **`plan_get`** gains `executions`. Each lists its changes with state, step, waiting reason, stop reason, task, branch, PR, current attempt, fix rounds, latest round (commit, CI, verdict, extra checks), and landing fact.
- **Plan note.** `teamPrompt.ts` adds the execution-task rules:
  - submit with `task_submit_result` and verdicts with `task_submit_findings`;
  - Kawai pushes and merges, so do not push the change's branch;
  - run the project's setup in a new worktree yourself;
  - replies to Kawai are refused.
- **Replies.** The `reply` tool and the human composer's reply path refuse a parent with `from_kind = 'system'`. The refusal text is the constant `KAWAI_REPLY_GUIDANCE`.
- No tool starts, stops, or retries an execution, and none may be added. The boundary is the one D2 draws.

### D19. Completion and closing

- **Completion.** When the last change lands, the execution finishes as completed. If its revision is still the plan's current approved revision and the plan is open, `PlanService.completeBySystem(planId, executionId)` writes `completed` with actor `system` under the command id `exec:<executionId>:complete` (D3). It refuses otherwise, and then the plan stays open.
- **Plan closed.** When the human completes or cancels the plan, an after-commit hook of `PlanService` calls `ExecutionService.stopForPlan` with the reason `plan-closed`. The plan-close transaction writes no task rows, as durable-plans' D8 requires. The hook then runs as Kawai, the tasks' creator, and cancels Kawai's own tasks.
- **Task closed.** A human close of an owned task that Kawai did not make stops the change as `task-closed`. A reopened task enables Retry.
- **Task closed while an effect runs.** A human close (accept or cancel) while one of the change's effects runs is handled like Stop for that change: the effect settles and is recorded first, and no new effect starts. A completed merge records its landing fact and the change lands (worktree removal included), but Kawai never changes the task the human closed — no second acceptance, no status change. Otherwise the change stops as `task-closed`.

### D20. Contracts published for later changes

| Contract | What it fixes | Bound by |
| --- | --- | --- |
| X1 Records and states | D3 tables; change states and steps; `executionProgress` | `plan-supervision` (cards, progress), `revision-control` (the revision a run keeps, holds per change), `execution-safety-recovery` (recovery from stored state) |
| X2 Attempts and manifests | D8 `AttemptManifest` v1; the attempt kinds | `revision-control` (what a published revision means for running attempts) |
| X3 Effects | D14 kinds, keys, states, and the command and outcome record; kinds are append-only, and `change` is null for an execution-level kind | `execution-safety-recovery` (audit view, crash matrix), `integration-candidates` (its branch writes as effects) |
| X4 Gate evaluation | D10 `evaluateCi` and the flaky rule; D11 `reviewVerdict` and `splitExtraChecks`; D13's clean-merge check | `integration-candidates` (gating candidates), `plan-supervision` (evidence, overrides) |
| X5 Start preconditions | D4 `START_PRECONDITIONS`, append-only | `revision-control` (`no-hold`), `integration-candidates` (registers its mechanism, appends entries) |
| X6 `LandingMechanism` | D13 interface, registry, and the base-branch meaning; the `plan_landing_slots` row, whose `holder_kind` a mechanism may extend | `integration-candidates` (`integration-branch`, promotions holding the slot) |
| X7 Landing facts | D3 `plan_change_landings`, one per plan and change | `integration-candidates` (writes them through the same path), `plan-supervision`, `revision-control` |
| X8 Rounds and stop reasons | D12 count rules and reason list, append-only | `plan-supervision` (a card per stop), `execution-safety-recovery` (new reasons), `integration-candidates` (`integration-rewritten`) |

Bindings consumed:
- **C1:** the changes, dependencies, groups, checks, landing, and roles.
- **C3:** `PlanService` stays the only plan writer. It appends the execution kinds through `recordExecutionEvent`, completes the plan under the deterministic command id through `completeBySystem`, and runs the plan-close hook (D3, D19). Executions are keyed by plan and revision.
- **C5:** the link, checked at the execution's revision, and progress replaced.
- **C6:** the event kinds.
- **C7:** the floor names.
- **V1:** Start's comparison.
- **V2:** `start` and `acceptance` conditions.
- **V3:** no extra input, because serialized pairs are exactly the pairs `dependsOn` already orders.
- **V4:** not used. Its row in `plan-validation` named this change for Apply and Archive. Applying is the implementer's own workflow, from its instruction, and archiving stays with the Lead. This change amends that row to name no consumer for those operations.
- **V5:** the entry, reused.
- **C-I1:** the gate.

## Risks / Trade-offs

- [A binary actor branch records Kawai as the human] → D2 converts every such branch in the touched services to an exhaustive switch. The type widening makes the compiler flag each one, and each service gets a test with a system caller.
- [GitHub rate limits from polling] → Kawai makes one checks read per gating round per minute, uses conditional requests where `gh api` passes ETags, and treats 403 and 429 as transient with backoff.
- [`gh` lacks a scope, or branch protection requires a human review] → The probe checks `gh auth status` and the viewer's write permission. A refused merge or rerun stops the change as `effect-failed` with GitHub's message. If the owner then merges by hand, Retry's inspection finds the pull request merged and records the landing fact.
- [The flaky rule hides an intermittent real failure] → Both runs are recorded and shown, and `plan-supervision` may add policy. The rule is P7's, applied mechanically. "Flaky" is recorded only for that round, never as a property of the check.
- [The landing slot is held while CI reruns on a base merge] → Only updating and merging hold the slot. Conditions wait outside it, and `ci-timeout` frees a stuck one. Serializing landings per team is the point.
- [The base moves between the pre-merge re-read and GitHub's merge] → The window is seconds wide. The landing fact's `tree_verified` flag shows it afterwards, and branch protection's strict up-to-date setting closes it for teams that enable it.
- [GitHub's merge and `git merge-tree` disagree on a clean merge's tree] → The two use the same ort strategy, so this should not happen. If it does, the change only takes an update attempt, which is safe.
- [A new worktree lacks dependencies] → Kawai runs no project commands. The plan note and the instruction tell the implementer to run setup.
- [The owner's local base branch is behind] → Kawai reads only `origin` (`changes-on-base`, provisioning, landing), never the local branch.
- [An implementer pushes on its own] → That is harmless while it fast-forwards. The submission check and the push effect catch any divergence and stop the change, without forcing.
- [A long instruction] → Acceptance rules and extra checks are cut at fixed limits, with a pointer to `plan_get`.

## Migration Plan

- The migration is additive: seven tables and one nullable column, with no backfill.
- The feature stays dormant until the human starts an execution, and Start is refused until `planExecution.floorChecks` is configured.
- **Rollback:** stop running executions. Older builds ignore the new tables and column. Tasks Kawai created stay readable, and an older build renders their creator as unknown.

## Open Questions

- Polling, timeout, and backoff constants (60 seconds; 30 minutes and 3 hours; 30 seconds, 2 minutes, and 10 minutes) may need tuning after the first real runs. They are constants in one module.
- Whether checks are read through GraphQL in one request rather than two REST calls. This is an adapter detail behind `github.ts`.
