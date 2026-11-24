## MODIFIED Requirements

### Requirement: Pushes require a full check of the pushed tree
The pre-push hook SHALL allow pushing a commit only when a full check passed for that commit's tree on the current platform and architecture, under the current Bun version or the Bun version pinned by the commit's own `.bun-version`. When no such pass exists and that pin differs from the current Bun, it SHALL refuse without running a check. Otherwise, when the working tree is clean at that commit, it SHALL run the full check; else it SHALL refuse, naming the commit and how to check it.

#### Scenario: Recorded pass
- **WHEN** the pushed commit's tree has a recorded full pass
- **THEN** the push proceeds without running checks

#### Scenario: Unchecked tip with a clean tree
- **WHEN** the pushed commit is HEAD, the working tree is clean, and no pass is recorded
- **THEN** the hook runs the full check and allows the push only if it passes

#### Scenario: Unchecked commit that is not checked out
- **WHEN** the pushed commit is not the clean working tree and has no recorded pass
- **THEN** the push is refused with a message naming the commit and `bun run check` on a checkout of it

#### Scenario: Multiple pushed refs
- **WHEN** stdin names two unchecked commits and only the first matches the clean working tree
- **THEN** the hook buffers both refs before checking the first, and still refuses the second with its commit id

#### Scenario: Annotated commit tag
- **WHEN** a pushed annotated tag points to a commit whose tree has a recorded full pass
- **THEN** the hook looks up the peeled commit tree and allows the push

#### Scenario: Deleting a branch
- **WHEN** a push only deletes a remote branch
- **THEN** the hook runs no check

#### Scenario: Recorded pass under the pinned Bun
- **WHEN** the pushed commit's `.bun-version` pins a Bun other than the current one, and its tree has a recorded full pass under that pin on the current platform and architecture
- **THEN** the push proceeds without running checks, naming the pinned Bun as the pass's version

#### Scenario: Bun mismatch without a pass
- **WHEN** the pushed commit pins a Bun other than the current one and its tree has no recorded full pass under either version, even with HEAD at that commit and a clean working tree
- **THEN** the push is refused without running a check, naming the current and pinned Bun and `bun run check` under the pinned Bun on a clean checkout

#### Scenario: Pin matching the current Bun
- **WHEN** the pushed commit pins the current Bun, it is HEAD, the working tree is clean, and no pass is recorded
- **THEN** the hook runs the full check and allows the push only if it passes

#### Scenario: Missing or malformed pin
- **WHEN** the pushed commit's tree has no `.bun-version`, or its trimmed content is not a `MAJOR.MINOR.PATCH` version
- **THEN** the hook accepts only a pass under the current Bun and otherwise behaves as without a pin, running the full check on a clean HEAD

#### Scenario: Pass under another Bun version
- **WHEN** the pushed commit's tree has a recorded full pass only under a Bun that is neither the current one nor the commit's pin
- **THEN** the hook treats the tree as having no recorded pass
