# Design

## Context

See proposal.md for motivation; the specs carry the requirements.

- **Turns.** `ChatSessionDriver.handleResult` emits `turn_completed` with `subtype`, cumulative `totalCostUsd`, and `numTurns`. The SDK result's `usage` is per turn and covers only the main loop (Task subagents excluded). `ChatSessionManager.handleDriverEvent` already writes `chat_turn_ends` (task-bound turns only, 7-day retention) from that event.
- **Agent start.** `ChatSessionDriver.spawnQuery` resolves the profile launch (env may set `CLAUDE_CONFIG_DIR`), reads `getSystemPromptAppend()` (`SessionTeams.promptFor` → `buildTeamPrompt`) and `getEffort()`, and starts the query. It runs on first start, resume, and respawn after a crash. `GroupCatalogEntry.file` names the group file in effect.
- **Memory.** Claude Code's auto-memory for a repository lives at `<config dir>/projects/<sanitized main checkout path>/memory`. On this host, `-home-coder-kawai/memory` holds 50 files, and none of the dozens of `-home-coder-kawai--claude-worktrees-*` project dirs has a `memory/`. So worktree sessions share the main checkout's memory (observed, not documented).
- **Task status.** `TaskStore` changes status in one `UPDATE team_tasks SET status = ?, updated_at = ?` (`taskStore.ts:347`), reached by `TaskService` status changes and by result acceptance. Nothing records the transition, and `updated_at` also moves on revisions.
- **Retention.** `chat_turn_ends` is kept 7 days; `profile_limit_events` is pruned at 24 h (`limitEvents.ts`, whose reads also filter at 24 h). Mail, message events, tasks, results, and findings are never pruned.
- **Surfaces.** Team page tabs are `WorkspaceTab` in `src/client/utils/teamLocation.ts`; WS human actions follow `strategyConnections.ts` (team addressed by `teamPath`, authoritative snapshots, command ids for replays) and must be listed in `CHAT_CONNECTION_TYPES`. `kawai-team` tools register in `createMailboxServer` and join `TEAM_ALLOWED_TOOLS`. Group frontmatter booleans parse in `groupFile.ts` (strict, like `canCreateTasks`).

## Goals / Non-Goals

**Goals:** one metric definition shared by the tab, the tool, and report snapshots; attribution of every turn and result to the prompt and memory versions it ran under; a decision record linking each human-accepted proposal to the version that implemented it.

**Non-Goals:** live-updating metrics on every mail change; enforcing that agents do not edit group or memory files (kawai detects unproposed changes, it cannot prevent a file edit); measuring subagent usage; history before the recording tables exist, beyond the status backfill in D3.

## Decisions

### D1. `chat_turn_usage`, written beside `chat_turn_ends`

```sql
chat_turn_usage (
  session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  team_id TEXT, group_id TEXT, profile_id TEXT, model TEXT,
  task_id TEXT, start_id TEXT,          -- D2
  ok INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
  num_turns INTEGER NOT NULL, ended_at TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX chat_turn_usage_team ON chat_turn_usage (team_id, ended_at);
CREATE INDEX chat_turn_usage_task ON chat_turn_usage (task_id);
```

`turn_completed` gains optional `usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }` mapped from `message.usage` (missing fields 0). The event stays additive, and replayed history without it is unchanged. The manager inserts with `INSERT OR IGNORE`, so a duplicate completion writes once, inside the same try/catch-and-log as the turn-end row. Team id is resolved when the row is written, so a later kill doesn't orphan it. Pruning drops rows past 60 days at startup and at most hourly.

**The task is pinned at turn start** (plan-supervision D14's rule, kept). The dispatcher delivers only to idle sessions, and `ChatSessionDriver.deliver` opens the turn itself: it emits `turn_started` and then, in the same turn, the `peer_message` carrying the envelope's task. (The mailbox's delivered hook fires after `deliver` returns, too late to see the turn start, so the pin reads the event stream instead.) `TurnUsageTracker` (in `chatTurnUsageStore.ts`, fed from `ChatSessionManager.handleDriverEvent`) pins on `turn_started` the session's task at that moment and its current `startId` (D2); a `peer_message` of that same turn then repins the task to the mail's (`task?.id ?? null`). `turn_completed` writes the pinned values. Mail delivered while a turn runs neither retargets it nor carries over, and a later association change (task mail sets `chat_sessions.task_id`) can't move a running turn. The one difference from D14: a turn with no task still writes its row with `task_id` null instead of writing nothing. A completion with no pin (a turn that began before a restart) falls back to the session's task at completion and the latest start.

*Why all turns rather than only task-bound ones (as plan-supervision D14 drafts):* coordinator overhead is mostly turns without a task. A plan read is the same table filtered by task id. *Why not extend `chat_turn_ends`:* its 7-day retention and task-only scope serve the morning summary; widening it would change that feature's meaning.

### D2. `agent_starts`, recorded from the spawn path

```sql
agent_starts (
  id TEXT PRIMARY KEY,                  -- 'start-<uuid>'
  session_id TEXT NOT NULL, team_id TEXT, group_id TEXT,
  profile_id TEXT, model TEXT, effort TEXT, cwd TEXT NOT NULL,
  group_file_hash TEXT, prompt_append_hash TEXT,
  memory_hash TEXT, memory_files INTEGER,
  instructions_hash TEXT,
  unavailable TEXT,                     -- JSON list of inputs that failed to hash
  started_at TEXT NOT NULL
);
CREATE INDEX agent_starts_team ON agent_starts (team_id, started_at);
CREATE INDEX agent_starts_session ON agent_starts (session_id, started_at);

memory_manifests (
  memory_hash TEXT PRIMARY KEY,         -- the directory hash below
  files TEXT NOT NULL                   -- JSON { "<relpath>": "<sha256>" }
);
```

Memory changes rarely, so a start stores only `memory_hash`. The per-file hashes live once per distinct directory state in `memory_manifests` (`INSERT OR IGNORE`), and per-file questions such as "which starts saw this version of `feedback-reviews.md`" read through it.

The driver gains an `onSpawn(info)` option, called in `spawnQuery` after the query is constructed with the exact `systemPromptAppend`, effort, cwd, and the launch env. The manager's `ProvenanceRecorder` hashes the inputs and writes the row, then remembers `startId` per session; D1 reads that id when a turn completes. A throw is logged and never reaches the driver.

Hashing: SHA-256 hex, shown as the first 12 characters.
- `group_file_hash`: bytes of `GroupCatalogEntry.file` for the session's group. Frontmatter counts, because settings such as `effort` and `profiles` change behavior too.
- `prompt_append_hash`: the appended text the agent received.
- `memory_hash`: over sorted `relpath \0 sha256(content) \n` of every file under `<claudeConfigDir(launch env)>/projects/<main checkout path with every non-alphanumeric character replaced by '-'>/memory`, with `memory_files` the count; null when the directory is absent.
- `instructions_hash`: `CLAUDE.md` at the session's worktree root (nearest enclosing `.git`), null when absent.

Reading a memory directory of about 50 small files after the query is constructed costs milliseconds and never delays the spawn.

*Why hash the file and the appended text separately:* the file is what a human edits and what a proposal targets. The appended text also changes when another group's description changes. Metrics slice by file hash, and the append hash is kept for diagnosis. *Why not git commits:* group files are edited uncommitted in practice (this branch has a modified `junior-devs.md`), and memory is outside git.

### D3. `team_task_status_events`, written in the status transaction

```sql
team_task_status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL, team_id TEXT NOT NULL,
  from_status TEXT, to_status TEXT NOT NULL,
  actor_kind TEXT NOT NULL,             -- 'human' | 'agent' | 'system'
  actor_session TEXT, at TEXT NOT NULL
);
CREATE INDEX team_task_status_events_team ON team_task_status_events (team_id, at);
```

`TaskStore`'s status update reads the old status and inserts the row in the same transaction only when the status differs. Acceptance already goes through that update, so it records itself. The migration backfills one `system` row per task currently `done` or `cancelled` (`from_status` null, `at = updated_at`) so lead time has data from day one. Backfilled lead times are approximate because `updated_at` moves on revisions; the backfilled rows are marked by `from_status IS NULL`, and the tab labels those values as approximate.

### D4. A pure metrics core over one load per read

`src/server/metrics/`:
- `metricsQuery.ts` loads, in one read transaction, the inputs in two phases:
  1. **Cohorts by in-window events** over `[end − 2w, end)` (window plus baseline): task ids whose first-ever `done` transition falls in range (a `MIN(at)` over each task's `done` rows, so a reopened task first done earlier never re-enters), status events in range (reopens, `done` transitions), results and findings created in range, mail delivered or sent in range, message events in range, and turn usage ended in range.
  2. **Their history, by id, with no time bound:** each cohort task's row and full status history, every result and finding of those tasks, every usage row with those task ids, and for every session that did attributed work, its agent starts (the latest at or before each piece of work is chosen in memory).

  Intervals crossing the range's start are loaded by overlap. That covers limit events from `end − 2w − 24 h` (routing's read cutoff, so an event before the range can still cool into it) and park episodes whose `parked` event precedes the range but whose end does not.
  Retention and recording bound what history exists: a cohort task created before the usage horizon gets its tokens marked partial. The horizon is the later of `end − 60 d` (retention) and the team's first recorded turn (recording began then; `end` when none exists), so tasks predating this change read partial rather than zero.
- Pure modules compute each family: `flow.ts`, `quality.ts`, `overhead.ts`, `capacity.ts`, `coverage.ts`.
- `slices.ts` handles attribution.
- `computeMetrics.ts` assembles `ProcessMetrics` (`src/shared/processMetrics.ts`): per metric its `id`, `family`, `unit`, `value | null`, `n`, `baseline { value, n }`, `insufficient`, `guard` id, and drill-down ids (task ids or message ids).

`METRIC_IDS` and the guard pairs are constants, and proposal validation (D6) uses the same list. Percentiles are nearest-rank, and `MIN_SAMPLE = 10`.

Attribution: each metric definition in `METRIC_DEFS` carries a `side`, and slicing is allowed only on that side.

| Side | Unit of work | Start used | Metrics |
|---|---|---|---|
| author | a task | its owner: the submitter's latest start at or before the task's first result | first-pass yield, fix iterations, tokens per task |
| reviewer | a finding | finding author's latest start at or before `created_at` | finding fail rate |
| sender | a message | sender group only (no start) | mail share, task mail per task |
| turn | a usage row | its pinned `start_id` | token totals |
| team | none | none | lead time, mail wait, reopen rate, coverage, friction, limit tax (profile slice only) |

- **One owner per task:** the author side's unit is the task, never the result, so every task-level value has exactly one owner. A task's first-pass outcome, all of its fix iterations, and every recorded token of it (whoever spent them) count under the owner's slice; the slices' `n` sum to the unsliced `n`. Tasks with no result fall under `no result`. Each slice also reports `mixed`: owned tasks with a later result from a start whose slice value differs. Splitting a task's tokens or iterations across versions was rejected: the denominators would stop being whole tasks, and "tokens per task" would no longer mean what it says.
- **Several reviewers on one result:** each finding counts once on the reviewer side under its own author's start. On the author side the result fails first pass if any of its findings fails.
- **Not sliceable:** a metric shown under a slice its side does not support is marked not sliceable instead of being guessed.
- **No recorded start:** work without one lands in `unrecorded`.
- **Memory-file slices:** for file `f`, take the start's manifest entry for `f` (absent counts as its own slice).

**Cooling time is the router's timeline**, reconstructed by a pure `coolingTimeline(events)` placed beside `cooldownUntil` in `limitEvents.ts` so both read one rule. Sort a profile's final events by `(at, rowid)`, the router's own tie order. Event `eᵢ` decides from its `at` until the earliest of:
- the next final event's `at`;
- its own cooldown end (`resets_at`, else `at + 1 h`);
- `at + 24 h`, when the router's read cutoff drops it. No older event can then take over, since older events left the read window first.

Cooling is the union of these intervals clipped to the window. A property test asserts that for sampled instants `t`, `t` is inside the timeline exactly when `cooldownUntil(events within 24 h of t, t)` is non-null.

**Parked hours** run from `parked` to the next `unparked`/`cancelled`/`forwarded`/`released` event for that message, else to the window end.

A read result is cached per `(team, window, slice)` for 30 s, so the tab and a tool call in the same moment share one computation.

*Why compute at read time:* metric definitions will change while the team learns, and stored values would mix old and new definitions. Cohorts cover 14 days, and their history is fetched by indexed id lookups; that is a few thousand rows today, so computing is cheap.

### D5. Surfaces

- **WS:** `process-metrics-open { teamPath, window, slice }` / `process-metrics-close` / `process-metrics-refresh` → `process-metrics-snapshot { teamPath, teamId, window, slice, computedAt, metrics, reports, unproposed }`. It is re-sent on open, refresh, and every report or decision commit, never on mail changes; the tab shows `computedAt` and a Refresh button. All of these types join `CHAT_CONNECTION_TYPES`.
- **Client:** `metrics` joins `WorkspaceTab` and `RENDERED_WORKSPACE_TABS`, with `#/team/<key>/metrics/<window>[/<report id>]`. A `metricsStore` holds snapshots per team, and `teamWorkspaceStore` holds window, slice, and collapsed families. Components live in `src/client/components/team/metrics/`: `MetricsView`, `MetricFamily`, `MetricRow` (value, `n`, baseline delta, flag, guard beside it), `ReportList`, `ProposalCard`, and `UnproposedChanges`. Drill-down navigates to the Tasks or Messages tab with the ids as a filter.
- **Tool:** `team_metrics { window, slice? }` in `src/server/metrics/metricsTools.ts`, bound to the calling session's team and added to `TEAM_ALLOWED_TOOLS`. It returns the same `ProcessMetrics` plus the usage caveat text.

### D6. Reports, proposals, decisions

```sql
process_reports (id TEXT PRIMARY KEY, team_id, author_session, window,
  period_start, period_end, summary, snapshot TEXT /* ProcessMetrics JSON */, created_at)
process_proposals (id TEXT PRIMARY KEY, report_id, team_id, kind /* change|revert */,
  target_kind /* group|memory */, target /* group id | memory file name */,
  edit TEXT, rationale TEXT, expected TEXT /* JSON [{metric, direction}] */,
  revert_to_hash TEXT)
process_proposal_decisions (proposal_id TEXT PRIMARY KEY, team_id,
  decision /* accepted|rejected */, reason, target_hash_at_decision, decided_at)
process_proposal_link_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id, team_id, action /* link|replace|unlink */,
  change_start_id, change_hash, change_at,    -- null on unlink
  actor_kind /* human|agent */, actor_session, at)
process_commands (team_id, command_id, kind /* decide|link */,
  payload TEXT /* canonical JSON */, outcome TEXT /* JSON */, at,
  PRIMARY KEY (team_id, command_id))
```

**Hashes are kept at the target's own granularity.** For a group, the hash is the group file hash. For a memory target, it is that one file's hash from the manifest; `null` means the file is absent, so a proposal that creates a file links to the change that first gave it a hash.

**Version changes** are derived at read time, never stored. Order every start that loaded the target by `started_at`, then `id`: every start of the group's members for a group target, every start of the team for a memory target. A version change is a start whose hash differs from the previous one. A hash can recur, so A → B → A yields two changes, and the first start ever recorded for a target is not a change.

**Links point at a version change.** A link names the change's start, so it records the post-decision occurrence even when the hash was seen before. The current link is the proposal's latest link event, unless that event is an unlink. History is never rewritten.

**Command outcomes are their own durable rows.** Each human decide, link, replace, or unlink command runs in one transaction:
1. Look up `(team_id, command_id)` in `process_commands`.
2. If the payload is the same, return the stored outcome and write nothing.
3. If the payload differs, refuse and name the first differing field (the `payloadDiff` pattern from `assignmentStore.ts`).
4. Otherwise apply the command and insert its command row.

Because the outcome lives apart from the link and decision rows, a later replace or unlink can't erase a command's identity, and replaying an old link key after an unlink returns the old outcome without re-linking. Agent links get a server-minted key per call, as `task_handoff` does, and they are refused anyway once a link exists.

Tools are `process_report_submit`, `process_reports_list`, and `process_report_get`. Submit checks `canReportProcess` from the caller's current group file. It then validates window roles, groups, metric ids, and revert hashes (a revert hash must appear in `agent_starts` for that group, or as a memory hash), computes the snapshot through D4, and inserts the report with its proposals in one transaction; any refusal writes nothing.

The human decides over WS with `process-proposal-decide { teamPath, proposalId, decision, reason?, commandId }`, through the command protocol above. A second decision on a decided proposal (under a new key) is refused. `target_hash_at_decision` is the latest recorded hash for the target.

**Implementation is never inferred.** A link is written in one of two ways:
- **By the human** over WS (`process-proposal-link { teamPath, proposalId, changeStartId | null, commandId }`; `null` unlinks). The human picks from link candidates: the target's version changes whose start is after `decided_at` and whose new hash qualifies (≠ `target_hash_at_decision` for a change, = `revert_to_hash` for a revert). A revert therefore qualifies when an earlier hash comes back after the decision, and an edit to another memory file never offers anything for this one.
- **By a reporting agent** through `process_proposal_link { proposal_id, change_start_id }`. It is refused unless the caller's group sets `canReportProcess`, the proposal is accepted and has no current link, and the change is a candidate.

A revert linked to a change with any other hash is refused, naming `revert_to_hash`. Only the human replaces or removes a link. Several proposals may link one version change, and each then reads "shares implementation with …".

The state derived at read time:
- **Implemented:** the current link (change start, hash, time, linker), else accepted, not implemented.
- **Outcome:** for each expected metric on its side (D4), compare two slices of work by the target's starts:
  - before: work by starts that loaded `target_hash_at_decision` before the linked change's time;
  - after: work by starts that loaded the linked hash at or after it.

  Pinning the boundary to the change keeps a reverted hash's old work out of the "after" slice. When the metric is team-side, or neither slice has work on its side (a reviewers proposal expecting author-side first-pass yield), the outcome compares equal windows before and after the change time, labeled not attributed. Values below `MIN_SAMPLE` are undetermined.
- **Unproposed:** every version change in the window, for a group or a memory file, that no accepted proposal's current link names, returns to an old hash included.

`canReportProcess` joins the strict booleans in `groupFile.ts`. There is no agent decide, apply, withdraw, relink, or unlink tool, and a test asserts the tool list (the pattern from `STRATEGY_FORBIDDEN_TOOL_NAMES`).

*Why explicit links rather than "next different hash":* a group file can change for reasons unrelated to any proposal, and two accepted proposals on one group would both claim the first edit. Inference would attach outcomes to the wrong change. *Why let the reporting agent link:* it usually makes or requests the edit and knows which version carries it; the human sees the linker and can replace the link.

### D7. Report cadence lives in the lead's prompt

`.kawai/groups/lead.md` sets `canReportProcess: true` and tells the lead to:
- schedule its own 1d, 3d, and 7d reports with `schedule_message`, rescheduling after each one;
- read `team_metrics` first;
- respect the window roles;
- cite `n` and leave insufficient samples undetermined.

The tab's per-window freshness makes a missed report visible. *Why not have kawai send "report due" mail:* there is no system mail sender today, and adding one for a cadence the lead already handles with scheduled mail isn't worth it.

### D8. Limit-event retention

`limitEvents.ts` splits its constant: pruning moves to 15 days, while `forProfile`/`cooldownUntil` keep their 24-hour read cutoff, so routing behavior is unchanged. `profile-limit-handling` requires "at least 24 hours", which this still satisfies.

### D9. Coordination with `plan-supervision`

Its D14 and its "Kawai records usage per completed turn" requirement become a read of `chat_turn_usage` filtered by plan task ids. It no longer defines the table, the driver mapping, the turn-start pinning (now D1 here, same rule), or the write. Its "a turn with no task writes nothing" becomes "a turn with no task has a null `task_id` and is outside every plan read", which gives the same plan totals. A task in this change amends that design and spec (artifacts only).

## Risks / Trade-offs

- [The lead games the metrics] → Fixed guard pairs, frozen server-computed snapshots, unproposed-change detection, and human-only decisions. Coverage exposes closing without results.
- [Small samples get over-read] → `n`, baselines, and the sufficiency flag appear on every value; outcomes stay undetermined below the threshold; and the 1d window can't propose.
- [Reviews mostly happen by mail, so quality `n` is tiny] → Coverage states it. Making results and findings the normal path is the lead prompt's job and shows up in coverage.
- [The memory path layout is undocumented] → Compute it with the CLI's sanitization rule. If the directory is missing, the hash is null and the tab says "memory not found". A test pins the rule against the observed layout.
- [Nobody links an implementation, so outcomes never appear] → Accepted-unlinked proposals that have link candidates are listed as needing a link in the tab, and the lead's prompt tells it to link the proposals it carries out.
- [Frontmatter-only edits create new versions] → Intended (settings change behavior). The proposal and the unproposed-changes list name the group, so the human sees what changed.
- [Backfilled lead times are approximate] → They're labeled and age out of the 14-day horizon within two weeks.
- [Metric reads cost more as the team grows] → The 14-day bounded load plus the 30 s cache.

## Migration Plan

Every table is additive and created by a numbered migration in `src/server/dbSafety/migrations.ts`, never by its store and never by a baseline edit: each DDL lives in a frozen `CREATE_…_SQL` export beside its store (the `strategy/impactSchema.ts` pattern), stores only read and write, and store tests open `schemaDb()`. Stage 1 adds one migration per table group as it lands (task status events with the backfill, agent starts with memory manifests, turn usage); stage 2 adds one for the report tables. Version numbers are the next free ones when each lands — a concurrent branch claiming the same number renumbers on rebase, since versions must stay dense. The status backfill runs inside its migration's `up`, so the framework's version row (committed in the same transaction) guarantees it runs once; the pre-migration backup covers it. Older builds refuse a database whose schema version is newer than they know, per the framework; rollback means restoring that backup.

## Open Questions

- Whether `MIN_SAMPLE` should vary per metric (mail wait reaches 10 within hours; review yield takes days). Starting with one constant doesn't affect the specs.
- Whether the tab should chart a metric across successive reports' snapshots. The snapshots already store what such a chart needs.
