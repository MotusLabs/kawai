# Spec Delta

## Purpose

Defines how Kawai lands an `integration-branch` plan. Changes provision from the plan's integration branch, and land on it instead of the default branch. Each landing is an exact candidate: the commit whose own CI passed becomes the integration head through a fast-forward, so every head Kawai gives the branch is a tree that was verified. The candidate chain, commits made outside Kawai, and promotion state are recorded and visible.

## ADDED Requirements

### Requirement: Integration-branch plans land through their own mechanism
Kawai SHALL provide the landing mechanism for `integration-branch`, so Start no longer refuses such a plan as `landing-mode-supported`. For such a plan, the execution's base branch SHALL be the plan's integration branch: changes provision from it, their pull requests target it, and they land on it. The repository's default branch SHALL be the promotion target, and landing a change SHALL never write to it.

#### Scenario: An integration plan starts
- **WHEN** the human starts an approved plan with landing mode `integration-branch` and branch `wave-c/integration`, and every precondition passes
- **THEN** the execution records `integration-branch`, the base branch `wave-c/integration`, and the default branch as the promotion target

#### Scenario: Pull requests target the integration branch
- **WHEN** a change of an integration plan is gated
- **THEN** its pull request's base is the integration branch, and nothing is pushed to or merged into the default branch

### Requirement: The landing probe checks the integration branch
For an integration plan, Start's `landing-ready` SHALL also refuse the integration branch when:
- it is the default branch or one of the plan's change names;
- it exists on `origin` without a record that an execution of this plan created it;
- another plan's record in the team holds it.

The probe SHALL change nothing.

#### Scenario: The default branch named as integration branch
- **WHEN** a plan's integration branch is the repository's default branch
- **THEN** Start is refused as `landing-ready`, naming the branch

#### Scenario: A branch made by hand
- **WHEN** `origin` already has the plan's integration branch and no execution of the plan created it
- **THEN** Start is refused as `landing-ready`, naming the branch, and the branch is left untouched

#### Scenario: Another plan's branch
- **WHEN** a plan names an integration branch that another plan's execution created
- **THEN** Start is refused as `landing-ready`, naming the branch and that plan

### Requirement: Kawai creates the integration branch before any provisioning
After Start, when the integration branch does not exist on `origin`, Kawai SHALL create it at the default branch's head as a new ref, refused if the name appeared meanwhile, before any change is provisioned. It SHALL record that commit, the creating execution, and the target branch. An existing branch SHALL be reused at its current head. A creation that fails after its retries SHALL stop every waiting change as `effect-failed`, naming the branch.

#### Scenario: The first execution creates the branch
- **WHEN** an integration plan's first execution starts
- **THEN** Kawai creates the branch at the default branch's head, records it, and only then provisions the first changes from it

#### Scenario: A later execution reuses it
- **WHEN** a later execution of the same plan starts after earlier changes landed on the branch
- **THEN** no branch is created, and its changes are provisioned from the branch's current head

### Requirement: Changes start from the integration branch
A change of an integration plan SHALL be provisioned from the integration branch's head on `origin`, recorded as its baseline, so it contains every change landed before it. `changes-on-base` SHALL compare the validated files with the integration branch's head. While that branch does not exist yet, it SHALL compare them with the default branch's head the branch will be created from.

#### Scenario: A dependent sees its dependency
- **WHEN** change `b` depends on change `a`, and `a` has landed on the integration branch
- **THEN** `b` is provisioned from an integration head that contains `a`'s landed commit

#### Scenario: Artifacts missing from the integration branch
- **WHEN** a change's artifacts were merged to the default branch after the integration branch was created
- **THEN** Start is refused as `changes-on-base`, naming the change and the integration branch

### Requirement: A passed change becomes an exact candidate
When a change's round passes and the change holds the landing slot, Kawai SHALL bring it up to date with the integration head, under the same up-to-date rule as direct landing. Kawai SHALL then record a candidate holding:
- the next sequence number;
- the head it extends;
- the change, result, and round;
- the exact commit and tree.

A candidate SHALL be verified only by CI on that exact commit.

#### Scenario: A change already up to date
- **WHEN** a change whose round passed already contains the integration head
- **THEN** its candidate is the round's commit, verified by that round's CI

#### Scenario: A change behind the integration head
- **WHEN** another change landed after this change's round passed
- **THEN** GitHub merges the integration head into the change's branch, CI runs on the merge commit, and the candidate is that merge commit once its CI passes

### Requirement: A candidate lands as a fast-forward of its verified commit
Kawai SHALL land a passed candidate by moving the integration branch to the candidate's exact commit as a fast-forward, never forced, so the landed head is that commit itself. Immediately before, Kawai SHALL read the branch's head again. When the branch moved, or `origin` refuses the fast-forward, nothing SHALL land, the candidate SHALL be superseded, and the change SHALL return to the up-to-date step.

#### Scenario: The verified commit is the new head
- **WHEN** a candidate on commit C passes
- **THEN** the integration branch's head becomes C itself, and the change's pull request shows as merged

#### Scenario: A branch moved by hand
- **WHEN** the owner pushes a commit to the integration branch after a candidate's CI ran
- **THEN** nothing lands, the candidate is superseded, and the change is brought up to date with the new head, so its next candidate lists the owner's commit as made outside Kawai

### Requirement: A rewritten integration branch stops landing
Before every landing, Kawai SHALL check that the integration branch still contains its last landed candidate, or the commit it was created at before any landing. When it does not, the landing change SHALL stop as `integration-rewritten`, naming the branch's head and the missing commit. Kawai SHALL never force the branch back. Retry SHALL check again.

#### Scenario: A force-push drops a landed change
- **WHEN** someone force-pushes the integration branch to a commit without change `a`'s landed candidate, and change `b` is ready to land
- **THEN** `b` stops as `integration-rewritten`, naming the head and `a`'s missing commit, and the branch is left as it is

#### Scenario: Retry after the owner restores the branch
- **WHEN** the owner pushes the branch back to a commit containing `a`'s candidate and retries `b`
- **THEN** `b` is brought up to date with that head and lands as a new candidate

### Requirement: Landing on the integration branch is acceptance
Each landed candidate SHALL give its change a landing fact with mechanism `integration-branch`, recording the pull request, the integration head it extended, and the landed commit. Kawai SHALL then accept the result and close the task, as in direct landing. Dependents SHALL become schedulable. The plan SHALL complete when every change has landed on the integration branch, whether or not it has been promoted.

#### Scenario: Landing closes the task
- **WHEN** a change's candidate lands on the integration branch
- **THEN** its landing fact names the integration branch and the landed commit, and its task is done with Kawai's acceptance

#### Scenario: The plan completes before promotion
- **WHEN** the last change of the revision lands on the integration branch
- **THEN** Kawai completes the plan, and its view shows the branch as not yet promoted

### Requirement: A failed candidate keeps the last good state
A candidate whose CI fails SHALL be recorded as failed and SHALL land nothing, so the integration branch keeps its previous candidate. The change SHALL get a fix attempt that continues from the candidate's commit and counts as a fix round, and later rounds SHALL produce new candidates. One candidate's evidence SHALL never verify another.

#### Scenario: Two changes that break together (R15)
- **WHEN** `a` has landed, and `b`, which passed alone, fails CI once merged with the integration head
- **THEN** `b`'s candidate fails, the integration branch keeps `a`'s candidate, and `b` gets a fix attempt naming the failing checks

#### Scenario: Incremental candidates (R16)
- **WHEN** the rounds of `a` and `b` pass a minute apart
- **THEN** `a`'s candidate lands first, `b`'s candidate is built on it and gets its own CI, and `a`'s evidence does not count for `b`

### Requirement: Commits made outside Kawai are flagged
When a candidate extends an integration head other than the previous landed candidate's commit, or other than the creation commit for the first candidate, the candidate SHALL record the commits between the two as made outside Kawai. The candidate chain SHALL show them. Kawai SHALL NOT revert or rewrite them. The candidate's own CI covers them as part of its tree.

#### Scenario: The owner pushes between executions
- **WHEN** the owner pushes a commit to the integration branch while no execution runs, and a later candidate extends it
- **THEN** that candidate lists the commit as made outside Kawai

#### Scenario: Back-to-back landings are not flagged
- **WHEN** two candidates land one after the other with nothing pushed in between
- **THEN** neither lists any commit as made outside Kawai

### Requirement: Integration-branch writes are recorded and inspected
Creating the integration branch and each fast-forward SHALL be recorded effects. When one's outcome was not recorded, Kawai SHALL read the branch on `origin` before acting:
- a head that contains the target commit SHALL be recorded as done;
- a head that the target commit contains SHALL run again;
- any other head SHALL be handled as a moved branch, or as a rewritten one when it lacks the last landed candidate.

#### Scenario: A restart after the fast-forward
- **WHEN** the server restarts after a fast-forward was sent but before its outcome was recorded
- **THEN** Kawai reads the branch, finds the candidate's commit at its head, and records the landing without moving the branch again

#### Scenario: A restart before the fast-forward
- **WHEN** the server restarts with a fast-forward recorded but the branch still at the candidate's base
- **THEN** Kawai runs the fast-forward again

### Requirement: Start waits for a running promotion
Start SHALL evaluate the appended precondition `promotion-idle`. It SHALL refuse Start while a promotion of the plan is running, naming the promotion and its step.

#### Scenario: A promotion is running
- **WHEN** the human starts a plan while one of its promotions is waiting for CI
- **THEN** Start is refused as `promotion-idle`, naming the promotion and its step

#### Scenario: A finished promotion
- **WHEN** the plan's last promotion has finished, whatever its outcome
- **THEN** `promotion-idle` passes

### Requirement: Landing facts must be reachable from the base
Start SHALL evaluate the appended precondition `landings-on-base`, in every landing mode. It SHALL refuse Start when the execution's base head on `origin` does not contain the landed commit of one of the plan's landing facts. The refusal names each such change and the branch it landed on.

#### Scenario: Switching to direct before promotion
- **WHEN** a plan's changes landed on its integration branch, and a new revision with landing mode `direct` is started before that branch is promoted
- **THEN** Start is refused as `landings-on-base`, naming those changes and the integration branch

#### Scenario: Switching after promotion
- **WHEN** the integration branch has been promoted onto the default branch, and the direct revision is started
- **THEN** `landings-on-base` passes

### Requirement: Progress and the Plans view show the integration branch
For a plan with an integration branch, progress SHALL show each change's landing on that branch and whether a promotion has carried it onto the default branch. The Plans view SHALL show the branch and its head, plus the candidate chain. Each candidate shows its sequence, change, commit, CI, and state, plus any commits made outside Kawai.

#### Scenario: Part of the work promoted
- **WHEN** three changes have landed on the integration branch and a promotion carried the first two
- **THEN** progress shows all three as landed, and only the first two as promoted

#### Scenario: The chain is visible
- **WHEN** the human opens an integration plan's detail
- **THEN** each candidate shows its sequence, change, commit, CI, and state, with a failed candidate kept beside the one that replaced it

### Requirement: Agents read integration state but cannot change it
`plan_get` SHALL include each integration branch of the plan, with its head, its candidates, and its promotions. No agent tool SHALL create or fast-forward an integration branch, or promote one or cancel a promotion. The instruction for an integration plan's task SHALL name the integration branch as its base, and tell the implementer not to push to it.

#### Scenario: plan_get shows the chain
- **WHEN** an agent calls `plan_get` for an integration plan
- **THEN** the result lists the integration branch, its head, its candidates with their states, and its promotions

#### Scenario: No agent can promote
- **WHEN** an agent looks for a tool to promote an integration branch or cancel a promotion
- **THEN** no such tool exists
