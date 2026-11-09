## ADDED Requirements

### Requirement: Kawai raises a card for each disputed finding
When a finding of a plan change's task is disputed, Kawai SHALL raise one decision card for it, asked on the disputing session's behalf and addressed like its own questions. The card SHALL name the finding, its level, clause, evidence, and the counter-evidence, with the options `Uphold F<n>` and `Reject F<n>`. The card's decision SHALL decide the dispute, and a later decision on the card by the owner SHALL replace it.

#### Scenario: The Lead decides a dispute
- **WHEN** the developer of a plan change disputes F3, and the plan names a Lead role
- **THEN** the Lead role receives one card for F3 with the options `Uphold F3` and `Reject F3`, and recording `Reject F3` makes F3 read rejected

#### Scenario: No Lead role
- **WHEN** the developer disputes F3 on a plan with no Lead role
- **THEN** the card is addressed to the owner

#### Scenario: The owner overrides a rejection
- **WHEN** the Lead rejected the dispute of F3, and the owner overrides the card with `Uphold F3`
- **THEN** F3 reads as it was before the dispute, the override is journaled, and the override creates its forward-fix task as for any card

#### Scenario: A superseded finding's card
- **WHEN** F3's card is still open and a new task revision supersedes F3
- **THEN** a later decision on the card is journaled and leaves F3 superseded
