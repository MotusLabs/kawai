# Spec Delta

## ADDED Requirements

### Requirement: The attention queue lists missing delivery evidence
Positive non-Git teams SHALL be not applicable. Otherwise, one human-owned `delivery-evidence` item SHALL link to Metrics 7d. Non-current or unknown facts SHALL list it with source reasons; current cohort exclusions SHALL list total, eligible, missing, unresolvable and unknown counts. It SHALL be absent when facts are current AND (evidence is complete OR the cohort is empty). Indeterminate classification means unknown availability. Recovery keeps its identity; it never claims performance.

#### Scenario: Facts not current
- **WHEN** the team's repository was last fetched 30 hours ago
- **THEN** the queue lists one human-owned `delivery-evidence` item stating stale with the fetch age, and no delivery value in its cause

#### Scenario: Missing results in the done cohort
- **WHEN** facts are current and 30 tasks are first done in the 7d window, 20 without a result and 1 naming an abbreviation
- **THEN** the item states 30 done, 9 eligible, 20 missing results, 1 unresolvable, and 0 unknown, and its action opens the Metrics tab on 7d

#### Scenario: Unknown containment only
- **WHEN** facts are current and 10 tasks are first done in the 7d window, all with full literal results, 9 contained by the window's end and 1 of unknown containment
- **THEN** exactly one item is listed, stating 10 done, 9 eligible, 0 missing results, 0 unresolvable, and 1 unknown

#### Scenario: Complete evidence clears the item
- **WHEN** facts are current and every task first done in the 7d window has a known landing state
- **THEN** no `delivery-evidence` item is listed, and the counts drop by one

#### Scenario: No done cohort
- **WHEN** facts are current and no task was first done in the 7d window
- **THEN** no `delivery-evidence` item is listed

#### Scenario: Plain directory team
- **WHEN** a team's directory is positively identified as not a git repository
- **THEN** no `delivery-evidence` item is listed, and the Metrics tab shows delivery unavailable

#### Scenario: Repository root lost
- **WHEN** a team expected to be Git-backed loses its git common directory
- **THEN** the `delivery-evidence` item is listed as unavailable with the reason, and no delivery value

#### Scenario: Repository root unreadable
- **WHEN** a team expected to be Git-backed has a common directory that cannot be read
- **THEN** the same item is listed as unavailable with the unreadable reason, never suppressed as not applicable

#### Scenario: Root recovers under one identity
- **WHEN** the lost or unreadable root is restored and the facts are current with complete evidence
- **THEN** the item that was listed under `delivery-evidence` clears, with no second identity raised

#### Scenario: Cause changes under one identity
- **WHEN** the item is listed for missing results and the facts then become stale
- **THEN** the same identity shows the new cause, and the client raises at most one toast for it in its session

#### Scenario: Facts go stale with no other event
- **WHEN** evidence is complete, no item is listed, and the last fetch reaches exactly 24 hours old with no other change
- **THEN** the item is listed at that time without waiting for another event, and 1 ms earlier it was not
