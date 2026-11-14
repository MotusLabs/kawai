# Design

## Context

See proposal.md (Why). Facts that shape the approach, observed in the code on origin/master `9f4eb9f2`:

- `ChatObservationTracker` (`src/server/metrics/observations/chatTracker.ts`) keeps one `LiveTurn` per session. It persists the turn to `process_live_observations` on every handled event (`save()`) and again at the 30 s `checkpoint()`. `recover()` closes each persisted turn at startup as `process-ended` at its `lastSeen` and records a `restart-gap`.
- Every phase change calls `closePhase()`, which writes one `activity` row keyed `segment:<session>:<turn>:<n>`.
- `tool_call` and `tool_result` each write a `tool` row keyed `chat:<session>:<eventId>`; the start row has `durationSeconds: null` and no `outcome`. `approval_request` and `question_request` likewise write a start `request` row. `request_resolved` always writes a `request` row, even with no open request: under the auto policy that is every tool permission (34,135 rows with `requestKind: 'unknown'`). `finish()` writes still-open calls and requests as partial rows with outcome `unavailable`.
- `ObservationStore.record` writes, in one transaction: a `process_observation_keys` row, the observation, one `process_observation_teams` row per team, and the export totals. No caller passes extra teams. `prune()` deletes ledger keys matching `EPHEMERAL_KEY` along with their rows.
- Ledger readers:
  - `reconcile.ts` uses `NOT EXISTS` scans on `usage:`, `source:` and `acceptance:` keys, the `first-acceptance:` marker, and `skipInvalid`'s reservation of a `source:` or `usage:` key;
  - `chatTracker.ts` uses the `chat:` key of each event and the `compaction:` key.
- `ExportAccumulator.observe` builds no family from `activity`, `tool` or `request`.
- `tool-call-metrics` (on master, not implemented; its `toolCalls.ts` is dormant) builds on:
  - per-call `tool` result rows, to which it adds `identity`, `label` and `failureClass`;
  - the 90-day `turn_ended` fact, to which it adds coverage scalars;
  - the indexed `turn_id` lookup of `turn_ended`;
  - ephemeral keys leaving with their rows.

  It forbids storing raw tool names and does not treat the wire sequence as authority. This design keeps every one of those.
- Startup order (`src/server/dbSafety/migrations.ts`): read the version, refuse if too new, take the `startup` snapshot, run the baseline, then apply each migration in a `BEGIN IMMEDIATE` transaction after its checked backup. `initDatabase` (`src/server/db.ts`) calls `migrateSchema`. The database runs `auto_vacuum = NONE` with a rollback journal.

## Goals / Non-Goals

**Goals:**
- Keep the storage cost per managed turn independent of the number of phase changes, and store one row per tool call or request instead of two.
- Keep every existing guarantee: deduplication of stored sources, restart closure at the last checkpoint, export totals, 14-day and 90-day retention, and everything `tool-call-metrics` builds on.
- Make pruning shrink the file and therefore the backups.

**Non-Goals:**
- Per-segment phase sequences. The owner decided that per-turn totals are enough.
- Packing tool calls or storing tool names. That is left to `tool-call-metrics`' bounded identity.
- Changing the Prometheus export, retention lengths, or the 90-day fact kinds (mail, settings, …).
- Switching to WAL.

## Decisions

### D1. Phase totals live on `turn_ended` as flat scalar fields

`LiveTurn` gains `phaseSeconds`, a map from phase name to seconds. `closePhase()` adds the elapsed time to it instead of writing a row. `turn_ended` declares one scalar field per phase: `thinkingSeconds`, `requestingSeconds`, `preparingToolSeconds`, `runningToolsSeconds`, `respondingSeconds` and `retryingSeconds`. It also declares `unmatchedResolutions`.

Flat scalars keep `validateObservation` unchanged, and because the phase set is closed, the field count is bounded. A phase outside the known set (a future `ChatActivity` phase) is added under `otherPhaseSeconds`, so no time is lost and no field is invented.

*Alternative:* a nested `phases` object. Rejected because it breaks the scalar-only contract.

*Alternative:* a separate per-turn kind. Rejected because it adds a row and a key to every turn and buys nothing.

`partial` keeps its meaning. A turn closed by `recover()` carries the totals in its last persisted state, and its open phase closes at `lastSeen` as today.

### D2. One row per call and per request, written at completion

The `tool_call`, `approval_request` and `question_request` handlers only open the live entry; they write nothing. Their `??=` keeps a duplicate start from resetting an open entry.

The completion handlers write exactly today's row:
- `tool_result` writes `startedAt`, `durationSeconds`, `outcome` and `partial`;
- `request_resolved` writes `requestKind`, `startedAt`, `durationSeconds` and `outcome`.

`finish()` still writes open entries as partial `unavailable` rows. The row shape `tool-call-metrics` extends is unchanged, so its D7 additions apply to these rows as written.

### D3. Unmatched request resolutions are counted

A `request_resolved` with no open entry in `turn.requests` increments `turn.unmatchedResolutions` and writes nothing. Orphan `tool_result` handling is unchanged; `tool-call-metrics` owns orphan results (its quarantine and taint rules).

### D4. Deduplication without ephemeral ledger keys

Ledger rows are written only for keys matching the durable predicate `isDurableObservationKey`: the prefixes `usage:`, `source:`, `acceptance:` and `first-acceptance:`, exported from `src/shared/processObservations.ts`. Every other key is deduplicated by `UNIQUE(source_key)` on `process_observations`. The insert becomes `INSERT … ON CONFLICT(source_key) DO NOTHING`, and a non-insert returns `null` exactly as a ledger hit does today, inside the same transaction as the totals.

`chatTracker`'s `chat:` and `compaction:` lookups read `process_observations.source_key`.

The deduplication outcome for every event that still writes a row is unchanged, because that row carries the same key. Events that write no row are idempotent by D2's `??=`. `turn_started` checks its row key before creating a live turn, as now.

`prune()` drops `EPHEMERAL_KEY`. It deletes the ledger key of a pruned row only when the key is not durable, which is now never: durable keys stay, as before.

An enumeration test collects every source-key template under `src/server/metrics/` and asserts each prefix is classified durable or ephemeral with a reason. A new prefix, such as `tool-call-metrics`' planned `tool_streak` key, must be classified on purpose. Durable is the explicit list because the failure modes are unequal: a durable source wrongly treated as ephemeral would be re-recorded after pruning and double-counted in lifetime totals, while the reverse only costs a ledger row.

### D5. Team scope from `team_id`; index set

`record(input, teams?)` loses the `teams` parameter, and `process_observation_teams` is dropped. `forTeam` filters on `team_id`, served by a new `(team_id, seq)` index. That replaces `team_time` (`team_id, observed_at, seq`), which no query uses, and `task` (`task_id, seq`), which has no reader either. The `turn` index stays because `tool-call-metrics`' closure join reads `turn_ended` by turn, and the `kind` index stays because prune uses it.

### D6. Migration `compact-observation-detail` (version 21)

In one `BEGIN IMMEDIATE` transaction, after its pre-migration backup, the migration deletes and drops in set-based statements:
1. `activity` rows;
2. `tool` and `request` rows with no `outcome` field: the start rows (partial `unavailable` rows carry an outcome);
3. `request` rows whose `requestKind` is `unknown`: the orphans, since a matched request is always `approval` or `question`;
4. the `process_observation_teams` table and its index;
5. every ledger key that is not durable;
6. the `team_time` and `task` indexes.

It then creates `(team_id, seq)`.

Export totals and checkpoints are untouched, so lifetime totals are identical before and after (oracle O-M1). The `activity` kind stays declared, so nothing that reads stored history breaks before those rows are gone.

### D7. Compaction is a post-migration startup step

`VACUUM` cannot run inside a transaction, so it is not part of a migration's `up()`. `compactDatabase(db)` in `src/server/dbSafety/compaction.ts` runs from `initDatabase` right after `migrateSchema`, before the server serves:
- if `PRAGMA auto_vacuum` already reads `2` (incremental), it does nothing;
- otherwise it runs `PRAGMA auto_vacuum = INCREMENTAL` then `VACUUM`, and logs the page counts and duration (`db_compacted`).

Any error is logged (`db_compaction_failed`) and swallowed. SQLite leaves the mode unchanged when `VACUUM` fails, so the file stays usable and the next start retries. The migration runner's startup-order comment lists the step.

After each prune pass, the observation service runs `PRAGMA incremental_vacuum` inside `recorder.safe`, which releases every free page in the file, including pages freed by other stores.

Old startup and pre-migration snapshots of the large file rotate out under the existing rules.

*Alternative:* `VACUUM INTO` a new file and swap. Rejected because it needs a file swap and a reopened connection.

*Alternative:* an hourly full `VACUUM`. Rejected because it blocks every hour, whereas incremental mode releases pages as they are freed.

### Acceptance oracles

**Table T1 — tracker event handling** (one live turn):

| id | event | open entry | stored rows | live-state effect |
|----|-------|-----------|-------------|-------------------|
| E1 | tool_call | none | none | `tools[id]` opened |
| E2 | tool_call (duplicate) | open | none | entry unchanged |
| E3 | tool_result | call open | one `tool` row: start, duration, outcome | call closed |
| E4 | tool_result (duplicate event id) | * | none | none |
| E5 | approval or question request | none | none | `requests[id]` opened, wait starts |
| E6 | request_resolved | request open | one `request` row: kind, start, wait, outcome | request closed |
| E7 | request_resolved | none | none | `unmatchedResolutions + 1` |
| E8 | turn_completed or interrupted | calls and requests open | one partial `unavailable` row per open entry, then `turn_ended` with phase totals and `unmatchedResolutions` | live turn removed |
| E9 | turn_started (duplicate event id) | * | none | none |

Unreachable: E4 with no stored row for that event id, since the first delivery of the same event wrote it.

**Table T2 — phase totals:**

| id | sequence | `turn_ended` |
|----|----------|--------------|
| P-a | thinking 2 s, requesting 3 s, thinking 1 s, completed | `thinkingSeconds` 3, `requestingSeconds` 3, others 0 or absent |
| P-b | phase open at interrupt | the open phase is added up to the interrupt |
| P-c | phase open at crash; `recover()` | the open phase is added up to `lastSeen`; `partial` true; `restart-gap` recorded |
| P-d | unknown phase `foo` for 2 s | `otherPhaseSeconds` 2 |
| P-e | request wait while a phase is open | the phase closes at the request; no time is charged during the wait (today's rule) |

**Table T3 — ledger classification at record:**

| id | key prefix | ledger row | duplicate record |
|----|-----------|-----------|------------------|
| K1 | `usage:`, `source:`, `acceptance:`, `first-acceptance:` | written | ignored via ledger, also after the row is pruned |
| K2 | any other | none | ignored via `UNIQUE(source_key)` while the row exists |

**Table T4 — startup compaction:**

| id | auto_vacuum before | VACUUM | outcome |
|----|-------------------|--------|---------|
| C1 | incremental | not run | none |
| C2 | none | succeeds | mode incremental, freelist 0, page count drops |
| C3 | none | throws | logged, mode none, contents intact, `initDatabase` returns, retried next start |

**Properties** (seeded mulberry32, already used in the server tests; no new dependency):
- **P1 (phase conservation):** for random sequences of activity changes, tool calls and results, request opens and resolutions (matched and orphan), duplicates and one optional crash-and-recover point, the sum of the `turn_ended` phase fields equals the sum of the durations the pre-change `closePhase` would have written, computed by a reference model in the test, to 1 ms. Seed 20261029, 300 cases.
- **P2 (one row per completion):** for the same sequences, the number of stored `tool` rows equals the number of distinct calls that completed or were open at close, and likewise for requests. No stored `tool` or `request` row lacks `outcome`, and `unmatchedResolutions` equals the number of orphan resolutions. Seed 20261030, 300 cases.
- **O-M1 (migration):** on a fixture database seeded with every kind, start rows, orphans, partial rows, totals, checkpoints and durable and ephemeral keys, after migration:
  - `process_export_totals` and `process_collection_checkpoints` are byte-identical;
  - durable keys and every kept observation are unchanged;
  - no deleted-class row, team table or ephemeral key remains;
  - `forTeam` returns the same kept rows as before.

Hazards consulted (`docs/oracle-hazards.md`):
- **M1:** T1 rows E3, E7 and E8 also run through the production `ChatSessionManager` composition, and C2 through the real `initDatabase`.
- **Several readers disagreeing:** the durable-key predicate is one exported function used by `record`, `prune`, the migration and the enumeration test.

## Risks / Trade-offs

- [The first start after the upgrade blocks: the pre-migration backup (one more 730 MB copy), the migration's deletes and a full `VACUUM`, about a minute in total] → It runs once, every step is logged with its duration, the deletes run before `VACUUM` so it copies only live pages, and a failed `VACUUM` never stops the start.
- [Per-segment phase order is gone] → The owner accepted this. Per-call tool rows keep the main debugging question answerable.
- [A duplicate `tool_call` event arriving after its result would reopen the call, leaving a phantom partial row at turn end] → The single producer emits fresh event ids and never re-emits. `tool-call-metrics`' first-seen call-id tombstones will close this when it lands. Not worth a separate mechanism now.
- [The 90-day fact kinds still grow to about 330k rows] → Out of scope and stated in the proposal as a follow-up.
- [`incremental_vacuum` adds write I/O after each prune] → It touches only free pages, at most hourly plus backlog batches.

## Migration Plan

1. Ship the code and migration 21 together. On first start: the pre-migration backup (the existing gate), then the migration, then compaction.
2. Rollback: an older build refuses the newer database (database-safety). Restore the `pre-migration-21` backup per `docs/operations/database-backups.md`. A database in incremental mode is readable by every SQLite Kawai supports.
3. Coordination: reword the `process-observability` delta ("activity intervals" becomes per-turn activity totals) in the same pull request.
