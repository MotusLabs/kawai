# Tasks

Implement after `durable-plans` and `strategy-revision-impact` have landed on master, then rebase this branch onto them. Every file stays under 500 LOC. Tests that spawn git use `cleanGitEnv`. Tests never spawn the real OpenSpec CLI: they use a stub executable on a private `PATH` or an injected adapter.

## 1. Shared model

- [x] 1.1 Reconcile names with the merged designs and record any renames in this change's design before coding:
  - from `durable-plans`: `PlanContent`, the pin type, `PlanStore.openPlans`, `APPROVAL_PRECONDITIONS` and its `ctx`, the plan-change notification, and `team-plan-result`;
  - from `strategy-revision-impact`: `ImpactService.gate` and `stateKey`.

  Verify by reading `durable-plans` D7 and D13 and `strategy-revision-impact` D11 against D2, D3, and D9 here.
- [x] 1.2 Create `src/shared/planValidation.ts` with the D2, D3, D5, and D7 types, `VALIDATION_CHECKS_VERSION = 1`, the finding-key builders, and `inputHash` over `canonicalJson`. Verify with unit tests:
  - the hash is stable under key order, and under the order of every array except `changes` (capabilities, claims, records);
  - the hash changes with each top-level input part;
  - location and baseline evidence never enter it.
- [x] 1.3 Implement `deriveRelations(changes, deltas, dependsOn)` (D4). Verify with unit tests:
  - a conflict on one requirement, unordered: an error;
  - the same pair ordered directly and transitively: serialized, with its order;
  - an overlap on one capability with different requirements: a warning;
  - several unordered overlaps on one capability: one warning keyed by the sorted change set, whose detail lists the pairs, while the per-pair relations remain;
  - a grown or shrunk overlap set: a new key;
  - one capability where a is ordered before b and c, and b and c are unordered: one warning naming only b and c;
  - a rename, given as its two touches: conflicts with a change touching either name;
  - three changes: one relation per pair;
  - no shared capability: no relation;
  - keys are sorted and stable.
- [x] 1.4 Implement `validationReadiness` (D7). Verify one test per alignment rule and per blocker kind:
  - the empty pin, and both the sticky conflict and its exception;
  - a later `aligned` that does not lift the conflict;
  - no assessment;
  - each of the five values, with conditions at each gate (`ready` blocks until resolved; `start` and `acceptance` are carried);
  - authorized and unauthorized exploration;
  - unanswered mandatory questions (optional ones never block);
  - unaccepted check warnings and finding warnings;
  - errors.

## 2. Store

- [x] 2.1 Add `src/server/plans/validation/validationSchema.ts` with the D1 DDL. Verify with migration tests on a fresh database and on one created by the `durable-plans` schema: plan rows read back unchanged, and a reopen round-trips every new row.
- [x] 2.2 Implement `validationStore.ts`: report insert with `seq = max + 1`, the newest report per revision, assessments and decisions per revision, and command-id lookups. Verify with store tests:
  - `UNIQUE (plan_id, revision, seq)` and both `UNIQUE (plan_id, command_id)` constraints refuse duplicates at the database;
  - two assessment rows with a null `command_id` (two agent calls) are both accepted;
  - rows are never updated (there is no update path);
  - a reopened store reads everything back.

## 3. OpenSpec adapter

- [x] 3.1 Implement `openspecAdapter.ts` (D3):
  - `probe()`: the version floor 1.14 and the capability names, cached for ten minutes;
  - `validate(root, change)` and `showDeltas(root, change)`: normalized JSON, the 15 s timeout, issues capped at 50 with a count;
  - a pool of four concurrent calls.

  Verify against a stub CLI:
  - missing executable, unparsable version, and a version below the floor: unavailable, never success;
  - a valid and an invalid change;
  - a timeout;
  - an unknown JSON shape: an error;
  - a RENAMED delta in the CLI's shape (`rename: { from, to }`, no `requirement`): two touches, one per name; one missing a name: an error;
  - more than four calls at once wait for the pool.

## 4. Inputs and identity

- [x] 4.1 Implement `validationInputs.ts`, the file-held parts of D2. It resolves changes from fresh `discoverRepository` state with `changeRegistry`'s canonical rule, plus the archive lookup. It hashes `proposal.md`, `design.md`, `tasks.md`, and `specs/**/spec.md`, the base specs at `openspec/specs/<path>/spec.md` for the change's own capability paths, and the root's `openspec/config.yaml` (else `config.yml`). It computes the catalog digests over the named groups' parsed definitions and the known profile ids. Verify with tests on temporary git repositories:
  - a registered change in the main checkout, and in its convention worktree;
  - a change only in another worktree;
  - an archived change;
  - a missing change;
  - nested capability paths;
  - an absent base spec (null);
  - an unknown group (null);
  - no CLI process is spawned (assert through the injected adapter).

## 5. Checks

- [x] 5.1 Implement `validationChecks.ts` with `VALIDATION_CHECKS` in the D3 order and rows. Verify one test per check outcome in the D3 table, including:
  - the adapter-unavailable errors on `openspec-valid` and `relations`;
  - unregistered changes skipped by both;
  - `change-claimed-elsewhere` ignores the plan's own revisions and closed plans;
  - `branch-free` only for `integration-branch` landing;
  - the profile warning only when the group declares `profiles`;
  - `capacity` evidence never fails a report;
  - each `strategy-impact` gate state.

## 6. Assessments and decisions

- [ ] 6.1 Implement assessment writes in `ValidationService.ts` (D5). Verify:
  - the target rules (an open plan, the revision status, the caller's team);
  - an empty pin refuses alignment;
  - the per-value shape rules;
  - an undefined ref is refused, naming it;
  - the 2,000-character limit is refused, never cut;
  - the 20-item caps on agent calls;
  - the owner's form writes exactly one alignment assessment per command id and replays by it;
  - an agent retry appends.
- [ ] 6.2 Implement `ValidationService.decide` (D6). Verify:
  - an agent actor is refused before any read;
  - a replay returns the stored decision, and a different payload is refused naming the first differing field;
  - a unique-constraint hit re-runs replay (simulate a concurrent resend);
  - each kind's target rule, including a warning key absent from the newest report and a condition index out of range;
  - text and scope limits;
  - a later decision on the same target supersedes, and both stay readable.

## 7. Running a validation

- [ ] 7.1 Implement `ValidationService.validate` (D8), with its single flight, the file phase, the record phase, the dedupe on an unchanged hash, and the after-commit push. Verify:
  - two concurrent requests run once;
  - unchanged inputs write nothing and return the newest report;
  - a changed artifact writes `seq + 1`;
  - a `superseded` or `withdrawn` revision and a closed plan are refused;
  - another team's plan reads as not found;
  - nothing outside the three tables is written (no mail, task, or plan event);
  - a recorded decision makes the newest report out of date.
- [ ] 7.2 Implement the dry run on a draft. Verify:
  - it computes as if submitted (the submission pin for `strategy-impact`, alignment not assessable);
  - it is marked `dryRun`;
  - it stores nothing.

## 8. Approval precondition

- [ ] 8.1 Add `prepareStanding` and `standing` (D9). Have `PlanService.approve` await `prepareStanding` before its transaction, and append `validation-current` to `APPROVAL_PRECONDITIONS`. Verify with `durable-plans`' approval:
  - not validated;
  - blocked (the message carries the counts and the alignment reason);
  - each changed input part, named: a change's artifacts, a base spec, an OpenSpec config, a group, profiles, the adapter, the strategy impact, claims, records, and the checks version;
  - current and ready: approval commits;
  - the shipped preconditions still run, and their failures accumulate with this one;
  - `prepareStanding` spawns no CLI process;
  - approval writes no validation row.

## 9. Agent tools and prompt

- [ ] 9.1 Implement `validationTools.ts`: `plan_validate`, `plan_validation_get`, and `plan_assess`, added to `TEAM_ALLOWED_TOOLS`. Verify:
  - identity binding;
  - other teams' ids read as not found;
  - the revision default (newest `in_review`, else approved);
  - capped findings with a count;
  - the read-only standing in `plan_validation_get`;
  - the tool list has no decide, accept, or approve tool.
- [ ] 9.2 Extend `teamPrompt.ts`'s plan note (D10). Verify with a prompt snapshot test that it never claims agents decide or approve.

## 10. Protocol and pushes

- [ ] 10.1 Add `team-plan-validate`, `team-plan-assess`, and `team-plan-validation-decide` to `src/shared/types.ts` and `CHAT_CONNECTION_TYPES`, answered by `team-plan-result` with additive fields. Verify with routing tests: an unknown team path is refused as `unknown-team`, and another team's plan is refused.
- [ ] 10.2 Add `validation` to `team-plan-detail` per `in_review` or `approved` revision. Its standing is coalesced per plan every 2 s, and pushes follow validation, assessment, and decision writes. Verify:
  - a push after each write;
  - coalescing under a burst of linked-task changes;
  - the standing names the changed parts.

## 11. Client

- [ ] 11.1 Add `PlanValidationSection.tsx` and its dialogs (Answer, Accept warning, Resolve condition, Record exception, Authorize exploration, Assess alignment), mounted in the Plans view's revision section, with plan-store wiring. Every store method that applies server state needs a WS dispatch caller. Dialogs mint one command id when they open and re-mint it when the payload changes. Verify with component tests:
  - each standing badge;
  - the report grouped by the four rows;
  - each dialog's validation, refusal, and replay;
  - the "reuse answer from revision N" prefill;
  - Unassessed with the capture link;
  - every control disabled while disconnected.
- [ ] 11.2 Show the standing and `validation-current` refusals in the approve dialog. Verify with a component test: a blocked report shows its counts and **Validate**, and a refusal renders inline.

## 12. Docs and walkthrough

- [ ] 12.1 Add an AGENTS.md How It Works bullet covering validation reports, identity, checks, relations, readiness, alignment, owner decisions, `validation-current` (approvals now require a validation), and the tools. Verify by reading it against D1–D11.
- [ ] 12.2 Add one browser walkthrough, `tests/e2e/plan-validation.spec.ts`, named in `.github/workflows/ci.yml`, using the fixture and a stub CLI. It runs this sequence:
  1. Validate a plan with a conflicting pair: Blocked.
  2. Resubmit with `dependsOn`, answer a mandatory question, and accept an overlap warning: Ready.
  3. Edit an artifact: Out of date, and approval is refused naming it.
  4. Validate and approve.

  Capture desktop and mobile screenshots. Run it alone, on a spare `E2E_PORT` after `bun run build`, never `bun run test:e2e` against a live server.

## 13. Gates

- [ ] 13.1 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate plan-validation --strict`, and record the results in the task journal.
