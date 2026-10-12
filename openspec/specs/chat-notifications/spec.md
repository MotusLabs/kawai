# chat-notifications Specification

## Purpose

Show chat users the warnings the interactive Claude CLI would show them, such as an expiring login or agent runtime notices, so problems that need action are visible in Kawai chat sessions without opening a terminal.

## Requirements

### Requirement: Expiring logins produce an account notice per profile
The system SHALL check each Claude profile's stored CLI login using the same environment that profile's agent receives. When the login uses stored first-party credentials and the refresh token expires within 3 days, the profile SHALL hold a warning notice, `Your login expires in N day(s)`, where N is the remaining days rounded up. A hint SHALL say to renew with `/login` in a Claude terminal.

#### Scenario: Login expires in under two days
- **WHEN** the default profile's stored login has a refresh token expiring 1.4 days from now
- **THEN** the default profile holds a warning notice reading "Your login expires in 2 days" with the renewal hint

#### Scenario: Login expires in less than a day
- **WHEN** the refresh token expires 5 hours from now
- **THEN** the notice reads "Your login expires in 1 day"

#### Scenario: Login is not close to expiry
- **WHEN** the refresh token expires more than 3 days from now
- **THEN** the profile holds no login notice

#### Scenario: Login already expired
- **WHEN** the refresh token's expiry time has passed
- **THEN** the profile holds no login notice, matching the CLI

#### Scenario: Access token outlives the refresh window
- **WHEN** the stored access token expires more than 3 days after the refresh token
- **THEN** the profile holds no login notice

#### Scenario: Profile authenticates without the stored login
- **WHEN** the profile's environment supplies an API key, an auth token, or an OAuth token, or selects a cloud provider (Bedrock, Vertex, or Foundry)
- **THEN** the profile holds no login notice, even if a stored login exists

#### Scenario: Profile uses its own config directory
- **WHEN** a profile's environment points the CLI config directory at a different location
- **THEN** that profile's notice is computed from the credentials in that location, independent of other profiles

#### Scenario: No readable credentials
- **WHEN** the credentials file is missing, unreadable, malformed, or has no refresh-token expiry
- **THEN** the profile holds no login notice and no error is shown

### Requirement: Account notices stay current
The system SHALL re-check a profile's login when an agent of that profile starts, when a client attaches to a session of that profile, and at least hourly while any session of that profile has an attached client. A notice SHALL update when the day count changes and SHALL disappear once the login no longer meets the condition.

#### Scenario: User renews the login
- **WHEN** a profile shows a login notice and the user runs `/login` in a terminal, extending the refresh token
- **THEN** after the next check the notice is no longer shown for that profile's sessions

#### Scenario: Day count rolls over
- **WHEN** a login notice reads "2 days" and a later check finds less than one day remaining
- **THEN** the notice reads "1 day"

#### Scenario: Sessions share a profile
- **WHEN** two chat sessions use the same profile and that profile holds a login notice
- **THEN** both sessions show the notice

### Requirement: Agent notifications become session notices
The system SHALL turn each notification the agent emits into a notice for that chat session. The notice SHALL carry the agent's key, text, and priority, and a severity taken from the agent's color, defaulting to info. A notification whose key matches an active notice of the session SHALL replace it. Notices from one session SHALL NOT appear in other sessions.

#### Scenario: Context-window cap warning
- **WHEN** the agent emits a notification with key `model-context-window`, a warning color, and its text
- **THEN** the session shows a warning notice with that text

#### Scenario: Error notification
- **WHEN** the agent emits "Error compacting conversation" with an error color
- **THEN** the session shows it as an error notice

#### Scenario: Same key again
- **WHEN** the agent emits a second notification with the key of a notice still shown
- **THEN** the session shows only the newer notice

#### Scenario: Another session
- **WHEN** session A's agent emits a notification
- **THEN** session B, even on the same profile, does not show it

### Requirement: Agent notices expire
An agent notice with a timeout from the agent SHALL disappear once that timeout elapses after it arrived. An agent notice without a timeout SHALL stay until the user closes it or the session's agent process ends. All agent notices of a session SHALL be cleared when its agent process ends, including archive, kill, and restart.

#### Scenario: Timed notice
- **WHEN** the agent emits a notification with a 15-second timeout
- **THEN** the notice disappears 15 seconds after it arrived

#### Scenario: Untimed notice
- **WHEN** the agent emits a notification without a timeout
- **THEN** the notice stays shown until closed or the agent ends

#### Scenario: Chat is archived
- **WHEN** a session showing agent notices is archived
- **THEN** its agent notices are gone, and the archived chat shows none

### Requirement: Notices reach attached clients
The chat snapshot SHALL include the session's active notices: its profile's account notices followed by its own agent notices. The full list SHALL be pushed to every attached client when it changes. Notices SHALL be held in server memory only, never persisted, never sequenced into or replayed from the transcript, and never part of the session-list status.

#### Scenario: Reconnect
- **WHEN** a client attaches to a session with an active login notice and an agent notice
- **THEN** the snapshot it receives contains both

#### Scenario: Live update
- **WHEN** an agent notice arrives while a client is attached
- **THEN** the client shows it without reconnecting

#### Scenario: After a server restart
- **WHEN** the server restarts
- **THEN** agent notices from before the restart are gone, and account notices reappear only after a new check

#### Scenario: Transcript is unchanged
- **WHEN** a chat with notices is replayed from history
- **THEN** no notice appears as a transcript entry

#### Scenario: Older client
- **WHEN** a client that predates notices receives a snapshot or a notices push
- **THEN** it ignores them and keeps working

### Requirement: The chat view shows a notification strip
The chat view SHALL show active notices in a strip directly under the chat header. Each notice SHALL be one line with its text and hint, styled by severity: warning and error visibly distinct from info. Higher-priority notices SHALL come first. The strip SHALL NOT render when the session has no active notices. It SHALL render for archived chats only for account notices.

#### Scenario: Login notice shown
- **WHEN** a chat session's profile holds a login notice
- **THEN** the strip shows "Your login expires in 2 days · run /login in a Claude terminal to renew" in warning style

#### Scenario: No notices
- **WHEN** a session has no active notices
- **THEN** no strip is shown and the layout is unchanged

#### Scenario: Several notices
- **WHEN** a session has an immediate-priority error notice and a high-priority warning notice
- **THEN** the error notice is listed first

### Requirement: Users can close a notice
Each notice in the strip SHALL have a close control. Closing an agent notice SHALL remove it for that session on the server. Closing an account notice SHALL hide it in that browser tab only, until its text changes or the page reloads; other sessions and clients keep showing it.

#### Scenario: Close an agent notice
- **WHEN** the user closes an agent notice in one tab
- **THEN** the notice is removed from that session in every attached client

#### Scenario: Close the login notice
- **WHEN** the user closes the login notice
- **THEN** it stays hidden in that tab until the day count changes or the page reloads
