# Spec Delta

## ADDED Requirements

### Requirement: Team views are mounted only on the Team page
Tasks, Messages, Mailbox, and Product Strategy SHALL be shown only as tabs of the Team page, never in a chat's side slot. A chat SHALL reach them through its header's Team button or task chip, which open the Team page for the chat's team.

#### Scenario: A task chip opens the Team page
- **WHEN** the human clicks a chat's task chip
- **THEN** the Team page for the chat's team opens on Tasks with that task selected

#### Scenario: Same record from any entry point
- **WHEN** the human opens a task from the navigator's Team entry and later from a chat's task chip
- **THEN** both show the same Team page view of that task, with the same revisions, journal, and messages

### Requirement: Product Strategy is a tab with full-width sub-views
The **Strategy** tab SHALL hold the strategy as four sub-views at the page's full width: an overview of the direction, a review of one revision in review, the draft editor, and the revision history. Each sub-view SHALL keep the existing strategy actions and their human-only approval rules. A team with no strategy record SHALL show the capture affordance in the overview.

#### Scenario: Overview leads with direction
- **WHEN** the human opens the Strategy tab of a team with an approved revision
- **THEN** purpose, primary users, needs and outcomes, use cases, principles, and boundaries are shown first, with every other section collapsed and expandable

#### Scenario: Review shows the diff beside the findings
- **WHEN** the human opens the review of revision 3 on a wide viewport
- **THEN** the changes from the approved revision and the Known / Assumed / Not decided findings are side by side, with **Approve revision 3** and **Withdraw** below them

#### Scenario: The draft editor keeps its text across sub-views
- **WHEN** the human edits a draft, switches to History, and returns to the draft
- **THEN** the unsaved text is unchanged

#### Scenario: No record offers capture
- **WHEN** the team has no strategy record
- **THEN** the overview offers capture, and the Tasks, Messages, Mailbox, and Members tabs work as usual

### Requirement: The Team page header shows the strategy status
The Team page header SHALL show a one-line strategy status on every tab: the approved revision number, or that none is approved, and a count of revisions in review. Activating it SHALL open the Strategy tab on the overview, or on the review when a revision is in review.

#### Scenario: A revision awaits review
- **WHEN** revision 2 is approved and revision 3 is in review while the human is on Tasks
- **THEN** the header shows approved revision 2 and one revision in review, and activating it opens the review of revision 3

#### Scenario: No strategy
- **WHEN** the team has no strategy record
- **THEN** the header shows that no strategy is captured, and activating it opens the Strategy overview

### Requirement: Mailbox is a tab of delivery operations
The **Mailbox** tab SHALL list every unsettled message in its delivery section with its waiting reason, and SHALL offer the existing Cancel, Retry, Discard, Hand off, and Reload routing rules actions. Held for review, Dead letters, and Parked SHALL come first and start expanded; the other sections SHALL start collapsed and show their counts. Routing state SHALL be its own collapsible section.

#### Scenario: Action sections lead
- **WHEN** the Mailbox tab opens with one held message, two queued, and three scheduled
- **THEN** Held for review is first and expanded, Queued and Scheduled are collapsed showing 2 and 3, and the held row's Retry and Discard are available

#### Scenario: A collapsed section expands
- **WHEN** the human expands Scheduled
- **THEN** its three rows are listed with their due times

### Requirement: Mailbox rows collapse to one line and can be searched
Each Mailbox row SHALL show by default one line: sender, recipient, age, priority, its waiting reason's immediate blocker, and the first line of its body. Expanding a row SHALL show the full body, every constraint, and any handoff detail. A search box SHALL narrow every section to rows whose sender, recipient, body, or reason contains the text. Empty sections SHALL be hideable.

#### Scenario: Expand a row
- **WHEN** the human expands a queued row whose body is twenty lines
- **THEN** the full body and the row's other waiting constraints are shown, and collapsing it returns to one line

#### Scenario: Search narrows the sections
- **WHEN** the human searches `strategy-ui`
- **THEN** only rows whose sender, recipient, body, or reason contains `strategy-ui` remain, and each section's count reflects the match

#### Scenario: Hide empty sections
- **WHEN** the human turns on hiding empty sections and Receiving has no rows
- **THEN** Receiving is not shown

### Requirement: Messages rows group by thread and collapse
The **Messages** tab SHALL group its list by thread: one collapsible row per thread, showing its latest message and message count. Message bodies SHALL be clamped to a few lines until expanded. **Expand all** and **Collapse all** SHALL act on every loaded thread. Opening a thread SHALL keep showing its detail and composer.

#### Scenario: A thread collapses to one row
- **WHEN** a thread holds six messages
- **THEN** the list shows one row for it with its latest message and a count of 6, and expanding it lists the six messages

#### Scenario: Long bodies are clamped
- **WHEN** a message body is longer than the clamp
- **THEN** the row shows its first lines with a control to show the full body

#### Scenario: Expand all
- **WHEN** the human chooses Expand all
- **THEN** every loaded thread row is expanded, and Collapse all collapses them again

### Requirement: Messages search covers the whole history
The Messages tab SHALL offer a text search that the server applies to the team's whole message history alongside the other filters, matching message bodies and participant names. It SHALL NOT be limited to loaded pages. Paging SHALL continue within the search's results.

#### Scenario: Search finds an old message
- **WHEN** the human searches a phrase that appears only in a message older than every loaded page
- **THEN** the list shows that message's thread

#### Scenario: Search combines with filters
- **WHEN** the human filters to urgent mail and searches `review`
- **THEN** only urgent messages containing `review` are listed, and **Load more** continues within those results

#### Scenario: A live message outside the search
- **WHEN** a new message that does not contain the search text arrives while a search is active
- **THEN** it is not added to the list

### Requirement: Tasks search and collapse
The **Tasks** tab SHALL offer a search box over each task's title and current direction. It SHALL show subtasks nested under their parent, with each parent collapsible. Each section of a task's detail — direction, acceptance, revision history, journal, subtasks, and messages — SHALL collapse and expand on its own.

#### Scenario: Search highlights matches
- **WHEN** the human searches `usage bar`
- **THEN** only tasks whose title or current direction contains it are listed, with the match marked, and a matching subtask is shown under its parent

#### Scenario: Collapse a parent
- **WHEN** the human collapses a parent task with two subtasks
- **THEN** its subtasks are hidden and the parent row shows that it has 2

#### Scenario: Detail sections collapse independently
- **WHEN** the human collapses Revision history and then opens another task
- **THEN** Revision history is collapsed in that task's detail too, while the other sections keep their own state

### Requirement: Each tab keeps its view state while the page is open
Each tab's search, filters, expanded items, and selection SHALL survive switching tabs, opening a chat and returning, and reconnecting, for as long as the browser tab is open. They SHALL be kept per team, so two teams' pages SHALL NOT share them. They SHALL NOT be sent to the server.

#### Scenario: State survives a chat visit
- **WHEN** the human searches Mailbox, expands two rows, opens a chat from one of them, and returns to the Team page
- **THEN** Mailbox shows the same search and the same two rows expanded

#### Scenario: Teams keep separate state
- **WHEN** the human searches Tasks on team A and then opens team B's Team page
- **THEN** team B's Tasks has no search applied

### Requirement: The Team page location is in the URL
The URL SHALL identify the Team page's repository, tab, Strategy sub-view, and selected task or thread. Reloading SHALL reopen that location, the browser's Back and Forward SHALL move between locations visited, and a location for an unknown repository or a missing item SHALL open the nearest valid view with a notice.

#### Scenario: Reload keeps the location
- **WHEN** the human reloads while viewing task `t_12` on the Tasks tab of `kawai`
- **THEN** the Team page reopens on Tasks with `t_12` selected

#### Scenario: Back returns to the previous tab
- **WHEN** the human moves from Tasks to Mailbox and presses the browser's Back
- **THEN** the Team page shows Tasks again

#### Scenario: A missing task
- **WHEN** the URL names a task that no longer exists in the team
- **THEN** the Tasks tab opens with no selection and a notice that the task was not found

## MODIFIED Requirements

### Requirement: A Team workspace opens at repository level, independent of the selected chat
The system SHALL open a full workspace view for a repository's team from its navigator **Team** entry, showing a **Strategy | Tasks | Messages | Mailbox | Members** tab strip under a header that shows the strategy status. The view SHALL NOT be tied to a chat selection. The Plans tab SHALL be a registered extension point: until a Plans view registers there, it renders no tab content and no placeholder data. Selecting a chat SHALL show that chat in the main pane; returning to the Team page SHALL restore its team, tab, and selection.

#### Scenario: Open the workspace from the navigator
- **WHEN** the human opens the **Team** entry of a repository
- **THEN** the full workspace view for that repository's team opens with the Strategy, Tasks, Messages, Mailbox, and Members tabs and the strategy status in its header

#### Scenario: The workspace survives chat selection
- **WHEN** the human selects a chat while the Team page is open on a selected task, then returns through the Team entry or the browser's Back
- **THEN** the Team page reopens on the same team with the same tab and selection

#### Scenario: The workspace survives its transport chat being killed
- **WHEN** the chat session whose connection carries the Team page's requests is killed while the page is open
- **THEN** the page stays open on its team, because it is addressed by the team's directory and not by any chat, and shows a disconnected state only when no connection is left

#### Scenario: No placeholder Plans
- **WHEN** no Plans view is registered and the workspace renders its tab strip
- **THEN** no Plans tab content or placeholder row is shown, and the place a future Plans tab occupies is a documented extension point

### Requirement: Workspace reads are team-scoped and refuse cross-team access
Every Team page read and action SHALL be scoped to the team of the repository path the page addresses. A path that is not a discovered repository, one of its listed worktrees, or the project directory of an existing chat session SHALL be refused. Another team's task, message, strategy, session, or worktree SHALL be refused server-side and SHALL NOT appear on the page.

#### Scenario: A second repository stays isolated (E14)
- **WHEN** a second repository's team is open beside the first
- **THEN** each workspace lists only its own team's tasks, members, messages, attention counts, and worktrees

#### Scenario: Cross-team ids are refused (E14)
- **WHEN** a workspace request names a task id belonging to another team
- **THEN** the server refuses it and no data for that task is returned

#### Scenario: Cross-team links are refused (E14)
- **WHEN** a workspace link names a task, message, or strategy of another team
- **THEN** the owning connection refuses it and the workspace shows no data for it

#### Scenario: An unknown path is refused
- **WHEN** a Team page request addresses a directory that is neither a discovered repository, a listed worktree, nor a chat session's project directory
- **THEN** the server refuses it and returns no team data

#### Scenario: Works with no chat
- **WHEN** a repository has only terminal sessions and the human opens its Team entry
- **THEN** its tasks, messages, mailbox, strategy, and members load

## REMOVED Requirements

### Requirement: The workspace reuses the chat-side task, message, and strategy views
**Reason**: The chat-side Tasks, Mailbox, Messages, and Strategy panels are removed (team views are scoped by team, not by chat), so there is no second mount to share with.
**Migration**: Covered by "Team views are mounted only on the Team page": a chat reaches the same views through its header's Team button or task chip.
