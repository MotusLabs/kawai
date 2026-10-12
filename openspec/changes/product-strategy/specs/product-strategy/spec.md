# Spec Delta

## Purpose

Gives each product a durable, human-owned strategy record — template sections, labeled claims, revision lifecycle, and durable drafts — that agents may read and propose to but never rewrite or publish.

## ADDED Requirements

### Requirement: A product strategy is a durable record
Each product SHALL have at most one `ProductStrategy` record holding its title, human owner, lifecycle, repository bindings, and current approved revision. The record SHALL live in kawai-owned server storage, not in a repository file. A repository document describing strategy is untrusted content and SHALL NOT be read as the record.

#### Scenario: First strategy for a product
- **WHEN** the human creates a strategy for a product that has none
- **THEN** the record exists with that human as owner, no approved revision, and the product's repository bindings

#### Scenario: Repository file is not the record
- **WHEN** a repository contains a file describing a product strategy
- **THEN** the strategy view and agent tools read the kawai-owned record, and the file changes neither

### Requirement: Revisions follow the default strategy template
Every revision SHALL carry the template sections: Purpose, Primary users, Needs and outcomes, Main use cases, Product approach, Principles and trade-offs, Boundaries and non-goals, Success measures, Assumptions and evidence, Open questions, and Decisions and revision history. Sections may be explicitly empty when their absence is recorded; completeness SHALL NOT require speculative filling.

#### Scenario: Draft from the template
- **WHEN** a draft revision is created
- **THEN** it contains every template section and records which optional sections are explicitly empty

#### Scenario: Use case keeps intent before features
- **WHEN** a use case is drafted
- **THEN** it records user or situation, trigger, wanted outcome, current obstacle, desired experience, success signal, and constraints

### Requirement: Revision lifecycle is Draft through Superseded with explicit Withdrawn
A revision SHALL move Draft → InReview → Approved → Superseded, or to explicit Withdrawn from Draft or InReview. Approved content SHALL be immutable. Superseded and Withdrawn revisions SHALL remain accessible. A draft SHALL NOT replace the active approved revision.

#### Scenario: Superseded revision stays readable
- **WHEN** a newer revision is approved
- **THEN** the earlier approved revision is Superseded and still readable with its original content

#### Scenario: Draft cannot overwrite approved
- **WHEN** an agent saves a draft while a revision is Approved
- **THEN** the approved revision is unchanged and the draft is stored as a separate revision

#### Scenario: Withdrawn draft remains in history
- **WHEN** the human withdraws an InReview revision
- **THEN** it is Withdrawn, no longer approvable, and still listed in revision history

### Requirement: Claims are labeled with their evidence kind
Strategy claims SHALL carry a kind — owner preference, explicit user statement, agent interpretation, proposed choice, hypothesis, or validated observation — plus source, observation context or date, limitations, and required validation where known. A validated observation without a source SHALL be refused.

#### Scenario: Hypothesis stays a hypothesis (S08)
- **WHEN** an agent drafts a market claim with no supporting evidence
- **THEN** it is stored as a hypothesis with its limitations, not as a validated observation

#### Scenario: Validated observation needs a source
- **WHEN** a claim is saved as a validated observation with no source reference
- **THEN** the save is refused with an error naming the missing source

### Requirement: Missing baselines and targets are Unknown
Success measures SHALL record outcome, proposed measure, known baseline, and agreed target. Values that are not known or agreed SHALL be stored as `Unknown`. Neither the store nor agent tools SHALL invent a baseline, target, or metric.

#### Scenario: Absent baseline stays Unknown (S08)
- **WHEN** a success measure is saved with no measured baseline
- **THEN** its baseline is `Unknown` and no placeholder number appears

#### Scenario: Unfounded demand figure stays a hypothesis
- **WHEN** a draft stores a demand figure with a hypothesis kind and no source reference
- **THEN** the claim is stored only as a hypothesis and is not stored as a validated observation

### Requirement: Drafts are durable and saved with expected-revision checks
Draft content SHALL be stored server-side and survive navigation, reconnect, and reload. A save SHALL carry the expected base revision and draft hash. A mismatch SHALL refuse the overwrite and leave the caller's unsaved text with the caller for resolution.

#### Scenario: Reconnect keeps the draft (S12)
- **WHEN** a client reconnects after saving a draft
- **THEN** the stored draft is returned unchanged

#### Scenario: Concurrent edit refuses overwrite (S12)
- **WHEN** two editors save a draft from the same base revision
- **THEN** the first save succeeds and the second is refused with the conflicting state, retaining its own text unsaved

### Requirement: Agents may read the strategy and propose drafts
An agent SHALL be able to read the current approved revision and existing drafts and to save a draft revision, including a material direction change with an impact proposal. Saving or submitting a draft SHALL NOT change the approved strategy. Agents SHALL have no tool that approves, publishes, withdraws, or deletes a revision.

#### Scenario: Agent proposes a material direction change (S05)
- **WHEN** an agent drafts a change to purpose or non-goals and records its impact proposal
- **THEN** the draft and impact proposal exist, the approved strategy is unchanged, and the draft is InReview only after an explicit submit

#### Scenario: Agent has no approve tool
- **WHEN** an agent lists its strategy tools
- **THEN** none of them can approve, publish, withdraw, or delete a revision

### Requirement: Work proceeds without a strategy
Creating or working on a task or plan SHALL be allowed when the product has no strategy record and no approved revision. No dummy strategy or binding SHALL be created. Absence of a strategy SHALL be shown as an unassessed state, never as alignment.

#### Scenario: Standalone task with no strategy (S11)
- **WHEN** the human creates a task for a product with no strategy
- **THEN** the task exists normally and no strategy record or binding is created

#### Scenario: Capture is offered, not forced (S11)
- **WHEN** the strategy view opens for a product with no record
- **THEN** it offers capture and shows no fabricated direction

### Requirement: The strategy is inspectable in the UI
The UI SHALL show a product's strategy at product and repository scope: purpose, primary users, outcomes, use cases, ordered trade-offs, and key boundaries first; revision, hash, owner, and status in supporting detail. It SHALL offer capture, draft editing, review findings, approve, revision history, and evidence with claim kinds and limitations.

#### Scenario: Strategy view leads with direction
- **WHEN** the human opens Product Strategy for a product with an approved revision
- **THEN** purpose, users, outcomes, use cases, trade-offs, and boundaries lead the view, with revision/hash/owner/status available in detail

#### Scenario: Review separates knowledge states
- **WHEN** the human opens review for a draft
- **THEN** findings show what is known, assumed, and not yet decided, with contradictions and unresolved decisions

### Requirement: Strategy records persist
Strategy records, revisions, drafts, evidence, and decisions SHALL persist across server restart and SHALL remain after the sessions that authored them are archived or killed.

#### Scenario: Author killed
- **WHEN** the agent session that saved a draft is killed
- **THEN** the draft remains readable and the human can still review and approve it
