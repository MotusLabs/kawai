# process-reports Specification

## Purpose
Lets a permitted agent write windowed process reports that freeze the metrics they cite and propose changes to group prompts or shared memory, which only the human accepts or rejects, and links each accepted proposal to the prompt or memory version that implemented it and to what changed afterwards.

## Requirements

### Requirement: Only permitted groups write reports
A group file SHALL accept `canReportProcess: true|false` (default false; any other value rejects the file like `canCreateTasks`). Report tools SHALL check the caller's current group file at each call and refuse a caller whose group does not set it, writing nothing. Reading reports SHALL be open to every team member.

#### Scenario: A dev tries to report
- **WHEN** a member of a group without `canReportProcess: true` submits a report
- **THEN** the call is refused naming the missing right and nothing is written

#### Scenario: Right removed
- **WHEN** the lead group file drops `canReportProcess` and the lead submits a report
- **THEN** the call is refused

### Requirement: A report freezes the metrics it was written from
`process_report_submit` SHALL take a window (1d, 3d, or 7d), a summary, and proposals. Kawai SHALL compute the team's metric set for that window ending at submission and store it with the report, so the report always shows the numbers it was written against. The author, team, window, and period SHALL be set by Kawai, never by arguments.

#### Scenario: Numbers cannot be supplied
- **WHEN** the lead submits a 7d report
- **THEN** the stored snapshot is the one Kawai computed at submission, whatever the summary says

#### Scenario: Later data
- **WHEN** a report is read a week after submission
- **THEN** its snapshot shows the values as of submission

### Requirement: Window roles bound what a report may propose
A 1d report SHALL carry no proposals. A 3d report SHALL carry only revert proposals. A 7d report MAY carry change and revert proposals. A report breaking its window's rule SHALL be refused whole, naming the rule, and nothing SHALL be written.

#### Scenario: 1d report proposes a prompt edit
- **WHEN** the lead submits a 1d report with a change proposal
- **THEN** it is refused naming the 1d rule

#### Scenario: 3d revert
- **WHEN** the lead submits a 3d report proposing to revert `reviewers.md` to an earlier hash
- **THEN** the report and its proposal are stored

### Requirement: Proposals name a target, a rationale, and expected effects
A proposal SHALL name its kind (change or revert), its target (one group's file, or one shared memory file by name), the proposed edit, a rationale, and at least one expected effect (a metric and a direction). A revert SHALL name the earlier hash recorded for that target that it returns to. A proposal naming an unknown group or metric SHALL refuse the report.

#### Scenario: Unknown metric
- **WHEN** a proposal expects `happiness` to rise
- **THEN** the report is refused naming the unknown metric

#### Scenario: Revert target
- **WHEN** a revert names a group file hash never recorded for that group
- **THEN** the report is refused

### Requirement: Only the human decides proposals
The human SHALL accept or reject each proposal from the Metrics tab, with an optional reason; a decision SHALL be final and recorded with the target's current hash. A second decision on a decided proposal SHALL be refused. No agent tool SHALL decide, apply, or withdraw a proposal, and Kawai SHALL NOT edit any file to apply one.

#### Scenario: Agent cannot accept
- **WHEN** an agent looks for a tool to accept a proposal
- **THEN** none exists, and the proposal stays undecided

#### Scenario: Retried decision
- **WHEN** the human's accept is re-sent after a reconnect with the same command
- **THEN** the original decision is returned and no second one is recorded

### Requirement: Target versions change at recorded starts
A version change of a target (a group's file, or one named memory file) SHALL be an agent start that recorded a hash for it different from the one recorded by the previous start that loaded that target. Each version change SHALL name its start, time, hash, and previous hash. A hash MAY recur: returning to an earlier hash SHALL be a new version change.

#### Scenario: Revert to an earlier version
- **WHEN** `reviewers.md` goes from A to B and later back to A
- **THEN** two version changes are recorded: A to B, then B to A

#### Scenario: First recorded start
- **WHEN** the first start that ever loads `lead.md` is recorded
- **THEN** it is not a version change

### Requirement: Implementation is an explicit link
An accepted proposal SHALL read as implemented only through an explicit link to one version change of its target that happened after the decision; the link SHALL record that change's start, time, and hash. A change proposal's linked hash SHALL differ from the hash at decision; a revert's SHALL equal its revert hash. No link SHALL be inferred. One version change MAY be linked to several proposals, each marked as sharing it.

#### Scenario: Revert returns to an earlier hash
- **WHEN** a revert to hash H is accepted and a reviewer later starts with `reviewers.md` back at H
- **THEN** that version change is offered for linking, and the link records the post-decision start that brought H back

#### Scenario: Unrelated edit
- **WHEN** `reviewers.md` changes after the human accepted a reviewers proposal, and nobody links the new hash
- **THEN** the proposal reads accepted, not implemented

#### Scenario: Two proposals, one edit
- **WHEN** two accepted proposals for `reviewers.md` are both linked to the same version change
- **THEN** both read implemented by it and are marked as sharing it

#### Scenario: Unrelated memory file
- **WHEN** a memory proposal targets `feedback-reviews.md` and only another memory file changes
- **THEN** no version change of `feedback-reviews.md` is offered for linking

#### Scenario: Revert linked to the wrong hash
- **WHEN** a revert to hash H is linked to a different hash
- **THEN** the link is refused naming H

### Requirement: Implementation links are made by the human or a reporting agent
The human SHALL link or unlink an accepted proposal's implementation from the Metrics tab, choosing among the target's qualifying version changes after the decision. A member of a group setting `canReportProcess: true` SHALL link an unlinked proposal through `process_proposal_link`. Each link, replacement, and unlink SHALL be kept as history with who made it and when; only the human SHALL replace or remove a link.

#### Scenario: Lead links its proposal
- **WHEN** the lead links an accepted, unlinked proposal to a recorded hash of its target
- **THEN** the proposal reads implemented, naming the lead as linker

#### Scenario: Agent cannot relink
- **WHEN** an agent tries to link a proposal that already has a link
- **THEN** the call is refused and the link is unchanged

### Requirement: Human proposal commands replay by their key
Each human decide, link, replace, or unlink command SHALL carry a command key unique within the team, and its outcome SHALL be kept durably apart from the link or decision it produced. Repeating a key with the same payload SHALL return the stored outcome and change nothing, even after later commands replaced or removed what it created. Repeating a key with a different payload SHALL be refused, naming the differing field.

#### Scenario: Old link replayed after unlink
- **WHEN** the human links P to change C with key K1, unlinks it with K2, and K1 is re-sent after a reconnect
- **THEN** K1's stored outcome is returned and P stays unlinked

#### Scenario: Key reused with another payload
- **WHEN** key K1 is sent again naming a different version change
- **THEN** the command is refused naming the version change field

### Requirement: Implemented proposals show their outcome
For an implemented proposal, Kawai SHALL show each expected effect's metric before and after on its own attribution side: work by starts that loaded the hash at decision before the linked change, versus work by starts that loaded the linked hash from that change on, each with `n` and flag, and whether it moved as expected; below threshold reads undetermined. A team-side metric, or one with no such work, SHALL compare equal windows around the change, labeled not attributed.

#### Scenario: Effect undetermined
- **WHEN** only 4 findings were filed by reviewers under the linked hash
- **THEN** the finding fail rate outcome reads undetermined with `n = 4`

#### Scenario: Effect on the wrong side
- **WHEN** a reviewers proposal expects first-pass yield to rise
- **THEN** the outcome compares the team's windows before and after the link and is labeled not attributed to the reviewer hash

### Requirement: Unproposed changes are visible
The Metrics tab and report reads SHALL list version changes in the window that no current link of an accepted proposal names, with the group or file, the previous and new hash, and when the change happened. Kawai SHALL detect these, not prevent them.

#### Scenario: Prompt edited without a proposal
- **WHEN** `lead.md` changes and no accepted proposal is linked to that version change
- **THEN** the change is listed as unproposed

#### Scenario: Unannounced return to an old version
- **WHEN** `lead.md` goes back to an earlier hash with no linked proposal
- **THEN** that return is listed as unproposed

### Requirement: Reports are listed with their freshness
The Metrics tab SHALL list reports newest first with window, author, summary, frozen snapshot, and proposals with their state, and SHALL show the latest report per window and its age. `process_reports_list` and `process_report_get` SHALL return the same to any team member.

#### Scenario: Missed daily report
- **WHEN** no 1d report was submitted for 30 hours
- **THEN** the tab shows the latest 1d report's age as 30 hours
