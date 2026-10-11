# Spec Delta

## Purpose

Surfaces the agents a chat session spawned — their identity, live status, and own transcript — so a fleet of background workers is visible in the chat view instead of hiding behind a launch receipt.

## ADDED Requirements

### Requirement: Each spawned worker is tracked by its Agent tool call
The system SHALL track every agent a chat session spawns as a worker identified by the parent's tool-call id, carrying the agent type and description from that call and the spawn's nesting depth. The worker SHALL exist from the tool call until it settles.

#### Scenario: Worker is spawned
- **WHEN** a chat turn makes an Agent tool call that starts a worker
- **THEN** a worker is tracked for that tool-call id, carrying the agent type, description, and nesting depth of the spawn

#### Scenario: Worker is already running on reconnect
- **WHEN** a client attaches to a chat session that has running workers
- **THEN** the snapshot lists those workers with their identity and running status

### Requirement: A worker has a lifecycle status
A tracked worker SHALL have a status of running, completed, failed, or stopped. Only that worker's own completion, failure, or stop SHALL write a settled status, and its final result SHALL be the recorded outcome. A report that the worker is no longer among the running work MUST NOT write a settled status. Status changes SHALL reach every attached client.

#### Scenario: Worker completes
- **WHEN** a worker finishes its work normally
- **THEN** its status becomes completed and every attached client sees it

#### Scenario: Worker fails or is stopped
- **WHEN** a worker ends in failure or is stopped before finishing
- **THEN** its status becomes failed or stopped respectively

#### Scenario: The running-set report precedes the worker's own result
- **WHEN** the running work is reported without a worker and that worker's completion arrives afterwards
- **THEN** the worker's status becomes completed from its own result and is not stopped from the earlier report

### Requirement: A worker's liveness is tracked apart from its outcome
The system SHALL track separately from its lifecycle status whether a worker is currently running. A worker with no settled status that is no longer reported among the running work SHALL NOT be listed in the live strip and SHALL NOT hold the session at working, and its row SHALL show no settled outcome until one arrives.

#### Scenario: Worker leaves the running set before its result
- **WHEN** a worker is no longer reported among the running work and has not yet reported its result
- **THEN** the live strip omits it, the session is not held at working, and its row shows no settled outcome

#### Scenario: Its result then arrives
- **WHEN** that worker's result arrives after it left the running set
- **THEN** its row shows the settled outcome and summary

### Requirement: Worker inner traffic stays out of the parent transcript
A worker's own tool calls, tool results, and assistant text SHALL NOT be emitted as top-level conversation events, except for the `Agent` and `Task` calls that spawn that worker's own children, which are emitted so those children have a row. The worker's body is reached by expanding its row.

#### Scenario: Worker runs a tool
- **WHEN** a running worker invokes a tool such as Bash or Read
- **THEN** no tool-call or tool-result entry for it appears as a top-level transcript entry

#### Scenario: Worker writes text
- **WHEN** a running worker produces assistant text
- **THEN** no assistant-message entry for it appears in the parent transcript

#### Scenario: Worker spawns its own worker
- **WHEN** a running worker makes an Agent tool call that starts a nested worker
- **THEN** that Agent tool call appears as a top-level transcript entry, and the nested worker's other tool calls and text do not

### Requirement: The Agent tool call renders as a worker summary row
In the chat view, a tool call that spawned a worker SHALL render as a worker summary row naming the agent type, description, current status, elapsed time since the call, and the most recent tool the worker ran, rather than as a collapsed tool card. Rows for workers of every depth SHALL sit as siblings in the parent transcript, and spawns below the top level SHALL be marked with their nesting depth.

#### Scenario: Running worker row
- **WHEN** a worker spawned by the parent is running and has just invoked Bash
- **THEN** its row shows the agent type, description, a running status, an elapsed time that increases, and Bash as the last tool

#### Scenario: Nested worker is marked
- **WHEN** a worker was spawned from inside another worker
- **THEN** its row sits alongside the top-level rows in the parent transcript and carries a depth marker showing it is below the top level

#### Scenario: Unknown worker tool
- **WHEN** a worker has not yet invoked any tool
- **THEN** its row shows the agent type, description, status, and elapsed time without a last-tool name

### Requirement: Expanding a worker row shows the worker's own transcript
Expanding a worker summary row SHALL show that worker's conversation — its prompt, tool activity, and assistant text — read from the worker's own on-disk transcript for the chat session's SDK session. The expanded body SHALL be available while the worker is running and after it settles.

#### Scenario: Expand a running worker
- **WHEN** the user expands a worker row while that worker is still running
- **THEN** the worker's transcript so far is shown, up to what has been written

#### Scenario: Expand a finished worker
- **WHEN** the user expands a worker row after the worker has settled
- **THEN** the worker's complete transcript is shown

#### Scenario: Worker transcript is missing
- **WHEN** a worker's on-disk transcript cannot be found or read
- **THEN** the expanded row reports that the body is unavailable rather than showing another worker's transcript or failing the chat view

### Requirement: A worker's outcome persists on its row
The system SHALL record a worker's identity when it spawns and its settled status and one-line result summary when it settles. Both SHALL survive server restart and reconnect: the row SHALL show the recorded outcome without a live worker, and the session SHALL NOT report the worker as running.

#### Scenario: Row after restart
- **WHEN** the server restarts after a worker completed
- **THEN** reopening the chat shows that worker's row with the completed status and its result summary

#### Scenario: Worker was running when the server died
- **WHEN** the server restarts after a worker was still running
- **THEN** that worker's row is still shown, with a stopped status and no result summary, and the session does not report it as running

#### Scenario: Reconnect does not resurrect a worker
- **WHEN** a client reconnects to a chat whose workers have all settled
- **THEN** no worker appears as running

### Requirement: A live strip lists running workers
While one or more workers of a chat session are currently running, the chat view SHALL show a strip above the transcript listing each of those workers with its agent type, description, last tool name, and elapsed time. The strip SHALL disappear when no worker is currently running, and SHALL NOT appear in archived chats.

#### Scenario: Two workers running
- **WHEN** a chat session has two currently running workers
- **THEN** the strip lists both, each with its own last tool and elapsed time

#### Scenario: Last worker leaves the running set
- **WHEN** no worker of a chat session is currently running any more
- **THEN** the strip is no longer shown

#### Scenario: Archived chat
- **WHEN** an archived chat is opened
- **THEN** no live strip is shown

### Requirement: Archived chats keep worker rows read-only
An archived chat SHALL keep every worker summary row with its persisted outcome, SHALL allow the row to be expanded to the worker's transcript, and SHALL NOT show a live strip or any running state. Opening or attaching to an archived chat MUST NOT start a worker or read one as live.

#### Scenario: Archived chat shows settled workers
- **WHEN** the user opens an archived chat that spawned workers
- **THEN** each worker row shows its persisted outcome and expands to its transcript, and nothing appears as running

#### Scenario: Archive while workers run
- **WHEN** a chat session with running workers is archived
- **THEN** the archived view shows those workers with a settled outcome recorded at archive time rather than a live running state
