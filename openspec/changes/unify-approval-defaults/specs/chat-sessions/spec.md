## ADDED Requirements

### Requirement: New chats start from their team's default approval policy
The New Session dialog SHALL seed its Auto-approve checkbox from the default of the team owning the picked project path, and manual when the path has no team, the team has no default, or the lookup fails. The user SHALL be able to override it. A chat made by `/clear`, `/reset`, or `/new` keeps the previous chat's policy. Settings SHALL have no approval control and SHALL say the default is set per team on the Team page. No default change SHALL alter an existing session.

#### Scenario: Team default seeds new chats
- **WHEN** the team owning the picked project path has the default auto and the user creates a chat session without touching Auto-approve
- **THEN** the session starts with the auto policy and its tool uses are granted without approval cards

#### Scenario: Creation dialog overrides the team default
- **WHEN** the team default is auto and the user creates a chat session with Auto-approve unchecked
- **THEN** the session starts with the manual policy

#### Scenario: A path without a team default seeds manual
- **WHEN** the picked project path belongs to no team, or to a team whose default was never set
- **THEN** the Auto-approve checkbox starts unchecked and says no team default applies

#### Scenario: Changing the path re-seeds an untouched checkbox
- **WHEN** the user picks a path in a team whose default is auto and then picks a path in a team with no default, without touching Auto-approve
- **THEN** the checkbox follows each path's default and ends unchecked; once the user has toggled it, a path change leaves it as the user set it

#### Scenario: A team default change does not touch existing sessions
- **WHEN** the human changes a team's default approval policy while chat sessions of that team exist
- **THEN** every existing session keeps the policy it already had

#### Scenario: A create request without a policy stays manual
- **WHEN** a client creates a chat session without naming an approval policy
- **THEN** the session starts with the manual policy regardless of any team default

#### Scenario: Settings has no approval control
- **WHEN** the user opens Settings → Chat
- **THEN** it offers no approval policy control and says the default approval policy is set per team on the Team page's Members tab

#### Scenario: A browser's stored value is ignored
- **WHEN** a browser kept an approval policy from an earlier Settings version and the user opens the New Session dialog for a path whose team has no default
- **THEN** Auto-approve starts unchecked, and no team default is set from the stored value

## REMOVED Requirements

### Requirement: Users configure the default approval policy for new chat sessions
**Reason**: The browser-local Settings default duplicated the team default, applied to only one kind of session, and was lost with the browser's storage.
**Migration**: The team default on the Team page's Members tab seeds the New Session dialog instead; see "New chats start from their team's default approval policy". A stored browser value is ignored and not carried over.
