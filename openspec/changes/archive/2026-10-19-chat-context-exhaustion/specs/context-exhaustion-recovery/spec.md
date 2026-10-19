# Spec Delta

## Purpose

Detects a chat session whose context is exhausted, stops it from silently swallowing work, settles the work it dropped, and asks whoever dispatched that work, or the human, to decide how to continue.

## ADDED Requirements

### Requirement: Exhausting terminal reasons flag the session
A turn that ends failed with terminal reason `prompt_too_long`, `blocking_limit`, or `rapid_refill_breaker` SHALL flag its session as context-exhausted, recording the time and the reason. The flag SHALL persist across server restart, archive, and restore. Other failures SHALL NOT set it.

#### Scenario: Prompt too long
- **WHEN** a turn's result has `is_error: true` and terminal reason `blocking_limit`
- **THEN** the session is flagged context-exhausted with reason `blocking_limit`

#### Scenario: Ordinary failure
- **WHEN** a turn fails with terminal reason `api_error`
- **THEN** the session is not flagged

#### Scenario: Restart
- **WHEN** the server restarts while a session is flagged
- **THEN** the session is still flagged

### Requirement: The flag clears when context is recovered
The flag SHALL clear when the session's agent reports a compaction boundary, or when a later turn of the session completes successfully. Archive, restore, and attach alone SHALL NOT clear it.

#### Scenario: Human compacts
- **WHEN** the human restores a flagged session and runs `/compact`, and the agent reports a compaction boundary
- **THEN** the flag clears

#### Scenario: Restore alone
- **WHEN** the human restores a flagged archived session
- **THEN** the session is still flagged

### Requirement: Context exhaustion is not a provider limit
Flagging a session SHALL NOT record a limit event, cool any profile or provider, park or forward work through limit outcomes, or exclude the session's profile from any message.

#### Scenario: Other sessions of the profile
- **WHEN** a `glm-flash` session is flagged
- **THEN** other `glm-flash` sessions stay routable and no cooldown is reported

### Requirement: The dispatcher is asked to decide
When a session is flagged while bound to a task, kawai SHALL send one normal-priority direct note tagged `context-exhausted` with that task to the dispatcher of the task's outstanding assignment, else to the task's creator. It SHALL send nothing when that recipient is the human, killed, archived, or itself flagged.

#### Scenario: Lead dispatched the work
- **WHEN** a dev spawned for a task the lead assigned is flagged
- **THEN** the lead receives one normal-priority `context-exhausted` note on that task

#### Scenario: Human dispatched the work
- **WHEN** the outstanding assignment was dispatched by the human
- **THEN** no note is sent, and the attention queue shows the item to the human

#### Scenario: Dispatcher itself exhausted
- **WHEN** the dispatcher session is flagged too
- **THEN** no note is sent to it, and the attention queue shows the item to the human

### Requirement: The decision note carries the facts to decide
The note SHALL name the flagged session, its worker, the terminal reason, the dropped message if any, the progress digest since that message's claim, the claim commit, and the session's current HEAD. It SHALL also state whether the task's current revision was acknowledged, and give the usage, reset times, and cooldowns of the providers of the session's group.

#### Scenario: Note contents
- **WHEN** the lead receives a `context-exhausted` note
- **THEN** it can read the dropped message id, the digest, the claim commit, HEAD, the acknowledgement state, and each provider's usage and cooldown without another call

### Requirement: Exhaustion appears in the attention queue
Each flagged episode SHALL produce one attention item with the session as source. It SHALL be listed under waiting on agents when a note went to a dispatcher session, and under needs you otherwise. It SHALL resolve when a newer dispatch on the task is made, the task closes, the dropped message is retried or discarded, the flag clears, or the session is killed.

#### Scenario: Lead decides
- **WHEN** the lead dispatches new task mail on the task after the note
- **THEN** the item resolves

#### Scenario: Human-created session
- **WHEN** a session the human created is flagged with no task
- **THEN** the item is listed under needs you until the flag clears or the session is killed

### Requirement: Kawai never compacts on its own
Kawai SHALL NOT send `/compact` or any other command to a flagged session on its own.

#### Scenario: Flagged session left alone
- **WHEN** a session is flagged
- **THEN** no turn is started in it by kawai
