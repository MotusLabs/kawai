# plans Specification

## Purpose
Gives a team a durable, human-owned plan record for one repository. A plan holds ordered OpenSpec changes, checks above the mandatory floor, a landing mode, roles and profiles, and a pinned product strategy. Agents draft and read plans; tasks link to plan changes; progress is derived from those tasks.

## Requirements

### Requirement: A plan is a durable, team-scoped record
A plan SHALL be a kawai-owned record of one team holding its title, creator, lifecycle (`open`, `completed`, or `cancelled`), and current approved revision; the human is every plan's owner and only approver. Plans, revisions, drafts, and events SHALL persist across server restart and SHALL remain when the sessions that created or drafted them are archived or killed. A repository file describing a plan SHALL NOT be read as the record.

#### Scenario: Creator killed
- **WHEN** the agent session that created a plan is killed
- **THEN** the plan, its revisions, drafts, and events remain, and the human can still approve and close it

#### Scenario: Restart keeps the plan
- **WHEN** the server restarts with an open plan holding an approved revision and a draft
- **THEN** the same plan, revision numbers, hashes, draft, and events are read back

#### Scenario: Repository file is not the record
- **WHEN** the repository contains a file describing a plan
- **THEN** the Plans view and agent tools read only the kawai-owned record, and the file changes neither

### Requirement: Plan revisions are immutable and hashed
Each plan revision SHALL be numbered, immutable, and identified by a content hash computed over a canonical serialization of its content and strategy pin, so equal content and pin always hash equally. A revision's status SHALL be `in_review`, `approved`, `superseded`, or `withdrawn`, and superseded and withdrawn revisions SHALL stay readable with their content.

#### Scenario: Key order does not change the hash
- **WHEN** two drafts carry the same content with object keys in a different order and are submitted under the same pin
- **THEN** both revisions carry the same content hash

#### Scenario: Superseded revision stays readable
- **WHEN** revision 3 is approved after revision 2
- **THEN** revision 2 is `superseded` and its full content and hash remain readable

### Requirement: Plan changes are ordered with dependencies
Plan content SHALL list its changes in order, each naming an OpenSpec change by kebab-case name and the changes of the same plan it depends on. Saving SHALL refuse a malformed or duplicate change name, a dependency on itself or on a change outside the plan, and a dependency cycle, listing every violation. The order expresses preference; dependencies are the hard constraint.

#### Scenario: Cycle refused
- **WHEN** a draft makes change `a` depend on `b` and `b` depend on `a`
- **THEN** saving is refused with a violation naming the cycle `a → b → a`, and the stored draft is unchanged

#### Scenario: Dependency outside the plan refused
- **WHEN** a draft makes change `ui` depend on `api` and the plan lists no change `api`
- **THEN** saving is refused with a violation naming `api` as unknown

#### Scenario: Every violation is listed
- **WHEN** a draft has a duplicate change name and a malformed one
- **THEN** the refusal lists both violations, not only the first

### Requirement: The check floor is fixed and plans only add checks
Kawai's mandatory check floor (lint, typecheck, unit tests, CI end-to-end, and a clean reviewer verdict) SHALL apply to every plan and SHALL NOT be plan content. A plan MAY add named extra checks plan-wide or per change, each with a description and an optional command. No content SHALL remove or weaken the floor; an extra check reusing a floor name or a name already used in its scope SHALL be refused.

#### Scenario: Floor name refused
- **WHEN** a draft adds an extra check named `lint`
- **THEN** saving is refused naming the reserved check name

#### Scenario: No field can disable the floor
- **WHEN** a draft carries an unknown field meant to skip a floor check
- **THEN** normalization drops the field, and the plan still shows all five floor checks

#### Scenario: Extra checks are shown beside the floor
- **WHEN** a plan adds the plan-wide check `browser-walkthrough` and the change check `migration-dry-run`
- **THEN** the plan detail shows the floor followed by both extra checks, each in its scope

### Requirement: Plans declare a landing mode
Plan content SHALL declare its landing mode: `direct`, where each change merges to the main branch once it passes, or `integration-branch` with a named branch on which changes accumulate. A new draft SHALL default to `direct`, and saving SHALL refuse a malformed branch name. This capability records the mode; landing work belongs to the plan's execution.

#### Scenario: Integration branch recorded
- **WHEN** a draft sets landing mode `integration-branch` with branch `wave-c/integration`
- **THEN** the saved draft and its submitted revision show that mode and branch

#### Scenario: Malformed branch refused
- **WHEN** a draft sets landing mode `integration-branch` with branch `bad..name`
- **THEN** saving is refused naming the branch

### Requirement: Plans declare the roles and profiles that execute them
Plan content SHALL list the groups that execute the plan, each with its provider profiles in preference order. It SHALL name each change's implementing group and a review group that gives the floor's reviewer verdict, set plan-wide or per change. Saving SHALL refuse a referenced group missing from the roles. Whether the groups and profiles exist is checked when the plan is validated, not at save.

#### Scenario: Group outside the roles refused
- **WHEN** a change names implementing group `senior-devs` and the roles list only `middle-devs` and `reviewers`
- **THEN** saving is refused naming `senior-devs` as missing from the roles

#### Scenario: Per-change review group
- **WHEN** the plan's review group is `reviewers` and change `api` sets review group `senior-devs`, both listed in the roles
- **THEN** the plan detail shows `senior-devs` reviewing `api` and `reviewers` reviewing the other changes

### Requirement: Plan drafts are durable and saved with expected-revision checks
Plan drafts SHALL be durable and keyed by draft id, which defaults to the saving agent's session id; any team agent MAY continue a draft by its id. Each save SHALL carry the expected base revision and draft hash. A mismatch SHALL refuse the write and return the stored draft, so the caller keeps its text. Saving a draft SHALL NOT change any revision, approval, task, or mail.

#### Scenario: Concurrent save refused
- **WHEN** two agents save the same draft id, both expecting the same draft hash
- **THEN** the second save is refused and returns the stored draft written by the first

#### Scenario: A replacement lead continues the draft
- **WHEN** the lead that wrote a draft is archived and a new lead saves to that draft id with its current hash
- **THEN** the save succeeds, and the draft records the new author

### Requirement: Submission requires a complete draft
Submitting a draft SHALL refuse it, naming each gap, when it lacks a goal, a success criterion, at least one change, an implementing group for every change, or an effective review group for every change. A draft MAY be saved incomplete. A closed plan SHALL refuse submission until it is reopened.

#### Scenario: Incomplete draft refused
- **WHEN** an agent submits a draft with a goal and one change but no success criterion and no review group
- **THEN** submission is refused naming both gaps, and no revision is created

#### Scenario: Incomplete draft can be saved
- **WHEN** an agent saves a draft with only a goal
- **THEN** the draft is stored and can be completed by later saves

### Requirement: Submission pins the product strategy
Submitting SHALL create the next numbered revision `in_review` and pin, on the server, the team's current approved strategy revision and hash. With no approved revision, the pin SHALL be empty and the plan SHALL show Alignment unassessed. An author SHALL NOT supply or change the pin. Alignment references SHALL exist in the pinned revision and SHALL be empty without a pin.

#### Scenario: Current strategy is pinned
- **WHEN** an agent submits a plan draft while strategy revision 2 is the team's approved revision
- **THEN** the new revision pins strategy revision 2 and its hash, whatever the draft content says about strategy

#### Scenario: No strategy means unassessed
- **WHEN** a draft is submitted for a team whose product has no approved strategy revision
- **THEN** the revision has an empty pin and the plan shows Alignment unassessed, with no placeholder binding

#### Scenario: Unknown alignment reference refused
- **WHEN** a draft's alignment statement cites `UC9` and the pinned strategy revision has no `UC9`
- **THEN** submission is refused naming `UC9`

#### Scenario: Unchanged resubmission returns the existing revision
- **WHEN** an agent submits a draft whose content and pin equal an existing `in_review` or `approved` revision
- **THEN** that revision's number is returned and no new revision is created

### Requirement: The human closes and reopens plans
The human SHALL complete, cancel, or reopen a plan. Cancelling SHALL require a reason. Completing SHALL require an approved revision, plus a reason when any of its changes is not done. Closing SHALL leave linked tasks, revisions, and drafts untouched. Every lifecycle action SHALL be recorded as an append-only plan event with actor, reason, and command id.

#### Scenario: Completing with unfinished changes needs a reason
- **WHEN** the human completes a plan while one change's linked tasks are still active
- **THEN** completion is refused until a reason is given, and the reason is recorded in the plan event

#### Scenario: Cancel without a reason refused
- **WHEN** the human cancels a plan with an empty reason
- **THEN** the plan stays open and the refusal asks for a reason

#### Scenario: Reopen
- **WHEN** the human reopens a cancelled plan
- **THEN** the plan is open again, accepts submissions and approvals, and its history shows both events

#### Scenario: Close is idempotent by command id
- **WHEN** a close command is resent after its result was lost, and later the same command id is sent with the other outcome
- **THEN** the resend returns the recorded close without a second event, and the other outcome is refused naming `outcome`

### Requirement: Plan state is derived from lifecycle, approval, and links
A plan's displayed state SHALL be Draft while it is open without an approved revision, Ready while it is open with one and no linked tasks, and In progress while it is open with linked tasks; otherwise Completed or Cancelled. Only the lifecycle SHALL be stored; the displayed state SHALL be derived when read.

#### Scenario: Ready becomes In progress
- **WHEN** a task is linked to a change of a Ready plan
- **THEN** the plan shows In progress without any plan write

#### Scenario: Draft until approved
- **WHEN** an open plan has revisions in review but none approved
- **THEN** it shows Draft

### Requirement: Change progress is derived from linked tasks
For each change of the current approved revision, the plan SHALL show its linked tasks and a progress derived from their statuses when read: not started, in progress, done, or cancelled. It SHALL also show the dependencies the change still waits on; a cancelled dependency keeps it waiting. Progress SHALL never be stored or set by hand. Linked tasks naming a change absent from the current revision SHALL be listed separately.

#### Scenario: Done when every linked task is closed and one is done
- **WHEN** change `api` has one done task and one cancelled task
- **THEN** `api` shows done, and a change depending on `api` no longer shows it as a wait

#### Scenario: Waiting on a dependency
- **WHEN** change `ui` depends on `api`, whose linked task is active
- **THEN** `ui` shows that it waits on `api`

#### Scenario: Cancelled dependency keeps its dependents waiting
- **WHEN** change `ui` depends on `api`, whose only linked task is cancelled
- **THEN** `api` shows cancelled and `ui` still waits on it until a newer approved revision drops or replaces the dependency

#### Scenario: Change dropped by a newer revision
- **WHEN** a newer approved revision removes change `legacy`, which has linked tasks
- **THEN** those tasks are listed as outside the current revision, with their links unchanged

### Requirement: Agents read and propose plans
Every team agent SHALL be able to list and read its team's plans and to save and submit drafts. Creating a plan SHALL require the agent's group file to set `canCreatePlans: true`, a strict boolean that defaults to false; an invalid value rejects the file. No agent tool SHALL approve, withdraw, complete, cancel, or reopen a plan, and the system prompt's plan note SHALL state these rights.

#### Scenario: Group without the right cannot create
- **WHEN** an agent whose group file does not set `canCreatePlans: true` calls `plan_create`
- **THEN** the call is refused naming the missing right, and no plan is created

#### Scenario: No approving tool exists
- **WHEN** an agent lists its `kawai-team` tools
- **THEN** it finds plan list, read, create, save-draft, and submit tools, and none that approves, withdraws, or closes a plan

#### Scenario: Other team's plan is not found
- **WHEN** an agent reads a plan id that belongs to another team
- **THEN** the tool answers not found and reveals nothing about that plan

### Requirement: Plans are inspectable in the UI
The UI SHALL list a team's plans with title, displayed state, approved revision, and strategy pin or Alignment unassessed. A plan's detail SHALL show its intent, the alignment statement labeled as claimed and not assessed, ordered changes with their dependencies, groups, checks, acceptance, guidance, linked tasks, and progress, the floor beside the extra checks, the landing mode, roles and profiles, revisions, drafts, and history.

#### Scenario: Plan detail
- **WHEN** the human opens an In progress plan
- **THEN** its intent, claimed alignment, changes with progress, checks, landing mode, roles, revisions, drafts, and history are shown

#### Scenario: Revision under review
- **WHEN** a plan has an approved revision 1 and revision 2 in review
- **THEN** revision 2 shows a diff summary against revision 1 with **Approve revision 2** and **Withdraw**

### Requirement: Plan views are team-scoped and connection-aware
The Plans view SHALL be scoped to the team of the repository it is opened for and SHALL refuse another team's plan ids. Authoritative pushes SHALL update it on every committed plan change and every change to a linked task. Every control SHALL be disabled while disconnected, and refusals SHALL show inline.

#### Scenario: Another team's plan refused
- **WHEN** a client of team A asks to open a plan id of team B
- **THEN** the request is refused and no plan data is sent

#### Scenario: Linked task change pushes the plan
- **WHEN** a task linked to change `api` is marked done while the plan's detail is open
- **THEN** the open detail updates `api`'s progress without a reload

#### Scenario: Controls disabled while disconnected
- **WHEN** the connection drops while an approve dialog is open
- **THEN** the approve control is disabled until the connection returns
