# Spec Delta

## Purpose

Defines the local check pipeline that agents, the lead, and the git hooks run before work is committed or handed on: what a check runs, how a passing result is recorded and reused, and how checks stay fast without weakening them.

## ADDED Requirements

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
