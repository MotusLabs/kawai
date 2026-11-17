## ADDED Requirements

### Requirement: A provider may bind custom headers to credential variables
A trusted `providers.json` provider may set `headers`: HTTP header names
mapped to credential variable names. The field SHALL be refused below the
user level and in any `profiles.json`, that file rejected whole. Bindings
whose header names collide case-insensitively are refused at parse. Each
header variable SHALL be withheld from every launch, registered from every
parsed catalog layer in any entry state, and a variable resolving empty
SHALL omit its header.

#### Scenario: A project file cannot bind headers
- **WHEN** a project's `.kawai/providers.json` sets `headers`
- **THEN** that file is rejected naming it and the field, and the rest of the catalog still resolves

#### Scenario: Case-insensitive collision is refused
- **WHEN** one provider binds `X-Bf-Vk` and `x-bf-vk` to different variables
- **THEN** that file is rejected naming the colliding header

#### Scenario: Empty variable omits the header
- **WHEN** a bound header variable resolves empty
- **THEN** that header is omitted from the composed value and creation proceeds

### Requirement: Bound headers compose into the launch environment
Resolvable header bindings SHALL compose into `ANTHROPIC_CUSTOM_HEADERS` at
launch as newline-separated `Name: Value` pairs in the process environment,
never in the flag settings layer. A pair whose resolved value contains CR,
LF, or NUL SHALL be refused as a validation diagnostic naming the header,
never the value.

#### Scenario: Header binds a virtual key
- **WHEN** a user-level provider sets `headers` binding `x-bf-vk` to a variable the store holds
- **THEN** the session's launch carries `ANTHROPIC_CUSTOM_HEADERS` with that pair, and the variable appears nowhere else in the agent environment

#### Scenario: Header values stay out of the settings layer
- **WHEN** a session of a provider with headers launches
- **THEN** the flag settings layer carries no header value

#### Scenario: A header value carrying a line break is refused
- **WHEN** a bound header variable resolves to a value containing CR, LF, or NUL
- **THEN** the launch is refused before anything spawns with a validation diagnostic naming the header, never the value

### Requirement: A headers-only provider pins its route
A provider that sets `headers` but no `authTokenEnv` SHALL take a non-empty
base URL from a trusted tier, and every launch composing its headers SHALL
pin the base URL and transport variables exactly as credentialed providers
are pinned.

#### Scenario: A headers-only provider pins its route
- **WHEN** a provider sets `headers` but no `authTokenEnv`
- **THEN** its launches pin the trusted base URL and transport variables like credentialed providers do

#### Scenario: Headers-only provider without a base URL
- **WHEN** a user-level provider sets `headers` and no trusted base URL
- **THEN** that file is rejected naming the provider, like a credentialed provider without one
