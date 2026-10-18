# Process observability foundation

Kawai records managed chats and team tasks in its own SQLite database. External
terminal sessions are excluded. Recording, replay recovery, and existing Metrics
views work without Prometheus. This foundation does not yet provide incident
recommendations, daily digests, model experiments, canonical stage measurements,
or account-scoped provider alternatives; these remain pending OpenSpec tasks.
The optimization target is time to an accepted result, with tokens and review
quality as guardrails. No recommendation here changes a model or starts work.

## Collection and recovery

Migration 11 adds observation details, team associations, retained source keys,
collection checkpoints, live interval checkpoints, opaque export aliases, and
cumulative export totals. Schema changes use the normal pre-migration backup path.
Task, status, assignment, result, finding, mailbox-transition, profile-limit and
completed-turn sources reconcile after notifications and every 30 seconds, up to
200 rows per source per pass. Notifications queue work after the operational
transaction. Observation and aggregate writes commit together; a collection
failure cannot undo an acceptance or mailbox settlement. Counters retry from the
same source identity; pruning source rows cannot cause rowid reuse to lose usage
or limit facts. Collection errors are logged without source payloads. Health checkpoint writes
coalesce to at most once per second, with immediate failure/recovery updates.

Live turn IDs are opaque UUIDs, so restarting or restoring a driver never reuses
a usage or interval identity. Legacy sequential IDs and any usage already lost
to their collisions cannot be reconstructed. A managed turn pins the known task, task revision and agent start when it opens;
mail can replace this initial task with its envelope's task (including none).
Later association and catalog edits do not relabel observations. Handoff mail
keeps the assignment and result references. Profile identity is retained, but an
unknown provider or account is **unknown**; profiles do not establish account
sharing. Settings include available effort, configured context window and
threshold provenance; unavailable driver/account version fields remain null.

Live activity, tool and request intervals are independent observations. Tool
intervals have their own references and can overlap: summed tool work is not
elapsed task time. Approval/question waits are subtracted from tool execution
and exclude activity phases, including overlapping request cards. Background
shell/Monitor roster updates do not extend active work. A heartbeat saves live
state every 30 seconds. Restart closes intervals at their last checkpoint as
partial, then records an unknown gap through restart; it never infers work from
old transcript text. A process exit or interruption retains available timing
without inventing final token usage.

Context readings coalesce to at most one ordinary sample per minute, with forced
samples at threshold changes, compaction and turn-end/failure boundaries. These
are sampled distributions, not averages over elapsed time. Structured compaction
records preserve trigger, pre/post sizes and observed start/end; missing post
size or duration stays null. Duration is measured only when the live compacting
status preceded the boundary in the same process. A model/profile window used as
a compaction-threshold fallback stays explicitly approximate. No measured optimum
can be inferred from an approximate threshold or missing compaction costs.

Completed main-loop turn tokens include input, output, cache-read and
cache-creation counts separately. Subagent usage and turns without a final usage
report are excluded. New missing usage reports produce no usage row; legacy rows
already written as zero cannot retrospectively prove a usage report was present.
A successful-looking turn is not the same as an accepted task. The acceptance
histogram measures task creation to **first recorded accepted result**, with the
recorded actor and known landing/manual/creator mechanism. Later reopens and
acceptances never add another first-acceptance sample. A done task with no
accepted result does not enter this histogram.

## Retention and coverage

Observation details and completed turn usage default to 90 days; pruning deletes
at most 500 rows per pass. Hourly scans continue a backlog in later 30-second
collection ticks (usage continues on later completed writes). Detailed observations
age by recording time so newly reconciled historical facts remain inspectable.
Source tasks/results/audits retain their own policies. Durable-source identities
(source rows, completed usage, acceptances), cumulative totals, aliases and
collection checkpoints outlive detail pruning; keys of live chat facts (events,
segments, context and settings samples, compactions, gaps) are never replayed
after their turn and leave with their detail rows, so the key ledger stays
bounded. A source row whose fact fails validation is logged and skipped rather
than stalling its source.
Recording start, conservative detail horizon, latest source observations,
unresolved gaps and error counts expose coverage. Existing rolling token metrics
use the later of the 90-day limit and the team's earliest retained usage: raising
retention cannot restore history that was already pruned. Interrupted usage and
unknown live gaps are never measured zero consumption. Immutable report snapshots
and evidence are not rewritten by retention or reconciliation.

## Optional Prometheus endpoint

Set both server environment variables and restart:

```sh
KAWAI_METRICS_ENABLED=true
KAWAI_METRICS_TOKEN=<nonempty-bearer-secret>
```

`GET /metrics` shares the existing listener and requires
`Authorization: Bearer <secret>`. Configure the scraper's bearer authorization
from its own secret file; never put credentials in URLs. Omitted/false enablement
leaves the route unregistered. Invalid enablement or an empty/whitespace token
logs a diagnostic and leaves it disabled; normal startup and recording continue.
Unauthorized requests return 401 before reading storage. An unavailable snapshot
returns 503 for this endpoint alone. Scrapes use a consistent local snapshot
cached for five seconds, make no network/model calls, and evaluate no advice.
This feature creates no listener, deployment, cluster service or scraper.

Metric names start with `kawai_`. The version-1 registry is
`src/server/metrics/export/registry.ts`. Observed core families are:

| Families | Type and unit |
| --- | --- |
| `task_acceptance_duration_seconds` | First-acceptance histogram, seconds, by team/mechanism |
| `agent_turn_duration_seconds` | Complete observed turn histogram, seconds, by team/group/provider/model/outcome; partial turns excluded |
| `agent_turn_tokens`, `agent_tokens_total` | Completed turn token histogram and lifetime token counter, by team/group/provider/model/token kind |
| `agent_compactions_total`, `agent_compaction_duration_seconds` | Boundary count and known duration histogram; start-only records do not count as completed compactions |
| `agent_context_tokens`, `agent_context_threshold_tokens` | Sampled token histograms with explicit approximation label |
| `task_results_total`, `review_findings_total`, `task_reopens_total` | Result, verdict and reopen counters; no cohort-quality inference |
| `tasks_open`, `tasks_oldest_age_seconds`, `tasks_blocked`, `mail_queued` | Current count/oldest age; canonical task stage/blocker is unknown |
| `measurement_source_available`, `measurement_source_last_observed_timestamp_seconds` | Installed collector capability and latest actual source observation; no timestamp sample before evidence exists |
| `observation_errors_total`, `observations_last_success_timestamp_seconds`, `observation_gap` | Collection health; errors persist after successful storage recovery |
| `measurement_definition_info`, `observation_recording_start_timestamp_seconds`, `observation_detail_retained_since_timestamp_seconds` | Definition and coverage |
| `export_label_overflow_total`, `export_series`, `export_series_budget` | Label collapses and expanded-series admission budget |

Duration bucket upper bounds are 1, 5, 15, 60, 300, 900, 3600, 14400, 86400,
604800 seconds and +Inf. Token bounds are 1000, 4000, 16000, 64000, 128000,
256000, 1000000 and +Inf. Every histogram exports cumulative buckets, count and
sum with HELP/TYPE. Lifetime totals survive restart, missing scrapes and detail
pruning. A later scrape recovers cumulative counts, not the exact timing of
observations missed during a scraper outage. Do not average team percentiles or
compare token kinds as if cache-read tokens were output tokens.

Team/group/provider/model/account/window values use persistent opaque aliases;
paths, task/session/turn IDs, prompts, file hashes and timestamps are never label
values. Unknown identities use `unknown`; excess dimensions/labelsets collapse
to `other`, preserving complete detail in SQLite. Limits include retired aliases:
32 teams, 32 groups per team, 32 providers, 64 models, 64 accounts, 16 windows per
account, 10,000 labelsets per family and 250,000 expanded series across all
families. Reserved overflow sets and bounded diagnostics count toward the budget.
Counters/histograms are observation-based, never repeated rolling summaries.

`task`, `managed-turn` and `structured-context` collectors are available.
`canonical-stage`, `provider-quota` and `canonical-incident` report capability 0.
Their registered stage/wait, account quota and incident families have no samples
until the actual integration contracts land. Raw profile retry/limit records do
not establish account quota or canonical incident counts. An availability zero
means missing integration, not zero usage or an idle service.
