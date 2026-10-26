# Proposal

## Why

Strategy revision 2 asks for results that are trustworthy before throughput (P10). Yet a result's evidence is still its author's word:
- Test outcomes are stored and shown as claims.
- The spec-to-test map is prose in the summary.
- The lead checks every result by hand: does the commit exist, is it the branch head, is the tree clean, did a full check pass for that tree, does it merge with master and with the other open branches, do the cited tests exist.

Those checks cost lead turns, the team's scarcest quota, and they fail like any reading does: a reconstructed commit id once named an object that did not exist.

Nothing ties a spec scenario to a test, either:
- Three fixture e2e specs (`chat-activity`, `chat-auto-approve`, `chat-workers`) skip unless the chat fixture is on. CI's fixture step lists its specs by hand and never listed them, so they have never run in CI. The sibling change `ci-fixture-specs` fixes that list.
- Reviewers read the author's map before building their own, so a scenario the author left out tends to stay out.

Parallel branches also collide on shared files that carry no logic. For example, parallel-suite's tasks 3.1 and 3.2 sit on adjacent lines of one tasks.md but belong to two pull requests, so ticking both conflicts.

Each collision costs a master merge, a new head, a CI rerun and a re-review.

## What Changes

- **Kawai checks each result.** After a result is stored, Kawai checks its commit from the repository, without the network, and records what it found, labeled as checked by Kawai:
  - whether the commit resolves, whether it is the worktree's HEAD, and on which branch;
  - whether the worktree is clean;
  - whether a full-check pass is recorded for the commit's tree, and under which Bun version;
  - whether it merges cleanly into origin's default branch, as last fetched;
  - which files conflict with other open tasks' branches, or are also changed by them.

  The submitter's test list keeps its "claimed" label, and the recorded pass is a separate checked line. Checks never block a submission and gate nothing. A recheck adds a new record.
- **Coverage maps become structured and checked.**
  - `task_submit_result` takes an optional coverage map: each spec scenario or task verify clause, with the tests that cover it cited as `` `file` › `title` ``.
  - Kawai checks that each cited test exists at the commit. Where the tree's recorded pass lists its tests, it also checks that the test ran and passed.
- **Blind-first review.**
  - A new tool, `task_submit_coverage`, records a reviewer's own map.
  - Kawai withholds the author's maps of the task from a reviewer holding its outstanding review handoff, until that reviewer records its own.
  - Afterwards Kawai shows both maps and where they differ.
- **Check records list their tests.** A full pass also records every test that ran, and its outcome, beside the record.
- **Spec coverage is checked.**
  - Tests name the scenarios they cover with `// @covers:` annotations.
  - The unit suite fails on an annotation that names no scenario, and on any scenario of a newly archived change that no test covers.
- **A local front end.** `scripts/verify-result.ts` prints the same checks for a worktree, from the same module, for pre-push and self-checks.
- **Procedure.**
  - Implementation PRs stop ticking tasks.md, and the archive PR ticks it.
  - The dev and reviewer group files describe the coverage map, the blind-first order, and the ticks.

## Capabilities

### New Capabilities
- `spec-coverage`: tests name the spec scenarios they cover, and the suite checks those names and the coverage of newly archived changes.

### Modified Capabilities
- `task-results`:
  - Kawai's result checks and rechecks;
  - coverage maps with checked citations;
  - reviewer maps behind the blind-first seal;
  - the persistence and reading of all three.
- `dev-checks`: full-check records list the tests that ran, and a local script reports a result's checks.

## Impact

- **Server.**
  - A new `src/server/verification/` module holds the checks and their scheduling. The result service schedules a check after each submission.
  - The task tools gain the `coverage` input and two tools, `task_submit_coverage` and `task_check_result`.
  - `task_get` and the human task detail carry checks and maps, with the seal.
  - Storage: a check table, a reviewer-map table, and a nullable coverage column on `team_task_results`, in the next free migration.
  - A recovery-matrix row covers checks still pending at restart.
- **Client.** `TaskResultCard` gains a "Checked by Kawai" section, the coverage map, the reviewer comparison, and a Recheck control.
- **Scripts.**
  - The check-record reader and the content key move from `scripts/lib/` to `src/server/checks/`. The test-title extractor moves there too, out of `recoveryMatrix.test.ts`.
  - The runner writes JUnit reports for the full check.
  - A new script, `scripts/verify-result.ts`.
- **Tests.** A spec-coverage guard, with its configuration file.
- **Docs.**
  - AGENTS.md lines.
  - The dev and reviewer group files.
  - The user-level `reviewers-claude` and `reviewers-mimo` files are the owner's to update.
- **Dependencies.**
  - `per-result-suite` supplies the full check before each result and the JUnit report parsing; `parallel-suite` supplies the runner's shape.
  - Neither blocks the server-side checks, which read today's records.
  - The CI fixture list is the sibling change `ci-fixture-specs`, which depends on nothing here.
- **Out of scope.**
  - Gating acceptance, handoffs or landing on the checks.
  - Running tests on the server.
  - Proving who wrote a check record: CI stays the independent run.
  - AGENTS.md and the migration registry as hot spots: their overlaps are reported, with no new mechanism.
