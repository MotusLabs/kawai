# Spec Delta

## MODIFIED Requirements

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


## ADDED Requirements

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
