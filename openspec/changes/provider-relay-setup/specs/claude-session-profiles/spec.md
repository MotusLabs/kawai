## MODIFIED Requirements

### Requirement: Profile catalog files are discovered and merged
The system SHALL assemble the chat catalog from `providers.json` and
`profiles.json` files found from the session's project path up to the
filesystem root, layered above the user-level catalog files, which layer
above the image-provided defaults. Entries appearing at multiple levels
SHALL merge per environment key with the nearest file winning, and an empty
value SHALL neutralize an inherited value. Shipped-tier composition SHALL
follow the install mode.

#### Scenario: Small override preserves shipped siblings
- **WHEN** a user-level `providers.json` overlays only the base URL of a shipped-tier provider (`claude`, or a retained default on an upgraded install)
- **THEN** that provider keeps its other shipped fields and remaining models, and shipped-tier ids the file does not name remain offered

#### Scenario: Complete user files keep the same catalog
- **WHEN** the user-level files define every shipped id they replace with the same values
- **THEN** the resolved catalog is identical to the one the previous replace-the-defaults rule produced

#### Scenario: Nearest file wins
- **WHEN** a project-level `.kawai/profiles.json` and the user-level catalog both define the `relay` profile with different base URLs
- **THEN** sessions created for that project path use the project-level base URL

#### Scenario: Per-key extension
- **WHEN** a project-level file defines `relay` with only a model override
- **THEN** the profile inherits the user-level routing configuration and applies the project-level model

#### Scenario: Neutralizing an inherited value
- **WHEN** a project-level file sets an inherited profile's environment key to an empty string
- **THEN** sessions for that project path launch without that variable's inherited value

#### Scenario: Provider overlay
- **WHEN** the user-level `providers.json` defines provider `relay` and a project-level `providers.json` sets only a different base URL for `relay`
- **THEN** that project path's sessions on every model of `relay` use the project-level base URL

#### Scenario: Overlay of a shipped provider's base URL
- **WHEN** no user-level catalog file exists and a project-level `providers.json` sets a different base URL for the shipped provider `claude`
- **THEN** that project path's sessions on every model of `claude` use the project-level base URL, and `claude` keeps the tier its shipped file gave it

#### Scenario: Mounted catalog replaces the image default
- **WHEN** a container deployment mounts a user-level catalog that defines or disables every shipped id it replaces
- **THEN** the mounted entries alone are offered for those ids, exactly as the previous replace-the-defaults rule produced

### Requirement: Named profiles configure independent provider sessions
Each named profile SHALL apply its predefined environment configuration to
its agent session without changing the backend environment or other
sessions. The session's environment SHALL be the backend environment merged
with the effective global provider overrides — the credential store's
launch-env entries when present, else the chat-env seed — with profile
settings taking precedence over conflicting Claude settings for the
profile-controlled variables.

#### Scenario: Effective global provider overrides
- **WHEN** the system assembles a session's environment
- **THEN** the effective global provider overrides are the credential store's launch-env entries when present — imported once from the persisted Settings map at upgrade — otherwise KAWAI_CHAT_ENV, merged over the backend environment

#### Scenario: Default and named profiles over the merged environment
- **WHEN** Default and a named profile session start from the merged environment
- **THEN** Default preserves that merged configuration, while the named profile retains credentials and unrelated variables and replaces inherited values for profile-controlled routing, model, attribution, and compaction variables

#### Scenario: GLM configuration
- **WHEN** a GLM chat session starts
- **THEN** it uses https://api.z.ai/api/anthropic, starts on Opus, maps Sonnet and Haiku to glm-5.3-flash[1m] and Opus and Fable to glm-5.3[1m], and requests a 1000000-token auto-compact window

#### Scenario: MiniMax and MiMo configuration
- **WHEN** MiniMax or MiMo sessions start
- **THEN** MiniMax uses https://api.minimax.io/anthropic starting on MiniMax-M3 with every Claude tier mapped to MiniMax-M3, and MiMo uses https://api.xiaomimimo.com/anthropic starting on mimo-v2.6-pro while mapping Sonnet to mimo-v2.6-flash and Opus, Haiku, and Fable to mimo-v2.6-pro

#### Scenario: Kimi configuration
- **WHEN** a Kimi chat session starts
- **THEN** it uses https://api.moonshot.ai/anthropic starting on kimi-k3[1m] with every Claude tier mapped to kimi-k3[1m] and a 1000000-token auto-compact window

#### Scenario: Profiles do not leak between sessions
- **WHEN** GLM and MiniMax sessions run concurrently on a backend with MiMo model and compaction variables
- **THEN** each receives its own routing and model configuration, GLM's compaction override does not enter MiniMax, and the backend environment is unchanged

#### Scenario: Conflicting Claude settings
- **WHEN** user or project settings specify a different base URL or model for a named profile session
- **THEN** the selected profile's routing and prescribed startup model apply while unrelated project settings remain available

#### Scenario: Global provider settings coexist with profiles
- **WHEN** global provider settings contain a gateway token, a base URL, and model overrides, and Default and GLM sessions start
- **THEN** Default uses the global configuration, GLM uses its catalog routing and controlled model configuration, and both retain the global token without exposing it to clients

## ADDED Requirements

### Requirement: The install mode decides how the shipped tier composes
Catalog assembly SHALL follow a durable, non-secret install-mode stamp:
fresh installs merge operator files over the shipped tier; existing
installs without a user-level catalog file merge over the shipped tier plus
the retained-defaults layer; existing installs with user-level files keep
whole-file replace until the operator opts into merge after previewing the
effective-catalog difference. `default` cannot be disabled.

#### Scenario: A fresh install merges over the shipped tier
- **WHEN** a fresh instance defines a user-level entry overlaying one field of a shipped id
- **THEN** the entry merges per field and the id's other shipped fields remain

#### Scenario: An install with user files keeps replace until the operator opts in
- **WHEN** an upgraded install has user-level catalog files and no switch is recorded
- **THEN** the user files stand alone exactly as before the upgrade, and an omitted optional field stays absent

#### Scenario: The opt-in follows a preview
- **WHEN** the operator switches the install to merge
- **THEN** the switch follows a preview of the effective-catalog difference, and merge applies from then on

#### Scenario: The retained layer serves removed ids
- **WHEN** an upgraded install without user-level files resolves a removed shipped id
- **THEN** the retained default serves it with its exact shipped facts until it is retired

#### Scenario: The default profile cannot be disabled
- **WHEN** a catalog entry sets `enabled: false` on `default`
- **THEN** the file is rejected naming it, and `default` stays in the resolved catalog

### Requirement: A user-level entry may disable an id
A user-level catalog entry may set `enabled: false`, removing that named id
from the resolved catalog and leaving a tombstone nearer tiers cannot
resurrect: a project file re-defining the id resolves nothing for it while
the tombstone stands, and a user-level entry without the field replaces the
tombstone. The field SHALL be refused in any file below the user level,
that file rejected whole naming the file. The `default` profile SHALL NOT
be disableable.

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
- **WHEN** a project file sets a credential-bearing provider's base URL or re-homes its model under another provider id
- **THEN** that file is rejected whole and the provider keeps its trusted route

#### Scenario: Labels and model mappings may overlay a credentialed id
- **WHEN** a project file overlays only a credential-bearing provider's label or model mappings
- **THEN** the overlay applies and the provider's route, credential fields, and model set stay trusted

#### Scenario: Disabling the default profile is refused
- **WHEN** a user-level entry sets `enabled: false` on `default`
- **THEN** the file is rejected naming it and `default` remains in the resolved catalog

### Requirement: A provider may bind custom headers to credential variables
A trusted `providers.json` provider may set `headers`: HTTP header names
mapped to credential variable names. The field SHALL be refused below the
user level and in any `profiles.json`, that file rejected whole. Bindings
whose header names collide case-insensitively are refused at parse. Each
header variable SHALL be withheld from every launch in any entry state —
enabled, disabled, retained, or template — and a variable resolving empty
SHALL omit its header.

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
- **WHEN** a stored session on an id absent from the catalog and not restored resumes
- **THEN** the session stays visible, sending reports the profile must be restored, and the message names the matching template

#### Scenario: Group references are warned and skipped
- **WHEN** a group file's profiles map names an id the catalog lacks
- **THEN** the group loads with a warning and no worker spawns for that profile

#### Scenario: Template adoption restores resolution
- **WHEN** the operator adopts the matching template
- **THEN** the stored session resumes on that id

### Requirement: An empty declared worker list never falls back to the default profile
A group that declares a worker list (`workers`, `profiles`, or `profile`)
whose ids all fail to resolve SHALL NOT substitute the default profile: its
group mail SHALL wait with a named reason and the group SHALL show a
warning, and nothing SHALL spawn on the default profile because of the
declared list. A group with no worker field keeps the default profile.

#### Scenario: All declared workers unknown holds the mail
- **WHEN** a group declares only ids the catalog lacks and mail arrives for it
- **THEN** the mail waits with a reason naming the missing profiles and no default-profile member or spawn takes it

#### Scenario: Restoring an id ends the wait
- **WHEN** a missing declared id returns to the catalog (template adoption or a user entry)
- **THEN** the waiting mail routes normally

#### Scenario: A group without a worker field keeps the default profile
- **WHEN** a group defines no worker field and mail arrives for it
- **THEN** the default profile serves it exactly as before

### Requirement: Profiles are marked when the provider's catalog lacks their model
The picker SHALL mark a profile whose wire model ID — the exact model string
the launch sends after CLI alias resolution — the provider's model catalog
does not list, using the availability check's result. A profile SHALL NOT
be marked when the catalog could not be retrieved.

#### Scenario: Unavailable model is marked
- **WHEN** the provider's model list succeeds and lacks a profile's wire model ID
- **THEN** the picker marks that profile as not in the provider's catalog

#### Scenario: Unknown catalog marks nothing
- **WHEN** the provider's model list could not be retrieved
- **THEN** no profile carries the mark

## REMOVED Requirements

### Requirement: The shipped catalog includes OpenRouter
**Reason**: the shipped catalog is trimmed to Anthropic and OpenAI (Codex);
the `openrouter` entry ships verbatim as a setup template preserving its
ids, and the credential mechanics this requirement introduced are kept.
**Migration**: upgraded installs without user-level catalog files keep the
entry through the retained-defaults layer until the operator retires it
after previewing the difference; afterwards the `openrouter` template or a
user-level entry restores it. Stored sessions on its models degrade per
"Removed shipped profiles degrade without a template" until then.
