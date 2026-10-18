## ADDED Requirements

### Requirement: OpenRouter providers are pulled from the OpenRouter key endpoint
When a session's provider has a base URL whose host is `openrouter.ai` or a subdomain of it, the server SHALL fetch usage from `/api/v1/key` at that origin once for the provider, with the session's effective auth token, instead of the coding-plan quota endpoint. The quota endpoint SHALL never be requested for such a provider, and the host-login usage pull SHALL stay suppressed for it, including after a refusal.

#### Scenario: OpenRouter session starts
- **WHEN** an `openrouter-sonnet` session's agent starts and its provider holds no report
- **THEN** one request goes to `https://openrouter.ai/api/v1/key` with the session's key, and no request goes to `/api/monitor/usage/quota/limit`

#### Scenario: Key refused
- **WHEN** the key endpoint answers 401 or 403
- **THEN** no provider data is recorded, the session is undisturbed, and the usage bar never shows the host claude.ai account's plan for it

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

### Requirement: OpenRouter usage refreshes after a costed turn
Besides the regular refresh, a completed turn that carried a provider-reported cost SHALL cause one more usage pull for its provider about 30 seconds later, at most once per provider per minute.

#### Scenario: Several quick turns
- **WHEN** three `openrouter` turns carrying cost complete within 20 seconds
- **THEN** one extra pull is made for `openrouter`, about 30 seconds after the first
