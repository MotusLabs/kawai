# Spec Delta

## ADDED Requirements

### Requirement: Chat views show distance to auto-compaction
The chat view header SHALL show how much of the session's auto-compaction
budget the conversation has used, as a percentage together with the used and
auto-compaction-threshold token counts. The reading SHALL be absent until the
session has produced a model request, rather than showing a zero reading.

#### Scenario: Meter appears after the first model request
- **WHEN** a chat session completes its first model request
- **THEN** the chat view header shows the used token count, the auto-compaction-threshold token count, and the percentage of that threshold in use

#### Scenario: No meter before any model request
- **WHEN** a chat session has not yet produced a model request
- **THEN** the chat view header shows no context meter

#### Scenario: Meter coexists with header chrome
- **WHEN** a chat view is open for a live session that has produced a model request
- **THEN** the context meter is shown beside the session status and the profile, project path, and session controls remain present

### Requirement: Context usage tracks the conversation as it grows
The reported used-token count SHALL follow the conversation's prompt size as
the turn proceeds, updating when each new model request's usage is observed,
so the reading moves during a long turn and not only at turn completion.

#### Scenario: Reading grows during a multi-step turn
- **WHEN** a turn makes several model requests in sequence, each with a larger prompt than the last
- **THEN** the reported used-token count rises after each request rather than only when the turn completes

#### Scenario: Reading is the current prompt, not cumulative traffic
- **WHEN** a turn has made many model requests so the session's cumulative token counts far exceed the window
- **THEN** the reported used tokens stay within the session's context window and describe the latest request's prompt size

### Requirement: Compaction resets the reported context usage
When the agent compacts the conversation and the post-compaction size is
known, the system SHALL report that size at the moment the compaction is
signalled, so the meter drops alongside the compaction notice rather than
waiting for the next model request. When the post-compaction size is not
known, the system SHALL retain the previous reading.

#### Scenario: Meter drops when the conversation auto-compacts
- **WHEN** a running conversation reaches its auto-compaction threshold and auto-compaction summarises it, and the post-compaction size is known
- **THEN** the reported context usage falls to the post-compaction size when the compaction is signalled to the chat view

#### Scenario: Manual compaction drops the meter too
- **WHEN** the conversation is compacted explicitly rather than by auto-compaction, and the post-compaction size is known
- **THEN** the reported context usage falls to the post-compaction size in the same way

#### Scenario: Unknown post-compaction size keeps the prior reading
- **WHEN** a compaction is signalled without a usable post-compaction size
- **THEN** the reported context usage retains its previous value, and no zero, undefined, or placeholder reading is published

### Requirement: Context usage is measured against the auto-compaction threshold
The percentage and threshold token count SHALL use the session's
auto-compaction threshold — the used-token count at which its conversation
would be compacted — rather than the model's full context window, so a
session nearing compaction reports a high percentage.

#### Scenario: Autocompact reserve is excluded from the threshold
- **WHEN** a session whose context window is 200000 tokens holds a 33000-token autocompact reserve and has 157900 tokens in use
- **THEN** its threshold token count reads 167000 and its percentage reads about 95 rather than the 79 that the full window would give

#### Scenario: Configured window overrides the model window
- **WHEN** a chat session runs under a profile that configures a 100000-token auto-compaction window on a 200000-token model
- **THEN** its threshold token count reflects the configured 100000-token window rather than the model's 200000 tokens

### Requirement: Context usage survives restarts and archives
The latest context usage SHALL be stored with the chat session and kept
across server restarts, conversation resume, archive, and restore. A restored
session SHALL show its last known reading. An archived session SHALL show its
final reading as history and SHALL NOT refresh it.

#### Scenario: Reading survives server restart
- **WHEN** a chat session has reported a context usage and the server restarts before the next model request
- **THEN** the chat view shows the stored reading rather than an empty meter

#### Scenario: Archived chat keeps its final reading
- **WHEN** a chat session is archived after producing a context usage
- **THEN** opening the archived chat shows that reading and no later update

#### Scenario: Reading survives restore
- **WHEN** an archived chat session is restored
- **THEN** it shows its stored reading and the next model request updates it
