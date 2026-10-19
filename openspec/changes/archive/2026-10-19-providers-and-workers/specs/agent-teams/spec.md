## ADDED Requirements

### Requirement: Groups may name per-model effort as modelEffort
Group frontmatter SHALL accept `modelEffort` as the name of `profileEffort`, with the same values, the same resolution at each agent start, and the same warnings. When a file sets both, `modelEffort` SHALL apply and a group warning SHALL name the ignored `profileEffort`. A `modelEffort` key written `<provider>/<model>` SHALL be read as that model's profile id when the provider holds that model, and otherwise ignored with a warning naming it.

#### Scenario: The new name has the same effect
- **WHEN** the `juniors` group sets `effort: low` and `modelEffort: { haiku: xhigh }`, and members on `haiku` and on `glm-flash` start their agents
- **THEN** the `haiku` member launches with effort `xhigh` and the `glm-flash` member with `low`

#### Scenario: Both spellings are set
- **WHEN** a group sets `modelEffort: { haiku: xhigh }` and `profileEffort: { haiku: high }`
- **THEN** `haiku` members launch with effort `xhigh`, and a group warning names the ignored `profileEffort`

#### Scenario: A qualified key
- **WHEN** a group sets `modelEffort: { claude/haiku: xhigh }` and provider `claude` holds `haiku`
- **THEN** `haiku` members launch with effort `xhigh`

#### Scenario: A qualifier naming the wrong provider
- **WHEN** a group sets `modelEffort: { zai/haiku: xhigh }` and provider `zai` holds no `haiku`
- **THEN** the entry is ignored, a group warning names `zai/haiku`, and `haiku` members launch with the group's `effort`
