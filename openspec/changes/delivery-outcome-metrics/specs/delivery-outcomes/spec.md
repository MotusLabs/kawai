# Spec Delta

## Purpose

Measures what a team delivers to its default branch — integrations, landed OpenSpec changes, and landed result commits — and how work on each change converges, and raises a fixed set of degradation alerts when delivery falls while spending does not.

## ADDED Requirements

### Requirement: Delivery facts are read from the default branch as last fetched
Kawai SHALL read delivery facts for a team from its repository's `refs/remotes/origin/HEAD` as last fetched, using read-only git at the main checkout. Kawai SHALL NOT fetch, write a ref, or touch a worktree to obtain them. A team whose directory is not a git repository, or whose default-branch ref is unset, SHALL have no delivery facts, and its delivery metrics SHALL read as unavailable with that reason.

#### Scenario: Plain directory team
- **WHEN** a team's directory is not a git repository
- **THEN** every delivery metric reads unavailable with the reason "no default branch", never 0

#### Scenario: No fetch
- **WHEN** delivery facts are read
- **THEN** no git command run for them contacts a remote or changes a ref

### Requirement: An integration is a first-parent commit of the default branch
Each commit on the first-parent chain of the default branch SHALL count as one integration at its committer time, whatever the merge method that produced it.

#### Scenario: Merge and squash alike
- **WHEN** one pull request lands as a merge commit and another as a squash commit
- **THEN** each counts as one integration

### Requirement: A change lands when its archive directory reaches the default branch
An OpenSpec change SHALL count as landed at the committer time of the first-parent commit that first added `openspec/changes/archive/<date>-<name>/proposal.md` to the default branch, identified by `<name>`. A change archived more than once SHALL land at its first archive.

#### Scenario: Archive merged
- **WHEN** a pull request archiving `parallel-suite` merges to master at 14:00
- **THEN** `parallel-suite` counts as landed at 14:00

#### Scenario: Archive on a branch only
- **WHEN** a change is archived on a feature branch that has not merged
- **THEN** it has not landed

### Requirement: A result commit lands when the default branch contains it
A result's commit SHALL count as landed at the committer time of the earliest first-parent commit of the default branch whose history contains it. A commit the default branch does not contain SHALL be not landed. The read horizon SHALL cover the longest trend range plus one window. A commit contained only through history older than that horizon SHALL be landed with an unknown time.

#### Scenario: Result merged through a pull request
- **WHEN** a result names commit C and the merge commit M that brought C to master lands at 10:00
- **THEN** C counts as landed at 10:00

#### Scenario: Unmerged result
- **WHEN** a result's commit exists only on its task branch
- **THEN** it counts as not landed

### Requirement: Delivery facts state their freshness
Delivery facts SHALL carry the default-branch head they were read from, the time of the read, and the last fetch time, which is the modification time of `FETCH_HEAD` in the git common directory, or unknown. Facts whose last fetch is older than 24 hours, or unknown, SHALL be marked stale, and every surface showing a delivery metric SHALL show the marker.

#### Scenario: Old fetch
- **WHEN** the repository was last fetched 30 hours ago
- **THEN** the delivery metrics show the stale marker with the fetch age

### Requirement: The delivery family reports landed outcomes per window
The metric set SHALL include a `delivery` family over each window and its baseline:
- changes landed;
- integrations;
- tokens per landed change, meaning the team's completed-turn tokens in the window divided by the changes landed in it, as a ratio whose `n` is the changes landed.

Each value SHALL follow the existing sample, baseline, and sufficiency rules.

#### Scenario: A busy week that lands little
- **WHEN** the 7d window holds 7.1 B tokens and 6 landed changes, against 4.0 B tokens and 40 in the baseline
- **THEN** tokens per landed change reads about 1.18 B against 100 M, with `n` 6 flagged insufficient and the baseline sufficient

### Requirement: Landed changes report how their work converged
For each change landed in the window, Kawai SHALL compute three convergence metrics, each with p50 and p90 or a mean:
- change cycle time: hours from the creation of its first linked task to its landing;
- tasks per landed change: the tasks linked to it by `openspec_change` or by a plan change of that name, of any status;
- review rounds per landed change: findings submitted on those tasks' results.

A landed change with no linked task SHALL be excluded from these three metrics.

#### Scenario: Follow-up chains are visible
- **WHEN** a landed change had 50 linked tasks, 30 of them review or follow-up tasks
- **THEN** it contributes 50 to tasks per landed change, whatever each task's own fix iterations were

#### Scenario: Unlinked change
- **WHEN** a change lands with no task naming it
- **THEN** it counts toward changes landed and not toward the convergence metrics

### Requirement: Convergence counts only work before the landing
A landed change's convergence SHALL count only the linked tasks created before its landing and the findings submitted before it. Work linked to the same change name after its landing SHALL NOT change that landing's values.

#### Scenario: Post-archive follow-up
- **WHEN** a task naming `parallel-suite` is created a day after `parallel-suite` landed
- **THEN** tasks per landed change for that landing is unchanged

### Requirement: Convergence states its own coverage
The delivery family SHALL report the share of changes landed in the window that have at least one linked task, so convergence values are read against how much they cover.

#### Scenario: Low linkage
- **WHEN** 2 of 6 landed changes have linked tasks
- **THEN** linked-change coverage reads 0.33 with `n` 6

### Requirement: In-flight changes report their age
The delivery family SHALL report the p50 and p90 age of in-flight changes at the window's end. A change is in flight when it has not landed by that time and at least one linked task was open, active, or blocked at that time. Its age runs from the creation of its first linked task. The baseline SHALL be the same reading at the baseline window's end.

#### Scenario: Stuck change
- **WHEN** a change's first task was created 9 days before the window's end and it has not landed
- **THEN** it contributes 216 hours to in-flight age

### Requirement: Degradation rules are a fixed table
Kawai SHALL evaluate a fixed table of degradation rules over the 7d window and its baseline. No surface, tool, or configuration SHALL change a rule. A rule SHALL fire only when its sample conditions hold, and it SHALL NOT fire on a team whose delivery facts are stale or unavailable. Rules SHALL be evaluated at read time, and their outcomes SHALL NOT be stored.

#### Scenario: Delivery drop while busy
- **WHEN** the 7d window lands 6 changes against a baseline of 40 and 59 integrations against 146, and tokens are not lower than in the baseline
- **THEN** the delivery-drop rule fires, naming the change counts, the integration counts, and both token totals

#### Scenario: Quiet week
- **WHEN** changes landed fall from 40 to 6 and tokens also fall by more than 20%
- **THEN** the delivery-drop rule does not fire

#### Scenario: Stale facts
- **WHEN** the delivery-drop condition holds but the last fetch is 30 hours old
- **THEN** no rule fires and the stale state is reported instead

### Requirement: Delivery metrics are exported when the endpoint is enabled
When the optional `/metrics` endpoint is enabled, it SHALL also export, per team alias:
- counters of first-parent integrations and of landed changes on the default branch;
- histograms of change cycle time in seconds, linked tasks per landed change, and review rounds per landed change;
- gauges of in-flight changes, oldest in-flight age, last-fetch age, staleness, and each degradation rule's firing state.

A disabled endpoint SHALL export nothing.

#### Scenario: Tokens per landed change in a query
- **WHEN** a scraper reads `kawai_delivery_changes_landed_total` and the existing `kawai_agent_tokens_total`
- **THEN** the ratio of their 7-day increases gives tokens per landed change without a dedicated series

#### Scenario: Rule state
- **WHEN** the delivery-drop rule fires for a team
- **THEN** `kawai_degradation_rule_firing{rule="delivery-drop"}` reads 1 for its team alias, and reads 0 once it stops

### Requirement: Exported delivery totals are recomputed, never accumulated
Delivery counters and histograms SHALL be derived at each scrape from the whole default-branch history and the team's task records. They SHALL survive restarts without stored state, and SHALL decrease only when that history is rewritten or task records are removed. A scrape SHALL NOT run git. It SHALL read the cached facts, and while none exist it SHALL export only an availability gauge of 0 for the team.

#### Scenario: Restart
- **WHEN** the server restarts between two scrapes and nothing has landed
- **THEN** both scrapes report the same delivery counter values

#### Scenario: Facts not yet read
- **WHEN** a scrape arrives before the team's first facts read completes
- **THEN** it exports `kawai_delivery_facts_available` 0 for the team, and no other delivery series

### Requirement: Exported delivery labels are bounded
Exported delivery series SHALL carry only the team alias and, for rule gauges, the rule id from the fixed table. No change name, branch name, commit, path, or task id SHALL be a label value.

#### Scenario: Many changes
- **WHEN** 90 changes have landed
- **THEN** the cycle-time histogram is one series per team alias, not one per change

### Requirement: Delivery and alerts never drive work
No delivery fact, delivery metric, or rule outcome SHALL be an input to dispatch, routing, staffing, execution, landing, or acceptance. Landing SHALL NOT accept a result.

#### Scenario: Landed result stays unaccepted
- **WHEN** a result's commit lands on the default branch
- **THEN** the result's acceptance is unchanged
