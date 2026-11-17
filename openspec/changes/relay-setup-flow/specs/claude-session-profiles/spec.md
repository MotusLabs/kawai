## ADDED Requirements

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
