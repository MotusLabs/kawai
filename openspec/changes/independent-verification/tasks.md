# Tasks

Every test this change adds for a spec scenario carries its `// @covers:` annotation (D8), including tests that land before the guard does.

## 1. Shared check modules (PR A)

- [ ] 1.1 Move `checkRecords.ts` and `checkKey.ts` from `scripts/lib/` to `src/server/checks/`, update `scripts/check.ts`, and move their tests along with them. Verify:
  - the check-dedup tests pass, unchanged except for their paths;
  - `bun run check` on an unchanged tree still reports the recorded pass without running.
- [ ] 1.2 Add `recordsForTree(dir, treeId)` (D3): newest first, across every Bun version, with `readRecord`'s age limit and fail-closed parsing. Verify with tests for:
  - two records of one tree under two Bun versions;
  - an expired record;
  - a malformed file;
  - a record of another tree.
- [ ] 1.3 Move `testTitles` out of `recoveryMatrix.test.ts` into `src/server/checks/testTitles.ts`, with an option that keeps only `test` and `it` titles (D5), and import it from the matrix test. Verify that the recovery-matrix test passes unchanged, and that the extractor's tests cover:
  - modifiers;
  - escaped quotes;
  - describe titles dropped by the option;
  - template literals skipped.

## 2. Server result checks (PR B)

- [ ] 2.1 Add the next free migration (D4), with its store methods:
  - `team_task_result_checks`, with its unique and partial unique indexes;
  - the `team_task_results.coverage` column;
  - `team_task_coverage_maps`.

  Verify with store tests over `schemaDb()`:
  - a second pending row for one result is refused by the index;
  - a row changes only once, from pending;
  - maps are append-only.
- [ ] 2.2 Implement `src/server/verification/resultChecks.ts` (D2): commit, HEAD, clean, recorded pass, base, and open branches, with their statuses, bounds, and `--no-optional-locks`. Verify in temporary repositories built under `cleanGitEnv`, one test per scenario of:
  - "Kawai checks a result's commit";
  - "Kawai checks a result against the base and other open branches".
- [ ] 2.3 Add `ResultCheckService` (D1):
  - the pending row in the submit transaction;
  - the `onResult` callback;
  - one check at a time per team, with the 120-second budget;
  - `unavailable` with reasons;
  - the startup run of pending rows;
  - its row in `docs/recovery-matrix.md`.

  Verify:
  - each scenario of "Result checks never block or gate", including a git call that hangs past its timeout and a restart with a pending row;
  - the recovery-matrix test resolves the new row.
- [ ] 2.4 Add the `task_check_result` tool and the human `team-task-recheck` command (listed in `CHAT_CONNECTION_TYPES`), reusing a pending row (D4). Verify both scenarios of "Results can be rechecked", over the tool and over the WebSocket command.
- [ ] 2.5 Surface the checks (D12):
  - `task_get` carries each result's newest check and the count of earlier ones;
  - `TaskResultCard` shows "Checked by Kawai", with each fact and a Recheck control, while the test list stays labeled claimed;
  - the structural test keeps the execution, landing, dispatch, staffing, routing, and plan-supervision modules free of `verification/` imports (D12).

  Verify with:
  - the client tests and the structural test;
  - the tool test for "Agents read the checks";
  - the results section of `tests/e2e/chat-teams.spec.ts`, extended with a seeded result on a real commit. Run it in a disposable checkout with an isolated database, a spare `E2E_PORT`, `--workers=1`, and CI's fixture setup.
- [ ] 2.6 Add one AGENTS.md bullet for result checks, beside the task-results bullets. Verify that `bun run test` passes, since tests read AGENTS.md.

## 3. Coverage maps and the blind-first seal (PR C)

- [ ] 3.1 Accept `coverage` on `task_submit_result`, with D5's limits and citation grammar, and store it. In the check, resolve each citation as not found, ran and passed, not run, not in the run, found with its run unknown, or unresolved without a commit, and derive each clause's status (D5). Verify:
  - one test per scenario of "Results carry a coverage map", "Citations without a commit" included;
  - a malformed citation is refused, naming its clause index.
- [ ] 3.2 Add `task_submit_coverage`, the seal in `task_get` (D6), and the derived comparison, with the seal and the comparison as pure functions in `src/shared/coverageMaps.ts` (D12). Verify each scenario of "Reviewers record their own coverage map first", covering:
  - a reviewer that is the session target of a review handoff;
  - a reviewer that claimed a group-target handoff;
  - the human, and a third session;
  - a newer result of the task, whose map is withheld too;
  - the three kinds of difference.

  Also verify with a `handoffInstruction` test that pins that no map is ever rendered.
- [ ] 3.3 Show the maps in `TaskResultCard`:
  - the submitter's map, labeled claimed, with each citation's checked outcome;
  - the reviewer maps;
  - the comparison.

  Verify with client tests, and with both scenarios of "Checks and coverage maps are kept and read with their results", across a restart.
- [ ] 3.4 Add one AGENTS.md bullet for coverage maps and the seal. Verify that `bun run test` passes.

## 4. Test lists beside records (PR D)

- [ ] 4.1 In a scratch project under Bun 1.4.3, record what `--reporter=junit` writes for each test with `--parallel`: whether a test case carries its file, how describe blocks nest, and how skips and todos appear. Settle the entry's file source, and verify the result by writing the answer into design.md's Open Questions.
- [ ] 4.2 Have the runner write a unique-path JUnit report for each invocation of a full check, reusing `per-result-suite`'s JUnit reader.
  - `check.ts` writes `<key>.tests.json.gz` before its record.
  - Pruning removes each list with its record, and removes orphaned lists.
  - Measure the size per record, and apply D7's newest-100 rule if it exceeds 200 KB.

  Verify each scenario of "Full-check records list the tests that ran", and record the measured size in the PR body.
- [ ] 4.3 Read the lists in the citation check (D5). Verify the scenarios "Citation resolves and ran" and "Cited test was skipped" against a real record that `bun run check` wrote in a temporary repository.
- [ ] 4.4 Add `scripts/verify-result.ts` (D10), comparing against the head of every other listed worktree. Verify each scenario of "A local script reports a result's checks", including the exit codes.

## 5. Spec coverage guard (PR E)

- [ ] 5.1 Add the annotation parser and the scenario index (D8), over the main specs and active deltas. Archived deltas feed only the required set (5.2). Verify with fixture trees:
  - an annotation that resolves;
  - an annotation naming an active change's scenario;
  - a stale annotation whose old name an archived delta still holds;
  - an annotation away from a test;
  - a requirement or scenario name containing ` › `, which fails, naming the spec file and line.
- [ ] 5.2 Add the guard test and `openspec/coverage.json`:
  - `since` is the landing day;
  - `exempt` lists every change active that day, except this one.

  Verify each scenario of "Newly archived changes have covered scenarios" over fixture trees, and that the real repository passes.
- [ ] 5.3 Add one AGENTS.md bullet for annotations and the archive rule. Verify that `bun run test` passes.

## 6. Procedure (PR F)

- [ ] 6.1 Update the dev group files (D11):
  - the map goes in `coverage`, never in prose;
  - tests that cover spec scenarios carry annotations;
  - `tasks.md` checkboxes are left for the archive PR;
  - `scripts/verify-result.ts` runs before each submission.

  Verify that `bun run test` passes, since tests read `.kawai/groups/`.
- [ ] 6.2 Update the reviewer group files with the blind-first order (D11). List the owner's follow-ups in the PR body: the user-level `reviewers-claude` and `reviewers-mimo` files, and the lead's archive procedure. Verify that `bun run test` passes.

## Workflow follow-up

- The archive PR ticks every task, naming the PR that completed each group (D11). Its CI runs the coverage guard over this change's own scenarios.
