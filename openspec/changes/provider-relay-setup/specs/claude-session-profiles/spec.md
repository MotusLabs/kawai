## MODIFIED Requirements

### Requirement: Profile catalog files are discovered and merged
The system SHALL assemble the chat catalog from `providers.json` and
`profiles.json` files in `.kawai` directories found by walking from the
session's project path up to the filesystem root, layered above the
user-level catalog files, which layer above the image-provided defaults. For
a provider id or model key appearing at multiple levels, entries SHALL merge
per environment key with the nearest file winning, and an empty value SHALL
neutralize an inherited value for that key.

#### Scenario: Small override preserves shipped siblings
- **WHEN** a user-level `providers.json` overlays only the `zai` base URL
- **THEN** `zai` keeps its shipped models and remaining settings, and shipped ids the file does not name remain offered

#### Scenario: Complete user files keep the same catalog
- **WHEN** the user-level files define every shipped id they replace with the same values
- **THEN** the resolved catalog is identical to the one the previous replace-the-defaults rule produced

#### Scenario: Nearest file wins
- **WHEN** a project-level `.kawai/profiles.json` and the user-level catalog both define the `glm` profile with different base URLs
- **THEN** sessions created for that project path use the project-level base URL

#### Scenario: Per-key extension
- **WHEN** a project-level file defines `glm` with only a model override
- **THEN** the profile inherits the user-level routing configuration and applies the project-level model

#### Scenario: Neutralizing an inherited value
- **WHEN** a project-level file sets an inherited profile's environment key to an empty string
- **THEN** sessions for that project path launch without that variable's inherited value

#### Scenario: Provider overlay
- **WHEN** the user-level `providers.json` defines provider `zai` and a project-level `providers.json` sets only a different base URL for `zai`
- **THEN** that project path's sessions on every model of `zai` use the project-level base URL

#### Scenario: Overlay of a shipped provider's base URL
- **WHEN** no user-level catalog file exists and a project-level `providers.json` sets a different base URL for the shipped provider `zai`
- **THEN** that project path's sessions on every model of `zai` use the project-level base URL, and `zai` keeps the tier its shipped file gave it

#### Scenario: Mounted catalog replaces the image default
- **WHEN** a container deployment mounts a user-level catalog that defines or disables every shipped id it replaces
- **THEN** the mounted entries alone are offered for those ids, exactly as the previous replace-the-defaults rule produced

## ADDED Requirements

### Requirement: A user-level entry may disable an id
A user-level catalog entry may set `enabled: false`, removing that id from
the resolved catalog and leaving a tombstone nearer tiers cannot resurrect:
a project file re-defining the id resolves nothing for it while the
tombstone stands, and a user-level entry without the field replaces the
tombstone. The field SHALL be refused in any file below the user level,
that file rejected whole naming the file.

#### Scenario: Disable removes an id
- **WHEN** the user level sets `enabled: false` on an entry
- **THEN** that id is absent from the resolved catalog

#### Scenario: A project file cannot resurrect a tombstoned id
- **WHEN** the user level disables an id and a project file re-defines that id without naming `enabled`
- **THEN** the id stays absent for that project path

#### Scenario: A project file cannot disable
- **WHEN** a project's `.kawai/providers.json` sets `enabled: false`
- **THEN** that file is rejected naming it, and the rest of the catalog still resolves

#### Scenario: A project file cannot re-home a credentialed provider
- **WHEN** a project file overlays the base URL of a credential-bearing id, including a headers-only one
- **THEN** that file is rejected whole and the provider keeps its trusted base URL

### Requirement: A provider may bind custom headers to credential variables
A trusted `providers.json` provider may set `headers`: HTTP header names
mapped to credential variable names. The field SHALL be refused below the
user level and in any `profiles.json`, that file rejected whole. Bindings
whose header names collide case-insensitively are refused at parse. Each
header variable SHALL be withheld from every agent launch, and a variable
resolving empty SHALL omit its header.

#### Scenario: A project file cannot bind headers
- **WHEN** a project's `.kawai/providers.json` sets `headers`
- **THEN** that file is rejected naming it and the field, and the rest of the catalog still resolves

#### Scenario: Case-insensitive collision is refused
- **WHEN** one provider binds `X-Bf-Vk` and `x-bf-vk` to different variables
- **THEN** that file is rejected naming the colliding header

#### Scenario: Empty variable omits the header
- **WHEN** a bound header variable resolves empty
- **THEN** that header is omitted, the preview marks it missing, and creation proceeds

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

### Requirement: The shipped catalog carries Anthropic and OpenAI only
The shipped defaults SHALL define the `claude` provider (Default, Claude
Opus, Claude Sonnet, Claude Haiku) and one Codex entry `openai` (label
"OpenAI (Codex)", runtime codex, default Codex home, no pinned model). No
other shipped provider or profile SHALL exist; the removed entries ship as
setup templates preserving their ids.

#### Scenario: A fresh instance resolves two providers
- **WHEN** a fresh instance with no user-level catalog resolves profiles
- **THEN** only the Claude provider and the OpenAI Codex entry are offered

#### Scenario: Templates carry the removed ids
- **WHEN** the operator lists the setup templates
- **THEN** zai, minimax, mimo, kimi, and openrouter are offered with their original model ids

### Requirement: Removed shipped profiles degrade without a template
A stored session whose profile id is absent from the resolved catalog SHALL
stay visible with its stored identity and SHALL block sending with an
actionable message naming the matching setup template when one exists. A
group file or routing rule naming an absent id SHALL be warned and skipped.
Adopting the template or re-adding the entry SHALL restore resolution.

#### Scenario: Stored session blocks and names the template
- **WHEN** a stored session on an id absent from the catalog and not adopted resumes
- **THEN** the session stays visible, sending reports the profile must be restored, and the message names the matching template

#### Scenario: Group references are warned and skipped
- **WHEN** a group file's profiles map names an id the catalog lacks
- **THEN** the group loads with a warning and no worker spawns for that profile

#### Scenario: Adoption restores resolution
- **WHEN** the operator adopts the matching template
- **THEN** the stored session resumes on that id

### Requirement: Referenced removed ids are adopted at upgrade
At startup, a removed shipped id that is still referenced — by a non-killed
stored session, a group's workers, profiles, profile, or effort keys (bare
or qualified), a routing rule pick, or queued mail — and that no catalog
layer defines SHALL be adopted once from its template into the user-level
catalog, marked "adopted at upgrade" in the source listing and named in the
server log. An operator's later removal SHALL win and never be re-adopted.

#### Scenario: Referenced ids adopt at startup
- **WHEN** an upgraded instance has a stored session on `mimo` and a group naming `glm-flash`, and no layer defines either
- **THEN** both templates are adopted at startup, the session resumes, and the group's workers spawn

#### Scenario: Unreferenced ids stay trimmed
- **WHEN** a fresh instance references none of the removed ids
- **THEN** only the shipped Anthropic and OpenAI entries are offered

#### Scenario: Operator removal wins
- **WHEN** the operator disables an adopted id
- **THEN** it stays absent and is not re-adopted at a later startup

### Requirement: An empty worker list never falls back to the default profile
A group whose worker list resolves to nothing SHALL NOT substitute the
default profile: its group mail SHALL wait with a named reason and the group
SHALL show a warning, and nothing SHALL spawn on the default profile because
of the empty list.

#### Scenario: All workers unknown holds the mail
- **WHEN** a group names only ids the catalog lacks and mail arrives for it
- **THEN** the mail waits with a reason naming the missing profiles and no default-profile member or spawn takes it

#### Scenario: Adoption ends the wait
- **WHEN** the missing id returns to the catalog (adoption or template adoption)
- **THEN** the waiting mail routes normally

### Requirement: Profiles are marked when the provider's catalog lacks their model
The picker SHALL mark a profile whose startup model ID the provider's model
catalog does not list, using the availability check's result. A profile
SHALL NOT be marked when the catalog could not be retrieved.

#### Scenario: Unavailable model is marked
- **WHEN** the provider's model list succeeds and lacks a profile's startup model ID
- **THEN** the picker marks that profile as not in the provider's catalog

#### Scenario: Unknown catalog marks nothing
- **WHEN** the provider's model list could not be retrieved
- **THEN** no profile carries the mark

## REMOVED Requirements

### Requirement: The shipped catalog includes OpenRouter
**Reason**: the shipped catalog is trimmed to Anthropic and OpenAI (Codex);
the `openrouter` entry ships verbatim as a setup template preserving its
ids, and the credential mechanics this requirement introduced are kept.
**Migration**: adopt the openrouter template or re-add the entry at the user
level; stored sessions on its models degrade per "Removed shipped profiles
degrade without a template" until then.
