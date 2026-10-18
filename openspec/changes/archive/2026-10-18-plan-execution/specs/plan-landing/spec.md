# Spec Delta

## Purpose

Defines how Kawai lands a plan's changes. Before Start it probes the repository and GitHub. It pushes results without force, keeps one pull request per change, and reads and reruns CI. It brings each branch up to date with its base, merges one change at a time with the reviewed head pinned, records a landing fact, and removes the worktree when that is safe. Every external step is recorded before it runs and inspected before it is ever repeated.

## ADDED Requirements

### Requirement: The landing probe checks the repository before Start
Start's `landing-ready` entry SHALL pass only when `git` runs in the main checkout, `origin` is a GitHub repository that an authenticated `gh` can read, the base branch the landing mechanism names can be landed on there, and every floor check run in CI is mapped. It SHALL also need that no worktree, local branch, or `origin` branch carries a change's name unless an execution of the plan created it. The probe SHALL change nothing.

#### Scenario: No GitHub origin
- **WHEN** the main checkout's `origin` is not a GitHub repository
- **THEN** Start is refused as `landing-ready`, naming the remote

#### Scenario: A branch left from hand work
- **WHEN** `origin` has a branch named like one of the plan's changes that no execution of the plan created
- **THEN** Start is refused as `landing-ready`, naming the branch, and the branch is left untouched

### Requirement: Kawai pushes without force, only to branches its executions created
Kawai SHALL push a round's commit to the change's branch on `origin` as a fast-forward. It SHALL never force a push, and SHALL push only to branches an execution of the plan created, never to the repository's default branch. A push that `origin` rejects because the branch moved SHALL stop the change as `effect-failed`, naming the remote head.

#### Scenario: A moved branch is never overwritten
- **WHEN** the change's branch on `origin` has a commit that the round's commit does not contain
- **THEN** nothing is forced, and the change stops as `effect-failed`, naming the remote head

#### Scenario: An implementer already pushed the commit
- **WHEN** the implementer pushed the result's commit itself before Kawai's push
- **THEN** Kawai records that `origin` already holds the commit and the round continues

### Requirement: Each change has one pull request
Kawai SHALL reuse the open pull request from the change's branch to the base branch, or open one naming the plan, its revision, the change, and the task. It SHALL record the pull request's number and link and whether Kawai opened it, and SHALL never open a second one while one is open. A pull request closed without merging SHALL stop the change as `pr-closed`; Retry SHALL open a new one.

#### Scenario: Rounds share the pull request
- **WHEN** a change's second round is gated
- **THEN** the first round's pull request is reused and no second one is opened

#### Scenario: A pull request closed by hand
- **WHEN** the human closes a change's pull request without merging it
- **THEN** the change stops as `pr-closed`, and nothing more is pushed for it until Retry

### Requirement: Kawai reads CI evidence for the round's commit
Kawai SHALL read the checks GitHub reports for the round's commit about once a minute, recording each check's name, conclusion, link, and run. The change SHALL stop as `ci-missing` when no check is reported 30 minutes after the push, or when every reported check has finished and a floor check is still uncovered. It SHALL stop as `ci-timeout` when a check is still pending 3 hours after the push. A CI stop SHALL cost no fix round.

#### Scenario: CI never starts
- **WHEN** no check is reported for the pushed commit 30 minutes after the push
- **THEN** the change stops as `ci-missing`, and no fix round is counted

#### Scenario: A floor check never reports
- **WHEN** every reported check has finished but none covers the mapped unit-test check
- **THEN** the change stops as `ci-missing`, naming the unit-test floor check

### Requirement: Kawai reruns failed checks through GitHub
For a round's single rerun, Kawai SHALL ask GitHub to rerun the failed jobs of each workflow run with a failed check, and read the new runs for the same commit. A failed check that GitHub cannot rerun, such as a commit status or another app's check, SHALL fail the round without a rerun.

#### Scenario: A rerun keeps both runs
- **WHEN** a workflow's unit-test job fails
- **THEN** Kawai requests one rerun of that run's failed jobs, and the round records the failed outcome and the rerun's outcome

#### Scenario: A status cannot be rerun
- **WHEN** a commit status reported by another service fails
- **THEN** the round fails without a rerun, naming that status

### Requirement: Changes land one at a time per team
Kawai SHALL land at most one change per team at a time. Among the changes ready to merge, the slot SHALL go to them in the order their rounds passed. A change waiting to land SHALL show which change holds the landing slot. A change that leaves landing without merging, for any reason, SHALL free the slot.

#### Scenario: Two changes pass together
- **WHEN** two changes' rounds pass a minute apart
- **THEN** the first to pass lands first, and the second shows that the first holds the landing slot

#### Scenario: A conflict frees the slot
- **WHEN** the landing change's base merge conflicts
- **THEN** the change leaves the landing slot, and the next waiting change takes it

### Requirement: A landing change is brought up to date with its base
Before merging, the change's branch SHALL contain the base branch's current head. If it does not, Kawai SHALL have GitHub merge the base into the pull request's branch, pinned to the head whose round passed. The new head SHALL carry the review verdict only as a clean base merge: its parents are that head and a commit of the base branch, and its tree is their clean merge. CI SHALL then run on the new head. Any other new head SHALL return the change as an update attempt.

#### Scenario: A clean base merge keeps the review
- **WHEN** another change landed after this change's review passed, and the base merges cleanly
- **THEN** Kawai updates the branch, CI runs on the merge commit, and the review is carried with that recorded, with no new review requested

#### Scenario: CI fails after the base merge
- **WHEN** CI fails on the merge commit, and fails again when rerun
- **THEN** the round fails, and the change gets a fix attempt continuing from the merge commit

#### Scenario: The branch moves during the update
- **WHEN** someone pushes another commit to the change's branch while GitHub updates it, so its new head is not a clean base merge
- **THEN** no verdict is carried, the change leaves the landing slot, and an update attempt continuing from the branch's head is dispatched

### Requirement: A conflicting base merge returns the change as an update attempt
When GitHub cannot merge the base into the change's branch, Kawai SHALL dispatch an update attempt to the implementing group, naming the base head to merge and the conflicting files. The update attempt's result SHALL be gated as a new fix round with its own CI and review. A verdict SHALL NOT carry over a merge the implementer resolved.

#### Scenario: A conflict with a landed change
- **WHEN** the base's new head conflicts with the change's branch
- **THEN** an update attempt is dispatched naming the base head, and the change shows it is implementing an update

#### Scenario: An update is reviewed again
- **WHEN** the update attempt's result is submitted
- **THEN** its round runs CI and requests a new review, and the earlier verdict does not count

### Requirement: Acceptance conditions are resolved before any landing
Before merging a change, each `acceptance` condition carried in the validation report the execution rested on SHALL be resolved by an owner decision. While one is unresolved, the change SHALL wait without holding the landing slot and show the condition.

#### Scenario: An open condition holds the merge
- **WHEN** a change's round passes while a carried acceptance condition is unresolved
- **THEN** the change waits before merging, quoting the condition, and nothing is merged

#### Scenario: Resolving the condition lets it land
- **WHEN** the owner resolves the carried acceptance condition
- **THEN** the waiting change takes the next landing slot

### Requirement: Kawai merges with the reviewed head pinned
Immediately before merging, Kawai SHALL read the base head again and return the change to the up-to-date step when the branch no longer contains it. Kawai SHALL merge the change's pull request with the team's merge method, pinned to the head whose round passed or was carried, so GitHub refuses the merge if the branch moved. A refused merge SHALL stop the change as `effect-failed` with GitHub's message, and nothing SHALL be merged.

#### Scenario: The reviewed head is merged
- **WHEN** a change's round passed on commit C and its branch is up to date
- **THEN** Kawai merges the pull request pinned to C, with a merge commit unless the team's merge method says otherwise

#### Scenario: A moved head is not merged
- **WHEN** someone pushes to the change's branch after its round passed
- **THEN** GitHub refuses the pinned merge, nothing is merged, and the change stops as `effect-failed`, naming both heads

#### Scenario: The base moves before the merge
- **WHEN** a pull request outside the plan merges into the base branch after the change's round passed on an up-to-date head
- **THEN** Kawai does not merge yet, brings the branch up to date again, and merges only after CI passes on the new head

### Requirement: A landing fact records each merge
Each merged change SHALL get exactly one landing fact for the plan. It records the execution, the pull request, the merged head, the base head it was verified against, the merge commit, whether the merge commit's tree is the merged head's tree, and the time. Landing facts SHALL be immutable and outlive later revisions and executions. Kawai SHALL then accept the landed result as the task's creator, which closes the task. Base-branch CI after the merge SHALL be evidence only.

#### Scenario: Landing closes the task
- **WHEN** a change's merge completes
- **THEN** its landing fact is recorded, its task is done with Kawai's acceptance of the landed result, and its spawned members are released once ready

#### Scenario: The base branch fails after landing
- **WHEN** the base branch's CI fails on the merge commit
- **THEN** the failure is shown beside the landing fact, and the change stays landed

#### Scenario: A merge onto a base that moved at the last moment
- **WHEN** the base branch moves between Kawai's last read and GitHub's merge
- **THEN** the landing fact records that the merge commit's tree is not the verified head's tree, and plan detail flags the landing

### Requirement: A landed change's worktree is removed only when safe
After a change lands, Kawai SHALL remove its worktree only when the worktree is clean and no live session's resolved worktree is it. It SHALL never force the removal, and SHALL keep the branch. Otherwise it SHALL keep the worktree, show why, and try again when that changes.

#### Scenario: A clean worktree is removed
- **WHEN** a landed change's worktree is clean and its spawned members have been released
- **THEN** Kawai removes the worktree and keeps the branch

#### Scenario: A live session keeps the worktree
- **WHEN** a session created by the human still runs in a landed change's worktree
- **THEN** the worktree is kept, and the change's row names the session holding it

### Requirement: Every external step is a recorded effect
Each worktree creation, push, pull request opening, rerun, branch update, merge, and worktree removal SHALL be recorded as an effect before it runs, under a key unique to its change and step, with its command and outcome. A transient failure SHALL be retried with backoff at most three times, then stop the change as `effect-failed`. Each change's effects SHALL be readable in plan detail.

#### Scenario: An unreachable GitHub is retried
- **WHEN** a push fails because GitHub cannot be reached
- **THEN** it is retried with backoff, and after the third failure the change stops as `effect-failed` with the error

#### Scenario: Effects are visible
- **WHEN** the human expands a change's row in plan detail
- **THEN** each of its effects shows with its step, command, outcome, and time

### Requirement: An unknown outcome is inspected, never repeated blindly
When an effect's outcome was not recorded, Kawai SHALL inspect before acting: the remote branch for a push, the pull requests from the change's branch for opening one, the run's attempts for a rerun, the pull request's head for a branch update, its state and merge commit for a merge, and the worktree list for worktree steps. A step found done SHALL be recorded done, one found not done SHALL run again, and one that cannot be decided SHALL stop the change as `effect-unknown`.

#### Scenario: A merge that completed during a restart
- **WHEN** the server restarts after a merge was requested but before its outcome was recorded
- **THEN** Kawai reads the pull request, finds it merged, and records the landing fact with its merge commit, without merging again

#### Scenario: An undecidable outcome stops the change
- **WHEN** a merge's outcome was not recorded and the pull request cannot be read after retries
- **THEN** the change stops as `effect-unknown`, naming the merge, and nothing is repeated until Retry

### Requirement: Integration-branch landing waits for its mechanism
Start SHALL be refused as `landing-mode-supported` for a plan whose landing mode is `integration-branch` while no landing mechanism for that mode exists. A landing mechanism SHALL probe the repository, name the base a change provisions from and merges onto, and land a passed change, producing a landing fact. A change's base branch SHALL be the one its mechanism names. Direct landing SHALL be the one mechanism this capability provides, with the repository's default branch as base.

#### Scenario: Integration-branch refused
- **WHEN** the human starts a plan whose landing mode is `integration-branch`
- **THEN** Start is refused as `landing-mode-supported`, naming the mode

#### Scenario: Direct landing
- **WHEN** the human starts a plan whose landing mode is `direct` and every other precondition passes
- **THEN** the execution records `direct` and lands each change on the base branch through its pull request
