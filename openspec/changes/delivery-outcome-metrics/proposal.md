# Proposal

## Why

In the week of 2026-10-20, by the original author's figures (unverified; no live data was read for this revision), Kawai's process metrics all reported improvement: 227 done tasks against 104, task lead time p50 1.5 h against 4.0 h, fix iterations 1.07 against 2.13. Over the same week, master took 59 first-parent merges against 146, OpenSpec archives fell from 40 to 6, and completed-turn tokens rose from 4.0 B to 7.1 B (about 4.5× the tokens per merge). Nothing told the owner. There were three causes:

1. The metrics count team tasks, not delivered work. Review, advisory, and follow-up tasks inflate the cohort. A develop-review-follow-up loop that spans many short tasks reads as faster work, and `fix_iterations` cannot see it because it counts results within one task.
2. The lead-time guard, `accepted_result_share`, has read 0 in every window ever recorded: no result has ever been accepted. A guard that is always zero cannot move.
3. Metrics are only computed when someone reads them, and no path raises them to the human. The one prose warning (in the 10-26 7d report) stayed inside the report. Agents also struggle to read them: `team_metrics` returns about 1 MB and `process_reports_list` about 2 MB (author-reported sizes).

This revision is the first vertical landing the owner asked for: delivery facts, `landed_result_share`, and one attention item. The rest of the original plan is a non-blocking follow-up (see Follow-up below). The owner's report that about two thirds of done tasks lack a result, and that the lead-time guard reads about 0, is context only, not a measurement made for this change.

## What Changes

- **Delivery facts.** Kawai reads the commit the team's default branch names as last fetched (`refs/remotes/origin/HEAD`), and its whole history, with read-only git:
  - first-parent integrations, in chain order;
  - OpenSpec changes landed, meaning their archive directory arrived on the default branch, at the first-parent position where it arrived;
  - for each result commit named by a full literal object id, whether it landed and at which first-parent position. Abbreviations and symbolic names are unresolvable and excluded with a count; no prefix search runs.

  Each landing's time is the interval from its position's committer time to the latest committer time at or before that position, a stated proxy for arrival. "Contained by T" is inclusive, and window membership is half-open, so no landing counts in two adjacent windows. A landing whose interval straddles a window boundary reads unknown there and is excluded. Facts are published whole, for one head, or not at all: a failed, clipped, or shallow read publishes nothing. Kawai never fetches. A facts generation is identified by its head, never by fetch time. Every live return, cache hits included, projects its state from the live ref: unavailable, behind, stale (24 hours old or older), expired, or current, with a defensive refresh-failed state that the controller never reaches; a needed head's failed read is a stated reason, retried after its backoff.
- **A small `delivery` metric family** over the existing windows and baselines: changes landed and integrations per window, with the facts' head, freshness, and unknown counts shown beside them.
- **A guard that can actually move.** `landed_result_share` is the share of done tasks whose newest result's commit landed on the default branch. It replaces `accepted_result_share` as task lead time's guard. Beside its value, baseline, and legacy flags it shows the done cohort's total, its eligible `n`, and the excluded tasks by reason (no result, unresolvable commit, unknown containment), so a high share cannot hide missing evidence. `accepted_result_share` stays a coverage metric with an unchanged definition. Accepting a result remains a separate act; landing never accepts a result.
- **One delivery-evidence attention item.** For each Git-backed team, one human-owned item states why delivery evidence is missing: the facts are not current (with the freshness or availability reasons), or the done cohort has excluded or unknown evidence (with its counts). It opens the Metrics tab on 7d, follows changing causes and counts under one identity, and clears on recovery. It is data-quality evidence, not a claim about performance or spending, and it never drives work.
- **Same read everywhere.** The existing Metrics tab and `team_metrics` show the same generation, projected state, and values. Their forms are otherwise unchanged. Report snapshots frozen before this change keep their stored shape and read the new metrics as absent.

Non-goals:
- deploying Prometheus or Grafana;
- adding a charting dependency;
- fetching from origin;
- accepting results automatically;
- notifying agents or sending mail about delivery evidence;
- changing the definition of any existing metric;
- recommendations or the daily digest, which belong to `process-observability`;
- making any metric or attention item an input to dispatch, routing, staffing, execution, landing, or acceptance;
- reading, copying, or calibrating against live data (any later real-data check needs its own authorization).

## Follow-up (non-blocking)

These parts of the original plan are not part of this change's first landing. Each is described in this change's artifacts as of commit `7e183f5d` and needs its own later revision or change; none blocks this one:
- per-change convergence (cycle time, linked tasks, review rounds, link coverage) and in-flight change age, with the linked-task history load;
- tokens per landed change and the source-coverage input with its producer contract (old task 0.1), which gates every token- and limit-dependent measure;
- the fixed degradation rule table, its monitor, and the `process-degradation` attention kind;
- compact `team_metrics` and report tools and compact snapshots;
- reads ending at a chosen time and the Trends view, with its protocol and charts;
- Prometheus delivery families, the export-only background refresh, and the PromQL documentation;
- their calibration cases and the trends timing measurement.

## Capabilities

### New Capabilities

- `delivery-outcomes`: delivery facts read from the default branch (integrations, landed OpenSpec changes, landed result commits), their freshness, and the delivery counts per window.

### Modified Capabilities

- `team-process-metrics`: task lead time's guard becomes `landed_result_share`, shown with its coverage counts, and the Metrics tab and `team_metrics` show the same delivery read.
- `process-reports`: report snapshots frozen before a metric existed read it as absent.
- `team-workspace`: the attention queue lists one `delivery-evidence` item per Git-backed team, linked to the Metrics tab.

## Impact

- **Server:**
  - a new `src/server/metrics/delivery/` module: the process-free source resolver, a git reader over `runGitAsync` with an explicit output bound and completeness checks, a pure landing walk with containment and membership, full-literal commit resolution, a facts cache of whole generations per head, the pure return-time projection (`delivery/view.ts`), the delivery observations, and one `DeliveryRuntime` per manager that owns their refresh and the freshness wake;
  - `computeMetrics.ts` and `metricsQuery.ts` take delivery facts as input, and the load adds each result's `commit_ref` and the result checks commit resolution reads;
  - `workspaceRead.ts` gains the delivery-evidence attention source.
- **Shared:**
  - `src/shared/processMetrics.ts` gains the `delivery` family, its metric ids, the changed guard, and the coverage counts;
  - `src/shared/teamWorkspace.ts` gains the `delivery-evidence` kind and a `metrics` link kind.
- **Client:** the Metrics tab renders the delivery family, its freshness markers, and the share's coverage counts; the attention queue opens the `metrics` link.
- **Data:** no migration, no new table, and no coverage ledger. Facts are derived from git and held in memory. Report snapshots frozen before this change keep their stored shape, and readers treat the new metrics as absent there.
- **Coordination:** `process-observability` plans acceptance-time metrics over first durable acceptances. Delivery facts and `landed_result_share` are separate outcome and guard evidence: they are not an acceptance, a substitute for one, or a completion of that change's pending integrations, and neither change redefines the other's metrics.
- **Verification capabilities:** the Metrics tab screenshot check needs the `dev-browser` skill in the implementing session; without it, that check waits for a separately reviewed alternative. Backend work does not depend on it.
