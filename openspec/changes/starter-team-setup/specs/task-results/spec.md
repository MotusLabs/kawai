## ADDED Requirements

### Requirement: A result records its author's profile
When an agent submits a result, the server SHALL record the submitting session's profile id with it, taken from the session record, never from tool input. A result submitted before this record existed SHALL resolve its author's profile from the submitting session's record, archived or not; a result submitted by the human SHALL have no author profile.

#### Scenario: The profile is recorded at submission
- **WHEN** a developer on profile `opus` submits a result
- **THEN** the stored result names profile `opus`

#### Scenario: The author profile survives release
- **WHEN** the developer who submitted a result is released and its session record later removed
- **THEN** the result still names its author's profile

#### Scenario: An older result falls back to the session record
- **WHEN** a result stored without a profile was submitted by an archived `codex-sol` session
- **THEN** its author profile resolves to `codex-sol`
