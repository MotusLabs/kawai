# Spec Delta

## ADDED Requirements

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
