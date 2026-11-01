# Spec Delta

## ADDED Requirements

### Requirement: Landed-result share measures delivery of done tasks
Kawai SHALL report `landed_result_share` over tasks first done in the window: the share whose newest result before the end names a commit contained by the end on the default branch. Its `n` SHALL count only known full-literal identities with known containment. Tasks with no result, unresolvable commits, and unknown containment SHALL be excluded and counted by reason beside the done-cohort total. While delivery facts are unavailable, it SHALL read unavailable.

#### Scenario: Done but not merged
- **WHEN** 10 tasks are first done in the window with results and 4 of those commits have landed by the window's end
- **THEN** `landed_result_share` reads 0.4 with `n` 10

#### Scenario: Acceptance is independent
- **WHEN** no result was ever accepted but all 10 commits landed
- **THEN** `landed_result_share` reads 1.0 and `accepted_result_share` still reads 0

#### Scenario: Landing unknown at the end
- **WHEN** one of 10 commits first landed at a first-parent position whose containment by the window's end is unknown
- **THEN** `landed_result_share` has `n` 9, and its coverage counts one unknown landing

#### Scenario: Abbreviated commit
- **WHEN** one of 10 results names a 7-digit commit prefix
- **THEN** `landed_result_share` has `n` 9, and its coverage counts one unresolvable commit

#### Scenario: Missing results stay visible
- **WHEN** 30 tasks are first done in the window, 20 of them have no result, and all 10 results land
- **THEN** `landed_result_share` reads 1.0 with `n` 10, beside a done cohort of 30 and 20 tasks without a result

#### Scenario: Facts unavailable
- **WHEN** no delivery facts have been accepted, the window's done cohort is 30 tasks of which 20 have no result, and the baseline's is 12 of which 3 have no result
- **THEN** `landed_result_share` reads unavailable with the reason, `n` 0, coverage `{ cohort 30, eligible 0, noResult 20, unresolvable 0, unknown 10 }` and baseline coverage `{ cohort 12, eligible 0, noResult 3, unresolvable 0, unknown 9 }`, and the tab and the tool show the same

### Requirement: The tab and the tool show the same delivery read
The Metrics tab and `team_metrics` SHALL read delivery through the same reader, generation, and return-time projection, so a read at the same moment carries the same generation identity, projected state, values, `n`, baselines, flags, and coverage counts. Each SHALL show the projected state with its reasons. Neither SHALL change its existing form otherwise.

#### Scenario: Same values as the tab
- **WHEN** the Metrics tab and a `team_metrics` call read the 7d window at the same moment over the same delivery facts
- **THEN** every delivery value, `n`, baseline, coverage count, and the projected state are identical

#### Scenario: Cache hit after a ref move on the tool
- **WHEN** the ref moves after a `team_metrics` read was cached and the next call is served from that cache
- **THEN** the call reports `behind` with its reasons, without recomputation

## MODIFIED Requirements

### Requirement: Guard metrics are paired and shown together
Each efficiency metric SHALL be shown beside its fixed guard:
- task lead time with the share of done tasks whose result landed on the default branch;
- group mail share, fix iterations, and finding fail rate with reopen rate;
- tokens per task with first-pass review yield for the same slice.

No surface or tool SHALL change a metric's definition or its guard.

#### Scenario: Faster but unverified
- **WHEN** lead time drops while the landed-result share also drops
- **THEN** both appear side by side for the same window

#### Scenario: Acceptance share is coverage only
- **WHEN** the Metrics tab shows task lead time
- **THEN** its guard is the landed-result share, and the accepted-result share appears among the coverage metrics
