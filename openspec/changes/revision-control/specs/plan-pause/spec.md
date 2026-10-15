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
The `task_checkpoint` tool SHALL let a Pausing attempt target's claimant record a checkpoint: commit, summary, unfinished actions, errors and tests, and next steps. It SHALL refuse other callers, a commit that is not the head of `refs/heads/<change>` or does not contain the branch's head on `origin`, a worktree with uncommitted or untracked files, and a call while Kawai writes the branch (`updating`, `merging`). Kawai SHALL push the commit as a `push-checkpoint` effect, never forced.

#### Scenario: A clean checkpoint
- **WHEN** the paused developer commits everything and calls `task_checkpoint` with that commit and next steps
- **THEN** the checkpoint is recorded and a `push-checkpoint` effect pushes the commit to the change's branch on `origin`

#### Scenario: Untracked files are refused
- **WHEN** the developer calls `task_checkpoint` with an untracked file in the worktree
- **THEN** the call is refused listing the file, and no checkpoint exists

#### Scenario: Kawai is writing the branch
- **WHEN** the paused developer calls `task_checkpoint` while the change is `updating`
- **THEN** the call is refused naming the step, and no checkpoint exists

#### Scenario: No pause, no checkpoint
- **WHEN** a developer whose change is not being paused calls `task_checkpoint`
- **THEN** the call is refused as `no-pause-requested`

### Requirement: Paused is recorded only when work is safe and the holder has stopped
A target SHALL read Pausing, with its causes, until its work is on `origin` and its holder is ready under member release's readiness. Its work is on `origin` when its newest checkpoint's push is done, a result round it submitted was pushed, or it is a review. Only then SHALL Kawai record Paused. A holder killed before its work reached `origin` SHALL read Pausing as `holder-killed`. Kawai SHALL NOT show Paused otherwise.

#### Scenario: Checkpoint pushed, holder still busy
- **WHEN** the checkpoint's push is done but the developer's turn is still running
- **THEN** the target reads Pausing as busy, and Paused is recorded only after the turn ends with nothing else outstanding

#### Scenario: A result instead of a checkpoint
- **WHEN** the paused developer submits a result and its round is pushed, then goes idle
- **THEN** the target is recorded Paused with a result checkpoint

#### Scenario: The holder is killed first
- **WHEN** the holder is killed before any checkpoint reached `origin`
- **THEN** the target reads Pausing as `holder-killed`, and Restart and Stop are offered

### Requirement: Parked, cooling, and landing holders are named, not forced
Kawai's pause mail SHALL NOT be refused for a cooling profile. It SHALL wait until its holder can take it, and for a parked holder until that holder's parked work resumes. Meanwhile the target SHALL read Pausing as `provider-limit`, naming the profile and its reset. A change whose merge or fast-forward effect has started SHALL NOT be a target. It SHALL be listed as landing in progress and settle as plan-execution's Stop rules settle it.

#### Scenario: A parked holder
- **WHEN** the owner pauses a change whose developer's work is parked until a reset
- **THEN** the pause mail is queued, not refused, and the target reads Pausing as `provider-limit` with the reset time

#### Scenario: A merge has started
- **WHEN** the owner pauses a hold covering a change whose merge effect is running
- **THEN** that change is listed as landing in progress, no mail is sent for it, and it lands if the merge completes

### Requirement: Pausing never resolves a pending request
A pause SHALL NOT approve, deny, or answer a holder's pending approval or question. The pause mail SHALL follow the shipped urgent direct semantics, interrupting only after pending requests resolve. A target whose holder has a pending request SHALL read Pausing with the cause `request`. A passed pause deadline on a target still Pausing for a cause other than `holder-killed` or `checkpoint-push-failed` SHALL raise `plan-pause-overdue`, and SHALL NOT kill or archive anyone.

#### Scenario: Pause beside a pending approval
- **WHEN** the owner pauses a change whose developer awaits a tool approval
- **THEN** the approval card stays pending, the target reads Pausing because of the request, and no Paused is recorded

#### Scenario: The pause deadline passes
- **WHEN** a target is still Pausing at the pause deadline
- **THEN** a `plan-pause-overdue` item asks the owner to unblock the holder, and the holder's session is untouched

#### Scenario: A failed checkpoint push past the deadline
- **WHEN** a target is Pausing as `checkpoint-push-failed` when the pause deadline passes
- **THEN** exactly one item exists for it, `plan-checkpoint-decision`, and no `plan-pause-overdue`

### Requirement: Pause state survives restart
Pauses, targets, checkpoints, and recorded Paused states SHALL be durable. After a restart Kawai SHALL re-derive Pausing from stored rows, inspect an unknown `push-checkpoint` effect before anything else for its change, and leave the pause mail to shipped receipt recovery. It SHALL NOT resume a holder or record Paused without the stored facts.

#### Scenario: Restart with a paused execution
- **WHEN** the server restarts while a target is Paused
- **THEN** the same execution, attempt, checkpoint, and Paused target exist, and Continue afterwards creates no new attempt

#### Scenario: Restart mid-pause
- **WHEN** the server restarts after the pause mail was recorded and before any checkpoint
- **THEN** the target reads Pausing with its causes, and no Paused is recorded and no resume mail is sent

### Requirement: The owner chooses how paused work goes on
For a Paused target the human SHALL choose, under a command id: Continue, sending its holder resume mail and creating no attempt, refused once the holder is killed; Adapt, publishing the task's next revision with notify; or Restart. Restart SHALL also be allowed from every Pausing state; Continue SHALL stay Paused-only. Stop is the cancel and SHALL stay available.

#### Scenario: Continue
- **WHEN** the owner continues a Paused attempt target
- **THEN** its holder gets one `plan-resume` mail naming the checkpoint commit and the task's newest revision, and no attempt is created

#### Scenario: Adapt
- **WHEN** the owner adapts a Paused target with a new direction
- **THEN** the task's next revision is published with its notice, and a fix attempt naming that revision is dispatched once the change is not held

#### Scenario: Continue to a killed holder
- **WHEN** the owner continues a target whose holder was killed after its checkpoint was pushed
- **THEN** Continue is refused as `holder-gone`, and Restart and Stop remain available

#### Scenario: The holder ignores the pause
- **WHEN** a target is still Pausing as `no-checkpoint` at its deadline and the owner restarts it
- **THEN** a new attempt is dispatched from the branch head on `origin` with the "may predate" note, and the old holder's later submissions are refused

### Requirement: Restart starts fresh from the newest safe commit
Restart SHALL release a spawned holder through member release once ready, never a human-created one, warning that the attempt may reach that human-created holder; the dispatch waits for the worktree. It SHALL supersede the held assignment, cancelling no claimed work, and dispatch a new attempt of the stage's kind from the newest checkpoint commit on `origin`, else the branch head there, which may predate the holder's work. The manifest SHALL name the checkpoint when one was recorded.

#### Scenario: Restart with a checkpoint
- **WHEN** the owner restarts a Paused target whose spawned developer is idle
- **THEN** the developer is released, and a new attempt starting from the checkpoint commit is dispatched with the checkpoint package

#### Scenario: Restart without a checkpoint
- **WHEN** the owner restarts a target whose holder was killed before any checkpoint reached `origin`
- **THEN** the new attempt starts from the branch head on `origin`, and its instruction says that head may predate the killed holder's work

### Requirement: Resolutions under a hold wait or release it
A resolution SHALL be recorded at once. Continue SHALL resume under a hold, which still blocks the next handoff and landing. Adapt's and Restart's dispatches SHALL wait on the change's holds, shown as `hold`, unless the same command releases the change from the pause's changes-scoped hold. A whole-plan hold SHALL be narrowed first. Releasing a hold SHALL NOT resolve a pause.

#### Scenario: Restart and release together
- **WHEN** the owner restarts a Paused change and also releases it from the pause's changes hold in the same command
- **THEN** the decision and the release commit together and the new attempt is dispatched

#### Scenario: Restart under a plan hold
- **WHEN** the owner restarts a change paused under a whole-plan hold without narrowing it
- **THEN** the decision is recorded, and the attempt shows as waiting on `hold` until the hold no longer covers the change

### Requirement: A paused change gets no new work until decided
While a change has an undecided pause target, Kawai SHALL dispatch nothing for it, including the fix attempt for a task revision published outside Adapt. The resolution that follows SHALL name the task's newest revision and dispatch at most once.

#### Scenario: A revision published during a pause
- **WHEN** the owner publishes a task revision on a Paused change from the task view
- **THEN** no fix attempt is dispatched, and the later Restart's attempt names that revision

#### Scenario: Continue after a published revision
- **WHEN** the owner continues that change after the revision was published
- **THEN** the resume mail names the newest revision and no fix attempt is dispatched

### Requirement: Pauses are visible to the owner and agents
The plan detail and `plan_get` SHALL list each pause with its deadline and targets: state, causes, holder, checkpoints, and decision. Supervision SHALL name `pausing` and `paused` as a target change's cause. A Paused target, or one Pausing as `holder-killed` or `checkpoint-push-failed`, with no decision SHALL raise only `plan-checkpoint-decision`, never also `plan-pause-overdue`, until decided or the execution finishes.

#### Scenario: A paused change's cause
- **WHEN** a target is Paused and undecided
- **THEN** its change's supervision cause is `paused` and a `plan-checkpoint-decision` item names the change

#### Scenario: Stop clears decisions
- **WHEN** the owner stops the execution while targets await decisions
- **THEN** the targets read cancelled, the pause is closed, and their items clear
