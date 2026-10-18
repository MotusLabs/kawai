# Design

## Context

See proposal.md for motivation and scope. Repository inspection established:

- `src/server/metrics/computeMetrics.ts` computes existing metrics from durable inputs with a 30-second read cache. `processMetrics.ts` defines fixed IDs, attribution sides, guards and `MIN_SAMPLE = 10`. `metricsQuery.ts` reads whole histories for window cohorts; it currently assumes a 60-day usage horizon.
- `chatTurnUsageStore.ts` records completed main-loop usage, pins task/start at turn start, and omits interrupted turns. It has no duration. `chatActivity.ts` is a pure live reducer, not a durable timing history; its phase is a projection and cannot account precisely for overlapping tools or hidden request waits.
- `ChatSessionDriver.ts` adopts compaction `post_tokens` and emits a generic notice; it currently drops useful structured trigger/pre-size metadata. `contextUsage.ts` distinguishes measured versus approximate thresholds. The latest context reading persists with a session, not as a history.
- `usageLimits.ts` contains parsers and `UsageLimitStore`; `ChatSessionManager.ts` owns quota pulls and ten-minute timers per profile. `providers-and-workers` will move that ownership to providers. Status-only report merging must not imply that preserved windows were freshly measured.
- `TaskResultService.accept` and `taskResultStore.ts` already retain acceptance actor/time and close the task. Planned landing accepts as Kawai; integration acceptance precedes promotion. `teamTaskStage.ts` projects stages over assignments and results, including queued review handoffs.
- `reportService.ts` enforces 1d/3d/7d proposal rules and group/memory targets. Decisions are final; `reportOutcomes.ts` requires sufficient samples. `MetricsConnections` supplies team-scoped subscriptions. `bootstrap.ts` composes a Hono HTTP server and the database. No Prometheus client dependency is installed.

## Goals / Non-Goals

**Goals:** a single evidence history and metric definition layer, useful initial recommendations without an established baseline, and independent optional monitoring. Distinguish observations, estimates and experimental evidence. Preserve existing service authority and operational semantics.

**Non-Goals:** interpreting file edits as reliable coding time; inferring human review effort; collecting raw text/tool payloads; turning the observation log into a replacement task store; inventing missing provider measurements; changing routing policy when advice is accepted. No new always-running model agent is needed for recommendations or digests.

## Decisions

### D1. SQLite records facts; Prometheus receives aggregates

Use existing SQLite and numbered migrations. Add `src/server/metrics/observations/`, `recommendations/` and `export/` modules with SDK-free types/reducers. Avoid a new event broker, analytics database or required OTel collector. Prometheus-only storage cannot preserve exact task/incident joins; DB-only storage would not meet the requested monitoring integration.

Flow:

```text
chat callbacks + committed task/mail/plan facts + quota readers
                             |
                             v
                 normalized observation recorder
                             |
                 one observation transaction
                    +--------+---------+
                    v                  v
               SQLite facts     durable export totals
                    |
             +------+------------------+
             v                         v
      shared metric reads       recommendation evaluator
             |                         |
       Metrics / tools          assessments / daily digest

authorized Prometheus scrape --> read-only aggregate snapshot
```

Collection is on by default for managed work. Export is opt-in and neither quotas nor recommendations ever read Prometheus. Disabling or losing the scraper has no core effect.

### D2. Normalized observations and explicit provenance

Use an append-only `process_observations` table: monotonic sequence, unique source key, kind, observed time, recorded time, nullable team/task/revision/assignment/result/session/turn/start references, provider-account configuration revision, model, and a bounded versioned JSON measurement payload. Index `(team_id, observed_at, seq)`, `(task_id, seq)`, `(session_id, turn_id, seq)` and `(kind, recorded_at)`.

Kinds cover turn lifecycle, activity transition, pending-request edges, tool intervals, sampled context, compaction, quota poll result, task-stage/wait change, acceptance reference, incident evidence and collection gap. Reference existing task, mail, result, finding, limit and provenance rows rather than copy their bodies. `source_key` uses durable event/command/round identity, with deterministic subkeys for phases or window rows; a newly received quota poll gets a new poll identity even if values are unchanged.

Snapshot effective worker/account identity and settings at collection: provider/model keys alone can be reassigned in configuration. Use an opaque account-configuration revision derived from provider identity and effective routing/auth context, never raw credentials or a reversible credential representation. Resolve contexts separately when project layering gives the same provider ID different effective accounts. Reuse resolved shared-account identity from provider/Codex support rather than guessing equality from URL or model. Store effort, effective model, driver/CLI version, configured context/compaction settings, and references to existing prompt/memory hashes. Historical reads use those versions, not current files.

Shared-provider quota is collected once per effective account context. Keep a `process_observation_teams` association for the teams entitled to that observation at collection; team reads cannot enumerate unrelated providers or teams. Shared quota does not mean token usage from another team becomes attributable to this team's task.

A bounded `measurement` envelope records supported fields and known/unknown/approximate/partial states. Legacy usage zero-fills remain compatible, but new coverage metadata records which fields were actually reported. Completed-turn totals keep their existing scope; missing interrupted/subagent usage is not repaired by guessing. Provider-specific cache fields are normalized with a documented accounting version so total usage never double-counts cache tokens already included in input. Historical legacy sums retain their existing definition and caveat.

### D3. Record after authoritative commits; recover what is recoverable

Attach protected recorder calls after successful service commits and at driver lifecycle callbacks. A recorder error is caught/logged and cannot roll back acceptance, change mailbox settlement, or alter chat status. Within the recorder's own transaction, insert by unique source key, update observation-derived export aggregates, and commit together. Duplicate inserts skip all aggregate updates.

At startup and periodically reconcile durable task/result/assignment/mail/limit/plan sources with missing observation source keys. This backfills known facts only, not unobserved activity or quota. Use a persisted per-source reconciliation cursor with a bounded overlap for same-timestamp/replayed commits; source keys guarantee idempotency. Explicit recording-start/last-good checkpoints and an in-memory failure latch create a collection-gap record on recovery. If the DB is unavailable, logs and the live health view expose failure until a gap can be persisted. Never claim perfect recovery of ephemeral observations.

Persist live timing boundaries. A process exit closes a turn if its timestamp is observed. After a server restart, a previously open turn/activity segment ends at the last reliable checkpoint as partial; the unobserved remainder is unknown, not measured model execution. Open task waiting can continue across restart only when durable sources prove the same wait; otherwise mark the gap. Reconnection/replay is not new work.

### D4. Two time axes and acceptance cohorts

Add a versioned metric registry extending `METRIC_DEFS`; preserve all existing IDs/cohorts. Add `acceptance_time_p50`, `acceptance_time_p90`, `tokens_per_accepted_task`, stage/wait distributions and current unfinished-task age/count. First acceptance is the earliest durable accepted-result fact, not first done, tool success, submission validation, round pass or promotion. Retain actor and acceptance mechanism (`manual`, `creator`, `direct-landing`, `integration-landing`, `unknown-legacy`) without exposing a new acceptance right. Reopens retain first acceptance and report subsequent tokens/work as rework. Tokens per accepted task sum all recorded task turns through that first acceptance, with completeness flags; post-acceptance rework is separate.

The default task-time partition starts at creation and ends at first acceptance (or now for unaccepted open work). Stage comes from the existing task-stage projection and, for execution-owned work, canonical plan-stage facts. Add plan-specific stage detail for CI/landing; never force them into coding. Creation before first assignment is `unstarted`; missing historical stages are `unknown`. Each outstanding assignment/handoff carries its exact result and revision linkage. Superseded assignments stop contributing as current stage holders while their already measured effort remains.

At each boundary, select one primary task cause in this deterministic order: intentional hold/pausing/paused, explicit acceptance/decision/request wait, dependency, quota, context, CI/effect wait, staffing/release/landing slot, dispatch queue, active tools, active model, awaiting acceptance, unknown. Preserve every concurrent cause and affected holder in detail. Priority is an accounting convention, not a root-cause claim. A blocked reviewer does not count as the task being wholly blocked if another authorized path can progress; use the execution's immediate blocking cause where available. Multiple actual parallel stages appear in detail while the canonical task stage provides the non-overlapping summary.

Per-agent intervals have independent clocks. The sum can exceed task elapsed time; task blocked time uses interval union, never the sum of parked agents or account cooldowns. Existing `limit_tax_hours` stays the existing cooling-plus-parked diagnostic and is explicitly not treated as lost task wall time.

Capture request creation/resolution separately from activity because the live activity projection is hidden while cards wait. Record tool IDs with start/end and bounded tool category; summed tool work and union-of-tools time are separate. Long-lived background shells/Monitors are background runtime, not continuously active development and never keep a task's model-execution clock running. Model activity is observed process time, not CPU time or a guarantee of useful code writing.

Completed cohorts always have companion open/unaccepted task age, closed-without-acceptance count, and interval/usage coverage. Stratify observational comparisons by stage/role, model, effort, task revision and acceptance mechanism. Mixed-model handoffs keep all contributors; label their whole-task outcome mixed rather than attribute a causal effect to the last model. Keep sample thresholds and existing attribution rules; do not repurpose author-side owner slices as evidence of isolated model performance.

### D5. Provider observation independent of started chats

Refactor the existing quota polling into a shared reader service with live-session and configured-team-worker subscriptions. A configured team is a registered/discovered Kawai team, not any directory on disk. Resolve its current group workers under the provider catalog and project context. Reference-count effective account configurations across teams and live chats; remove a timer only when both subscription kinds are gone.

Default poll/freshness boundary: ten minutes. On service startup/configuration changes poll eligible standalone readers once; thereafter use one in-flight request per context, a ten-second request timeout, jitter and bounded exponential backoff (one to thirty minutes). Incident evaluation may request a debounced refresh, but first records the evidence already available and never blocks managed work or a recommendation on network access. A refresh arriving later produces a new assessment. No model request, CLI agent start or login change is allowed just to collect quota.

Use the existing strict quota endpoint parser and auth-refusal rules. Resolve the origin and credentials in memory through the provider launch resolver; do not persist HTTP bodies or errors containing secrets. Standalone readers can serve configured quota endpoints; host-login SDK/Codex pulls that require a running agent only observe when one exists. Unsupported sources remain unknown. Record failed, unavailable, auth-refused and unsupported observations as such; no placeholder capacity.

Keep each window's own observation time. A status-only push updates status provenance, not preserved window age. When provider measurement time is missing, use receipt time and mark its basis. Values older than ten minutes, with reset already passed, with a later conflicting failure/limit, or describing an unrelated host account cannot establish available routed-provider capacity. Fresh reported headroom is evidence, not a reservation or a promise of sufficient future quota. Use all applicable windows and the same effective cooldown predicate as routing; do not add percentages of unrelated plans or infer remaining tokens from percent-only quotas.

`UsageLimitStore` remains the latest live report cache and may start empty after restart; durable history does not silently grant stale capacity to routing. `team_capacity` continues reading routing state, with no writes or fetches. Observability provides history through its own read models and can publish successful fresh pulls through the existing usage path. This explicitly supersedes the no-live-agent/no-poll clause of the provider-scoped usage spec, not the dispatch tool's contract.

### D6. Early deterministic advice, then accumulated outcomes

Implement a versioned SDK-free rule evaluator over committed evidence. No new LLM dependency, scheduled reasoning agent, or provider quota is needed to issue initial advice. It produces structured facts/rationale rendered as text. Permitted agents can add prose via existing report tools, but cannot supply forged metric snapshots or human decisions.

Persist `process_recommendations` (team, kind, scope, episode key, current assessment), `process_recommendation_assessments` (number, evidence cutoff, rule version, facts, estimates, coverage, rationale, status), and append-only decision/intervention records. Unique `(team, kind, episode, scope)` deduplicates. New material evidence or changed action makes a new assessment; equal canonical content is a no-op. Evidence includes compact frozen values and IDs so it remains interpretable after detailed retention. Link related/superseding recommendations instead of rewriting history.

Start with quota/context incidents; consume the authoritative final limit/context outcome and its episode key, not every retry frame. The evaluator runs on the next queued server job after commit, coalesced per episode; target publication within five seconds under normal load. Re-evaluate on relevant quota/reset/intervention/outcome changes and daily. A slow/failed evaluator leaves work untouched, exposes freshness and retries independently.

Switch comparison:

```text
wait   = reset wait + estimated remaining execution/rework
switch = handoff/release + context rebuild + alternative execution/rework
benefit = wait - switch
```

Populate numeric ranges only for supported terms. A known reset and fresh alternative quota can justify provisional advice without a completion baseline, but the total time saving is unknown if a material term is unknown. Show measured reset delay separately. Use matched historical intervention cohorts where available; report n and observed spread, not invented probabilities. If every term has a supported range, use conservative interval arithmetic; never rank a partial estimate as a proven winner.

Candidates come from dispatch-worker-choice's allowed workers and existing routing/staffing diagnostics, including model/account scope, worker selectors, plan allowed profiles, cross-model review, caps, occupancy and release readiness. Record each excluded alternative and its reason. A recommendation proposes an existing dispatch/handoff path; it does not modify selectors or bypass writer occupancy. A context-exhausted chat has session-local failure, not provider exhaustion.

Stage bottleneck rules use the durable task-time partition, queue distribution and current unfinished work to identify the largest observed delay and a concrete action or investigation. They do not infer that adding capacity will improve a dependency/hold bottleneck. Compaction rules identify exhaustion, repeated compaction/thrashing, or context-growth overhead and propose bounded experiments. No universal threshold or automatic `/compact` is generated as an action.

### D7. Existing incident and decision ownership

Attach recommendations to existing context-exhaustion decision requests and attention items. For plan stalls, reuse plan-supervision episode identities, meaningful-progress rules and named waits. Do not send a second alert, change its thresholds, or classify an intentional wait as a no-progress stall. For standalone quota incidents create a durable episode and one in-app Metrics/attention entry; no email, external chat or system mail to an agent is needed.

Recommendation decisions belong only to the human and bind `(recommendation, assessment, action fingerprint)`. Human commands use the existing team resolver and command-key replay protocol; changed payload or stale assessment is refused with current identity. Available decisions: accept, reject, defer. Changing a prior decision is an append-only human supersession with rationale; historical decisions never vanish. An action-changing assessment requires new approval. Advice-only status changes do not repeat notifications.

For group/memory edits already represented by a process proposal, link that proposal and use its existing decision as the one approval record; do not show a second accept button. Its once-only decision semantics remain intact. An alternative changed action needs a new proposal/assessment. Lowering expected benefit or withdrawing advice never undoes an already applied change.

Interventions link explicit real artifacts: new assignment/handoff and its actual worker, an agent start with loaded settings, or an experiment. A human records the choice and affected IDs; the server validates team/time/scope. Do not infer implementation merely because a model or prompt changed nearby. Existing services still validate/execute every action, and no recommendation agent tool dispatches, accepts, edits, retries or overrides on the human's behalf.

### D8. Daily reassessment and report compatibility

Add per-team observability settings in SQLite for digest time/time zone, retention policy and freshness/poll cadence within validated bounds. Defaults are planning choices: 09:00 UTC, 90-day detail, ten-minute polls/freshness. Keep at least 90 days of completed-turn usage; the detail-retention control cannot shorten that prerequisite contract. Credentials remain existing operator/provider configuration, never team settings.

Persist one `process_digests` row per `(team, local scheduled date)` and a schedule checkpoint. A minute scheduler reassesses recommendations/outcomes and records a digest without requiring a lead. On restart create only the latest missed scheduled date and state the uncovered interval; daylight-saving duplicate local times cannot duplicate a digest. Schedule edits take effect for the next due occurrence and cannot overwrite an existing dated digest. Commit digest content and its schedule checkpoint together.

Each digest references current immutable assessments and summarizes strengthened/revised/withdrawn/resolved advice, new incidents, bottlenecks, experiment progress and coverage. It is a typed system digest alongside the existing report list, not an impersonated `process_reports.author_session`. Existing scheduled lead reports can continue as human-readable interpretation; do not schedule another lead message for this digest.

Modify `WINDOW_PROPOSAL_KINDS`/rules to accept change and revert for all supported report windows. Keep proposal target and hash validation, `canReportProcess`, final human decisions and explicit version links. Add optional assessment references to report submission, validated and frozen at submission. This exposes worker/compaction advice through typed recommendation references instead of pretending a model choice is a memory-file edit. Existing snapshots and legacy reports remain readable with their original meaning and definition version.

Extend Metrics view/store/subscriptions in place: recommendation list/detail, assessment/evidence timeline, digest freshness, human decision and intervention dialogs, experiment form and comparison view. Reuse existing incident links, task/result/thread navigation and plan passive health/freshness displays. Add read-only `process_recommendations_list` and `process_recommendation_get` to the team tool table; no new write tools for agents. Recommendations are not plan decision cards, and do not acquire plan-supervision's override/fix-task semantics.

### D9. Experiment and outcome records

Persist experiment definition/revisions with human actor, baseline/treatment settings, model/effort, task/role scope, hypothesis, primary/guard metrics and stopping criteria. Default scope is a matched task cohort; do not reuse the same task concurrently under two writers. Human linking of actual assignments/starts establishes membership; randomized allocation is future work. Stop/complete changes tracking state only and cannot interrupt or mutate running chats.

The initial outcome comparison is observational. Report all tasks selected, accepted cohorts and unfinished ages, elapsed-to-acceptance distribution, tokens per accepted task, first-pass yield, fix iterations, reopen events, coverage, mixed models and scope changes. Minimum n=10 per comparison cohort is a sufficiency flag, never a guarantee of causality. Below it, outcome is undetermined while the incident advice may stay provisional. Rule-based guard degradation flags stop recommending expansion and prompt human review; they never stop work automatically.

Compaction comparisons retain the actually loaded threshold, observed pre/post context, automatic/manual trigger, failure/thrashing and compaction duration when directly observed. A boundary alone cannot reconstruct duration. Track later execution, rework and acceptance, not just compression ratio. Compare within model, effort and task class when recorded; missing task class weakens comparability, it is not invented from task text. A model's effective context window fallback is not a measured compaction threshold. Report a promising observed range, not a universal sweet spot.

### D10. Durable export and bounded dimensions

Add `process_export_totals` keyed by aggregate schema version, family, canonical bounded labels and histogram bucket. Insert/update cumulative counts, sums and bucket counts in the same observation transaction. Persisted `(source_key, metric definition version)` deduplication survives raw-detail pruning in a compact processed-key ledger, or its equivalent durable source high-water marks where ordering is guaranteed. The ledger must not grow with token deltas: only aggregated observation events are export inputs. Raw observations are not replayed into the current aggregate namespace after version changes.

For durable task/acceptance/usage sources, one-time initial reconciliation can accumulate retained history with an explicit recording horizon. Gauges are as-of-now projections and are never fabricated historically. An aggregate schema change uses a new metric name/version namespace; compatible additions do not reset existing totals. Prometheus rate calculations after a scrape outage cannot reconstruct exact event timing, and historical gauges stay in SQLite only.

Initial families (prefix `kawai_`):

| Family | Type | Unit / dimensions |
| --- | --- | --- |
| `task_acceptance_duration_seconds` | classic histogram | team, acceptance mechanism |
| `task_stage_duration_seconds` | classic histogram | team, stage, primary state |
| `agent_turn_duration_seconds` | classic histogram | team, group, provider, model, outcome |
| `agent_turn_tokens` | classic histogram | team, group, provider, model, token kind |
| `agent_tokens_total` | counter | team, group, provider, model, token kind |
| `agent_compactions_total` | counter | team, provider, model, trigger, outcome |
| `agent_compaction_duration_seconds` | classic histogram | team, provider, model, trigger |
| `limit_incidents_total` | counter | team, provider, model, kind |
| `tasks_open`, `tasks_oldest_age_seconds` | gauge | team, stage |
| `tasks_blocked`, `mail_queued` | gauge | team, bounded reason |
| `provider_quota_used_ratio`, `provider_quota_observed_timestamp_seconds`, `provider_quota_reset_timestamp_seconds`, `provider_quota_fresh` | gauge | opaque account-context alias, provider, bounded window/model scope |
| `observation_errors_total`, `observations_last_success_timestamp_seconds`, `export_label_overflow_total` | health counter/gauge | bounded collector/family |

Add review verdict/result/reopen counters to support quality dashboards with the same cohort caveats as Kawai. Do not average per-team percentiles. Existing rolling metrics remain read-time values; export distributions are observations, not repeated insertion of rolling summaries.

Use a small pure renderer for the fixed registry with Prometheus text exposition, HELP/TYPE and correct escaping, backed by the persistent snapshot. This avoids a required new client/runtime dependency and fits the existing pure metric core. Classic histograms give broad compatibility; duration buckets cover seconds through days (1, 5, 15, 60, 300, 900, 3600, 14400, 86400, 604800, +Inf); token buckets span 1k through 1m (1k, 4k, 16k, 64k, 128k, 256k, 1m, +Inf). Native histograms can be added later without blocking the first export.

Register `GET /metrics` on the existing Hono listener only when `KAWAI_METRICS_ENABLED=true` and a nonempty `KAWAI_METRICS_TOKEN` is configured. Use bearer authentication; never put the secret in URLs or logs. Missing/invalid settings leave the route disabled with a diagnostic and do not abort core startup. No extra listener, cluster configuration or deployment is created by this change. Scrapes read a consistent cached aggregate/gauge snapshot with a five-second freshness target, perform no external calls, and cannot publish recommendations.

Enforce label vocabulary: bounded aliases for configured team/group/provider/model/account contexts, enum stages/reasons/outcomes and mapped quota windows (`other` for unrecognized kinds). No IDs for tasks, chats, turns, prompts, revisions, files, or timestamps as labels. Cap each registry dimension (teams 32, groups 32/team, providers 32, models 64, account contexts 64, windows 16/context), and each metric family at 10,000 complete labelsets including retired catalog values; overflow goes to `other` and increments its diagnostic. Histogram buckets multiply series, so expose and test a total-series budget of 250,000 across the registry. Admit a new labelset only if its bucket expansion fits; otherwise collapse bounded labels to `other`. Alias assignments persist across restarts and do not leak paths or credentials. Detailed evidence stays complete even when export collapses a dimension.

### D11. Retention and performance

Retain observation detail 90 days by default and completed usage at least 90 days. Record the actual start/horizon and missing-field coverage; the upgrade cannot restore already pruned rows. Keep recommendation evidence/decisions/interventions/digests, experiment definitions, aggregate totals and compact source processing identities beyond detail retention. Existing source tables retain their own policies; don't prune tasks or audit records under this policy. Old recommendation links state expired detail rather than disappear.

Record transitions, not every text/token delta. Aggregate context updates to at most one ordinary reading per session per minute plus exact request-end, turn-end, compaction, failure and configured-threshold-change boundaries. Transient peaks needed for compaction comparisons are retained at those boundaries. Store numeric facts and bounded enums, never raw HTTP bodies, prompts or tool output. Prune in bounded batches at startup/hourly after export accumulation, with indexed reads and a separate scheduler from chat handling. Expose collector lag, gaps, rows/disk growth and label overflow so defaults can be revised from observed volume.

### D12. Coordination and delivery order

| Change | Contract used / reconciliation |
| --- | --- |
| `team-process-metrics` | Implemented prerequisite; archive before this change's modified specs. Reuse tables/attribution; extend usage horizon and reports without rewriting snapshots. |
| `providers-and-workers` | Required for provider identities and shared/model-window cooldowns. Its usage spec archives before the live-polling delta here. |
| `dispatch-worker-choice` | Required for actionable alternatives; consume its selector/capacity predicates. `team_capacity` remains fetch/write free. |
| `chat-context-exhaustion` | Required for canonical context failure classification and episodes; retain session-local versus provider failure distinction. |
| `plan-supervision` | Integrate its stall episodes, waits and attention sources when available; no duplicate detector. Standalone incident advice does not wait for plan execution to land. |
| `revision-control` | Holds/pauses/checkpoint/revision adapters use canonical facts when available; capability absent means no such fact, not an invented hold. |
| `plan-execution`, `integration-candidates` | Consumption adapters for rounds, CI, landing/acceptance and later promotion. Do not wait for promotion to measure accepted task time. |
| `session-targeted-task-handoffs` | Preserve named recipient, assignment/result linkage and standing-handoff deduplication. |
| `codex-chat-sessions` | Optional provider adapter at the neutral driver boundary; map usage/context only when supported and do not fan out shared-account usage twice. |
| `plan-workspace` | Reuse passive-health/freshness concepts; Metrics owns recommendations, not a second Architect or Lead chat. |
| `execution-safety-recovery` | Use numbered migrations/backups and protected callbacks; no budget or audit semantics change. |
| `rename-agentboard-to-kawai` | New env names use KAWAI; resolve the existing database path instead of hardcoding a data home. |

Keep other changes' artifacts untouched in this planning change. During implementation, rebase consumed contracts against what actually landed and carry any necessary new callback fields in their existing modules. The new delta specs state the intended supersession. Archive only after prerequisite specs exist; do not apply modifications to absent main capabilities.

## Risks / Trade-offs

- [Cold-start advice lacks performance evidence] -> Give immediate observed alternatives and unknown estimates; accumulate intervention outcomes, preserve sample flags and never invent a time saving.
- [Observational comparisons confuse harder tasks with worse models] -> Record cohort definitions, settings/role/revision, mixed work and unfinished ages; label results observational and propose human-scoped experiments.
- [Stage and activity proxies are imperfect] -> Preserve unknown/approximate states, separate task-time union from summed agent work, and show source evidence.
- [Unused-provider polling needs account access] -> Reuse existing credential resolution and standalone readers only; no auto-login or model calls. Unsupported providers stay unknown.
- [High-volume or unavailable SQLite] -> Coalesce context deltas, bound retention/batches, record collection health/gaps, and isolate recorder failures from authoritative outcomes.
- [Scope spans unfinished plan/driver work] -> Land managed-Claude/standalone advice first, use additive capability adapters, and integration-test the landed plan/Codex contracts when those features arrive.
- [Feedback loops optimize measured shortcuts] -> Keep explicit acceptance, coverage, first-pass/reopen/rework guards and human control; no automatic routing or compaction tuning.

## Migration Plan

1. Confirm implemented `team-process-metrics` is archived and provider/dispatch/context prerequisite contracts are landed; do not archive them as part of this change's planning. Record actual dependency versions. Main observations can be developed independently but actionable provider rollout follows these prerequisites.
2. Add dense numbered migrations for observation/association/coverage state; recommendation/assessment/decision/intervention/experiment/digest state; export totals and processing identities. Use existing pre-migration backups and frozen schema exports. Set recording horizon, increase usage pruning to 90 days, and update all usage-horizon calculations.
3. Enable managed observation and eligible-provider collection, then incident recommendations. Existing records stay readable. Reconcile only trustworthy durable facts; flag legacy timing and usage gaps. No database-wide replay of raw chat logs.
4. Land task-time metrics, Metrics/history/decision UI, daily digest and report-window extension; then compaction experiments/outcomes and optional plan/Codex adapters. Prometheus route and durable totals can land in parallel after D2/D4 definitions stabilize; neither gates incident advice.
5. Verify without any Prometheus config, with valid scrape config, and with failing/unauthorized scrapes. Document metric definitions, omissions, schedule, collection identity and retention, with reserved example hosts only. No Prometheus deployment is included.
6. Rollback: disable collector/scheduler/export using runtime controls in the new build if needed. Schema additions remain. An older build refusing the newer schema must follow the existing backup/restore procedure; never suggest bypassing version checks. Unapproved advice never changes execution, so rollback needs no compensating model/config action.
