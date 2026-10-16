# Tasks

Implement after `durable-plans`, `strategy-revision-impact`, and `plan-validation` have landed on master, then rebase this branch onto them. Every file stays under 500 LOC. Tests that spawn git use `cleanGitEnv`. Tests never reach GitHub: they put a stub `gh` executable on a private `PATH` and use a local bare repository as `origin`.

## 1. Shared model

- [x] 1.1 Reconcile names with the merged designs and record any renames in this design before coding. Verify by reading the merged `durable-plans` D7–D13, `plan-validation` D2/D7/D9/D12, and `strategy-revision-impact` D11 against D3, D4, D13, and D19 here:
  - `durable-plans`: `PlanContent`, `PlanService`, `plan_events`, `planProgress`, `PLAN_CHECK_FLOOR`, and `team-plan-result`/`team-plan-detail`;
  - `plan-validation`: `prepareStanding`, `carriedConditions`, `resolve-condition`, and the `validation-current` entry;
  - `strategy-revision-impact`: `ImpactService.gate`.
- [x] 1.2 Create `src/shared/planExecution.ts` with the D3 state and stop-reason unions, `CiCheck`, `AttemptManifest` (D8), the view types, and `FLOOR_VERSION = 1`. Verify with a typecheck and a unit test that the manifest hash is stable under key order.
- [x] 1.3 Implement `evaluateCi` (D10). Verify with unit tests:
  - all pass, and pass with `neutral` and `skipped`;
  - pending inside the window;
  - `ci-missing` with no checks after 30 minutes, and with an uncovered floor check after everything finished;
  - `ci-timeout` after 3 hours;
  - a rerun requested once for failed Actions runs;
  - an immediate fail for a status, or a non-Actions check;
  - flaky after a passing rerun, and fail after a second failure;
  - the newest run of a name decides;
  - a non-floor check counts.
- [x] 1.4 Implement `reviewVerdict` and `splitExtraChecks` (D11). Verify with unit tests:
  - a claimant `pass`;
  - an author's own `pass` ignored;
  - a non-claimant's findings ignored;
  - a forwarded claimant counts;
  - a claimant who authored a result, directly or as a forward successor, yields `author-claimant`;
  - a `fail` fails;
  - findings on another result ignored;
  - extra checks split by reported names.
- [x] 1.5 Implement `fixRoundOutcome` (D12) and `executionProgress` (D17). Verify with unit tests:
  - the implementation round does not count;
  - three failed fix rounds stop;
  - a pass resets the count;
  - a carried round counts as the round it carries;
  - superseded rounds and CI stops never count;
  - landed changes come from facts while done tasks without a fact are not landed;
  - every state and waiting reason is rendered.

## 2. Kawai as a system actor

- [x] 2.1 Add `SystemActor` and widen the task creator, assignment dispatcher, and message sender types, with `from_kind = 'system'`. Add the system `TaskCaller` minted only inside `src/server/plans/execution/`. Rewrite the comment in `src/shared/teamTasks.ts` that records member-release D4 ("the system is never a sender or task creator"), so it states D2's rights instead. Verify with a typecheck, and with a test that no tool handler or WebSocket connection path can construct a system caller.
- [x] 2.2 Convert every two-way actor branch in `TaskService`, `AssignmentService`, `TaskResultService`, `MemberRelease`, `TaskRelease`, the mailbox enqueue and sender paths, and the row mappers (`taskStore`, `assignmentStore`, `messageRow`) to exhaustive switches. Verify with tests that call each service with a system caller and read back `system` as creator, dispatcher, and sender, never the human.
- [x] 2.3 Keep the human-only paths refusing `system`: publish, notify, Release, plan approve, withdraw, close, and reopen, strategy actions, and validation decisions. Verify with one refusal test per path.
- [x] 2.4 Render "Kawai" as creator, dispatcher, sender, and journal author in the task list and detail, the assignment history, the Mailbox, the Messages view, and peer-message rows. It is never a link. Verify with component tests.

## 3. Records

- [x] 3.1 Add the D3 migration: seven tables including `plan_landing_slots`, the partial unique indexes, the nullable effect `change`, and `team_messages.allowed_profiles`. Verify with a migration test on an existing database: tables created, old rows intact, rerun idempotent.
- [x] 3.2 Implement `executionStore.ts`: inserts, transitions guarded by `state` and `generation`, owned-change lookups, taking and releasing the slot row in the transitions that enter and leave landing, clearing an orphan slot row (D3), and constraint errors mapped to `one-execution`, `changes-unclaimed`, and slot taken. Verify with unit tests, including two racing inserts per index, two racing slot takes, and a slot row held by a change outside `landing` cleared at startup and when the slot is found taken.
- [x] 3.3 Add `PlanService.recordExecutionEvent` for the kinds `execution-started`, `execution-stopped`, and `change-retried`, with the D3 compared payloads, and `completed` with actor `system` under the command id `exec:<id>:complete`. Verify with replay tests: same payload returns the prior result; a different payload is refused naming the field; a repeated completion writes one event. Verify with a grep test that only `PlanService`'s store writes `plan_events`.

## 4. Settings

- [x] 4.1 Extend `TeamCaps` with `planExecution(teamId)` (D16): top-level default, per-team override, the floor-name and value checks, and errors through the existing log. Verify with unit tests for valid, missing, malformed, and unknown-key files, and that a missing floor map yields no default.

## 5. Git and GitHub adapters

- [ ] 5.1 Implement `ghCommand.ts`: argument-array `gh` with a timeout, bounded output, and token redaction in recorded output. Verify with tests against a stub `gh`: timeout, output cap, exit codes, and redaction.
- [ ] 5.2 Implement `gitRemote.ts`: fetch, `ls-remote`, fast-forward push (never `--force`), worktree add and remove (never `--force`), ancestry, and `merge-tree --name-only`. Verify against a local bare `origin`: a non-fast-forward push is rejected and left as it was; conflicting files are listed; the main checkout's HEAD and index are untouched.
- [ ] 5.3 Implement `github.ts`: PR list, create, and view; check-runs and statuses for a commit; `run rerun --failed`; `update-branch` with `expected_head_sha`; and `pr merge --match-head-commit`. Verify with the stub `gh` replaying recorded API responses for every call, including 202, 422, 403, and 5xx.
- [ ] 5.4 Classify outcomes as success, transient, or permanent (D14). Verify with a table test over the adapters' error shapes.

## 6. Probe and base checks

- [ ] 6.1 Implement `landingProbe.ts` (plan-landing "landing probe"). It checks git, a GitHub `origin`, `gh auth status`, write permission, the default branch, the floor map, and names taken locally, on `origin`, or as worktrees, unless provisioned by the plan. Verify with tests for each finding, and that the probe writes nothing (refs and worktree list unchanged).
- [ ] 6.2 Implement the `changes-on-base` comparison (D4). Compare `git hash-object` blob ids of the validated files and touched base specs with `origin`'s tree. Verify with tests: a change only in the main checkout, a design edited on `origin`, and equal content.

## 7. Start, preview, and the preconditions

- [ ] 7.1 Implement `START_PRECONDITIONS` (D4) with every entry. Verify with one test per entry passing and failing, and with a test that every failing entry is reported at once.
- [ ] 7.2 Implement `ExecutionService.preview` and `start`: agent refusal, pre-reads, then one transaction for replay, preconditions, rows, and the event, followed by an executor wake. Verify with tests:
  - a lost result replays;
  - a different payload under the same command id is refused naming the field;
  - two racing Starts leave one execution;
  - a cross-plan owned change is refused;
  - landed changes start as landed;
  - no task or mail is written.

## 8. Ownership guards and the agent surface in team services

- [ ] 8.1 Add `ExecutionOwnership` and its null implementation. Wire it into `TaskService.create`, `AssignmentService.dispatch`, `TaskResultService.handoff` and `submit`, `TaskRelease.release`, and the reply paths. Verify with tests that the team services build and pass without the plans module.
- [ ] 8.2 Make the system create path link to the execution's revision. Refuse other links to an owned change, for the human and for agents. Verify with the `team-tasks` delta scenarios.
- [ ] 8.3 Refuse non-system dispatch and reassignment onto an owned task. Accept `allowedProfiles` and `tags` from the system caller only. Verify with the `task-assignment` delta scenarios, and that an agent cannot pass `allowedProfiles`.
- [ ] 8.4 Refuse non-system handoffs and Release on owned tasks, while still accepting findings. Add the result submission checks (D9), refusing results only while the change is `updating` or `merging`. Verify with the `task-results` delta scenarios, that a refused result writes nothing, and that a result submitted while the change waits at `conditions` is accepted.
- [ ] 8.5 Refuse replies to Kawai's mail with `KAWAI_REPLY_GUIDANCE`, in the `reply` tool and the human composer. Verify with the `agent-mailbox` delta scenarios.
- [ ] 8.6 Add `execution: { id, revision }` to the task envelope for owned tasks (`taskContext.ts`). Verify with tests: the execution's revision differs from the current approved one, and unowned tasks keep their shape.

## 9. Routing

- [ ] 9.1 Carry `allowed_profiles` through `EnqueueInput`, the store, and forwarding (`routing/handoff.ts`). Verify with tests: stored on system mail; copied on forward with the limited profile excluded.
- [ ] 9.2 Filter `buildCandidates` by `allowedProfiles`: the `outside-role` exclusion, spawn slots only for allowed profiles in the role's order, and `profile-order` by the role's order. Verify with the `team-routing-rules` delta scenarios and the existing routing suite.
- [ ] 9.3 Add the `outside-role` waiting reason. Verify with a waiting-reasons test: a message with every role profile cooling names the role's profiles.
- [ ] 9.4 Tag review handoffs with `author-profile:<id>`, and document the tags and `allowed_profiles` in `docs/routing/README.md`. Verify with a router test in which a rule reads the tag and picks another profile.

## 10. Effects runner

- [ ] 10.1 Implement `effects.ts` (D14): mark running, call with a timeout, commit the outcome with its follow-on transition, back off transient failures 3 times, fail permanent ones, and cancel effects on Stop. Verify with unit tests over a fake adapter: success, transient then success, three transients, permanent, and a cancelled effect never run.
- [ ] 10.2 Implement startup recovery and the per-kind inspectors in the D14 table. Verify with one test per kind for found done, not done, and an undecidable inspection (`effect-unknown`), including a merge that completed before the restart.

## 11. Executor, provisioning, and the first dispatch

- [ ] 11.1 Implement `ExecutionExecutor` (D5): the wake sources, single-flight per team, the 60-second timer while running, and the pure `planSteps`. Verify with tests: concurrent wakes run one tick; a tick after a restart resumes from stored rows.
- [ ] 11.2 Implement scheduling: plan order, landed dependencies, the parallel limit, and a stopped dependency holding its dependents. Verify with the `plan-execution` scheduling scenarios.
- [ ] 11.3 Implement the provision effect (D6): branch from `origin`'s base, refuse `name-taken`, and reuse worktrees and branches from earlier executions. Verify against a bare `origin`, including a foreign remote branch left untouched.
- [ ] 11.4 Create Kawai's task and dispatch the implement attempt with its manifest and request key (D7, D8). Verify with tests: task fields, link, assignment dispatcher, `allowed_profiles` on the mail, and a replayed dispatch step yielding one instruction.

## 12. Rounds and the gate

- [ ] 12.1 Create rounds from new results, superseding the current round, passed or not, unless its merge started, and releasing the slot when the change held it. Supersede on a new task revision and dispatch a fix attempt naming it, after any running `update-branch` effect settles (D9). Verify with the round-supersession scenarios, including:
  - a revision published while the change holds the slot and waits for CI on its base merge;
  - a revision published during an update that then conflicts dispatches one fix attempt, naming the revision, the base head, and the files, and no update attempt;
  - a revision published during an update that then passes the clean-merge check continues from the updated head;
  - the superseded review handoff's cancelled mail does not stop the change as `instruction-failed`.
- [ ] 12.2 Run the push and open-pr effects for each round (plan-landing push and PR rules). Verify against a bare `origin` and the stub `gh`: reuse across rounds; an implementer's own push accepted; a moved branch stops as `effect-failed`; a closed PR stops as `pr-closed`.
- [ ] 12.3 Poll CI and request the single rerun (D10). Record checks, flaky marks, and stops. Verify with tests driving the stub `gh` through pending, failed, rerun, and passed states, and through both timeouts.
- [ ] 12.4 Release before review for worktree-scoped review groups, then dispatch the review handoff with the instruction, allowed profiles, and author tags (D11). Verify with tests: a not-ready member holds the step with its reason; an unscoped group leaves the implementer; human sessions are never released.
- [ ] 12.5 Decide rounds from CI, the verdict, and the extra checks. Verify with the review and extra-check scenarios.

## 13. Fix rounds, stops, Retry, and Stop

- [ ] 13.1 Dispatch fix attempts with the failing checks, findings, count, and continue-from commit. Apply the round limit. Verify with the fix-round and round-limit scenarios.
- [ ] 13.2 Detect failed instructions and human task closes. Verify with the `instruction-failed` and `task-closed` scenarios, including a hand acceptance that merges nothing.
- [ ] 13.3 Implement Retry for every stop reason with a new generation (D12), and the wait for a free slot. Implement the `review-unavailable` stop when an author claims the review, checked on the claim before any findings (D11). Verify with one test per reason, that Retry is refused while the task is closed, that a `name-taken` change, which has no task, can be retried, and that an author's claim stops the change with no findings submitted.
- [ ] 13.4 Implement Stop and the plan-close hook (D12, D19): cancel tasks as Kawai with member release, cancel pending effects, and settle a running merge first. Verify with the Stop scenarios, including Stop during a merge.

## 14. Direct landing and completion

- [ ] 14.1 Implement the conditions check and the landing slot (D13). Verify with tests: an unresolved acceptance condition holds the change outside the slot, and resolving it lets the change land; two passing changes land in order among those ready to merge; every stop releases the slot.
- [ ] 14.2 Implement up to date: the ancestry check, the `merge-tree` conflict prediction, the update attempt on conflict, `update-branch` with the clean-merge check (parents, base containment, and tree), and the carried round with CI on the new head. Verify against a bare `origin` and the stub `gh`:
  - a clean update keeps the review;
  - a base that moved during the update still passes when the merge is clean;
  - a hand-made merge with the right parents but another tree, and a head moved by a push, each release the slot and dispatch an update attempt;
  - a conflict dispatches an update attempt naming the files;
  - failed CI after the update dispatches a fix from the merge commit.
- [ ] 14.3 Implement the pre-merge base re-read, the pinned merge, the landing fact with `base_sha` and `tree_verified`, Kawai's acceptance, worktree removal when safe, and post-landing CI as evidence. Verify with tests:
  - a base that moved before the merge returns the change to the up-to-date step;
  - a moved head is refused and nothing merged;
  - the fact is written once, and `tree_verified` is 1 for a landing whose base held still under each of `merge`, `squash`, and `rebase`, and 0 when the base moved between the re-read and the merge;
  - the task is done and its members are released once ready;
  - a live session keeps the worktree;
  - a failing base branch keeps the change landed.
- [ ] 14.4 Add `PlanService.completeBySystem` and the execution's completion (D19). Verify with tests: the last landing completes the plan as `system`, while a newer approved revision leaves it open.
- [ ] 14.5 Register `direct` in the mechanism registry, and refuse `integration-branch` as `landing-mode-supported`. Verify with the integration-branch scenarios.

## 15. Human protocol and the Execution section

- [ ] 15.1 Add the D17 messages to `src/shared/types.ts` and `CHAT_CONNECTION_TYPES`, plus `executionConnections.ts` with team-scope resolution and cross-team refusals. Verify with connection tests for each message, and a refusal for another team's plan.
- [ ] 15.2 Push `executions` in `team-plan-detail` after execution writes and owned task or mail changes. Verify with a test that a CI transition and a mail claim each push once.
- [ ] 15.3 Wire `teamPlanStore`: executions, and the dialogs' command ids minted at open and re-minted only on a payload change. Verify with store tests, and a grep test that every applying method has a dispatch caller.
- [ ] 15.4 Build `PlanExecutionSection`, `PlanExecutionStartDialog`, `PlanExecutionChangeRow`, and `PlanExecutionStopDialog`, and replace progress with `executionProgress` for executed plans. Add the owned-task note to the task view's **Accept result** dialog (D17). Verify with component tests for the Plans-view scenarios: Start standing and refusal, waiting explained, flaky and attested labels, a landing flagged for an unverified tree, disconnected controls, Stop listing what it cancels and keeps, and the Accept note on an owned task only.

## 16. Agent surface

- [ ] 16.1 Add `executions` to `plan_get` (D18). Verify with a tool test reading a running execution's change states, attempt, and latest round.
- [ ] 16.2 Add the execution-task rules to the plan note in `teamPrompt.ts`. Verify with a prompt snapshot test.

## 17. End to end and docs

- [ ] 17.1 Add an integration test with a bare `origin`, the stub `gh`, and fake members submitting results and findings. Two changes have a dependency. One gets a flaky check and one a failed review with a fix round. Both land, and the plan completes as `system`. The server restarts once mid-merge. Verify that the test passes and records one landing fact per change, with no duplicate dispatch, push, or merge.
- [ ] 17.2 Add one fixture browser walkthrough of the Execution section, using a fixture landing adapter, and name it in `.github/workflows/ci.yml`. Verify by running that one spec on a spare `E2E_PORT` after `bun run build`, never the whole e2e suite.
- [ ] 17.3 Add AGENTS.md How It Works bullets for execution, landing, the system actor, the ownership guards, routing roles, and the settings. Verify by reading them against the specs.
- [ ] 17.4 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate plan-execution --strict`. Verify that both pass.
