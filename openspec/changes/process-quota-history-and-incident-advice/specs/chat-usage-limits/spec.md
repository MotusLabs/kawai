# Spec Delta

## ADDED Requirements

### Requirement: Background quota observation is bounded and credential-safe
Background observation SHALL poll each effective account configuration at most once at a time, with a request timeout, jitter, and bounded backoff after failures, and SHALL stop when its last reason is removed. It SHALL resolve credentials in memory only and SHALL NOT persist a response body, an error text containing credentials, or a credential. It SHALL NOT start an agent, make a model request, or change a login.

#### Scenario: Shared account polled once
- **WHEN** two teams list workers whose providers resolve to the same effective account configuration
- **THEN** one request at a time is made for that account, and both teams' histories receive the observation

#### Scenario: Failing reader backs off
- **WHEN** a standalone reader fails three times in a row
- **THEN** each next request waits longer, up to the backoff bound, and the held windows keep their original observation times

#### Scenario: Removing the last reason stops polling
- **WHEN** the last configured team drops a provider that has no started session
- **THEN** no further quota requests are made for it

#### Scenario: Refused credentials are not stored
- **WHEN** a background request is refused for authentication
- **THEN** the observation records an auth-refused outcome without the response body or any credential, and no agent or login is started
