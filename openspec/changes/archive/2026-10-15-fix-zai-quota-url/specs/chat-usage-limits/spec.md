# Spec Delta

## MODIFIED Requirements

### Requirement: Provider plan usage is pulled from the provider quota endpoint
When a session's profile has a provider base URL, the server SHALL fetch coding-plan usage from `/api/monitor/usage/quota/limit` at that URL's origin, using the session's effective credentials, without waiting for a turn. Model API paths, queries, and fragments SHALL NOT enter the quota URL. Only a matching quota response SHALL produce provider window data, marked with its own usage source; failures SHALL leave the session undisturbed.

#### Scenario: API-key gateway profile shows provider usage
- **WHEN** a session's profile routes through a base URL that serves the quota endpoint and authenticates with an API key with no host login
- **THEN** the usage bar shows the provider's plan windows once the session's agent has started

#### Scenario: Non-matching response records no data
- **WHEN** the quota endpoint answers with an auth refusal, an error, or a body without the usage shape
- **THEN** no provider window data is recorded, the chat session is undisturbed, and any host-account windows follow the separate fallback rules

#### Scenario: Provider report is marked
- **WHEN** plan usage is obtained from the quota endpoint
- **THEN** the report carries a usage source distinct from pushed, reported, and SDK-pulled reports

#### Scenario: Default route is never probed
- **WHEN** a session's profile has no provider base URL
- **THEN** no quota request is ever made for that profile

#### Scenario: Model API path does not prefix the quota endpoint
- **WHEN** the effective provider base URL is `https://gateway.example/api/anthropic`
- **THEN** the quota request goes to `https://gateway.example/api/monitor/usage/quota/limit`, with the same effective credentials

#### Scenario: Scheme and port are preserved while unrelated URL parts are discarded
- **WHEN** the effective provider base URL is `http://gateway.example:8080/api/anthropic/?route=glm#model`
- **THEN** the quota request goes to `http://gateway.example:8080/api/monitor/usage/quota/limit`

## ADDED Requirements

### Requirement: Quota failures distinguish missing routes from authentication refusals
Quota authentication refusals SHALL suppress the host-login SDK usage fallback. Missing routes, non-provider responses, and service or transport failures SHALL preserve that fallback. A JSON `success: false` alone SHALL NOT establish an authentication refusal. HTTP 200 with `{ "success": false, "code": 500, "msg": "404 NOT_FOUND" }` SHALL be treated as a missing route. Failed quota pulls SHALL NOT create provider windows or erase a held report.

#### Scenario: Wrapped missing route permits fallback
- **WHEN** the quota endpoint returns HTTP 200 with `{ "success": false, "code": 500, "msg": "404 NOT_FOUND" }`
- **THEN** the host-login SDK usage fallback is allowed, no provider windows are invented, and the failure is not treated as bad credentials

#### Scenario: Ordinary missing route permits fallback
- **WHEN** the quota endpoint returns HTTP 404 or 405
- **THEN** the host-login SDK usage fallback is allowed

#### Scenario: Explicit authentication refusal suppresses fallback
- **WHEN** the quota endpoint returns HTTP 401 or 403, or an HTTP 200 failure envelope with authentication code 401, 403, or 1001
- **THEN** no host-login SDK usage fallback runs, and an initially empty profile shows no usage bar

#### Scenario: Unknown or service failure is not an authentication refusal
- **WHEN** the quota endpoint returns HTTP 200 with `success: false` and an unknown or service-error code, without a recognized missing-route signal
- **THEN** the host-login SDK usage fallback is allowed and no provider windows are recorded

#### Scenario: Failed refresh keeps a held provider report
- **WHEN** a previously successful provider profile's scheduled refresh fails
- **THEN** its held report remains unchanged and no host-login report is substituted by that refresh
