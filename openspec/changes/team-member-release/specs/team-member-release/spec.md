# Spec Delta

## Purpose

Frees team capacity held by spawned members whose work is over: kawai archives (never kills) a task's spawned members once the task closes and they have settled, and agents can release a settled spawned member on request unless their group opts out.

## ADDED Requirements

### Requirement: Closing a task releases its spawned members
When a task becomes `done` or `cancelled`, the system SHALL mark every live spawned session spawned for that task as pending release, whoever closed it. A pending member SHALL be archived as soon as it is ready. Sessions created by the human SHALL never be marked, nor spawned members of other tasks.

#### Scenario: Idle dev released when its task is done
- **WHEN** the lead marks a task `done` and the dev spawned for it is idle with no pending request or mail
- **THEN** the dev is archived and no longer counts as a live member

#### Scenario: Human-created member kept
- **WHEN** a task is cancelled and a human-created `devs` session has been working on it
- **THEN** that session stays live

#### Scenario: Another task's spawned member kept
- **WHEN** a task is done and a spawned member of a different, open task runs in the same group
- **THEN** that member stays live

### Requirement: A member still spawning at close is released
When a task closes while a member is being spawned for it, the system SHALL withdraw the spawn's reserved message so the new member never receives it. A session spawned for a task that is already `done` or `cancelled` when its spawn completes SHALL be marked pending release, unless its group opts out, and released once ready.

#### Scenario: Task closed while its dev is starting
- **WHEN** group mail for a task has reserved a spawn in worktree `feat-x` and the lead marks the task `done` before the new dev starts
- **THEN** the dev starts without receiving the task's message, is archived once its agent is idle, and `feat-x` no longer holds a live spawned member

### Requirement: A closed task's undelivered worktree mail is withdrawn
When a task is `done` or `cancelled`, its undelivered group mail (queued, awaiting a request, or reserved for a spawn) to a worktree-scoped group SHALL be dead-lettered with reason `task-closed`, at the close and whenever such mail later waits, and SHALL NOT be delivered or cause a spawn. Direct mail and mail to groups that opt out of worktree scoping SHALL be delivered as usual. A release SHALL NOT requeue mail for delivery.

#### Scenario: Queued instruction for a done task
- **WHEN** an instruction for a task waits in the `devs` queue and the human marks the task `done`
- **THEN** the instruction is dead-lettered `task-closed` and no dev is spawned for it

#### Scenario: Report to the lead still arrives
- **WHEN** the `lead` group sets `worktreeScoped: false` and a dev sends it a report for its task just after the task is marked `done`
- **THEN** the lead receives the report

#### Scenario: Group note to a scoped group after close
- **WHEN** a task is `done` and a member sends a `qa` group, which does not set `worktreeScoped`, a note referencing that task
- **THEN** the note is dead-lettered `task-closed`, no session is spawned, and it stays in the Mailbox, retryable once the task is reopened

### Requirement: Release waits until the member is ready
A member SHALL be ready for release only when it is idle in the sense mail delivery uses, has no pending approval or question, has no live background worker, holds no claimed or parked mail, and has no due direct mail queued for it. Every release path SHALL use this one definition. A pending member that is not ready SHALL be released once it becomes ready, without further action.

#### Scenario: Busy dev released after its turn
- **WHEN** a task is marked done while its dev is mid-turn writing a final report
- **THEN** the dev finishes the turn, its report is delivered, and then it is archived

#### Scenario: Pending approval holds the release
- **WHEN** a task is done while its dev awaits a tool approval
- **THEN** the dev is not archived until the approval is answered and its turn ends

#### Scenario: Live background worker holds the release
- **WHEN** a task is done while its dev is idle but a background worker it started is still running
- **THEN** the dev is not archived until the worker stops

#### Scenario: Queued direct mail is delivered first
- **WHEN** the lead closes a task and then sends its dev a closing direct message
- **THEN** the dev receives that message, finishes its turn, and is then archived

### Requirement: Pending releases survive restart
A pending release SHALL be durable. After a server restart, members still pending release SHALL be released when ready.

#### Scenario: Restart before the member settles
- **WHEN** a task is done while its dev is busy and the server restarts before the dev becomes idle
- **THEN** the dev is archived once it is ready after the restart

### Requirement: Reopening or restoring cancels the release
Setting a closed task's status to anything other than `done` or `cancelled` SHALL cancel its members' pending releases. A human restore of a released member SHALL keep it live; it SHALL NOT be released again until its task closes again.

#### Scenario: Task reopened before release
- **WHEN** a task is done while its dev is busy and the human reopens the task before the dev's turn ends
- **THEN** the dev is not archived

#### Scenario: Restored member stays
- **WHEN** the human restores a member that was released for a done task
- **THEN** it stays live after its next turns while the task remains done

### Requirement: Releases are journaled
Every release SHALL append an entry to the released member's task journal, authored by kawai, naming the session and the reason (task closed, or released by a named agent with its stated reason).

#### Scenario: Automatic release entry
- **WHEN** a dev is released because its task was marked done
- **THEN** the task journal shows a kawai-authored entry naming the dev and stating the task was closed

### Requirement: Release frees capacity immediately
A release SHALL archive the member through the same path as a human archive, keeping its record, conversation, and protocol log, so it stops counting toward group, profile, team spawn, and worktree caps. Waiting mail SHALL be re-evaluated right after.

#### Scenario: Queued task spawns after a release
- **WHEN** group mail for a new task waits because `devs` is at `max`, and a finished dev is released
- **THEN** a dev is spawned for the waiting mail without other activity

### Requirement: Groups can keep their members
A group file SHALL accept `releaseOnTaskClose: true|false` (default `true`). Spawned members of a group whose current file sets `false` SHALL NOT be released on task close. Any other value SHALL be reported and the file skipped, as for other invalid settings.

#### Scenario: Opted-out group
- **WHEN** the `qa` group sets `releaseOnTaskClose: false` and a task with a spawned `qa` member is done
- **THEN** the `qa` member stays live

### Requirement: Permitted agents can release spawned members
A group file SHALL accept `canReleaseMembers: true|false` (default `true`). Members of a group that has not opted out SHALL be able to release a spawned member of their own team with a `release_member` tool, giving a session id and an optional reason; it archives at once. The tool SHALL be allowed without an approval card.

#### Scenario: Lead releases a finished dev
- **WHEN** a member of the `lead` group, which does not opt out, releases an idle spawned dev with reason "merged"
- **THEN** the dev is archived and its task journal records the release by that lead with reason "merged"

#### Scenario: Settled member of an open task
- **WHEN** the lead releases an idle spawned dev whose task is still `active` and whose instruction was delivered
- **THEN** the dev is archived, the task stays `active`, and its delivered instruction is left as it is

#### Scenario: Group without the right
- **WHEN** a `devs` member, whose group file sets `canReleaseMembers: false`, calls `release_member`
- **THEN** the tool returns an error saying its group has opted out of releasing members, and nothing is archived

### Requirement: Agent releases are refused unless safe
`release_member` SHALL refuse, with a reason and without archiving, when the target is the caller itself, a human-created session, a session of another team, an archived or unknown session, or a member that is not ready for release. Agents SHALL NOT be able to kill or restore sessions.

#### Scenario: Busy member refused
- **WHEN** the lead releases a dev that is mid-turn
- **THEN** the tool returns an error saying the dev is busy and the dev keeps working

#### Scenario: Member with a live background worker refused
- **WHEN** the lead releases an idle dev whose background worker is still running
- **THEN** the tool returns an error naming the live background worker, and nothing is archived

#### Scenario: Human-created session refused
- **WHEN** the lead releases the human-created reviewer session
- **THEN** the tool returns an error saying only spawned members can be released
