# Spec Delta

## Purpose

Measures what a team delivers to its default branch — integrations, landed OpenSpec changes, and landed result commits — and how work on each change converges, and raises a fixed set of degradation alerts when delivery falls while spending does not.

## ADDED Requirements

### Requirement: Delivery facts are read from the default branch as last fetched
Kawai SHALL read delivery facts for a team from the commit its `refs/remotes/origin/HEAD` names, as last fetched, using read-only git at the main checkout. Kawai SHALL NOT fetch, write a ref, or touch a worktree to obtain them. A team whose directory is not a git repository, or whose default-branch ref is unset or unreadable, SHALL have no delivery facts, and its delivery metrics SHALL read as unavailable with that reason.

#### Scenario: Plain directory team
- **WHEN** a team's directory is not a git repository
- **THEN** every delivery metric reads unavailable with the reason "no default branch", never 0

#### Scenario: No fetch
- **WHEN** delivery facts are read
- **THEN** no git command run for them contacts a remote or changes a ref

### Requirement: Delivery facts come from one head and complete history
Every delivery fact SHALL be derived from one resolved commit of the default branch and its whole history, read in full. Facts SHALL be published only as a whole, for the commit the ref names when the read completes. A read that fails, times out, is cut short, or meets shallow or missing history SHALL publish nothing; the previous facts stay, marked as failing to refresh, or delivery reads unavailable with the reason.

#### Scenario: Ref moves during a read
- **WHEN** a fetch moves the default branch from H1 to H2 while the facts for H1 are being read
- **THEN** no facts mixing H1 and H2 are published, and the facts published next are wholly H2's

#### Scenario: Output cut short
- **WHEN** a history read stops at the output bound
- **THEN** no partial facts are published, and delivery states that the history exceeds the read bound

#### Scenario: Shallow clone
- **WHEN** the repository is shallow
- **THEN** delivery reads unavailable stating that history is incomplete

### Requirement: An integration is a first-parent commit of the default branch
Each commit on the first-parent chain of the default branch SHALL count as one integration, ordered by its position on that chain, with its committer time as the time of the integration, whatever the merge method that produced it.

#### Scenario: Merge and squash alike
- **WHEN** one pull request lands as a merge commit and another as a squash commit
- **THEN** each counts as one integration

### Requirement: A change lands when its archive directory reaches the default branch
An OpenSpec change SHALL count as landed at the first first-parent commit of the default branch that added `openspec/changes/archive/<date>-<name>/proposal.md`, identified by `<name>`, whether the directory was added or moved there. A change archived more than once SHALL land at its first archive.

#### Scenario: Archive merged
- **WHEN** a pull request archiving `parallel-suite` merges to master in a merge commit with committer time 14:00
- **THEN** `parallel-suite` counts as landed at 14:00

#### Scenario: Archive on a branch only
- **WHEN** a change is archived on a feature branch that has not merged
- **THEN** it has not landed

### Requirement: A result commit lands at its first containing position
A result's commit SHALL land at the first first-parent commit F of the default branch, in chain order, whose history contains it, with F's committer time as a proxy for its arrival. A commit the default branch does not contain SHALL be not landed. It SHALL be landed by a time T only when no position up to F has a committer time after T, unknown at T when F's time is at or before T but an earlier position's is later, and not landed by T otherwise.

#### Scenario: Result merged through a pull request
- **WHEN** a result names commit C and the merge commit M that brought C to master has committer time 10:00
- **THEN** C counts as landed at 10:00

#### Scenario: First position, not earliest time
- **WHEN** C is first contained by F1 at time 100 and is also contained by the later F2, whose time is 90
- **THEN** C lands at F1 with time 100

#### Scenario: Backdated bridge
- **WHEN** F1 has time 100, F2 has time 50 and first contains X, and F3 has time 200
- **THEN** X is not landed by 40, unknown at 75, and landed by 150

#### Scenario: Unmerged result
- **WHEN** a result's commit exists only on its task branch
- **THEN** it counts as not landed

### Requirement: Delivery facts state their freshness
Delivery facts SHALL carry the default-branch head they were read from, the time of the read, and the last fetch time, which is the modification time of `FETCH_HEAD` in the git common directory, or unknown. Facts whose last fetch is older than 24 hours, or unknown, SHALL be marked stale, facts for a head the ref no longer names SHALL be marked behind, and every surface showing a delivery metric SHALL show the marker.

#### Scenario: Old fetch
- **WHEN** the repository was last fetched 30 hours ago
- **THEN** the delivery metrics show the stale marker with the fetch age

#### Scenario: Fetch without new commits
- **WHEN** a fetch updates `FETCH_HEAD` but the default branch did not move
- **THEN** the facts are fresh again without re-reading history

### Requirement: The delivery family reports landed outcomes per window
The metric set SHALL include a `delivery` family over each window and its baseline:
- changes landed;
- integrations;
- tokens per landed change: the team's completed-turn tokens in the window divided by the changes landed in it, as a ratio whose `n` is the changes landed.

Each value SHALL follow the existing sample, baseline, sufficiency, and partial rules. Landings unknown at the window's end SHALL be excluded and counted in a coverage note.

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

### Requirement: Convergence reads every linked task
Delivery metrics SHALL read every task linked to a change, with its full status, result, and finding history, whatever its age and whether or not it has events in the windows read.

#### Scenario: Old task with no recent events
- **WHEN** a change lands this week and its only linked task was created and done a month earlier, with no later event
- **THEN** the change counts that task, and its cycle time runs from that task's creation

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
The delivery family SHALL report the p50 and p90 age of in-flight changes at the window's end. A change is in flight at T when it has not landed by T, its landing is not unknown at T, and a linked task was open, active, or blocked at T. Its age runs from the creation of its first linked task. The baseline SHALL be the same reading at the baseline window's end. Statuses inferred from backfilled records SHALL mark the value approximate.

#### Scenario: Stuck change
- **WHEN** a change's first task was created 9 days before the window's end and it has not landed
- **THEN** it contributes 216 hours to in-flight age

#### Scenario: Landed since the baseline
- **WHEN** a change landed yesterday and its task was active at the baseline window's end
- **THEN** it counts as in flight in the baseline reading

### Requirement: Degradation rules are a fixed table
Kawai SHALL evaluate a fixed table of degradation rules over the 7d window and its baseline. No surface, tool, or configuration SHALL change a rule. Each rule SHALL state the inputs it needs, and SHALL fire only when they are present, complete, and above its sample floors. A rule SHALL NOT fire while delivery facts are stale, behind, or unavailable. Rules SHALL be evaluated at read time, and their outcomes SHALL NOT be stored.

#### Scenario: Delivery drop while busy
- **WHEN** the 7d window lands 6 changes against a baseline of 40 and 59 integrations against 146, and tokens are not lower than in the baseline
- **THEN** the delivery-drop rule fires, naming the change counts, the integration counts, and both token totals

#### Scenario: Quiet week
- **WHEN** changes landed fall from 40 to 6 and tokens also fall by more than 20%
- **THEN** the delivery-drop rule does not fire

#### Scenario: No usage recorded
- **WHEN** changes landed fall from 40 to 6 and integrations fall, but neither window has any recorded turn usage
- **THEN** no rule that compares tokens fires, and the rule states that baseline usage is missing

#### Scenario: Cost rises while integrations hold
- **WHEN** tokens per landed change double with at least 3 current and 10 baseline landings, while integrations do not fall
- **THEN** the cost-per-change rule fires

#### Scenario: Stale facts
- **WHEN** the delivery-drop condition holds but the last fetch is 30 hours old
- **THEN** no rule fires and the stale state is reported instead

### Requirement: Delivery metrics are exported when the endpoint is enabled
When the optional `/metrics` endpoint is enabled, it SHALL also export, per team alias:
- counters of integrations and of landed changes;
- histograms of change cycle time, linked tasks, and review rounds per landed change;
- gauges of facts availability, in-flight changes and oldest age, fetch age, staleness, rule currency, and each rule's firing state.

A disabled endpoint SHALL export nothing.

#### Scenario: Tokens per landed change in a query
- **WHEN** a scraper divides the per-team sum of `kawai_agent_tokens_total`'s 7-day increase by the 7-day increase of `kawai_delivery_changes_landed_total`
- **THEN** the result approximates tokens per landed change by when increases were observed, and the documentation states that it can differ from Kawai's committer-time read

#### Scenario: Rule state
- **WHEN** the delivery-drop rule fires for a team
- **THEN** `kawai_degradation_rule_firing{rule="delivery-drop"}` reads 1 for its team alias, and reads 0 once it stops

### Requirement: An enabled export keeps delivery current without a viewer
While the endpoint is enabled, Kawai SHALL refresh delivery facts and re-evaluate the rules for every registered team periodically, whether or not any browser, subscription, or tool reads them. A rule gauge SHALL read 1 only for a rule outcome evaluated recently over the current facts, and SHALL read 0 otherwise.

#### Scenario: Export-only restart
- **WHEN** the server restarts with the endpoint enabled and no browser ever connects
- **THEN** scrapes report availability 0 until the first refresh completes, then the full delivery series

#### Scenario: Viewer closes
- **WHEN** the last workspace view of the team closes and a rule later stops holding
- **THEN** the next refresh sets its gauge to 0

### Requirement: Exported delivery totals are recomputed, never accumulated
Delivery counters and histograms SHALL be derived at each scrape from the current facts of the whole default-branch history and the team's task records. They SHALL survive restarts without stored state once facts are read again, and SHALL decrease only when that history is rewritten or task records are removed. A scrape SHALL NOT run git. It SHALL read the cached facts, and while none exist it SHALL export only an availability gauge of 0 for the team.

#### Scenario: Restart
- **WHEN** the server restarts between two scrapes, nothing has landed, and the facts have been read again
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
No delivery fact, delivery metric, or rule outcome SHALL be an input to dispatch, routing, staffing, execution, landing, or acceptance, directly or through another component. Landing SHALL NOT accept a result, and a landed commit SHALL NOT count as an acceptance.

#### Scenario: Landed result stays unaccepted
- **WHEN** a result's commit lands on the default branch
- **THEN** the result's acceptance is unchanged

#### Scenario: Delivery state changes nothing downstream
- **WHEN** the same team state is dispatched, routed, staffed, executed, and accepted once with delivery unavailable, once with a rule firing, and once with stale facts
- **THEN** every decision and effect is the same in all three
