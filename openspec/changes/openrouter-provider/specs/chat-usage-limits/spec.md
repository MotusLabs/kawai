## ADDED Requirements

### Requirement: OpenRouter providers are pulled from the OpenRouter key endpoint
A session's provider whose base URL host is `openrouter.ai` or a subdomain of it has its own usage endpoint selected: the server SHALL fetch usage from `/api/v1/key` at that origin once for the provider, with the session's effective auth token, instead of the coding-plan quota endpoint. The quota-failure fallback rules SHALL NOT apply to such a provider: no quota request is made for it, and no failure of its own pulls SHALL enable the host-login usage pull.

#### Scenario: OpenRouter session starts
- **WHEN** an `openrouter-sonnet` session's agent starts and its provider holds no report
- **THEN** one request goes to `https://openrouter.ai/api/v1/key` with the session's key, and no request goes to `/api/monitor/usage/quota/limit`

#### Scenario: Key refused
- **WHEN** the key endpoint answers 401 or 403
- **THEN** no provider data is recorded, the session is undisturbed, and the usage bar never shows the host claude.ai account's plan for it

#### Scenario: Key endpoint missing or failing
- **WHEN** the key endpoint answers 404, a server error, or a body without the expected shape, or the request fails in transport
- **THEN** no provider data is recorded, no quota request is made, and the host-login usage pull stays suppressed for the provider
### Requirement: An OpenRouter key's caps and budgets render as meters
Each budget the key endpoint reports SHALL render as one usage-bar meter with its percent spent, its remaining dollars in the label, and its reset time when reported. A daily budget SHALL carry a 24-hour period and a weekly budget a 7-day period; monthly and non-resetting ones SHALL carry none. Without budgets, a key cap SHALL render as one meter. A key with neither SHALL produce no meter.

#### Scenario: Capped key
- **WHEN** the key endpoint reports a `key_limit` budget of $0.05 with $0.0489 remaining and no reset
- **THEN** the bar shows one meter "Key cap · $0.05 left" at about 2% used, with no reset time and no time marker

#### Scenario: Daily budget
- **WHEN** the key endpoint reports a daily budget of $5 with $1 spent and a reset at the next UTC midnight
- **THEN** the bar shows a 20% meter resetting at that time with a 24-hour time marker

#### Scenario: Uncapped key without a balance key
- **WHEN** the key endpoint reports no budgets and a null limit, and the provider names no balance key
- **THEN** no usage bar is shown for the provider's sessions

#### Scenario: Unknown budget scope
- **WHEN** a budget names a scope the server does not know
- **THEN** its meter is labelled with the raw scope value

### Requirement: Account credits render when a balance key is configured
When the provider's `balanceKeyEnv` variable is non-empty, the server SHALL also fetch `/api/v1/credits` with that value from the server process, and render one "Credits" meter showing the dollars left of the credits purchased. A refusal of this request SHALL drop only the credits meter, and SHALL be logged without the key.

#### Scenario: Management key configured
- **WHEN** credits report $40 purchased and $15.57 used
- **THEN** the bar shows a "Credits · $24.43 left" meter at about 39% used, beside any key meters

#### Scenario: Balance key is not a management key
- **WHEN** the credits request answers 403
- **THEN** the key meters still show, the credits meter is absent, and the log names the provider but not the key

### Requirement: An exhausted OpenRouter meter reports a limited status
An OpenRouter usage report SHALL have status limited when any of its meters has no dollars remaining, and allowed otherwise. It SHALL carry the provider usage source.

#### Scenario: Cap spent
- **WHEN** the key cap's remaining amount is 0
- **THEN** the provider's report status is limited

### Requirement: OpenRouter usage refreshes while sessions are live and after a costed turn
While at least one non-archived session of a provider whose own usage endpoint is selected has a started agent, the server SHALL re-pull that provider's usage on the same fixed cadence as quota-serving providers, once per provider, and SHALL stop when no session qualifies. A completed turn that carried a provider-reported cost SHALL also cause one more pull for its provider about 30 seconds later, at most once per provider per minute. Background quota observation SHALL NOT start these pulls.

#### Scenario: Balance change appears without a turn
- **WHEN** the owner tops up OpenRouter credit while an `openrouter` session has a started agent and no turn runs
- **THEN** a later scheduled pull shows the new remaining amount

#### Scenario: OpenRouter pulls stop without live sessions
- **WHEN** every `openrouter` session is archived or no longer has a started agent
- **THEN** no further requests go to the OpenRouter key or credits endpoints

#### Scenario: Several quick turns
- **WHEN** three `openrouter` turns carrying cost complete within 20 seconds
- **THEN** one extra pull is made for `openrouter`, about 30 seconds after the first

## MODIFIED Requirements

### Requirement: Usage is refreshed when no report has arrived
When a provider holds no report and its chat agent has started or it qualifies for background quota observation, the system SHALL fetch plan usage on demand, once per provider: a quota-serving provider's own plan usage; for a provider whose own usage endpoint is selected, only that endpoint's data, never the host login's, even after a refusal; otherwise the agent process's logged-in account. Without obtainable data nothing SHALL be recorded or shown. Older data SHALL NOT replace fresher data.

#### Scenario: Windows appear before the first message
- **WHEN** a client attaches to a chat session, starting its agent without sending a prompt, and the provider holds no report while plan usage data is obtainable
- **THEN** the usage bar shows the plan windows without waiting for the first turn

#### Scenario: Session whose agent has not started
- **WHEN** a chat session's provider holds no report, its agent has not started, and it does not qualify for background quota observation, as with a session no client has attached to, an archived chat, or a missing project directory
- **THEN** no usage bar is shown

#### Scenario: One pull per provider
- **WHEN** sessions on two profiles of a provider that does not serve the quota endpoint start their agents while the provider holds no report
- **THEN** plan usage is fetched once, and both sessions show the result

#### Scenario: Gateway-routed profile with an account login
- **WHEN** the session's provider routes model traffic through a non-Anthropic endpoint that does not serve the provider quota endpoint while the agent process is logged in with a Claude account
- **THEN** the usage bar shows that account's plan windows

#### Scenario: Gateway-routed profile whose provider serves the quota endpoint
- **WHEN** the provider serves the quota endpoint while the agent process is logged in with a Claude account
- **THEN** the usage bar shows the provider's plan windows, not the logged-in account's

#### Scenario: Session without plan limits
- **WHEN** the session authenticates with an API key, has no account login, and its provider serves no quota endpoint, so plan limits do not apply
- **THEN** no usage bar is shown

#### Scenario: Stale data is not downgraded
- **WHEN** a refresh returns data older than what the provider already holds
- **THEN** the held report is kept unchanged

#### Scenario: Eligible alternative without a live chat
- **WHEN** a configured team worker uses a provider with a standalone quota reader and no chat agent is running for it
- **THEN** background observation can fill its quota history without starting a chat or making a model request

#### Scenario: Own usage endpoint never falls back to the host login
- **WHEN** an `openrouter` session's agent starts while the agent process is logged in with a Claude account, and the OpenRouter key endpoint refuses the key
- **THEN** the usage bar never shows that account's plan windows for the session

### Requirement: Provider plan usage is pulled from the provider quota endpoint
When a session's provider has a base URL, the server SHALL fetch plan usage from `/api/monitor/usage/quota/limit` at its origin once per provider, with the qualifying session's or worker's effective credentials, without waiting for a turn, but never for a provider whose own usage endpoint is selected. Model API paths, queries, and fragments SHALL NOT enter the quota URL. Only a matching response SHALL yield provider windows, with their own source; failures SHALL leave the session undisturbed.

#### Scenario: API-key gateway profile shows provider usage
- **WHEN** a session's provider routes through a base URL that serves the quota endpoint and authenticates with an API key with no host login
- **THEN** the usage bar shows the provider's plan windows once the session's agent has started

#### Scenario: Shared plan pulled once
- **WHEN** sessions on `glm` and `glm-flash` of provider `zai`, whose base URL serves the quota endpoint, start their agents
- **THEN** one quota request is made for `zai`, and both sessions' usage bars show its plan windows

#### Scenario: Non-matching response records no data
- **WHEN** the quota endpoint answers with an auth refusal, an error, or a body without the usage shape
- **THEN** no provider window data is recorded, the chat session is undisturbed, and any host-account windows follow the separate fallback rules

#### Scenario: Provider report is marked
- **WHEN** plan usage is obtained from the quota endpoint
- **THEN** the report carries a usage source distinct from pushed, reported, and SDK-pulled reports

#### Scenario: Default route is never probed
- **WHEN** a session's provider has no base URL
- **THEN** no quota request is ever made for that provider

#### Scenario: Model API path does not prefix the quota endpoint
- **WHEN** the effective provider base URL is `https://gateway.example/api/anthropic`
- **THEN** the quota request goes to `https://gateway.example/api/monitor/usage/quota/limit`, with the same effective credentials

#### Scenario: Scheme and port are preserved while unrelated URL parts are discarded
- **WHEN** the effective provider base URL is `http://gateway.example:8080/api/anthropic/?route=glm#model`
- **THEN** the quota request goes to `http://gateway.example:8080/api/monitor/usage/quota/limit`

#### Scenario: Background provider configuration
- **WHEN** a quota-serving provider qualifies through a configured team worker rather than a started session
- **THEN** the pull resolves that worker's effective provider configuration, records its observation identity, and never exposes credentials in the result

#### Scenario: Own usage endpoint is never probed
- **WHEN** a session's provider has base URL `https://openrouter.ai/api`
- **THEN** no request is ever made to `/api/monitor/usage/quota/limit` for that provider, whether or not its own usage pull succeeds
