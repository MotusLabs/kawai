# Spec Delta

## Purpose

Makes the background shell commands and Monitors that a chat session's agent starts visible and controllable from the chat view: whether each is still running, what it printed, how it ended, and a way to stop it.

## ADDED Requirements

### Requirement: Background shell and Monitor tasks are tracked per chat session
The system SHALL track each background shell or Monitor task a chat
session's agent starts. Each task is identified by its task id and linked
to the tool call that started it. A task the agent starts in the foreground
SHALL NOT be tracked unless it is later moved to the background. Agent
workers and housekeeping tasks the agent reports as ambient SHALL NOT be
tracked as background tasks.

#### Scenario: Background Bash command becomes a task
- **WHEN** the agent runs a `Bash` call with `run_in_background`
- **THEN** the chat session tracks a running background task linked to that call, labelled `Shell` with the call's description

#### Scenario: Monitor becomes a task
- **WHEN** the agent starts a `Monitor`
- **THEN** the chat session tracks a running background task linked to that call, labelled `Monitor` with the call's description

#### Scenario: Foreground command is not a task
- **WHEN** the agent runs a `Bash` call in the foreground and it finishes there
- **THEN** no background task is tracked for it, and its tool entry renders as before

#### Scenario: Command moved to the background becomes a task
- **WHEN** a foreground `Bash` command is moved to the background while it runs
- **THEN** from that point it is tracked as a running background task linked to its call

#### Scenario: Agents and ambient tasks are excluded
- **WHEN** the agent spawns an `Agent` worker, or starts a task it marks as ambient
- **THEN** no background task is tracked for it

### Requirement: A background task's tool entry shows its state
The tool entry of a call that started a background task SHALL show the
task's state: running with a ticking elapsed time, or its outcome —
completed, failed or stopped — with the one-line summary the agent
received, such as the exit code. A failed task SHALL be marked `✗`.

#### Scenario: Running task shows elapsed time
- **WHEN** a background task is running
- **THEN** its tool entry shows a running mark and an elapsed time that keeps advancing

#### Scenario: Completed task shows its summary
- **WHEN** a background task completes
- **THEN** its tool entry shows a completed mark and the reported summary, and the elapsed time stops

#### Scenario: Failed task is marked
- **WHEN** a background task fails
- **THEN** its tool entry shows `✗` and the reported summary

#### Scenario: Stopped task is marked stopped
- **WHEN** a background task is stopped by the user, by the agent, or because the agent process ended
- **THEN** its tool entry shows a stopped mark rather than running

### Requirement: Users can read a background task's recent output
Expanding a background task's tool entry SHALL show the end of the task's
output (at most the last 8 KiB) as plain text below the tool result,
noting when earlier output was cut off. While the task runs and the entry
is expanded, the output SHALL refresh periodically. When no output can be
read, the entry SHALL say so instead of showing an empty panel.

#### Scenario: Expanded running task refreshes its output
- **WHEN** the user expands the entry of a running background task that is printing output
- **THEN** the latest output appears below the tool result and keeps updating while the entry stays expanded

#### Scenario: Long output is marked as truncated
- **WHEN** a task's output exceeds 8 KiB
- **THEN** the panel shows only the last 8 KiB and indicates that earlier output was omitted

#### Scenario: Ended task shows its final output
- **WHEN** the user expands the entry of a task that has ended and whose output is still on disk
- **THEN** the final output tail is shown and no longer refreshes

#### Scenario: Output no longer available
- **WHEN** the user expands a task whose output can no longer be read
- **THEN** the entry states the output is unavailable

#### Scenario: Output is not rendered as markup
- **WHEN** the output contains escape sequences or HTML-like text
- **THEN** it is shown as plain text and never interpreted as markup

### Requirement: Users can stop a single background task
While a background task is running in a live chat session, the chat view
SHALL offer a Stop control for that task. Stopping SHALL end only that
task: the in-flight turn, other background tasks, and agent workers SHALL
continue. Archived chats SHALL NOT offer Stop.

#### Scenario: Stop ends one task
- **WHEN** the user stops one of two running background tasks
- **THEN** that task is reported stopped, and the other task and any in-flight turn keep running

#### Scenario: Stop is offered only while running
- **WHEN** a background task has ended, or the chat is archived
- **THEN** no Stop control is shown for it

#### Scenario: Stop of an already-ended task is harmless
- **WHEN** a Stop request arrives for a task that has just ended
- **THEN** the task keeps its reported outcome and no error is shown in the transcript

### Requirement: Running background tasks appear in the live strip
While any background task is running, the live strip above the transcript
SHALL list it, alongside running agent workers: its label (`Shell` or
`Monitor`), description, elapsed time and a Stop control. A task SHALL
leave the strip as soon as it ends. The strip SHALL be hidden in archived
chats.

#### Scenario: Running task is listed
- **WHEN** a background task starts running
- **THEN** the live strip shows a row with its label, description, and ticking elapsed time

#### Scenario: Ended task leaves the strip
- **WHEN** the task completes, fails or is stopped
- **THEN** its row disappears from the live strip, and the strip hides when nothing else is running

### Requirement: Background tasks do not change session status
A running background task SHALL NOT keep a chat session in the `working`
status. Once its turn ends, a session whose only running work is
background shells or Monitors SHALL report `waiting`, as an idle session
does.

#### Scenario: Session waits while a task runs
- **WHEN** a turn ends while a background shell started in it is still running
- **THEN** the session is reported as `waiting` in the session list

### Requirement: Background task state survives reconnect, restart and archive
Clients SHALL receive the current background task list when they attach
and whenever it changes. A task's identity and outcome SHALL persist
across server restart, resume, archive and restore. A task that was
running when its agent process ended SHALL be shown as stopped.

#### Scenario: Reconnect restores task state
- **WHEN** a client reconnects while a background task runs
- **THEN** the task's tool entry and live-strip row show it running with the correct elapsed time

#### Scenario: Restart keeps outcomes
- **WHEN** the server restarts after a background task completed
- **THEN** the replayed tool entry still shows the completed outcome and summary

#### Scenario: Restart settles running tasks as stopped
- **WHEN** the server restarts while a background task was running
- **THEN** the task is shown as stopped, not running

#### Scenario: Archived chat shows outcomes read-only
- **WHEN** the user opens an archived chat that had background tasks
- **THEN** each task's outcome is shown, its output tail can be read while its output file still exists, and no Stop control is offered
