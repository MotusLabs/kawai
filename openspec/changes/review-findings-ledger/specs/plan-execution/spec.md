## MODIFIED Requirements

### Requirement: The review follows green CI
Once a round's CI passes, Kawai SHALL hand the result to the change's review group as a review handoff. The handoff SHALL name the result, commit, pull request, acceptance rules, the extra checks to attest, the contract identity, and the findings still blocking, and SHALL ask for structured findings on that result through the findings tool. A text-only submission from the handoff's claimant SHALL be refused.

#### Scenario: The review names what to check
- **WHEN** a round's CI passes
- **THEN** the review group receives a handoff naming the result, its commit, the pull request, the acceptance rules, and the extra checks to attest

#### Scenario: Changes requested fail the round
- **WHEN** the review handoff's claimant submits findings whose derived verdict is `fail` on the result
- **THEN** the round fails and its blocking findings go into the fix attempt's instruction

#### Scenario: A verify review lists the open findings
- **WHEN** a fix round's CI passes and F2 and F3 are blocking
- **THEN** the review handoff names F2 and F3 with their clauses and asks for a disposition of each

#### Scenario: The claimant's text-only findings are refused
- **WHEN** the review handoff's claimant submits text with a `fail` verdict and no structured findings
- **THEN** the submission is refused naming the structured form, and the round still waits

### Requirement: A failed round returns the change for fixes
When a round fails, Kawai SHALL dispatch a fix attempt to the change's implementing group as a handoff. The handoff SHALL carry the failing checks with their links, the blocking findings by id with clause, evidence, and reproduction, the count of other findings, the fix-round count, and the branch head to continue from. A round whose attempt is a fix or update attempt SHALL be a fix round.

#### Scenario: The fix instruction carries the failure
- **WHEN** a round fails on the end-to-end check
- **THEN** the implementing group receives a fix handoff naming the check, its link, and the commit to continue from

#### Scenario: Failed CI skips the review
- **WHEN** a round's CI fails after its rerun
- **THEN** no review handoff is dispatched for that result, and the fix handoff goes to the implementing group

#### Scenario: Only blocking findings are listed
- **WHEN** a round fails with F1 accepted at P1, F2 advisory, and F3 out of contract
- **THEN** the fix handoff lists F1 with its clause, evidence, and reproduction, says two other findings are in `task_get`, and does not list F2 or F3

## ADDED Requirements

### Requirement: An undecided dispute holds the round
A round whose review leaves no blocking finding SHALL wait while a finding of the task is disputed. When every dispute is decided, the round SHALL pass if none was upheld, and otherwise fail with the upheld findings as its blocking findings. The change SHALL show what it waits for.

#### Scenario: The round waits for a dispute
- **WHEN** the review of R2 resolves F1 and F2, and F3 is disputed
- **THEN** the round waits and the change shows it waits on the dispute of F3

#### Scenario: An upheld dispute fails the waiting round
- **WHEN** a round waits only on the dispute of F3, and the dispute is upheld
- **THEN** the round fails, and the fix handoff lists F3

### Requirement: Rejected disputes re-gate a failed round's result
When a round that failed only on its review has every finding that blocked it rejected by a decision on its own dispute, its result is pinned to the task's current revision, and the change has no newer result, Kawai SHALL gate that result again as a new round, keeping its CI and the counted review, with the verdict derived from the ledger, and SHALL close the outstanding fix attempt as answered. It SHALL do so once, after a restart as well.

#### Scenario: A refuted review passes without a new commit
- **WHEN** R1's round failed on F1 alone, the developer disputes F1 without submitting a result, and the Lead rejects the dispute
- **THEN** a new round for R1 passes on its kept CI and review, the fix count resets, and the fix attempt reads answered

#### Scenario: A superseded finding is not a refutation
- **WHEN** R1's round failed on F1 and F2, the dispute of F1 is rejected, and a new task revision supersedes F2
- **THEN** no new round is created for R1, and the change waits for a result pinned to the new revision

#### Scenario: A restart between the decision and the re-gate
- **WHEN** Kawai restarts after the dispute's rejection is recorded and before the new round exists
- **THEN** exactly one new round for R1 is created after the restart

### Requirement: An accepted P0 alerts the Lead role
When a round's review accepts a P0 finding, Kawai SHALL send one message tagged `review-p0` to the plan's Lead role, or record a plan event the owner sees when the plan has none, naming the change, the finding, its clause, and its evidence. The alert SHALL NOT change the round or the fix attempt. An unsupported P0 SHALL send no alert.

#### Scenario: A security finding alerts the Lead
- **WHEN** the review of a change accepts F1 at P0
- **THEN** the Lead role receives one `review-p0` message naming the change, F1, its clause, and its evidence, and the fix attempt is dispatched as usual

#### Scenario: An unsupported P0 does not alert
- **WHEN** a review submits a P0 without evidence
- **THEN** no `review-p0` message is sent and the finding reads unsupported
