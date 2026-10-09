# Spec Delta

## ADDED Requirements

### Requirement: Users configure the default approval policy for new chat sessions
The system SHALL let the user choose the approval policy new chat sessions
start with, from Settings, and SHALL apply it at creation unless the user
overrides it in the New Session dialog. The stored default SHALL NOT change
the policy of any existing session.

#### Scenario: Settings default seeds new chats
- **WHEN** the user sets the default approval policy to auto and then creates a chat session
- **THEN** the session starts with the auto policy and its tool uses are granted without approval cards

#### Scenario: Creation dialog overrides the default
- **WHEN** the default approval policy is auto and the user creates a chat session with Auto-approve unchecked
- **THEN** the session starts with the manual policy

#### Scenario: The default does not touch existing sessions
- **WHEN** the user changes the default approval policy while chat sessions exist
- **THEN** every existing session keeps the policy it already had

#### Scenario: Unspecified policy creates a manual session
- **WHEN** a client creates a chat session without naming an approval policy
- **THEN** the session starts with the manual policy regardless of the stored default

## MODIFIED Requirements

### Requirement: Chat sessions have a per-session approval policy
Each chat session SHALL have an approval policy of either manual or auto.
A new chat session SHALL start with the policy supplied at its creation, or
manual when none is supplied. A session's profile SHALL NOT choose its policy.
The policy SHALL be stored with the session and SHALL be kept across server
restarts, conversation resume, archive, and restore. Sessions created before
this feature SHALL behave as manual.

#### Scenario: New chat starts manual
- **WHEN** a user creates a chat session with any profile and no approval policy supplied
- **THEN** the session's approval policy is manual and tool approvals show approval cards

#### Scenario: New chat starts with the supplied policy
- **WHEN** a user creates a chat session with the auto policy
- **THEN** the session's approval policy is auto and its tool uses are granted without approval cards

#### Scenario: Policy survives restart
- **WHEN** a chat session's policy is auto and the server restarts
- **THEN** the session is listed with the auto policy and its next tool approval is granted without a card

#### Scenario: Policy survives archive and restore
- **WHEN** a chat session with the auto policy is archived and later restored
- **THEN** the restored session still has the auto policy

#### Scenario: Legacy session defaults to manual
- **WHEN** the server loads a chat session stored before approval policies existed
- **THEN** the session's approval policy is manual
