# dev-checks Specification

## Purpose
Defines the local check pipeline that agents, the lead, and the git hooks run before work is committed or handed on: what a check runs, how a passing result is recorded and reused, and how checks stay fast without weakening them.

## Requirements

### Requirement: A full check runs lint, typecheck, and the unit suite
`bun run check` SHALL run lint, typecheck, and the unit suite against the working tree, stop at the first failing step, exit non-zero naming that step, and exit zero only when all three pass.

#### Scenario: All steps pass
- **WHEN** lint, typecheck, and the unit suite all pass
- **THEN** the check exits zero and reports each step's duration

#### Scenario: A step fails
- **WHEN** typecheck fails
- **THEN** the check exits non-zero naming typecheck, and the unit suite does not run

### Requirement: Passing checks are recorded by content key
A passing check SHALL be recorded under a content key made of the working tree's content identity (tracked and untracked files that git does not ignore), the Bun version, and the platform. A failed or interrupted check MUST NOT be recorded.

#### Scenario: Pass is recorded
- **WHEN** a check passes on a working tree
- **THEN** a record holding the key, the time, and each step's duration is written

#### Scenario: Failure is not recorded
- **WHEN** a check fails or is interrupted
- **THEN** no record is written, and the next check on the same tree runs in full

#### Scenario: Untracked files change the key
- **WHEN** an untracked, non-ignored file is added after a recorded pass
- **THEN** the next check computes a different key and runs in full

### Requirement: A recorded pass is reused across worktrees
A check whose content key matches a recorded pass SHALL report the recorded pass, with its time and the worktree it ran in, and run no step. Records SHALL be visible from every linked worktree of the repository. `--force` SHALL run every step regardless of records.

#### Scenario: Lead re-checks a dev's tree
- **WHEN** a dev's check passed in one worktree and the lead checks out the same content in another worktree
- **THEN** the lead's check reports the recorded pass in seconds and runs no step

#### Scenario: Forced run
- **WHEN** a check is run with `--force` on a tree that has a recorded pass
- **THEN** every step runs, and a pass refreshes the record

#### Scenario: Different Bun version
- **WHEN** a recorded pass was made under another Bun version
- **THEN** the key differs and the check runs in full

### Requirement: The commit hook reuses recorded passes
The pre-commit hook SHALL obtain its suite result through the recorded-pass mechanism, so committing a working tree whose content key already passed runs no suite. Docs-only commits keep skipping the suite.

#### Scenario: Message-only amend
- **WHEN** a commit is amended without content changes after its tree passed
- **THEN** the hook reports the recorded pass and does not run the suite

#### Scenario: Source change
- **WHEN** a commit changes a source file
- **THEN** the hook runs the suite, and records it when it passes

### Requirement: Typecheck is incremental and exact
Typecheck SHALL reuse its previous result in the same worktree, and SHALL report exactly the errors a clean typecheck of the same tree reports. Its incremental state MUST NOT be committed.

#### Scenario: Repeat typecheck after a small edit
- **WHEN** typecheck runs again after one file changed
- **THEN** it finishes faster than a clean run and reports the same diagnostics a clean run would

#### Scenario: Incremental state stays out of git
- **WHEN** typecheck has run in a worktree
- **THEN** `git status` lists no new file from it

### Requirement: The unit suite runs files in parallel isolated workers
The unit suite SHALL run its test files across a fixed number of parallel worker processes, each file with its own global and module registry, so a module mock or global patch in one file never reaches another. Real-tmux integration files SHALL run in a separate serial step.

#### Scenario: A module mock does not leak
- **WHEN** one file installs a module mock and a later file on the same worker imports the real module
- **THEN** the later file sees the real module

#### Scenario: Real-tmux files stay serial
- **WHEN** the full suite runs
- **THEN** the real-tmux integration files run one at a time after the parallel step, and are skipped where real tmux is excluded today

### Requirement: Parallel workers stay within one memory slot
The default worker count SHALL be fixed and documented, chosen so that a full parallel run's peak memory stays within the memory one serial run used before this change. The count SHALL be overridable through an environment variable. If no measured count fits the budget, the existing runner SHALL remain the default until one does. CI MUST NOT increase the measured count merely to match its CPU count.

#### Scenario: Default run fits the slot
- **WHEN** the full suite runs with the default worker count in the shared workspace
- **THEN** its measured peak resident memory does not exceed the recorded peak of the serial runner

#### Scenario: Override
- **WHEN** the worker-count variable is set to 2
- **THEN** the suite runs with 2 workers

### Requirement: Parallel workers stay within the CPU quota
The default worker count SHALL NOT exceed the CPU quota the workspace grants, read from the cgroup quota where one is set rather than from the CPU count the platform reports. The default SHALL be validated with other full suites running at the same time, as the shared workspace runs them.

#### Scenario: Quota below the reported CPU count
- **WHEN** the cgroup CPU quota is 6 and the platform reports 16 CPUs
- **THEN** the default worker count is at most 6

#### Scenario: Busy workspace
- **WHEN** the full suite runs with the default worker count while two serial full suites run in the same workspace
- **THEN** no test fails on its timeout

### Requirement: Parallel files never share runner-provided paths
Each test file SHALL receive fresh temporary database, log, Claude config, and Codex directories from the runner, including sequential files on the same worker. The parent runner SHALL clean up its run root after all child processes exit, on success or failure.

#### Scenario: Concurrent files and the default database path
- **WHEN** two files on different workers both use the runner-provided database path
- **THEN** each opens a different file

#### Scenario: Worker reused for another file
- **WHEN** a worker finishes one file and loads another
- **THEN** the second file receives different runner-provided paths, and both file roots are cleaned up after the run

### Requirement: Slowest files start first
After a full run, the runner SHALL record each file's duration, and the next run SHALL schedule files longest-first from that record. A missing or unreadable record SHALL fall back to an unordered run, never a failure.

#### Scenario: Recorded timings
- **WHEN** a previous full run recorded timings
- **THEN** the next run starts the files with the longest recorded durations first

#### Scenario: No record
- **WHEN** no timing record exists
- **THEN** the suite runs normally and writes one at the end

### Requirement: The slow tier is selectable
Files named `*.integration.test.ts` and the real-tmux files SHALL form the slow tier. The runner SHALL run both tiers by default and SHALL accept an option that excludes the slow tier. After a published full run the runner SHALL keep that run's snapshot beside the record and SHALL keep the newest five. No file whose shortest duration across the kept snapshots is over 5 s MAY sit outside the slow tier, unless it is listed with a reason.

#### Scenario: Excluding the slow tier
- **WHEN** the runner is asked to exclude the slow tier
- **THEN** no `*.integration.test.ts` or real-tmux file runs

#### Scenario: A slow file outside the tier
- **WHEN** a file outside the slow tier is over 5 s by its shortest duration across the kept run snapshots and is not listed with a reason
- **THEN** the runner's timing report names it as misplaced

#### Scenario: A load spike
- **WHEN** a file outside the slow tier is over 5 s in one kept run snapshot and under 5 s in another
- **THEN** the timing report does not name it

### Requirement: Full-check records list the tests that ran
A full pass SHALL also record, beside its record, every test that ran, read from the runner's machine-readable reports. Each entry holds:
- the test's file, describe path, and title;
- whether it passed, was skipped, or was a todo.

The list SHALL be written before its record and removed with it. A missing or unreadable list SHALL read as unknown, never as a failure or as an empty run.

#### Scenario: Pass with its test list
- **WHEN** a full check passes
- **THEN** its record names a test list holding every executed test, with its outcome

#### Scenario: Pruned together
- **WHEN** a record is pruned for age or count
- **THEN** its test list is removed with it

#### Scenario: Record without a list
- **WHEN** a record written before this change is read
- **THEN** its tests read as unknown

#### Scenario: Interrupted writing
- **WHEN** the check is interrupted after writing the list but before writing the record
- **THEN** no record exists, and the next prune removes the orphaned list

### Requirement: A local script reports a result's checks
`scripts/verify-result.ts` SHALL print, for a worktree and a commit (HEAD by default), the commit, worktree, recorded-pass, base, and coverage checks that Kawai records, computed by the same module. Instead of open tasks, it SHALL compare against the head of every other listed worktree.

It SHALL use no network, and SHALL exit non-zero when a check fails.

#### Scenario: Same answer as Kawai
- **WHEN** the script and Kawai check the same commit with the same records and base
- **THEN** they report the same commit, worktree, recorded-pass, base, and citation outcomes

#### Scenario: A failing check
- **WHEN** the checked commit conflicts with the base
- **THEN** the script lists the conflicting files and exits non-zero

#### Scenario: Coverage from a file
- **WHEN** the script is given a coverage map file
- **THEN** it checks each citation as Kawai does
