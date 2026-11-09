## ADDED Requirements

### Requirement: Failed fix rounds count toward the backstop
Kawai SHALL count a change's consecutive failed fix rounds, and when the count reaches the team's backstop it SHALL open a diagnosis instead of stopping the change. The first implementation round SHALL NOT count as a fix round. A passing round and a closed diagnosis SHALL reset the count, flaky checks SHALL NOT fail a round, and the rest of the execution SHALL continue.

#### Scenario: The fifth failed fix round opens a diagnosis
- **WHEN** a change's implementation round fails, no signal fires, and its next five fix rounds also fail under the default backstop
- **THEN** the change waits on a diagnosis naming the backstop, with the last round's evidence, and no sixth fix is dispatched until the card is decided

#### Scenario: A passing round resets the count
- **WHEN** two fix rounds fail, the next round passes, and the landing's update attempt then fails its round
- **THEN** the change shows one failed fix round of five and gets another fix attempt

## MODIFIED Requirements

### Requirement: A failed round returns the change for fixes
When a round fails and no diagnosis opens on it, Kawai SHALL dispatch a fix attempt to the change's implementing group as a handoff. The handoff SHALL carry the failing checks with their links, the blocking findings by id with clause, evidence, and reproduction, the count of other findings, the fix-round count, and the branch head to continue from. A round whose attempt is a fix or update attempt SHALL be a fix round.

#### Scenario: The fix instruction carries the failure
- **WHEN** a round fails on the end-to-end check
- **THEN** the implementing group receives a fix handoff naming the check, its link, and the commit to continue from

#### Scenario: Failed CI skips the review
- **WHEN** a round's CI fails after its rerun
- **THEN** no review handoff is dispatched for that result, and the fix handoff goes to the implementing group

#### Scenario: Only blocking findings are listed
- **WHEN** a round fails with F1 accepted at P1, F2 advisory, and F3 out of contract
- **THEN** the fix handoff lists F1 with its clause, evidence, and reproduction, says two other findings are in `task_get`, and does not list F2 or F3

#### Scenario: A diagnosis holds the fix
- **WHEN** a round fails and a convergence signal fires on its review
- **THEN** no fix handoff is dispatched until the diagnosis card is decided

### Requirement: Retry runs again the stage the change stopped in
Retry SHALL run the stage of the change's stop reason:
- `diagnosis-escalated`, and `round-limit` for a change stopped before the backstop existed: a fix attempt, with a new fix-round count;
- `instruction-failed` and `task-closed`: that stage's instruction;
- `review-unavailable`: the review handoff;
- `name-taken`: the name check, then provisioning;
- `effect-failed` and `pr-closed`: the effect;
- `effect-unknown`: the effect's inspection first;
- `ci-missing` and `ci-timeout`: CI, with new timeouts.

#### Scenario: Retry after an escalated diagnosis
- **WHEN** the human retries a change stopped as `diagnosis-escalated`
- **THEN** a fix attempt is dispatched, its fix-round count starts again at one, and the retry is recorded with the owner as actor

#### Scenario: Retry after the round limit
- **WHEN** the human retries a change that stopped as `round-limit` before the backstop existed
- **THEN** a fix attempt is dispatched and its fix-round count starts again at one

#### Scenario: Retry after an unknown outcome
- **WHEN** the human retries a change stopped as `effect-unknown` on its merge
- **THEN** Kawai inspects the pull request first, and records the landing if the merge had completed instead of merging again

### Requirement: Execution settings are user-level
Each team's `planExecution` settings SHALL live only in the user-level `~/.kawai/teams.json`, and project files SHALL NOT set them. They SHALL map each floor check run in CI to CI check names, and SHALL set the parallel limit (default 3), the merge method (default merge commit), and the backstop `maxFailedFixRounds` (an integer from 2 to 20, default 5). A malformed value SHALL be logged and its default used. A floor check without a mapping SHALL refuse Start as `landing-ready`.

#### Scenario: Missing end-to-end mapping
- **WHEN** the team's mapping names CI checks for lint, typecheck, and unit tests but none for CI end-to-end
- **THEN** Start is refused as `landing-ready`, naming the unmapped floor check

#### Scenario: A malformed value falls back to its default
- **WHEN** the team's `maxParallelChanges` is the string `"three"`
- **THEN** the problem is logged and the next Start records the default limit of 3

#### Scenario: An out-of-range backstop falls back
- **WHEN** the team's `maxFailedFixRounds` is 1
- **THEN** the problem is logged and the backstop reads 5

## REMOVED Requirements

### Requirement: Three consecutive failed fix rounds stop the change
**Reason**: A fixed round count cannot tell converging work from diverging work; it stops the first and lets the second spend its rounds. The convergence signals and the configurable backstop open a diagnosis instead.
**Migration**: The backstop is "Failed fix rounds count toward the backstop", and the diagnosis is the `review-convergence` capability. Changes stopped as `round-limit` before the upgrade keep that reason, and Retry still runs their fix attempt.
