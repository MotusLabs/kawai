## MODIFIED Requirements

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

#### Scenario: Usage reported only at the end of a request's stream
- **WHEN** a session's provider reports zero usage when a model request starts and reports the request's real token counts only in that request's final stream update, as GLM profiles do
- **THEN** the reported used-token count comes from those final counts, and a context meter shows for the session once a threshold is known, rather than staying empty

#### Scenario: A partial final update does not lower the reading
- **WHEN** a model request's start already reported its input and cache token counts and its final stream update carries only the output token count
- **THEN** the reported used-token count keeps the start's input and cache counts plus the final output count, and does not drop to the output count alone

#### Scenario: Subagent requests do not move the reading
- **WHEN** a subagent spawned by the session streams its own model requests, including final usage updates
- **THEN** the session's reported used-token count is unchanged by them
