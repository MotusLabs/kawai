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
cumulative export totals; migration 14 indexes `chat_turn_usage.ended_at` and
`profile_limit_events.at` for the reconciler's ordered scans of unrecorded rows.
Schema changes use the normal pre-migration backup path.
Task, status, assignment, result, finding, mailbox-transition, profile-limit and
completed-turn sources reconcile after notifications and every 30 seconds, up to
200 rows per source per pass. Notifications queue work after the operational
transaction: the first arms one pass 250 ms later and the rest join it, so a
burst of commits costs one reconcile. Observation and aggregate writes commit together; a collection
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

Activity phases (thinking, requesting, preparing a tool, running tools,
responding, retrying; any other phase as other) are summed per turn and stored
as seconds per phase on the turn's end observation; per-segment order is not
kept. Each tool call and each approval or question is one observation, written
when it completes or, still open, as partial with outcome unavailable when the
turn closes; it carries its start time and duration. Tool intervals have their
own references and can overlap: summed tool work is not elapsed task time.
Approval/question waits are subtracted from tool execution and exclude activity
phases, including overlapping request cards. A request resolution with no open
approval or question (a tool granted by the auto policy) stores nothing and is
counted as `unmatchedResolutions` on the turn end. Background shell/Monitor
roster updates do not extend active work. A heartbeat saves live state every 30
seconds. Restart closes the turn at its last checkpoint as partial, with the
phase totals known then, and records an unknown gap through restart; it never
infers work from old transcript text. A process exit or interruption retains available timing
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

Fact observations (task, status, assignment, result, finding, acceptance, mail,
limit, usage, turn end, gap, compaction, settings) and completed turn usage default
to 90 days. Intra-turn interval detail (tool, request, context samples,
turn start and attribution) — most of the volume — is kept 14 days. Older
builds also stored per-segment activity rows and separate tool and request start
rows; migration 21 removes them once, leaving totals unchanged. Pruning
deletes at most 500 rows per pass. Hourly scans continue a backlog in later 30-second
collection ticks (usage continues on later completed writes). Detailed observations
age by recording time so newly reconciled historical facts remain inspectable.
Source tasks/results/audits retain their own policies. Durable-source identities
(source rows, completed usage, acceptances), cumulative totals, aliases and
collection checkpoints outlive detail pruning; keys of live chat facts (events,
partial closures, context and settings samples, compactions, gaps) are never
replayed after their turn, so they never enter the key ledger: the observation's
own unique key deduplicates them and leaves with it. Each observation records
its team once, on the row. The database runs in incremental auto-vacuum mode
(converted once at startup), and each pruning pass releases the freed pages, so
the file and its backups shrink. A source row whose fact fails validation is logged and skipped rather
than stalling its source.
Recording start, the conservative detail horizon (the 14-day interval cutoff:
`observation_detail_retained_since_timestamp_seconds`, checkpoint
`detail-retained-since`; facts reach back to checkpoint `facts-retained-since`), latest source observations,
unresolved gaps and error counts expose coverage. Existing rolling token metrics
use the later of the 90-day limit and the team's earliest retained usage: raising
retention cannot restore history that was already pruned. Interrupted usage and
unknown live gaps are never measured zero consumption. Immutable report snapshots
and evidence are not rewritten by retention or reconciliation.

## Background quota observation and incident advice

`QuotaReaderService` (`src/server/chat/quota/`) polls each effective account
configuration — provider, base URL origin, and an in-memory hash of the
credential — of every configured team worker whose profile resolves to a
standalone quota endpoint, whether or not a chat is running. Teams come from
tracked sessions and the durable session directory, re-read on each team
resolution and every minute, so editing a group file or killing the last chat
changes nothing until the configuration does. It polls a new key at once, then
every ten minutes ±10%, backs off 1, 2, 4, 8, 16, then 30 minutes after
consecutive failures, bounds each request at ten seconds, allows one request in
flight per key (live sessions' spawn pulls and cadence join it), and stops a
key with its last worker. Host-login SDK pulls and OpenRouter keep their
session-only behavior: a worker with no standalone reader records one
`unsupported` observation per configuration and starts nothing. No poll starts
an agent, makes a model request or changes a login.

Each settlement and each agent-pushed report writes `process_quota_observations`
per team: provider, the `provider@host` alias, an account scope (an HMAC of the
account key under a per-process salt, so a new credential or a restart never
inherits headroom), whether the data describes the routed account or may be the
host login, the reason, the outcome (`supported`, `unavailable`,
`auth-refused`, `failed`, `unsupported`), and each window with its own
observation time. A status-only or failed update stores no windows and never
freshens older ones. No response body, error text or credential is stored or
logged. Rows are detail: they prune with the 14-day interval retention.

`team_capacity` is unchanged: read-only and fetch-free, it reads the same
in-memory usage store, which worker pulls now also fill.

At a final limit event or a context-exhausted flag, Kawai records one
recommendation per team, kind and episode with the routing facts frozen from
`team_capacity`'s reader (caps, live counts, cooldowns, login sharing), the held
message's worker choice and cross-model restriction, and writer occupancy. A
coalescing queue (one second) evaluates it: alternatives on the limited
account, cooling, restricted or capped are excluded by name; the rest are
listed with headroom known only for a routed window at most ten minutes old,
unreset, unvetoed by a later failure or limit of the account, and below 100%.
Advice is provisional: no numeric saving is claimed while handoff and rework
costs are unknown, and fewer than ten observed handoffs keep the small-sample
flag. Assessments are immutable versions: unchanged evidence writes nothing;
later evidence writes the next version. Context advice attaches to the
`context-exhausted` attention id, quota advice to a stall alert of the task's
plan change when one exists; neither sends mail or raises another alert. That
attention item gains a **View advice** link that opens the recommendation in
the Metrics tab; it is the same item, never a second alert. Advice is never
"demonstrated" here: that needs an outcome baseline this change does not build.
Evaluator failures record a gap in `process_recommendation_gaps`; startup
re-enqueues every unresolved or unassessed recommendation. The Metrics view
lists the advice from the snapshot (no Prometheus); agents read it through
`process_recommendations_list` and `process_recommendation_get`, and no tool
approves or applies it. The export's `provider-quota` capability stays 0 until
its export family lands.

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

Metric names start with `kawai_`. The version-2 registry is
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
observations missed during a scraper outage. Estimating a percentile from
histogram buckets in Prometheus is an approximation at bucket resolution and is
not equal to the Metrics view's exact read-time percentiles, which are
nearest-rank over the retained samples. Do not average team percentiles or
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

## Tool measurement

Managed live events add bounded tool measurements without retaining tool input,
output, raw foreign names, or failure text. A successful result counts as a call
with failure class `none`; a failure has exactly one class: `denied`,
`input-invalid`, `blocked`, `unavailable`, `precondition`, `refused`,
`command-failed`, or `other`. Classification follows anchored wrappers and
tool-specific rules. Only an approval denial linked through the host's native
call ID establishes trusted denial. Audit fallbacks, matching input, generic
errors, cancelled requests and successful results cannot establish it.

Built-ins and exact production catalogue members retain bounded canonical
identities. Per turn, foreign tools have at most 96 opaque slots; ambiguous
names and additional names remain unknown. No raw foreign name is persisted.
The turn admits at most 512 first-seen call IDs and 64 approval-request records
with terminal tombstones. Duplicates never replace an owner or free capacity.
Auto-policy grants and questions consume no approval-link capacity. The first
saturating call closes open streaks unknown once and stops tool measurement.

Consecutive failures of one recognized tool within a turn form a streak.
Success closes it recovered, normal turn close abandoned, and a recording
gap, orphan result, restart, replacement or partial close unknown. Unknown
lengths are observed lower bounds, excluded from exact recovered/abandoned
claims. Tool result detail stays 14 days; streak facts and turn-end coverage
scalars stay 90 days. The opening failed call ID stays untruncated in the
existing identity column; detail pruning does not expire a readable anchor.

The Tools family shows result failure rate, closed-cohort first-attempt success
for exact team tools, abandoned streak count, and mean failures before recovery.
First ownership follows call order, never result order or a later retry.
A valid retained turn-end carrier from the same read snapshot must confirm
complete coverage. Live, tainted, legacy, missing-carrier and unavailable history
stays partial or unrecorded, never success or zero. Attribution uses the pinned
agent start and group/profile/file versions. A tool-only session needs no task
or token-usage row to appear.

### Recovery and current status

Startup inventories live rows before tracker admission. Each valid row recovers
in its own transaction; facts, memory maps and row deletion commit together.
Failure leaves the row and admission block for the existing checkpoint tick to
retry. Malformed, unusable or scope-mismatched rows stay byte-identical and
quarantined across restarts; no automatic repair, reset or overwrite occurs.
Quarantine blocks all tracker metrics of that session, including context,
settings and compaction. Repeated status or recovery-write failures may taint
every live turn; this conservative behavior is deliberate.

`toolMeasurement.recovery` carries status `unknown`, `ok`, `pending` or
`quarantined`, nullable pending/quarantined counts and `checkedAt`.
`toolMeasurement.export` separately carries state `unknown`, `active` or
`budget-unavailable`, a bounded reason and nullable `availableSince`.
Both keys are read consistently and masked by this process's verification
gates. Stored healthy bytes from another process need current verification.
A failed write masks the view unknown even when stored bytes did not change;
successful verification can restore it without rewriting those bytes.
Unchanged healthy ticks retain timestamp and bytes and produce no view churn.

Health, the Metrics tab, compact and full `team_metrics`, report numeric
snapshots with current status overlays, and scrapes share this view.
Numeric metrics cache for 30 seconds; reads overlay current status without
mutating those numbers. Text captures status before its five-second cache
lookup. An effective change coalesces one notification to every team's open
Metrics views. Export activation proves neither collection completeness,
Delivery source coverage nor provider-usage continuity.

### Tool exports and admission

Registry definition version 2 adds these families with the `kawai_` prefix:

| Family | Meaning |
| --- | --- |
| `agent_tool_calls_total` | Committed eligible results, by tool/outcome/failure_class |
| `agent_tool_failure_streaks_total` | Closed streaks, by tool/resolution |
| `agent_tool_failure_streak_length` | Histogram of observed failures, by tool/resolution |

Streak buckets are 1, 2, 3, 4, 6, 10 and +Inf; buckets plus count/sum cost nine
expanded series per labelset. Public tool labels have 96 values: 18 built-ins,
up to 76 exact team names in production table order, `other` and `unknown`.
Foreign slots export as coarse `other`, never raw names or unbounded slots.
Failure classes have nine values; resolutions are recovered, abandoned and
unknown. Existing opaque team/group/provider/model labels keep their budgets.

Activation is one transaction under the existing 250,000 expanded-series and
10,000-labelsets-per-family limits. It counts existing weighted series, every
missing required catch-all, diagnostic and planned family row before inserting
all reservations with `tool-export-v2`, or none on refusal.
While unavailable or unknown, already-admitted labels keep committed eligible
increments. New tool labelsets write nothing, including aliases, catch-alls or
overflow increments. All three families are suppressed together on scrape;
non-tool totals continue normally. Reactivation gets a new boundary when
required, never resets, replays or backfills counters. Pruning and status-only
transactions add no tool contribution.

These PromQL expressions are examples for operator-owned alerts; thresholds
and windows need local judgment:

```promql
# Failed eligible results / all results, with enough recent calls.
(
  sum by (tool) (rate(kawai_agent_tool_calls_total{outcome="failed"}[15m]))
  /
  sum by (tool) (rate(kawai_agent_tool_calls_total[15m]))
) > 0.2
and on (tool)
sum by (tool) (increase(kawai_agent_tool_calls_total[15m])) >= 10

# New abandoned streaks, excluding unknown lower bounds.
sum by (tool) (
  increase(kawai_agent_tool_failure_streaks_total{resolution="abandoned"}[1h])
) > 0
```

An absent or suppressed family is unavailable evidence, not an idle tool or
zero failures. Check collection/export status before interpreting an alert or
comparing activation boundaries. These examples configure no alert, scraper,
provider, server or deployment.

### Drill paging and transcript reveal

The inline drill contains at most 50 abandoned entries plus the total and five
longest recovered streaks. **Show all abandoned streaks** continues through
**Load next page** until `nextCursor` is null, with no page-count cap.
Each page has at most 50 entries and the total. Its cursor fixes team, slice,
window/end, page size, high-water sequence and last closed-time/sequence pair.
Later inserts do not shift the cohort. Malformed or mismatched cursors, unknown
teams and page sizes outside 1–50 return a refusal without entries.

Opening a streak selects its chat and reveals `tool:<firstCallId>`, opens the
tool card and highlights its first failed call. It requests older history at
most once per reveal. Missing targets report `not-found`, `archived` or
`unreadable`; an archived but readable target can still reveal.
A reconnect that only resets an in-flight history request does not consume a
pending reveal before its designated host can transfer it.
