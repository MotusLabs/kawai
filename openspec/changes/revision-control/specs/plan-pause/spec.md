# Spec Delta

## Purpose

Lets the plan's owner pause held work at a safe point. Kawai asks each holder to stop and save a durable checkpoint, pushes that checkpoint to the change's branch, and records Paused only once the work is on `origin` and the holder has stopped. The owner then chooses, per change, to continue, adapt, restart, or stop.

## ADDED Requirements

### Requirement: The owner pauses the work a hold covers
The human SHALL be able to pause the work of an active hold of a plan with a running execution, with a deadline, under a command id. The targets SHALL be the held changes whose current stage is an agent-held attempt or review. In the same transaction Kawai SHALL send each target's holder one urgent direct system mail on the change's task, tagged `plan-pause`, asking it to stop at a safe point. A replay SHALL send nothing again.

#### Scenario: Two developers are asked to pause
- **WHEN** the owner pauses a hold covering two changes whose developers hold their attempts
- **THEN** one pause with two targets exists, each developer has one urgent `plan-pause` mail, and a resend of the command creates no second pause or mail

#### Scenario: Kawai-held steps are not targets
- **WHEN** a held change is waiting for CI with no agent holder
- **THEN** the pause lists it as having no active work, and no mail is sent for it

### Requirement: An unclaimed instruction is withdrawn
When a target's instruction or review handoff is still queued or awaiting a request at the pause, Kawai SHALL supersede it through reassignment's stop branch, cancelling the mail, and record the target Paused with no checkpoint. The change SHALL NOT stop as `instruction-failed`. An instruction still spawning SHALL get its pause mail once its claim is recorded.

#### Scenario: A queued instruction
- **WHEN** the owner pauses while a held change's fix instruction is still queued
- **THEN** the mail is cancelled, the assignment reads superseded, the target is Paused, and the change is not stopped

#### Scenario: A spawning instruction
- **WHEN** a held change's instruction is starting an agent at the pause
- **THEN** the target reads Pausing as starting, and the pause mail is sent once the new member claims the instruction

### Requirement: Holders record checkpoints through task_checkpoint
The `task_checkpoint` tool SHALL let the claimant of a Pausing attempt target record a checkpoint: a commit, summary, unfinished actions, errors and tests, and next steps. It SHALL refuse a commit that is not the change branch's head, a worktree with uncommitted or untracked files, a commit lacking the branch head on `origin`, and callers that are not a Pausing target's claimant. Kawai SHALL push the commit as a `push-checkpoint` effect, never forced.

#### Scenario: A clean checkpoint
- **WHEN** the paused developer commits everything and calls `task_checkpoint` with that commit and next steps
- **THEN** the checkpoint is recorded and a `push-checkpoint` effect pushes the commit to the change's branch on `origin`

#### Scenario: Untracked files are refused
- **WHEN** the developer calls `task_checkpoint` with an untracked file in the worktree
- **THEN** the call is refused listing the file, and no checkpoint exists

#### Scenario: No pause, no checkpoint
- **WHEN** a developer whose change is not being paused calls `task_checkpoint`
- **THEN** the call is refused as `no-pause-requested`

### Requirement: Paused is recorded only when work is safe and the holder has stopped
A target SHALL read Pausing, with its causes, until its work is on `origin` and its holder is ready under member release's readiness. Its work is on `origin` when its newest checkpoint's push is done, a result round it submitted was pushed, or it is a review. Only then SHALL Kawai record Paused. A holder killed with no pushed checkpoint SHALL read Checkpoint lost. Kawai SHALL NOT show Paused otherwise.

#### Scenario: Checkpoint pushed, holder still busy
- **WHEN** the checkpoint's push is done but the developer's turn is still running
- **THEN** the target reads Pausing as busy, and Paused is recorded only after the turn ends with nothing else outstanding

#### Scenario: A result instead of a checkpoint
- **WHEN** the paused developer submits a result and its round is pushed, then goes idle
- **THEN** the target is recorded Paused with a result checkpoint

#### Scenario: The holder is killed first
- **WHEN** the holder is killed before any checkpoint reached `origin`
- **THEN** the target reads Checkpoint lost, and only Restart or Stop is offered

### Requirement: Pausing never resolves a pending request
A pause SHALL NOT approve, deny, or answer a holder's pending approval or question. The pause mail SHALL follow the shipped urgent direct semantics, interrupting only after pending requests resolve. A target whose holder has a pending request SHALL read Pausing with the cause `request`. A passed pause deadline SHALL raise the `plan-pause-overdue` attention item and SHALL NOT kill or archive anyone.

#### Scenario: Pause beside a pending approval
- **WHEN** the owner pauses a change whose developer awaits a tool approval
- **THEN** the approval card stays pending, the target reads Pausing because of the request, and no Paused is recorded

#### Scenario: The pause deadline passes
- **WHEN** a target is still Pausing at the pause deadline
- **THEN** a `plan-pause-overdue` item asks the owner to unblock the holder, and the holder's session is untouched

### Requirement: Pause state survives restart
Pauses, targets, checkpoints, and recorded Paused states SHALL be durable. After a restart Kawai SHALL re-derive Pausing from stored rows, inspect an unknown `push-checkpoint` effect before anything else for its change, and leave the pause mail to shipped receipt recovery. It SHALL NOT resume a holder or record Paused without the stored facts.

#### Scenario: Restart with a paused execution
- **WHEN** the server restarts while a target is Paused
- **THEN** the same execution, attempt, checkpoint, and Paused target exist, and Continue afterwards creates no new attempt

#### Scenario: Restart mid-pause
- **WHEN** the server restarts after the pause mail was recorded and before any checkpoint
- **THEN** the target reads Pausing with its causes, and no Paused is recorded and no resume mail is sent

### Requirement: The owner chooses how paused work goes on
For a Paused or Checkpoint lost target the human SHALL choose, under a command id: Continue, sending its holder resume mail and creating no attempt; Adapt, publishing the task's next revision with notify, which returns the change for re-evaluation; or Restart, superseding the held assignment and dispatching a new attempt carrying the checkpoint. Stop is the cancel. Each dispatch SHALL wait for the change's holds.

#### Scenario: Continue
- **WHEN** the owner continues a Paused attempt target
- **THEN** its holder gets one `plan-resume` mail naming the checkpoint commit, and no attempt is created

#### Scenario: Adapt
- **WHEN** the owner adapts a Paused target with a new direction
- **THEN** the task's next revision is published with its notice, and a fix attempt naming that revision is dispatched once the change is not held

#### Scenario: Continue to a killed holder
- **WHEN** the owner continues a target whose holder was killed after its checkpoint was pushed
- **THEN** Continue is refused as `holder-gone`, and Restart remains available

### Requirement: Pauses are visible to the owner and agents
The plan detail and `plan_get` SHALL list each pause with its deadline and targets: state, causes, holder, checkpoints, and decision. Supervision SHALL name `pausing` and `paused` as a target change's cause. A Paused or lost target with no decision SHALL raise the `plan-checkpoint-decision` attention item until it is decided or the execution finishes.

#### Scenario: A paused change's cause
- **WHEN** a target is Paused and undecided
- **THEN** its change's supervision cause is `paused` and a `plan-checkpoint-decision` item names the change

#### Scenario: Stop clears decisions
- **WHEN** the owner stops the execution while targets await decisions
- **THEN** the targets read cancelled, the pause is closed, and their items clear
