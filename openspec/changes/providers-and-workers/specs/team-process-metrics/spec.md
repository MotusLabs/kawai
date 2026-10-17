## MODIFIED Requirements

### Requirement: Cooling time follows the routing rule
Cooling time SHALL be reconstructed from the same rule routing applies at each instant: only the latest final limit event within routing's read cutoff decides, and the profile cools until that event's reset (else one hour after it). A later final event SHALL replace an earlier event's cooldown, shortening or extending it. A profile's events are its own final events plus its provider's provider-scoped final events, so a provider cooldown shows in the cooling time of every profile it covers.

#### Scenario: A shorter reset supersedes a longer one
- **WHEN** a final event resetting in five hours is followed a minute later by a final event resetting a minute after that
- **THEN** about two minutes of cooling are counted, not five hours

#### Scenario: Event outside the read cutoff
- **WHEN** a final event's reset is 30 hours after it
- **THEN** cooling counts only until routing stops reading that event, 24 hours after it

#### Scenario: A sibling model's provider-scoped event counts
- **WHEN** `glm` of provider `zai` has a final provider-scoped event and `glm-flash` of the same provider has no event of its own
- **THEN** `glm-flash`'s cooling time includes that event's cooldown, while a model-scoped window event on `glm` would count in `glm`'s cooling time alone
