# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Window roles bound what a report may propose`
- TO: `### Requirement: Report windows do not delay proposals`

## MODIFIED Requirements

### Requirement: Report windows do not delay proposals
A 1d, 3d or 7d report SHALL be allowed to carry change and revert proposals. Each proposal SHALL retain its target, rationale and expected effects and SHALL expose insufficient evidence when applicable. A report window SHALL NOT establish that a recommendation is proven. Existing target validation, reporting rights, human-only decisions and explicit implementation links SHALL remain required.

#### Scenario: 1d report proposes a prompt edit
- **WHEN** a permitted lead submits a 1d report with a valid change proposal
- **THEN** it is accepted without waiting for a 7d window and insufficient evidence remains visible

#### Scenario: 3d revert
- **WHEN** the lead submits a 3d report proposing to revert `reviewers.md` to an earlier hash
- **THEN** the report and its proposal are stored

#### Scenario: 3d change
- **WHEN** a permitted lead submits a 3d report with a valid change proposal
- **THEN** the report and proposal are accepted under the same target and human-decision rules as a 7d proposal

## ADDED Requirements

### Requirement: Reports reference immutable recommendation assessments
A report SHALL be allowed to reference assessments of its team's recommendations, including worker choice, compaction experiments, bottlenecks and prompt/memory advice. References SHALL bind to assessment versions as of report creation. Unknown or other-team references SHALL refuse the submission without writes. References SHALL NOT grant execution or approval rights.

#### Scenario: Recommendation later changes
- **WHEN** a report references assessment 2 and assessment 3 later withdraws the advice
- **THEN** the report retains assessment 2 and its frozen evidence while linking to the newer assessment

### Requirement: Recommendation updates preserve proposal decisions
A recommendation linked to an existing process proposal SHALL reference that proposal and its recorded decision and implementation links rather than create a second approval for the same action. A changed action SHALL require a new assessment and approval; prior proposal decisions SHALL remain final and readable. A withdrawal SHALL revise advice without erasing or reversing an executed human decision.

#### Scenario: Already approved prompt edit
- **WHEN** reassessment changes the predicted benefit of a prompt edit already accepted as a process proposal
- **THEN** the prediction is revised while its decision and explicit implementation history remain intact

### Requirement: Daily digests complement agent reports
The Metrics surface SHALL show the server-generated daily recommendation digest separately from agent-authored 1d, 3d and 7d reports, with source, period and freshness. Generating a digest SHALL NOT impersonate a reporting agent, require a running lead, or create another scheduled lead message for the same digest.

#### Scenario: Lead unavailable
- **WHEN** the lead has no running agent at the configured digest time
- **THEN** the daily recommendation digest still appears and any missing agent report retains its own freshness indication
