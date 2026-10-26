# Spec Delta

## ADDED Requirements

### Requirement: The New Session dialog names agent sessions independently of runtime
The New Session dialog SHALL display `AI agent` as the Session kind option for agent-backed chat sessions, for every supported agent runtime. The Terminal option, profile selection, session creation behavior, and entry-point defaults SHALL retain their existing behavior.

#### Scenario: Shared agent session choice
- **WHEN** a user opens the New Session dialog
- **THEN** the Session kind selector offers `AI agent` and `Terminal`, and the agent option is not labeled `Claude chat` or `Chat`

#### Scenario: Claude and Codex share the label
- **WHEN** a user selects either a Claude or Codex profile under the agent session kind
- **THEN** the Session kind option continues to read `AI agent` and creation uses the selected profile's runtime

#### Scenario: Existing entry-point defaults
- **WHEN** the dialog opens from a generic entry point or a change-section entry point
- **THEN** it retains the existing agent or Terminal preselection for that entry point, with the agent option displayed as `AI agent`
