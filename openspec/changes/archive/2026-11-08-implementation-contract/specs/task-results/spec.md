# Spec Delta

## ADDED Requirements

### Requirement: Kawai checks a result against its contract's scope
Kawai's result check SHALL compare the files the result's commit changes since its merge base with origin's default branch against the scope globs of the contract of the revision the result is pinned to. It SHALL name each path no glob matches, judging a rename by both its old and new paths. Paths under the linked change's own directory SHALL count as in scope. It SHALL name at most 20 paths and count the rest.

#### Scenario: Everything in scope
- **WHEN** a result pinned to a revision with scope `src/server/team/**` changes only `src/server/team/taskStore.ts` and the linked change's `tasks.md`
- **THEN** the check says the result is within scope and names no path

#### Scenario: Outside the scope
- **WHEN** the same result also changes `src/client/App.tsx`
- **THEN** the check names `src/client/App.tsx` as outside scope

#### Scenario: Rename out of scope
- **WHEN** the result moves `src/server/team/a.ts` to `src/shared/a.ts`
- **THEN** the check names `src/shared/a.ts` as outside scope

#### Scenario: Many paths outside scope
- **WHEN** the result changes 25 files that no glob matches
- **THEN** the check names 20 of them and counts the 5 it did not name

#### Scenario: The pinned revision's contract counts
- **WHEN** a result pinned to revision 2 is checked after revision 3 widened the scope
- **THEN** the check judges the paths against revision 2's scope

### Requirement: The scope fact says when it cannot judge
The scope fact SHALL read "no contract" when the pinned revision has none, and unknown, with its reason, when the commit does not resolve or the base ref is unset. Like every result check, it SHALL NOT block, gate, or change acceptance, handoffs, findings, or task status.

#### Scenario: Task without a contract
- **WHEN** a result of a task whose pinned revision has no contract is checked
- **THEN** the scope fact reads "no contract" and names no path

#### Scenario: Outside scope does not gate
- **WHEN** a result's scope fact names paths outside scope
- **THEN** the result can still be handed off, reviewed, and accepted under the existing rules
