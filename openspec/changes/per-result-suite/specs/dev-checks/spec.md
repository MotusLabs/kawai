# Spec Delta

## ADDED Requirements

### Requirement: Source commits run lint, typecheck, and affected tests
For a commit that is not docs-only, the pre-commit hook SHALL run lint, typecheck, and only the fast-tier unit test files affected by the change: files reaching a changed file through imports, and files declaring a runtime read that matches a changed path. It MUST NOT run the full suite unless the change touches a path outside the import graph.

#### Scenario: Leaf module change
- **WHEN** a commit changes one source module imported by three test files
- **THEN** the hook runs lint, typecheck, and those three test files

#### Scenario: Nothing affected
- **WHEN** a commit's changed source files are reached by no test file and declared by none
- **THEN** the hook runs lint and typecheck, runs no tests, and succeeds

#### Scenario: Slow tier left out
- **WHEN** an affected file is in the slow tier
- **THEN** the commit hook does not run it, and says how many slow-tier files it skipped

### Requirement: Changes outside the import graph run the full check
A commit that changes the test runner, check or hook scripts, the hooks themselves, `package.json`, the lockfile, TypeScript configuration, or a test preload SHALL run the full check through the recorded-pass mechanism instead of affected tests.

#### Scenario: Lockfile change
- **WHEN** a commit changes `bun.lock`
- **THEN** the hook runs the full check, and a recorded pass for the same content key skips it

### Requirement: Tests declare the repository files they read
A test file that reads a repository file at runtime SHALL list that path or glob in an `@reads` header. A guard test SHALL fail, naming the file and the path, when a test file's source names a repository documentation, group, workflow, or OpenSpec path that its header does not declare.

#### Scenario: Undeclared read
- **WHEN** a test file contains the literal path `AGENTS.md` and has no `@reads` header covering it
- **THEN** the guard test fails naming that file and `AGENTS.md`

#### Scenario: Declared read selects the test
- **WHEN** a commit changes `.kawai/groups/lead.md` and a test declares `@reads: .kawai/groups/*.md`
- **THEN** that test is among the affected tests the hook runs

### Requirement: Docs-only commits run the tests that read them
A docs-only commit SHALL run lint, typecheck, and the test files whose `@reads` declarations match a changed path, and no other tests.

#### Scenario: AGENTS.md edit
- **WHEN** a docs-only commit changes `AGENTS.md`
- **THEN** the hook runs the test files declaring `AGENTS.md`

#### Scenario: Unread doc
- **WHEN** a docs-only commit changes a document no test declares
- **THEN** the hook runs lint and typecheck only

### Requirement: Pushes require a full check of the pushed tree
The pre-push hook SHALL allow pushing a commit only when a full check passed for that commit's tree under the current Bun version and platform. When no record exists and the working tree is clean at that commit, it SHALL run the full check. Otherwise it SHALL refuse, naming the commit and how to check it.

#### Scenario: Recorded pass
- **WHEN** the pushed commit's tree has a recorded full pass
- **THEN** the push proceeds without running checks

#### Scenario: Unchecked tip with a clean tree
- **WHEN** the pushed commit is HEAD, the working tree is clean, and no pass is recorded
- **THEN** the hook runs the full check and allows the push only if it passes

#### Scenario: Unchecked commit that is not checked out
- **WHEN** the pushed commit is not the clean working tree and has no recorded pass
- **THEN** the push is refused with a message naming the commit and `bun run check` on a checkout of it

#### Scenario: Deleting a branch
- **WHEN** a push only deletes a remote branch
- **THEN** the hook runs no check
