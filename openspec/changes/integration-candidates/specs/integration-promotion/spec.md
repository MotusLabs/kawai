# Spec Delta

## Purpose

Defines how the owner promotes a plan's integration branch onto the repository's default branch. Promotion is a separate, human-only operation, pinned to the integration head the owner reviewed. Kawai builds it on its own branch and pull request, brings it up to date with the default branch, verifies the exact result on the check floor, and merges it with a merge commit only after re-checking the default branch's head. A failed promotion merges nothing and keeps its evidence.

## ADDED Requirements

### Requirement: Only the human promotes an integration branch
The human SHALL be able to promote a plan's integration branch onto the repository's default branch, naming the integration head they reviewed, under a command id. A retry with the same command id and payload SHALL return the prior promotion, and the same command id with a different payload SHALL be refused naming the differing field. No agent tool SHALL promote or cancel a promotion, and the service SHALL refuse an agent caller on those paths.

#### Scenario: A lost Promote result replays
- **WHEN** the human's Promote succeeds, its result is lost, and the dialog resends it under the same command id
- **THEN** the same promotion is returned, and no second promotion branch or pull request exists

#### Scenario: No agent can promote
- **WHEN** an agent calls the promotion service path directly
- **THEN** the call is refused and nothing is written

### Requirement: Promote evaluates named preconditions
Promote SHALL evaluate an ordered list of named preconditions and run every entry. A failure SHALL refuse Promote, naming every failing entry with its message, and SHALL write nothing:
- `integration-branch-known`: the branch is the plan's, created by its execution;
- `no-execution` and `no-promotion`: none of the plan's runs;
- `from-current`: the named head is the branch's head on `origin`;
- `something-to-promote`;
- `merge-commits-allowed`, `landing-ready`, and `promotion-name-free`.

#### Scenario: The branch moved after review
- **WHEN** a candidate lands on the integration branch after the owner opened the Promote dialog, and the owner confirms
- **THEN** Promote is refused as `from-current`, naming the new head, and nothing is created

#### Scenario: Nothing to promote
- **WHEN** the default branch already contains the integration branch's head
- **THEN** Promote is refused as `something-to-promote`

#### Scenario: Merge commits are disabled
- **WHEN** the repository does not allow merge commits
- **THEN** Promote is refused as `merge-commits-allowed`, naming the repository setting

### Requirement: Promotion works whatever the plan's state
Promote SHALL NOT require the plan to be open, so the owner can promote after the plan completed. Promotion SHALL NOT change the plan's state, revisions, or tasks. A promotion of a cancelled plan SHALL carry only the changes that landed before the cancellation.

#### Scenario: Promoting a completed plan
- **WHEN** every change of a plan has landed on its integration branch, the plan has completed, and the owner promotes
- **THEN** the promotion runs, and the plan stays completed

#### Scenario: Promoting part of a cancelled plan
- **WHEN** the owner cancelled a plan after two of its changes landed on the integration branch, then promotes it
- **THEN** the promotion carries those two changes, and the plan stays cancelled

### Requirement: A promotion is built on its own branch and pull request
Kawai SHALL create the promotion branch `<integration branch>--promote-<n>` on `origin` at the named head as a new ref, refused if the name exists. It SHALL then open a pull request from that branch into the default branch, naming the plan, the integration branch, and the head. Kawai SHALL NOT write the integration branch during a promotion, except to fast-forward it after the merge.

#### Scenario: Promote opens a pull request
- **WHEN** the human promotes `wave-c/integration` at commit I for the first time
- **THEN** Kawai creates `wave-c/integration--promote-1` at I and opens a pull request from it into the default branch

#### Scenario: The integration branch is untouched while verifying
- **WHEN** the promotion's branch is brought up to date with the default branch
- **THEN** only the promotion branch receives the merge, and the integration branch stays at I

### Requirement: The promotion is brought up to date and verified on its exact head
When the promotion branch lacks the default branch's head, Kawai SHALL predict conflicts first, and a conflict SHALL fail the promotion as `promotion-conflict`, naming the files. Otherwise GitHub SHALL merge the default branch into the promotion branch, pinned to its head, and the new head SHALL pass the clean-merge check of direct landing. CI SHALL then run on the promotion's exact head under the floor and CI rules, including the one rerun and the flaky rule.

#### Scenario: A conflict with the default branch
- **WHEN** a file changed on the integration branch was also changed on the default branch
- **THEN** the promotion fails as `promotion-conflict`, naming the file, and nothing is merged

#### Scenario: A flaky check
- **WHEN** a floor check fails on the promotion's head and passes on its one rerun
- **THEN** the check is shown as flaky for the promotion, and the promotion continues to its merge

#### Scenario: CI fails on the combination
- **WHEN** CI fails on the promotion's head and fails again on its rerun
- **THEN** the promotion fails as `ci-failed`, naming the checks, and nothing is merged

### Requirement: Kawai merges the promotion with a merge commit on its verified head
Immediately before merging, Kawai SHALL read the default branch's head again. When the promotion's head no longer contains it, Kawai SHALL return the promotion to the up-to-date step. After the third such move the promotion SHALL fail as `target-moved`. Kawai SHALL merge with a merge commit, whatever the team's merge method, pinned to the verified head, so the default branch contains every integration commit.

#### Scenario: The default branch moves once
- **WHEN** another pull request merges into the default branch while the promotion's CI runs
- **THEN** the promotion is brought up to date again, CI runs on its new head, and the promotion merges once that passes

#### Scenario: The default branch keeps moving
- **WHEN** the default branch moves for the third time before the promotion can merge
- **THEN** the promotion fails as `target-moved`, and nothing is merged

#### Scenario: Squash teams still keep the history
- **WHEN** the team's merge method is `squash` and a promotion merges
- **THEN** it merges with a merge commit, and the default branch contains each landed candidate's commit

### Requirement: A merged promotion is recorded and fast-forwards the integration branch
After the merge, Kawai SHALL record the promotion's merge commit, verified head, and the landed candidates it carried. It SHALL then fast-forward the integration branch to the verified head, never forced, so later work starts from it. If the integration branch's head is no longer an ancestor of the verified head, Kawai SHALL leave the branch as it is and record why.

#### Scenario: Later work starts from the promotion
- **WHEN** a promotion of head I merges with verified head P
- **THEN** the integration branch moves to P, and the next change of the plan is provisioned from P

#### Scenario: A branch moved during the promotion
- **WHEN** the owner pushed to the integration branch while the promotion ran
- **THEN** the promotion is recorded as merged, the branch is left as it is, and the promotion says why it was not fast-forwarded

### Requirement: A failed promotion merges nothing and keeps its evidence
A promotion that fails SHALL merge nothing, leave the integration branch unchanged, and keep its branch, pull request, CI, and steps. It SHALL record one outcome:
- `promotion-conflict`, `ci-failed`, `ci-missing`, or `ci-timeout`;
- `target-moved`;
- `effect-failed` or `effect-unknown`;
- `pr-closed`.

A later Promote SHALL build a new promotion.

#### Scenario: A failure keeps its evidence
- **WHEN** a promotion fails as `ci-failed`
- **THEN** its pull request, CI runs, and steps stay readable in plan detail, and the integration branch is unchanged

#### Scenario: Promoting again
- **WHEN** the owner promotes again after a failed promotion
- **THEN** Kawai creates `<integration branch>--promote-2` and a new pull request, and the failed promotion stays as it was

### Requirement: The owner cancels a running promotion
The human SHALL be able to cancel a running promotion with a reason under a command id. No new step SHALL start. A running step SHALL settle and be recorded, and a merge that completed SHALL finish the promotion as merged. The promotion branch and pull request SHALL be kept.

#### Scenario: Cancel while CI runs
- **WHEN** the owner cancels a promotion while its CI runs
- **THEN** the promotion finishes as cancelled with the reason, nothing is merged, and its branch and pull request are kept

#### Scenario: Cancel during the merge
- **WHEN** the owner cancels a promotion while its merge is running, and the merge completes
- **THEN** the promotion finishes as merged, and the cancellation is recorded as having come too late

### Requirement: A promotion holds the team's landing slot
From its up-to-date step until it finishes, a promotion SHALL hold the team's landing slot. While it updates, verifies, or merges, no change of any plan SHALL land through it. A promotion waiting for the slot SHALL show which change holds it, and a change waiting for it SHALL show the promotion.

#### Scenario: A direct landing waits for the promotion
- **WHEN** another plan's direct change passes while a promotion's CI runs
- **THEN** the change waits to land, showing that the promotion holds the landing slot

#### Scenario: A promotion waits for a landing
- **WHEN** the owner promotes while another plan's change holds the landing slot
- **THEN** the promotion waits before its up-to-date step, showing that change, and continues once the slot is free

### Requirement: Promotion steps are recorded effects
Each promotion step that writes to `origin` or GitHub SHALL be a recorded effect, retried with backoff on a transient failure, and inspected before it is repeated when its outcome was not recorded, as for execution effects. A step that cannot be decided SHALL fail the promotion as `effect-unknown`.

#### Scenario: A restart after the merge
- **WHEN** the server restarts after the promotion's merge was requested but before its outcome was recorded
- **THEN** Kawai reads the pull request, finds it merged, and records the promotion without merging again

#### Scenario: An unreachable GitHub
- **WHEN** opening the promotion's pull request fails three times because GitHub cannot be reached
- **THEN** the promotion fails as `effect-failed`, with the error, and nothing is merged

### Requirement: The Plans view offers promotion
Plan detail SHALL offer **Promote to `<default branch>`** while the plan's integration branch has something to promote and nothing of the plan runs. Its dialog SHALL show the preconditions' standing, the head it pins, the landed changes it carries, and commits made outside Kawai. Each promotion SHALL show its steps, pull request, CI, moves, and outcome, with **Cancel promotion** while it runs. Every control SHALL disable while disconnected.

#### Scenario: The dialog shows what it carries
- **WHEN** the owner opens **Promote to `master`** for a branch with three landed candidates, one with a commit made outside Kawai
- **THEN** the dialog lists the three changes, flags that commit, and names the head it pins

#### Scenario: A refusal shows inline
- **WHEN** the owner confirms Promote and `no-execution` fails
- **THEN** the dialog shows the refusal naming `no-execution`, and no promotion exists
