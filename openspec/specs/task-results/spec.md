# task-results Specification

## Purpose
Makes completion and acceptance inspectable: a durable, claimed-labeled result per submission; explicit review/QA/fix handoffs to a role; findings bound to the exact result examined; acceptance under the existing closing rights; and a release-and-hand-off that frees the worktree for the reviewer.

## Requirements

### Requirement: A result records what was delivered, as a claim
Each submitted result SHALL record a summary, a commit or diff reference, the worktree the work happened in, the tests performed with their outcomes, known limitations, the task revision pinned at submission, and the submitting agent. Test outcomes are the submitter's claims: wherever shown they SHALL be labeled claimed, never as verified evidence. Each result has its own identity; a new submission supersedes the task's previous outstanding result, and earlier results remain readable.

#### Scenario: Result shows its evidence
- **WHEN** a developer submits a result naming a commit, the tests run, and known limitations
- **THEN** the task's Results section shows the summary, the commit reference, the worktree, each test with its outcome, the limitations, the pinned task revision, and the submitter

#### Scenario: Claims are labeled, not verified
- **WHEN** a submitted result claims its tests pass
- **THEN** the outcomes are displayed labeled as claimed, and nothing presents them as verified evidence

#### Scenario: Fixes supersede without erasing
- **WHEN** a new result is submitted after fixes
- **THEN** the new result becomes the task's outstanding result and the earlier result remains readable with its own findings

### Requirement: Agents submit results with a tool
Any team member SHALL be able to submit a result for a task of its team with the `task_submit_result` tool, allowed without an approval card. The server SHALL pin the task's current revision and worktree into the record at submission. Submission SHALL append a journal note naming the result and SHALL NOT change the task's status.

#### Scenario: Developer submits a result
- **WHEN** a developer working the task calls `task_submit_result` with a summary and a commit reference
- **THEN** the result is stored pinned to the task's current revision and worktree, a journal note names it, and the task's status is unchanged

#### Scenario: Submission needs no approval
- **WHEN** `task_submit_result` runs under a manual approval policy
- **THEN** the tool is allowed without an approval card, like the other team task tools

### Requirement: Handoffs are explicit role assignments
Task detail SHALL offer **Request review**, **Request QA**, and **Return for
fixes**, recording kind, role, instructions, result, and expected response.
Human handoffs SHALL use keyed task-assignment dispatch with idempotency and
worktree routing. Agents SHALL use `task_handoff` to a group or named session.
A duplicate for the same task, result, and kind SHALL return the outstanding
handoff with a notice and no new dispatch.

#### Scenario: Human requests review
- **WHEN** the human requests review of the outstanding result from task detail
- **THEN** one member of the chosen reviewer role receives instructions carrying the result reference and the expected response

#### Scenario: Double click dispatches one handoff
- **WHEN** the human clicks **Request review** twice with the same request key
- **THEN** exactly one handoff and one instruction exist

#### Scenario: Occupied worktree waits with a reason
- **WHEN** review is requested while the task's worktree is occupied by its spawned developer
- **THEN** the handoff waits and shows the occupancy waiting reason, and nothing is interrupted

#### Scenario: Lead requests QA by tool
- **WHEN** a lead agent calls `task_handoff` with kind `qa` for a result
- **THEN** a QA handoff assignment is dispatched to the named role with the result reference

#### Scenario: A duplicated handoff call dispatches once
- **WHEN** `task_handoff` is retried while the handoff it created is still outstanding
- **THEN** the outstanding handoff is returned with a duplicate notice and no second instruction is dispatched

#### Scenario: Return for fixes dispatches a fix handoff
- **WHEN** findings fail and the requester returns the examined result for fixes to the developer role
- **THEN** a fix handoff carries that result's reference, and its expected response is a new result

#### Scenario: A handoff supersedes the outstanding assignment as the next stage
- **WHEN** a handoff is dispatched while the task has an outstanding assignment
- **THEN** that assignment is superseded through task-assignment's stop branch with a journal line naming the handoff kind, its instruction is cancelled only while queued or awaiting a request, and no reassignment note is sent

### Requirement: Findings are bound to the result examined
Any team member SHALL submit review or QA findings with `task_submit_findings`, naming the exact result examined and a verdict. Findings SHALL apply only to the result they name: a newer result or commit SHALL NOT inherit them. When a newer result supersedes an earlier one, the earlier result and its findings SHALL remain readable with their binding unchanged.

#### Scenario: Findings name the examined result
- **WHEN** a reviewer submits findings for a result
- **THEN** they attach to that result with the reviewer, the verdict, and the time, visible beside it

#### Scenario: A newer commit inherits no approval
- **WHEN** the developer submits a new result after findings were reported on the earlier one
- **THEN** the earlier findings do not approve or transfer to the new result

### Requirement: Accepting a result closes it under existing rights
**Accept result** SHALL be available only to the human or the task's creator, and SHALL close the task as done only under the existing closing rights; a refusal SHALL write nothing. Before closure the UI SHALL show the task's acceptance criteria and any child tasks not done or cancelled. Accepting a result labeled Needs re-evaluation, or closing despite open child work, SHALL require a stated reason that is journaled. A parent SHALL never auto-close when its children finish.

#### Scenario: Contributor cannot accept
- **WHEN** a contributor that is not the creator accepts its result for a human-created task
- **THEN** the action is refused with nothing written, and the task stays open until the human accepts

#### Scenario: Open child work needs a reason
- **WHEN** the human accepts a result while a child task is still open
- **THEN** acceptance requires a stated reason, the reason is journaled, and the child task is untouched

#### Scenario: A finished child never closes its parent
- **WHEN** the last child task's result is accepted and the child closes
- **THEN** the parent task remains open

#### Scenario: An accepted task reopens normally
- **WHEN** the human reopens a task whose result was accepted
- **THEN** the task is open again, the result remains accepted, and no acceptance is cleared

#### Scenario: Flagged result needs a reason
- **WHEN** the human accepts a result labeled Needs re-evaluation
- **THEN** acceptance requires a stated reason and the reason is journaled

### Requirement: Older-revision results are labeled Needs re-evaluation
A result whose pinned revision is older than the task's current revision SHALL be labeled Needs re-evaluation wherever results are shown. The label SHALL be derived at read time by comparing the pinned revision with the task's current revision number: a new task revision triggers it and nothing else does. The label SHALL NOT appear on results pinned to the current revision.

#### Scenario: Amendment flags the result
- **WHEN** the task's direction or acceptance criteria are amended after a result was submitted
- **THEN** that result is labeled Needs re-evaluation in the Results section

#### Scenario: A fresh result carries no label
- **WHEN** a result is submitted at the task's current revision
- **THEN** it is shown without the Needs re-evaluation label

### Requirement: Release worktree and hand off
Task detail SHALL offer **Release worktree and hand off** for a task with a worktree and an outstanding result. It SHALL archive its live spawned members via the release readiness and archive path — never kill — keeping results and transcripts, then dispatch the review handoff, reusing one already standing. It SHALL be refused with an actionable reason while a member is mid-turn, awaits a request, holds mail, or runs a background worker. Other live sessions in the worktree SHALL be shown first.

#### Scenario: Release hands the worktree to review
- **WHEN** the human releases the worktree after the developer's turn has ended and its requests resolved
- **THEN** the developer is archived, its result and transcript persist, and one reviewer receives the result reference

#### Scenario: Busy developer is refused
- **WHEN** release is attempted while the developer is mid-turn
- **THEN** the action is refused with an actionable reason, and nothing is archived or dispatched

#### Scenario: Background worker holds the release
- **WHEN** release is attempted while the developer is idle but a background worker it started is still running
- **THEN** the action is refused naming the worker, and nothing is archived or dispatched

#### Scenario: Pending approval is refused, then one retry succeeds
- **WHEN** release is attempted while the developer awaits an approval, the request is resolved, the turn ends, and the human retries
- **THEN** the first attempt is refused naming the pending request, and the retry performs exactly one release and one dispatch

#### Scenario: Concurrent manual sessions are shown
- **WHEN** another live manual session works in the task's worktree
- **THEN** release shows it before dispatching, without claiming the cap prevents concurrent edits

#### Scenario: A review already queued is not doubled
- **WHEN** review was requested while the developer occupied the worktree, and the human then releases the worktree
- **THEN** the developer is archived and the queued review proceeds in the freed worktree; no second review is dispatched

### Requirement: Results persist and remain inspectable
Results, their findings, and acceptance SHALL persist across server restart and SHALL remain readable after any submitting or reviewing session is archived or killed, with the submitter named. Task detail SHALL show a Results section listing every result with its findings, and the task record agents read SHALL include the task's results and findings.

#### Scenario: Restart preserves results
- **WHEN** the server restarts after results and findings were submitted and one result accepted
- **THEN** every result, its findings, and the acceptance are unchanged

#### Scenario: Killed submitter stays named
- **WHEN** the submitting agent's session is killed
- **THEN** its result remains readable with the submitter named

#### Scenario: Agents read the results
- **WHEN** a team member reads the task with `task_get`
- **THEN** the task's results and their findings are included

### Requirement: Results for execution tasks are checked at submission
For a task of a change a running execution owns, `task_submit_result` SHALL refuse, writing nothing and naming the fix:
- a result without a commit;
- a commit not on the change's branch;
- a commit that does not contain the branch's head on `origin`, with guidance to merge `origin/<branch>` first;
- any result while Kawai is updating or merging the branch.

Every other stage, including landing, SHALL accept results. A refused result SHALL cost no round.

#### Scenario: A diff-only result
- **WHEN** a dev submits a result with only a diff for an execution task
- **THEN** the result is refused naming the missing commit, and no result or round exists

#### Scenario: A commit behind the published head
- **WHEN** the branch on `origin` has a base-merge commit that the submitted commit does not contain
- **THEN** the result is refused with guidance to merge `origin/<branch>` first, and no round is counted

#### Scenario: A result during the merge
- **WHEN** a dev submits a result while Kawai's merge of the change is running
- **THEN** the result is refused naming the merge, and no round is counted

### Requirement: Kawai owns the handoffs of a running change
While a running execution owns a change, `task_handoff`, the human's handoffs, and **Release worktree and hand off** on its task SHALL be refused, naming the execution and pointing to `task_submit_findings`. Kawai SHALL request reviews and return fixes itself. Findings SHALL still be accepted and recorded.

#### Scenario: A reviewer returns fixes by tool
- **WHEN** a reviewer calls `task_handoff` with kind `fix` on an execution task
- **THEN** the call is refused with the guidance and nothing is dispatched, while its `fail` verdict through `task_submit_findings` returns the change

#### Scenario: The human requests review by hand
- **WHEN** the human chooses **Request review** on the task of a change a running execution owns
- **THEN** the handoff is refused naming the execution, and nothing is dispatched

### Requirement: Agent handoffs support explicit recipient kinds
The `task_handoff` tool SHALL accept `target_kind` as `group` or `session`,
with `target` naming that kind's identifier. Omission SHALL mean `group`,
including when the identifier resembles a session id. Review, QA, and fix
handoffs SHALL preserve their result reference, assignment history, and
supersession semantics for either recipient kind.

#### Scenario: Existing group calls remain compatible
- **WHEN** an agent calls `task_handoff` with `target: reviewers` and no
  `target_kind`
- **THEN** it dispatches to the reviewers group with the existing role routing

#### Scenario: Lead selects one reviewer
- **WHEN** the Lead requests review with `target_kind: session`, a same-team
  reviewer session id, and a result id, with no equivalent standing handoff
- **THEN** one handoff assignment and one task instruction target that session,
  carrying the result and expected response without selecting another member

#### Scenario: Fixes return to a named developer
- **WHEN** the Lead dispatches a fix handoff to a named eligible developer
  session with the examined result id
- **THEN** its assignment names that session, its instruction references that
  result, and the expected response is a new result

#### Scenario: Invalid recipient syntax writes nothing
- **WHEN** a caller supplies an unsupported `target_kind` or a blank target
- **THEN** the call is refused without creating or superseding an assignment,
  enqueuing mail, or adding a journal entry

### Requirement: Session handoffs use assignment recipient validation
A new session-targeted handoff SHALL require an existing, non-archived session
of the task's team. Invalid recipients SHALL be refused without dispatch or
supersession. Valid recipients SHALL receive ordinary direct task mail:
busyness delays delivery without interruption, worktree differences do not
block dispatch, and dispatch does not spawn, restore, release, or move sessions.

#### Scenario: Invalid session cannot replace current work
- **WHEN** a new session handoff names an unknown, killed, archived, or
  other-team session
- **THEN** it is refused with a recipient error and the existing assignment,
  instruction mail, journal, and session lifecycle remain unchanged

#### Scenario: Busy reviewer receives queued work
- **WHEN** a valid reviewer is busy or awaiting a request at session handoff
- **THEN** its instruction queues for normal direct-mail delivery without
  interruption or fallback to a different reviewer

#### Scenario: Reviewer works in another worktree
- **WHEN** the named same-team reviewer lives outside the task's worktree
- **THEN** dispatch succeeds without spawning or moving a member and the
  instruction carries the task and result context

#### Scenario: Findings answer the claimed session handoff
- **WHEN** the named reviewer claims the handoff and submits findings on its
  referenced result
- **THEN** the findings name that result and handoff, and a later result
  inherits neither those findings nor their approval

### Requirement: Duplicate handoffs expose the standing recipient
While a handoff with the same task, result, and kind stands, an agent call
SHALL return that assignment as a duplicate without dispatch or supersession.
The notice SHALL identify its target kind and id, assignment id, dispatcher,
and state. If the requested target differs in kind or id, the notice SHALL
identify both recipients and state that no reassignment occurred.

#### Scenario: Identical session retry dispatches once
- **WHEN** an agent repeats a session handoff while its earlier handoff stands
- **THEN** the original assignment is returned with a duplicate notice naming
  its recipient and exactly one instruction exists

#### Scenario: Changed session does not silently reassign
- **WHEN** a handoff stands for reviewer A and an agent repeats the same task,
  result, and kind requesting reviewer B
- **THEN** the original handoff is returned and the notice names A and B and
  explicitly states that no reassignment occurred

#### Scenario: Switching target kind does not duplicate a stage
- **WHEN** a group handoff stands and an agent repeats the same task, result,
  and kind with a session target, or the reverse
- **THEN** the standing handoff is returned unchanged and the notice identifies
  the differing target kinds and ids

#### Scenario: A standing handoff survives recipient lifecycle changes
- **WHEN** an equivalent handoff stands and a retry names an invalid or
  subsequently archived session
- **THEN** the call returns the standing handoff with the recipient notice
  before new-dispatch recipient validation, and restores or dispatches nothing

#### Scenario: Failed work can be dispatched again
- **WHEN** the previous handoff has failed or been superseded and no
  equivalent handoff stands
- **THEN** a new call validates the requested recipient and can dispatch a new
  handoff under existing assignment and supersession rules

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
- **THEN** the check records that there is no commit to check

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

#### Scenario: Citations without a commit
- **WHEN** a result that names only a diff reference carries a coverage map
- **THEN** the check marks each citation as unresolved, because there is no commit, and each clause that cites tests as unresolved

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
