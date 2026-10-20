# Spec Delta

## ADDED Requirements

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
Files named `*.integration.test.ts` and the real-tmux files SHALL form the slow tier. The runner SHALL run both tiers by default and SHALL accept an option that excludes the slow tier. No file over 5 s in the recorded timings MAY sit outside the slow tier, unless it is listed with a reason.

#### Scenario: Excluding the slow tier
- **WHEN** the runner is asked to exclude the slow tier
- **THEN** no `*.integration.test.ts` or real-tmux file runs

#### Scenario: A slow file outside the tier
- **WHEN** recorded timings show a file outside the slow tier taking over 5 s and the file is not listed with a reason
- **THEN** the runner's timing report names it as misplaced
