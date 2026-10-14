# Spec Delta

## Purpose

Makes completion and acceptance inspectable: a durable, claimed-labeled result per submission; explicit review/QA/fix handoffs to a role; findings bound to the exact result examined; acceptance under the existing closing rights; and a release-and-hand-off that frees the worktree for the reviewer.

## ADDED Requirements

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
Task detail SHALL offer **Request review**, **Request QA**, and **Return for fixes** as handoffs: assignment records carrying the kind, requested role, instructions, referenced result, and expected response. Human handoffs dispatch under a client request key with task-assignment's idempotency and worktree routing. Agents dispatch with `task_handoff`; while an equivalent handoff (same task, result, kind) is outstanding, a duplicate call returns it with a notice, not a second dispatch.

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
Task detail SHALL offer **Release worktree and hand off** for a task with a worktree and an outstanding result. It SHALL archive the task's live spawned members through the release readiness and archive path — never kill — keeping results and transcripts, then dispatch the review handoff. It SHALL be refused with an actionable reason while a member is mid-turn, awaits a request, holds mail, or runs a background worker. Other live sessions in the worktree SHALL be shown before dispatch.

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
