## MODIFIED Requirements

### Requirement: Profiles preserve chat permissions and credential privacy
Selecting a profile SHALL preserve the chat approval flow: a profile SHALL NOT change a session's approval policy, and only the user's explicit per-session policy choice SHALL let tool uses run without approval cards. Profile discovery and session metadata SHALL expose identifiers and labels without credentials. Authentication checks SHALL use the effective server-side environment, accepting configured API-key or auth-token credentials or existing CLI login credentials, and SHALL refuse creation without configured authentication.

#### Scenario: Wrapper permission flag is not imported
- **WHEN** a named profile's source wrapper launches Claude with dangerously-skip-permissions
- **THEN** a new session with that profile starts with the manual approval policy and chat tool uses still follow the existing approval flow

#### Scenario: User-chosen auto policy applies to any profile
- **WHEN** the user switches a named profile session to the auto approval policy
- **THEN** its tool approvals are granted without cards exactly as for a Default profile session

#### Scenario: Gateway token authentication
- **WHEN** the backend has an ANTHROPIC_AUTH_TOKEN and a user creates a named profile session
- **THEN** creation passes the configured-authentication check without requiring an additional API key

#### Scenario: Credentials remain server-side
- **WHEN** a client requests profiles or session metadata
- **THEN** it receives no authentication secret or environment map
