## ADDED Requirements

### Requirement: Catalog entries may name a model family
A provider, a provider's model, and a `profiles.json` entry SHALL accept a `family`: a lowercase identifier matching `^[a-z0-9][a-z0-9-]*$` naming the model lineage the profile runs, such as `claude`, `gpt`, or `glm`. A model's own `family` SHALL win over its provider's. A profile with no family from either SHALL be its own family, equal to its profile id.

#### Scenario: A model inherits its provider's family
- **WHEN** provider `zai` sets `family: glm` and its model `glm-flash` sets none
- **THEN** `glm-flash` has family `glm`

#### Scenario: A model's family overrides its provider's
- **WHEN** provider `openrouter` sets no family and its model `openrouter-opus` sets `family: claude`
- **THEN** `openrouter-opus` has family `claude`

#### Scenario: No family falls back to the profile id
- **WHEN** a user-level `profiles.json` entry `lan` names no family and no provider family applies
- **THEN** `lan` has family `lan`

#### Scenario: An invalid family is an error
- **WHEN** a user-level entry sets `family: "Claude Opus"`
- **THEN** that file is reported with an error naming the entry and the field

### Requirement: Model family is a trusted-tier field
Like `codexHome` and `network`, `family` SHALL be set only by the shipped default and the user-level catalogs. A catalog file below the user level that sets it SHALL be rejected with an actionable error identifying the file, and profiles from the remaining files SHALL stay available.

#### Scenario: A project file sets a family
- **WHEN** a `.kawai/profiles.json` in the project path sets `family: gpt` on an entry
- **THEN** that file is reported and profiles from the remaining files stay available

### Requirement: Shipped catalog entries name their families
Every model of the shipped default catalogs SHALL resolve to an explicit family: Claude-lineage models `claude` (including OpenRouter's Claude aliases), Codex models `gpt`, Z.AI models `glm`, and each other vendor's models that vendor's name.

#### Scenario: Shipped Claude aliases share a family
- **WHEN** the shipped catalogs are loaded with no user-level catalog
- **THEN** `opus`, `sonnet`, `haiku`, `openrouter-opus`, `openrouter-sonnet`, and `openrouter-haiku` all have family `claude`, and `codex-sol` and `codex-luna` have family `gpt`
