# Design

## Context

See proposal.md (Why) for the motivation. The current state that shapes this design:

- **Results.**
  - `TaskResultService.submit` stores a result in one transaction with its journal note, then calls `onWrite`.
  - A result's `tests` are free-text claims, and `TaskResultCard` renders each one with "(claimed)".
  - For tasks a plan execution owns, `ownership.checkResult` already refuses a commit outside the change's branch (plan-execution D9). That check is a gate for owned tasks only.
- **Check records** (check-dedup).
  - `scripts/check.ts` writes `<git-common-dir>/kawai-checks/<key>.json` after a full pass. The record holds `treeId`, `bun`, `platform`, `arch`, `at`, `worktree`, and `steps`.
  - The key hashes the tree id together with the Bun version, platform and architecture. A clean working tree's tree id equals its commit's tree.
  - `scripts/lib/checkRecords.ts` and `checkKey.ts` already import `src/server/git/gitCommand.ts`.
- **The suite.**
  - `scripts/test-runner.ts` runs the suite. It writes no machine-readable report today; `per-result-suite` D1 adds JUnit reports for its affected-test passes.
  - About 6,500 `test`/`it` calls exist, 7 of them `test.skip`.
- **Test titles.** `src/server/__tests__/recoveryMatrix.test.ts` resolves citations of the form `` `file` › `exact title` `` with a literal-title extractor (`testTitles`), which allows modifiers and skips template literals.
- **The CI fixture step.**
  - One `run:` line in `ci.yml` names 26 fixture specs.
  - 32 specs mention `AGENTBOARD_CHAT_FIXTURE`. Three of them (`chat-activity`, `chat-auto-approve`, `chat-workers`) gate on it but are not listed, so the main e2e step skips them and the fixture step never runs them.
- **Git.**
  - `refs/remotes/origin/HEAD` names origin's default branch.
  - Server git calls go through `runGitAsync`, with a 10-second timeout and `cleanGitEnv`.

## Goals / Non-Goals

**Goals:**
- Every fact the lead checks by hand before a review is computed by Kawai from the repository and kept with the result.
- A coverage claim becomes checkable, both per result and across the repository.
- A reviewer's account of coverage is formed before the author's is seen.
- Parallel branches stop colliding on the CI fixture list and on task ticks.

**Non-Goals:**
- A check never gates anything: not submission, handoff, findings, acceptance, execution, or landing. A later change can add a gate once the checks have a track record.
- Kawai never runs lint, typecheck, or tests, and never fetches. It reads records and local git state.
- Telling a genuine record from a forged one. A record shows that a check passed on this host, not who ran it; CI remains the independent run.
- Judging whether a cited test is adequate. Reading tests and targeted mutants remain the reviewer's work.
- Backfilling checks for results submitted before this change.

## Decisions

### D1. Checks run in the server, after the result commits, one per team at a time

- **Scheduling.**
  - `submit` inserts a `pending` check row in the same transaction as the result. After commit, a new `onResult` callback hands the row to `ResultCheckService`.
  - The service runs a team's pending checks one at a time, oldest first. Each git call has the existing 10-second timeout, and the whole check has a 120-second budget.
  - A check that throws, times out, or overruns is stored as `unavailable` with its reason. The tool call that submitted the result returned long before.
- **Startup.** Every `pending` row runs once after startup. Because the row commits with its result, a crash between the commit and the run loses nothing. This is a new recovery mechanism, so it gets a row in `docs/recovery-matrix.md`.
- **Alternatives rejected.**
  - Checking inside the tool call: dozens of merge-trees would delay or fail a submission.
  - A lead-run script only: its output would be the lead's reading, not Kawai's record. The script still exists (D10) for local use.
  - A gate: false failures, such as a stale base or a removed worktree, would refuse legitimate results.

### D2. What a check reads

Every call is read-only, so a running commit hook in that worktree is never disturbed:
- status runs as `git --no-optional-locks status`;
- the index, refs, and worktree are never written.

The only write is `git merge-tree --write-tree`, which adds unreferenced objects that gc prunes.

1. **Commit.** `rev-parse --verify <given>^{commit}` gives the full sha and its tree. When the given text is not a full sha, the check records it as resolved at check time. A miss ends the check: `commit: not found`.
2. **HEAD.** The worktree's HEAD sha and its branch (or `detached`), related to the commit as `same`, `ahead n`, `behind n`, or `diverged`, via `merge-base --is-ancestor` and `rev-list --count`.
3. **Clean.** `status --porcelain=v1 -z` lists modified, staged, and untracked non-ignored paths: the first 20, plus a count.
4. **Recorded pass** (D3). Whether a record exists for the commit's tree. The check compares each record's Bun version with `git show <sha>:.bun-version`, and its platform and architecture with the server's.
5. **Base.**
   - The base is `refs/remotes/origin/HEAD`, as last fetched. When that ref is unset, the base facts are `unknown` with the fix: `git remote set-head origin --auto`.
   - The check records the base sha and how many base commits the result lacks.
   - `merge-tree --write-tree --name-only --no-messages <base> <sha>` gives a clean merge or the conflicting paths.
6. **Open branches.**
   - Compared: every other `open`, `active`, or `blocked` task of the team whose worktree is a listed worktree root.
   - Its HEAD is skipped when it equals the commit, is contained in the commit, or is contained in the base. Heads are deduplicated by sha. At most 30 are compared, newest task first, and the rest are counted.
   - For each one compared, the check records:
     - conflicts, from `merge-tree` between the two heads;
     - overlap: the intersection of `diff --name-only <base>...<sha>` and `diff --name-only <base>...<other>`.

     Both lists are capped at 20 names plus a count.
7. **Coverage** (D5).

**Statuses.**
- Each fact has the status `pass`, `warn`, `fail`, or `unknown`.
- `warn` covers HEAD ahead of the commit, a pass under another Bun version, and an overlap without a conflict. A conflict is `fail`.
- The stored facts are versioned JSON of at most 64 KB.

### D3. Records are found by tree, under any Bun version; the record code moves into `src/server/checks/`

- **Lookup by tree.** The server cannot rebuild a record's key: a compiled Kawai binary embeds its own Bun, which need not be the worktree's.
  - So `recordsForTree(dir, treeId)` scans the record directory (at most 500 small files) for matching `treeId`s, newest first.
  - It applies `readRecord`'s age limit and its fail-closed parsing.
- **Pre-push stays exact.** `per-result-suite` D4's pre-push lookup keeps its exact key under the current Bun.
- **Files that move.**
  - `checkRecords.ts` and `checkKey.ts` move to `src/server/checks/`, and `scripts/check.ts` imports them from there.
  - `testTitles` moves to `src/server/checks/testTitles.ts`, with an option for `test`/`it` titles only. `recoveryMatrix.test.ts` imports it.
- **Rejected:** importing `scripts/` from the server.

### D4. Storage, rechecks, and the one-pending rule

All storage arrives in the next free migration. master is at 14 today; coordinate the number with the open branches at implementation.

- **`team_task_result_checks`.** Columns: `id`, `team_id`, `task_id`, `result_id`, `seq`, `trigger` (`submit` or `recheck`), `requested_by_kind`, `requested_by_session`, `status` (`pending`, `done`, or `unavailable`), `facts`, `reason`, `created_at`, `finished_at`.
  - `UNIQUE (result_id, seq)`.
  - A partial unique index on `result_id WHERE status = 'pending'` makes one pending check per result a database fact.
  - A row changes once, from `pending` to `done` or `unavailable`; the update matches `status = 'pending'`.
- **Rechecks.**
  - `task_check_result { task_id, result_id }` serves agents; the human's equivalent is the `team-task-recheck` command over the chat WebSocket, listed in `CHAT_CONNECTION_TYPES`.
  - Either one inserts a new pending row, or returns the existing one when the unique index refuses the insert.
- **`team_task_results.coverage`.** A nullable JSON column holds the submitter's map, written at insert.
- **`team_task_coverage_maps`.** Holds reviewer maps: `id`, `team_id`, `task_id`, `result_id`, `author_session`, `coverage`, `created_at`. It is append-only, and the newest map per (result, session) counts.

### D5. Coverage maps: shape, grammar, and resolution

- **Input.** `coverage?: { clause, tests, note? }[]`, with these limits; malformed input is refused at submission with the clause index:
  - at most 200 clauses;
  - each `clause` at most 500 characters;
  - `tests` holds 0–10 citations;
  - `note` at most 500 characters.
- **Clauses.**
  - A spec scenario is written as `<capability> › <requirement> › <scenario>`, the same name the annotations use (D8).
  - A task clause is written as its task number plus `Verify` (for example `2.1 Verify`).
- **Citations.** A citation uses the recovery-matrix grammar, `` `path` › `title` ``, with the path relative to the repository root.
- **Resolution at the commit.**
  - `git show <sha>:<path>` must exist, and `testTitles` must find the title as a `test` or `it` title.
  - The tree's newest record with a test list (D7) then classifies the citation:
    - **ran and passed:** some entry with that file and title passed, and none was skipped;
    - **not run:** every matching entry was skipped or a todo;
    - **not in the run:** no entry matches;
    - **unknown:** no record has a test list.
- **Clause status.** A clause is one of:
  - **covered:** every citation was found and ran;
  - **partly covered**;
  - **not covered:** a citation was not found;
  - **declared uncovered:** it cites nothing.

### D6. The blind-first seal

- **Who is sealed.** A reading session S is sealed from result R's map when both hold:
  - S holds R's outstanding review handoff: the assignment's `handoff_kind` is `review`, its `result_id` is R, and S is either its session target or its claimant.
  - S has no row for R in `team_task_coverage_maps`.
- **What sealing does.** For S, `task_get` replaces R's map with `{ withheld: true, clauses: n }`.
- **What is never sealed.**
  - `handoffInstruction` builds the review instruction and already names only the result, its commit, and the summary. A test pins that it never renders the map.
  - The human and every other session always see the map.
- **The comparison** is derived at read time and never stored. It covers:
  - clauses only one map names;
  - per clause, the citations only one side gives;
  - clauses one side declares uncovered while the other cites tests.

  Clauses match by normalized text: trimmed, whitespace collapsed, backticks dropped, case-folded. Citations match by normalized path and title.
- **Limitation.** The seal hides Kawai's copy only. A map the author repeats in the summary, a journal note, or a commit stays visible, and `@covers` annotations in the diff are visible by design. So the procedure (D11) keeps maps out of prose, and the reviewer builds its clause list from the spec before reading the tests.

### D7. Test lists beside full-pass records

- **Reports.** For a full check, the runner gives each `bun test` invocation a unique `--reporter=junit --reporter-outfile` path, reusing `per-result-suite`'s JUnit reader.
- **Writing.**
  - After a full pass, `check.ts` writes `<key>.tests.json.gz` first and the record second. The record gains `tests: { file: '<key>.tests.json.gz', count }`.
  - The list holds sorted entries of the form `{ file, path, name, status }`, where `status` is `passed`, `skipped`, or `todo`.
- **Pruning** removes a list with its record, and removes lists that have no record.
- **Reading.** A missing, unreadable, or mismatched list reads as unknown.
- **Size.**
  - Estimate: about 6,500 entries, about 0.8 MB raw and 80 KB gzipped per record. That is up to about 40 MB at the 500-record cap.
  - Task 4.2 measures the real size. If it exceeds 200 KB, only the newest 100 records keep lists.
- **Rejected:** detecting skips statically, because `describe.skip`, `test.if`, and the runner's own exclusions are invisible to a regex.

### D8. `@covers` annotations and the archived-change rule

- **Annotations.**
  - An annotation is a line `// @covers: <capability> › <requirement> › <scenario>`, using the U+203A separator with spaces as in the recovery matrix.
  - Several annotations may stack. The next line that is neither blank nor a comment must open a `test(` or `it(` call, with modifiers.
  - The guard scans `src/**/*.test.ts(x)`, `scripts/**/*.test.ts`, and `tests/e2e/**/*.spec.ts`.
- **Scenario index.**
  - Main specs: every `### Requirement:` and its `#### Scenario:` lines in `openspec/specs/*/spec.md`.
  - Active change deltas: every section.
  - Archived deltas: the `ADDED` and `MODIFIED` sections only.

  A name that itself contains ` › ` cannot be annotated, and the guard reports it.
- **The required set.**
  - It is every (capability, requirement, scenario) that both:
    - appears in the `ADDED` or `MODIFIED` sections of an archive dated on or after `since` and not exempt;
    - still exists in the main specs.
  - Matching by current names means a later rename or removal drops the old name instead of failing on it.
- **Configuration.** `openspec/coverage.json` holds `{ "since": "YYYY-MM-DD", "exempt": [<change names>] }`.
  - `since` is the day the guard lands.
  - `exempt` lists the changes active on that day, so no in-flight change is blocked by a rule it was not written for.
  - An exempt name with neither an active directory nor an archive fails the suite.
  - This change is not exempt: its own PRs annotate their tests.
- **The guard reads `openspec/`.** It therefore carries `per-result-suite`'s `@reads` header once that lands.
- **Rejected alternatives.**
  - A baseline of uncovered scenarios: it is thousands of lines, and an archive PR that merges on green could add to it unreviewed.
  - Citations written into the spec text: they couple requirements to file layout.

### D9. The fixture lister and its guards

- **The lister.** `scripts/e2e-fixture-specs.ts` prints, sorted, every `tests/e2e/*.spec.ts` that contains the gate `test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1'` (whitespace-insensitive).
  - An empty list exits non-zero, because a bare `playwright test` would run everything.
  - The CI step becomes `bunx playwright test $(bun scripts/e2e-fixture-specs.ts) --workers=1`.
- **The guards.** A unit test asserts:
  - the lister's output equals the set of gated specs;
  - in a spec without the gate, every use of the variable in code (comments aside) sets it to `'0'`;
  - the fixture step's `run`, parsed with `Bun.YAML.parse`, calls the lister and names no `tests/e2e/` path.
- **Rejected:** a `*.fixture.spec.ts` rename. It churns 26 files, and forgetting the suffix fails silently in the same way.
- **The three never-run specs** run locally under the fixture recipe before CI switches (task 6.2).

### D10. One module, two front ends

- **The module.** `src/server/verification/resultChecks.ts` computes D2 over an injected git runner and a source of "other heads".
- **The server** supplies the open tasks' worktrees.
- **The script.** `scripts/verify-result.ts [--worktree P] [--commit R] [--coverage F] [--json]` supplies the other `git worktree list` heads and prints the same facts.
  - It exits 0 when no fact fails, 1 when one fails, and 2 on a usage error.
  - It is the lead's pre-push check and a dev's self-check. Run by the author, its output is still a claim, which the procedure says.

### D11. Hot files and the procedure

- **Ticks at archive.**
  - Implementation PRs leave `tasks.md` checkboxes alone. A result's coverage map names the task clauses it completes (`2.1 Verify`).
  - The archive PR ticks every box and names the PR that completed each group.
  - The cost: Kawai's navigator reads progress from `tasks.md` (openspec-visibility), so a change shows its unticked count until archive. The task records and the lead's state note carry progress instead.
  - Rejected: one `##` section per parallel PR. It keeps the display, but needs `tasks.md` restructured when a change is split, and it fails when one task spans two PRs.
- **AGENTS.md and the migration registry** keep their workflow. They merge cleanly unless two branches touch the same lines, and the open-branch check names them when two branches touch the same file.
- **The dev group files** say:
  - put the map in `coverage`, not in prose;
  - annotate the tests that cover spec scenarios;
  - do not tick `tasks.md`.
- **The reviewer group files** say, in this order:
  1. List the clauses from the spec and the task.
  2. Map them from the diff.
  3. Record the map with `task_submit_coverage`.
  4. Read the author's map, and treat each difference as a finding or explain it.

### D12. Surfaces

- **Agents.** In `task_get`, each result carries `checks: { newest, earlier }`, `coverage` (or the withheld form), `reviewerMaps`, and `comparison`.
- **The human.**
  - `TaskResultCard` shows "Checked by Kawai · <time>", with each fact's status and detail, and a Recheck button.
  - It shows the map with the "claimed" label, beside each citation's checked outcome, and the reviewers' maps with the comparison.
- **Guards.** A structural test keeps the execution, landing, dispatch, acceptance, and staffing modules free of `verification/` imports, so no check can become an input to them.

## Risks / Trade-offs

- [The base is as last fetched, so a clean merge can be stale] → The check names the base sha and the time. The lead rechecks after a fetch, and landing re-runs its own clean-merge check.
- [A record is local evidence that an agent could fabricate] → It is labeled as a recorded pass on this host, not as Kawai's run. CI runs the suite independently at the PR.
- [The seal leaks through prose, journal notes, or annotations] → Its limit is stated (D6). The procedure keeps maps out of prose, and the reviewer derives clauses from the spec first.
- [Up to 30 merge-trees per result add host load] → They run one team at a time, only on submission and recheck, are read-only, and use no slot.
- [The three never-run specs fail on their first run] → Task 6.2 runs them first, then fixes them or stops for a decision before CI switches.
- [An archive PR now fails when its change's scenarios lack annotations] → That is intended: green now means covered. The fix is a test PR before the archive.
- [Annotations go stale on renames] → The guard names the file and line, and the fix is mechanical.

## Migration Plan

1. **PR A:** move the record, key, and title modules (tasks 1.x). It depends on nothing open.
2. **PR B:** server checks, storage, recheck, the result card, and the recovery-matrix row (2.x), after PR A. It reads today's records, which have no test lists, so citations read "ran: unknown" until PR D.
3. **PR C:** coverage maps, the seal, and the comparison (3.x), after PR B.
4. **PR D:** test lists beside records, and the local script (4.x), after PR A and once `per-result-suite` PR A's JUnit reader and `parallel-suite`'s runner are on master.
5. **PR E and PR F**, in parallel with B–D: the coverage guard (5.x), after PR A, and the fixture lister (6.x), independent.
6. **PR G:** procedure and docs (7.x), last.

Rollback: every part is additive. Reverting a PR leaves its tables in place, since migrations only move forward, and they are unused. Results from before this change show no checks.

## Open Questions

- The test-list size per record (measured in 4.2) decides whether the newest-100 rule applies.
- The exact per-test fields of Bun 1.4.3's JUnit output: whether a test case carries its file, and how describe blocks nest. Task 4.1 checks this in a scratch project, as parallel-suite 1.2 checked runner behavior. If a test case lacks its file, the entry takes it from its enclosing file-level suite.
