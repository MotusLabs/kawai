# Spec Delta

## Purpose

Provide the repository-level Team workspace where the human supervises a team's product strategy, tasks, attention items, and group settings in one view that is independent of any selected chat.

## ADDED Requirements

### Requirement: A Team workspace opens at repository level, independent of the selected chat
The system SHALL open a full workspace view for a repository's team from its navigator **Team** entry, showing **Product Strategy** above a **Tasks | Messages | Members** tab strip. The view SHALL NOT be tied to a chat selection. The Plans tab SHALL be a registered extension point that renders no content and no placeholder data. Changing the selected chat SHALL NOT close the workspace.
#### Scenario: Open the workspace from the navigator
- **WHEN** the human opens the **Team** entry of a repository
- **THEN** the full workspace view for that repository's team opens with Product Strategy above Tasks, Messages, and Members

#### Scenario: The workspace survives chat selection
- **WHEN** the human selects a different chat while the workspace is open
- **THEN** the workspace stays open on the same team with the same tab and selection

#### Scenario: The workspace survives its transport chat being killed
- **WHEN** the chat session carrying the workspace's wire transport is killed while the workspace is open
- **THEN** the workspace stays open keyed by its team, moving transport to another live session of the team, and shows a disconnected state only when none is left

#### Scenario: No placeholder Plans
- **WHEN** the workspace renders its tab strip
- **THEN** no Plans tab content or placeholder row is shown, and the place a future Plans tab occupies is a documented extension point

### Requirement: The workspace reuses the chat-side task, message, and strategy views
Tasks, Messages, and Product Strategy in the workspace SHALL be the same views the chat side slot mounts, not parallel copies, keyed by team id rather than by the chat that hosts them. The chat-side Tasks, Mailbox, Messages, and Strategy panels SHALL remain available as shortcuts. The Mailbox panel SHALL keep its delivery operations and SHALL NOT be restyled by this view.
#### Scenario: A task opens the same way from either surface
- **WHEN** the human opens a task from the workspace and from a chat's Tasks panel
- **THEN** both show the same task record with the same revisions, journal, and messages

#### Scenario: The chat-side shortcuts remain
- **WHEN** the human opens a chat with the workspace closed
- **THEN** its Tasks, Mailbox, Messages, and Strategy side-slot panels are still available

### Requirement: Task rows show workflow stage separately from task status
Each task row SHALL show its title, task status, workflow stage, accountable session or role, worktree, current waiting reason, and next action. The workflow stage SHALL be projected from the task's assignment and its result and handoff records and displayed separately from task status. A finished agent turn SHALL NOT mark a task done.
#### Scenario: Stage and status are distinct
- **WHEN** an assigned task's agent finishes a turn with no result submitted
- **THEN** the row still shows the task's own status and a workflow stage of Implementing, not done

#### Scenario: A review request moves the stage
- **WHEN** a result's review handoff is outstanding
- **THEN** the row shows a workflow stage of In review alongside the unchanged task status

#### Scenario: A queued review handoff already shows In review
- **WHEN** a review handoff is dispatched and still queued while its result is unaccepted
- **THEN** the row shows In review — the ladder's handoff order precedes Awaiting acceptance

#### Scenario: A closed task shows no stage
- **WHEN** a task's status is done while its last assignment stands delivered
- **THEN** the row shows no workflow stage, not Implementing

#### Scenario: Accountability falls back to the requested role
- **WHEN** a group assignment is queued with no claimed agent
- **THEN** the row shows the requested role as the accountable party and names no session

### Requirement: Task rows can be filtered and closed tasks stay searchable
The task list SHALL filter by active, blocked, awaiting human, awaiting acceptance, group, and worktree. Tasks with status done or cancelled SHALL be searchable but excluded from the default list. Filters and the selected task SHALL survive navigation within the workspace.
#### Scenario: Closed tasks are absent by default
- **WHEN** the workspace opens on a team with done tasks
- **THEN** those tasks are not in the default list and are found by search

#### Scenario: Awaiting-human filter narrows the list
- **WHEN** the human applies the awaiting-human filter
- **THEN** only tasks whose next action requires a human are listed

#### Scenario: Filters survive navigation
- **WHEN** the human filters by worktree, opens a task, and navigates back
- **THEN** the worktree filter and the selected task are unchanged

### Requirement: The attention queue lists what needs a human or is waiting on an agent
The attention queue SHALL consolidate pending approvals and questions, uncertain deliveries, staffing waits, and pending acceptance. Each item SHALL show its cause, owner, impact scope, next action, and a link to its card, task, or message. Human-required items SHALL be separated from agent-owned waits.
#### Scenario: An open approval is a human-required item (E05)
- **WHEN** a session has a pending approval
- **THEN** the queue lists it as human-required with the session as owner, its task as impact scope, and a link to that chat's approval card

#### Scenario: A staffing wait is agent-owned (E05)
- **WHEN** a message waits on a group cap
- **THEN** the queue lists it under agent-owned waits with the capacity as its cause and a link to the message

#### Scenario: An uncertain delivery needs the human
- **WHEN** a message is held as an uncertain delivery
- **THEN** the queue lists it as human-required with retry or discard as its next action and a link to the message

#### Scenario: Pending acceptance needs the human
- **WHEN** a submitted result awaits **Accept result**
- **THEN** the queue lists it as human-required with the task as impact scope and a link to the task

### Requirement: Attention items have a stable identity and accept later sources
Each attention item SHALL carry a kind, a stable identity, and a link that MAY target a card. A later change MAY add kinds — plan holds, stalls, Lead decision cards — without changing the item shape. An item of an unrecognized kind SHALL still be rendered with its cause and next action rather than dropped.
#### Scenario: An unrecognized kind still renders
- **WHEN** the queue receives an item whose kind this client does not know
- **THEN** the item is listed with its cause, owner, impact scope, next action, and link

#### Scenario: A card link is accepted
- **WHEN** an item's link targets a card
- **THEN** the item renders and its link opens that card

### Requirement: Attention counts reconcile after reconnect without duplicate toasts
On open and on reconnect the workspace SHALL replace its attention items and counts with the authoritative snapshot rather than incrementing them. Each item identity SHALL raise at most one toast across its transitions; a reconnect that replays unchanged state SHALL raise no toast.
#### Scenario: Reconnect converges the counts (E05, E13)
- **WHEN** the connection drops while two approvals are pending and one is resolved, then the client reconnects
- **THEN** the workspace shows one attention item, not two and not three

#### Scenario: Replaying state does not re-toast (E05, E13)
- **WHEN** a reconnect resends a snapshot whose items are unchanged
- **THEN** no toast is raised for those items

### Requirement: Members is a read-only inspection of group settings
The Members tab SHALL list each of the team's groups with its role description, live membership, task-creation right, effective profiles with caps and live counts, effective approval policy, member cap, routing strategy and limit policy, effort, and routing warnings. No control SHALL edit a group. A prompt change SHALL affect future agent starts only and SHALL NOT elevate runtime permissions.
#### Scenario: Caps show live counts
- **WHEN** a group allows two members on a profile and one is live
- **THEN** the row shows 1 of 2 for that profile with the live member named

#### Scenario: Members cannot be edited
- **WHEN** the human opens the Members tab
- **THEN** it presents no control that writes a group file or changes a running agent's permissions

#### Scenario: A warning names what fell back
- **WHEN** a group file lists a profile the catalog does not define
- **THEN** the group's row shows that warning alongside the settings that took effect

### Requirement: Members names the source file of every setting
Each group row SHALL name the file that defines it and, when both layers define it, both paths with the one in effect marked. The row SHALL state that prompt changes apply to future agent starts only.
#### Scenario: A project file overrides a user file
- **WHEN** `~/.kawai/groups/devs.md` and `<main-checkout>/.kawai/groups/devs.md` both define `devs`
- **THEN** the row marks the project file as in effect and lists the user file beneath it

#### Scenario: A single-layer group names one file
- **WHEN** a group is defined only in the user's home
- **THEN** the row names that file as its source

### Requirement: The morning summary groups the interval's outcomes
A summary band SHALL list completed results, capacity waits, approvals, uncertain deliveries, and finished turns without a result over the last 24 hours, each bucket naming its items with links. A finished turn with no submitted result SHALL NOT be counted as a completed result.
#### Scenario: Each bucket is populated (E13)
- **WHEN** the last 24 hours hold a submitted result, a cap wait, an open approval, an uncertain delivery, and an agent that finished a turn with no result
- **THEN** the summary shows one item in each of the five buckets

#### Scenario: A finished turn is not a completion (E13)
- **WHEN** an agent finishes a turn and submits no result
- **THEN** it appears only in the finished-turn-without-result bucket and never among completed results

#### Scenario: Resolved items leave the buckets (E13)
- **WHEN** an approval in the summary window is answered
- **THEN** the recomputed summary no longer lists it as an open approval

#### Scenario: A restart keeps durable buckets (E13)
- **WHEN** the server restarts and the workspace opens
- **THEN** completed results and uncertain deliveries in the window are still listed, while capacity waits list only waits the running server has observed

### Requirement: The workspace supports one-handed list and detail navigation
At a narrow viewport the workspace SHALL use list and detail panes with an explicit **Back** action. Opening a chat SHALL preserve the task selection and filters. Unsubmitted composer drafts and the current selection SHALL survive navigation within the workspace.
#### Scenario: Back returns to the preserved list (E14)
- **WHEN** the human filters tasks, opens one on a narrow viewport, then uses **Back**
- **THEN** the filtered list and selection are as they were

#### Scenario: Opening a chat preserves workspace state (E14)
- **WHEN** the human opens a session from an attention item and returns
- **THEN** the workspace tab, filters, and selection are unchanged

### Requirement: The workspace is keyboard accessible
Every workspace control SHALL be reachable and operable from the keyboard, show a visible focus indicator, and have an accessible name. Every state SHALL carry a text label in addition to any color or icon.
#### Scenario: Keyboard-only attention handling (E14)
- **WHEN** the human uses only the keyboard to open the workspace and resolve an attention item
- **THEN** each control shows visible focus, is named, and the item's state change is announced as text

### Requirement: Workspace reads are team-scoped and refuse cross-team access
Every workspace read and action SHALL be scoped to the calling session's team. Another team's task, message, strategy, session, or worktree SHALL be refused server-side and SHALL NOT appear in the workspace.
#### Scenario: A second repository stays isolated (E14)
- **WHEN** a second repository's team is open beside the first
- **THEN** each workspace lists only its own team's tasks, members, messages, attention counts, and worktrees

#### Scenario: Cross-team ids are refused (E14)
- **WHEN** a workspace request names a task id belonging to another team
- **THEN** the server refuses it and no data for that task is returned

### Requirement: The workspace stays current without a manual refresh
The workspace SHALL receive one authoritative snapshot on open and on reconnect, and unfiltered change pushes the client applies. A new attention item or a stage change SHALL appear without a manual reload.
#### Scenario: A new approval appears live
- **WHEN** a session raises a pending approval while the workspace is open
- **THEN** the attention queue shows it without a manual refresh

#### Scenario: Opening always snapshots
- **WHEN** the workspace is opened after a period of change
- **THEN** it receives a full authoritative snapshot before any incremental push is applied
