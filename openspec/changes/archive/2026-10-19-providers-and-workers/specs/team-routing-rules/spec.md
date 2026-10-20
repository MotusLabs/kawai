## ADDED Requirements

### Requirement: Groups may list their workers
A group's frontmatter SHALL accept `workers` as the name of `profiles`, in the same list and capped-map forms with the same meaning. When `workers` is set, `profiles` and `profile` SHALL be ignored and a group warning SHALL name each ignored key. A worker written `<provider>/<model>` SHALL be read as that model's profile id when the provider holds that model; otherwise it SHALL be reported and ignored like an unknown profile id.

#### Scenario: Workers map
- **WHEN** the `juniors` group sets `workers: { glm-flash: 3, haiku: 2 }`
- **THEN** spawned members may use `glm-flash` or `haiku`, preferred in that order, with at most 3 and 2 live members on them

#### Scenario: Old and new keys together
- **WHEN** a group sets `workers: [haiku]` and `profiles: [glm-flash]`
- **THEN** spawned members use `haiku`, and a group warning names the ignored `profiles`

#### Scenario: Qualified names
- **WHEN** a group sets `workers: [zai/glm, claude/haiku]` and those providers hold those models
- **THEN** spawned members may use `glm` or `haiku`

#### Scenario: Qualifier names the wrong provider
- **WHEN** a group sets `workers: [zai/haiku, glm]` and provider `zai` holds no `haiku`
- **THEN** `zai/haiku` is reported and ignored, and spawned members use `glm`

### Requirement: Rules see each candidate's provider
The route context SHALL name the provider of each candidate and each listed profile, and SHALL carry, for each provider of those profiles, its usage, its limit events, and its cooldown end. Each profile's cooldown end SHALL be its effective cooldown, including its provider's. These fields SHALL be additive, so a rule written for the earlier context keeps working.

#### Scenario: A rule sees the cooling provider
- **WHEN** `glm` and `glm-flash` are profiles of provider `zai`, `glm` has a final limit event, and a rule routes group mail allowing both
- **THEN** the rule sees `zai` cooling, and the `glm-flash` profile reports the same cooldown end as `zai`

#### Scenario: Earlier rules keep working
- **WHEN** a rule written for the earlier context reads only candidates and per-profile entries
- **THEN** it loads and routes as before, and profiles of a cooling provider read as cooling
