# Spec Delta

## ADDED Requirements

### Requirement: Kawai checks a result's commit
After storing a result that names a commit, Kawai SHALL check the commit in the result's worktree and record what it found, with the time, labeled as checked by Kawai:
- whether the commit resolves;
- whether it is the worktree's HEAD, and on which branch;
- whether the worktree is clean;
- whether a full-check pass is recorded for the commit's tree, and under which Bun version.

Kawai SHALL NOT fetch, run tests, or change the worktree.

#### Scenario: A clean, checked commit
- **WHEN** a developer submits a result whose commit is its worktree's HEAD, the worktree is clean, and a full pass is recorded for the commit's tree under the commit's `.bun-version`
- **THEN** the result shows each of these as passing under "Checked by Kawai", and its test list stays labeled claimed

#### Scenario: Unknown commit
- **WHEN** the result's commit does not resolve in the repository
- **THEN** the check records that the commit was not found, and checks nothing else about it

#### Scenario: HEAD moved past the commit
- **WHEN** the worktree's HEAD is two commits ahead of the result's commit on its branch
- **THEN** the check names HEAD and its branch, and says that HEAD is two commits ahead

#### Scenario: Dirty worktree
- **WHEN** the worktree has a modified tracked file and an untracked file that git does not ignore
- **THEN** the check lists both paths as uncommitted

#### Scenario: No recorded pass
- **WHEN** no full pass is recorded for the commit's tree
- **THEN** the check says that no full check passed for this tree

#### Scenario: Pass under another Bun version
- **WHEN** the only recorded pass for the tree ran under a Bun version other than the commit's `.bun-version`
- **THEN** the check shows the pass with both versions, marked as a warning

#### Scenario: Result without a commit
- **WHEN** a result names only a diff reference
- **THEN** the check records that there is no commit to check, and marks each citation of its coverage map as unresolved for that reason

#### Scenario: Worktree removed
- **WHEN** the result's worktree no longer exists
- **THEN** the commit and its tree are checked from the repository, and HEAD and cleanliness are recorded as unknown, with the reason

### Requirement: Kawai checks a result against the base and other open branches
Kawai SHALL check whether the result's commit merges cleanly into origin's default branch as last fetched, naming that base commit and how many of its commits the result lacks.

It SHALL also check the commit against the branch head of each other open task of the team, naming the conflicting files and the files both change. It SHALL skip heads that the base or the result contains, compare at most 30 heads, newest task first, and name at most 20 files in each list, counting the rest.

#### Scenario: Clean against the base
- **WHEN** the commit merges cleanly into the base and lacks three of the base's commits
- **THEN** the check names the base commit, says the merge is clean, and says the result is three commits behind

#### Scenario: Conflict with the base
- **WHEN** the commit conflicts with the base in two files
- **THEN** the check lists both files as conflicting

#### Scenario: Conflict with another open task's branch
- **WHEN** another open task's worktree head conflicts with the commit
- **THEN** the check names that task, its head commit, and the conflicting files

#### Scenario: Shared files without a conflict
- **WHEN** another open task's branch changes a file this result also changes, and the two merge cleanly
- **THEN** the check names the shared file as overlapping, not as a conflict

#### Scenario: Landed or contained heads
- **WHEN** an open task's head is already contained in the base or in the result
- **THEN** that task is not compared

#### Scenario: Other teams
- **WHEN** a task of another team has an open branch
- **THEN** that branch is never compared or named

#### Scenario: More open branches than the cap
- **WHEN** 35 other open tasks of the team have distinct heads that the base and the result do not contain
- **THEN** the check compares the heads of the 30 newest tasks, and counts the 5 it did not compare

### Requirement: Result checks never block or gate
Kawai SHALL record a pending check in the result's own transaction, and SHALL run the check only after that transaction commits. Running a check SHALL NOT delay, fail, or refuse the submission. A check that cannot finish SHALL be recorded as unavailable, with its reason.

Checks SHALL NOT change acceptance, handoffs, findings, task status, execution ownership, or landing. A check still pending when the server stops SHALL run once after startup.

#### Scenario: Git does not answer
- **WHEN** a git call of the check exceeds its timeout
- **THEN** the submission has already succeeded, and the check is recorded as unavailable, naming the timeout

#### Scenario: A failing check does not gate
- **WHEN** a result's check shows a conflict with the base
- **THEN** the result can still be handed off, reviewed, and accepted under the existing rules

#### Scenario: Restart during a check
- **WHEN** the server restarts while a result's check is pending
- **THEN** the check runs after startup and is recorded once

### Requirement: Results can be rechecked
The human and any team member SHALL be able to request a new check of a result. Agents do so with `task_check_result`, which is allowed without an approval card.

Each check SHALL be recorded beside the earlier ones, which stay readable, and the newest SHALL be shown first. A request made while a check of that result is pending SHALL return the pending check instead of starting another.

#### Scenario: Recheck after the base moved
- **WHEN** a team member rechecks a result after the base gained a conflicting commit
- **THEN** a new check records the conflict, and the earlier clean check stays readable

#### Scenario: Recheck while pending
- **WHEN** a recheck is requested while a check of that result is pending
- **THEN** the pending check is returned, and no second check runs

### Requirement: Results carry a coverage map
`task_submit_result` SHALL accept an optional coverage map. Each clause, a spec scenario or a task's verify clause, cites its tests as `` `file` › `title` `` or cites none. The map SHALL be stored with the result as the submitter's claim.

Kawai's check SHALL resolve each citation at the result's commit, and derive each clause's status from them:
- the file exists and holds a test with that literal title;
- when the tree's recorded pass lists its tests, that test ran and passed.

#### Scenario: Citation resolves and ran
- **WHEN** a clause cites a test whose file and title exist at the commit, and the tree's recorded pass lists that test as passed
- **THEN** the check shows the clause as covered by a test that ran and passed

#### Scenario: Cited test does not exist
- **WHEN** a citation names a title that no test in that file has at the commit
- **THEN** the check marks the citation as not found, and the clause as not covered

#### Scenario: Cited test was skipped
- **WHEN** a clause's only citation names a test that the recorded pass lists as skipped
- **THEN** the check marks the citation as not run, and the clause as not covered

#### Scenario: Partly covered clause
- **WHEN** a clause cites two tests, the recorded pass lists the first as passed, and the second does not exist at the commit
- **THEN** the check marks the first citation as ran and passed, the second as not found, and the clause as partly covered

#### Scenario: Record without a test list
- **WHEN** the tree's recorded pass lists no tests, and every citation of a clause exists at the commit
- **THEN** the check marks each citation as found with whether it ran unknown, and the clause as covered with its run unknown

#### Scenario: Declared uncovered
- **WHEN** a clause cites no tests
- **THEN** the check lists the clause as uncovered, by the submitter's own statement

#### Scenario: The map is a claim
- **WHEN** a result carries a coverage map
- **THEN** the map is shown labeled as claimed, and only the citation checks are labeled as checked by Kawai

### Requirement: Reviewers record their own coverage map first
A team member SHALL be able to record its own coverage map for a result with `task_submit_coverage`, allowed without an approval card.

While a session holds a task's outstanding review handoff for a result and has recorded no map for that result, the task record that session reads SHALL withhold the submitter's map of every result of the task, stating how many clauses each has. Once that session has recorded its map, the task record SHALL show the maps and their differences.

#### Scenario: Map withheld from the reviewer
- **WHEN** a reviewer holding the review handoff for a result reads the task before recording its own map
- **THEN** the result shows how many clauses the submitter's map has, and that the map is withheld until the reviewer records its own

#### Scenario: Map shown after recording
- **WHEN** that reviewer records its map with `task_submit_coverage`
- **THEN** its next read shows both maps, with:
  - the clauses only one map names;
  - for each clause, the tests only one side cites;
  - the clauses that one side calls uncovered while the other cites tests for them

#### Scenario: A newer result's map is withheld too
- **WHEN** the submitter submits a newer result while the reviewer holds the review handoff for the earlier one and has recorded no map for it
- **THEN** the newer result's map is withheld from that reviewer as well

#### Scenario: Others see the submitter's map
- **WHEN** the human, or a session without that review handoff, reads the task
- **THEN** the submitter's map is shown

#### Scenario: The handoff carries no map
- **WHEN** a review handoff's instruction is built
- **THEN** it names the result and its commit, and never includes the submitter's map

### Requirement: Checks and coverage maps are kept and read with their results
Checks and coverage maps SHALL persist across server restart. They SHALL remain readable after the submitting or reviewing session is archived or killed.

Task detail SHALL show each result's checks, newest first, and its maps. The task record agents read SHALL include each result's newest check and its maps, except a map withheld from a reviewer.

#### Scenario: Restart keeps checks and maps
- **WHEN** the server restarts after a result was checked and a reviewer recorded a map
- **THEN** the check and both maps are unchanged

#### Scenario: Agents read the checks
- **WHEN** a team member reads the task with `task_get`
- **THEN** each result carries its newest check, the number of earlier checks, and its maps, except a withheld map
