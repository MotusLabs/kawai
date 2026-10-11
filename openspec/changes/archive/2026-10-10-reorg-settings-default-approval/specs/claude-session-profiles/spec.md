# Spec Delta

## ADDED Requirements

### Requirement: Profiles contribute no approval behavior at creation
Creating a chat session with a named profile SHALL apply the user's
creation-time approval policy unchanged. A profile SHALL NOT add to, override,
or neutralize that policy, and a profile that names a permission-skipping
executable SHALL NOT cause a session to start with the auto policy.

#### Scenario: Named profile keeps the creation policy
- **WHEN** a user creates a chat session with a named profile and a creation-time approval policy
- **THEN** the session starts with exactly that policy and the profile contributes no approval behavior

#### Scenario: Default profile and named profiles behave the same
- **WHEN** a user creates one chat session with the Default profile and another with a named profile, both with the auto policy
- **THEN** both sessions start with the auto policy and grant tool uses without cards

## MODIFIED Requirements

### Requirement: Profiles preserve chat permissions and credential privacy
Selecting a profile SHALL preserve the chat approval flow for server-configured profiles: a profile SHALL NOT change a session's approval policy, and only a user-chosen approval policy — a settings default, a creation-time value, or a later per-session switch — SHALL let tool uses run without approval cards. Profile discovery and session metadata SHALL expose identifiers and labels without credentials. An executable named by a user-level catalog entry is trusted operator configuration; its flags are the operator's responsibility and SHALL remain unreachable from the client API. Authentication checks SHALL use the effective server-side environment, accepting configured API-key or auth-token credentials or existing CLI login credentials, and SHALL refuse creation without configured authentication.

#### Scenario: Wrapper permission flag is not imported
- **WHEN** a user-level catalog entry names an executable that launches Claude with a permission-skipping flag
- **THEN** the entry does not set the session's approval policy, the entry applies as trusted operator configuration for that profile, and clients still cannot supply executables, flags, or environment maps through the profile interface

#### Scenario: User-chosen auto policy applies to any profile
- **WHEN** the user switches a named profile session to the auto approval policy
- **THEN** its tool approvals are granted without cards exactly as for a Default profile session

#### Scenario: Catalog files carry no credentials
- **WHEN** catalog files are read, committed, or mounted
- **THEN** they contain only routing, model, attribution, and compaction configuration; credentials enter sessions only through the server environment layer

#### Scenario: Gateway token authentication
- **WHEN** the backend has an ANTHROPIC_AUTH_TOKEN and a user creates a named profile session
- **THEN** creation passes the configured-authentication check without requiring an additional API key

#### Scenario: Credentials remain server-side
- **WHEN** a client requests profiles or session metadata
- **THEN** it receives no authentication secret or environment map
