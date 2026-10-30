# Proposal

## Why

Process-observation detail takes up most of Kawai's database, and nothing reads it. A copy of the live database taken on 2026-10-29 was 729 MB, and about 643 MB of it (88%) was observation tables and their indexes. In ten days the observer wrote 513k rows: 268k activity segments and 141k tool rows. Each row costs about 1.25 KB across the table, its five indexes, the `process_observation_keys` ledger and the `process_observation_teams` table, against about 100 bytes of timing data. No production code reads the rows: `ObservationStore.forTeam` has no caller outside tests, and the Prometheus export reads `process_export_totals`.

Backup rotation multiplies the cost. The 34 rotated backups take 22 GB. The file never shrinks either: `auto_vacuum` is off and the free list is empty, so pruning frees pages for reuse but returns nothing to the disk or the backups. At about 60 MB a day and 14-day interval retention, the observation tables alone reach about 1 GB before pruning keeps pace.

## What Changes

- **Activity phases become per-turn totals.** A turn no longer writes a row per phase segment. It accumulates seconds per phase (`thinking`, `requesting`, `preparing_tool`, `running_tools`, `responding`, `retrying`) and records them once on its `turn_ended` observation. This is about 70 rows per turn fewer.
- **Tool calls keep one row per call.** Today each call writes a start row (no duration) and a result row. The start row is dropped, and the result row keeps its current shape. That shape is the one `tool-call-metrics` extends with a bounded tool identity and a failure class, and which its tool metrics read. Packing calls together, storing raw tool names and replacing event deduplication are left out to keep that design intact.
- **Orphan request resolutions are no longer recorded.** A `request_resolved` event with no open approval or question in the turn writes nothing. These come from tools that auto-approve resolved without a card, and they account for 34,135 of the 34,229 request rows. The turn counts them instead. Each real approval or question keeps one observation, written when it resolves; the start row is dropped.
- **The schema is cleaned up in a new numbered migration.** It:
  - drops `process_observation_teams`, an exact copy of `team_id`;
  - keeps only durable-source keys (`usage:`, `source:`, `acceptance:`, `first-acceptance:`) in `process_observation_keys`;
  - replaces the `team_time` and `task` indexes (no reader) with one `(team_id, seq)` index, keeping the `turn` index that `tool-call-metrics`' closure join uses;
  - deletes existing activity segments, tool and request start rows, and orphan request rows.

  Ephemeral keys are already deduplicated by `UNIQUE(source_key)` on `process_observations`.
- **The database file returns pruned space.** One startup compaction, run after the migrations, sets `auto_vacuum = INCREMENTAL` and runs a full `VACUUM`. Each prune pass then releases free pages with `incremental_vacuum`. Backups shrink with the file.
- **Retention is unchanged**: 14 days for interval detail and 90 days for facts. Prometheus families, labels and lifetime totals are unchanged.
- **BREAKING (stored data only):** existing per-segment activity rows, tool and request start rows, and orphan request rows are deleted by the migration. They have no reader, and they would have aged out within 14 days.

## Capabilities

### New Capabilities
- `process-observations`: compact storage of managed-turn detail (per-turn phase totals, one row per tool call, matched requests only) and the key-ledger and team-association layout. The capability is otherwise owned by the in-progress `process-observability` change and has no main spec yet, so this change adds requirements under distinct names. It also aligns the wording of `process-observability`'s "Turn timing includes non-completing outcomes" requirement ("activity intervals" becomes per-turn activity totals). `tool-call-metrics` (on master, not yet implemented) owns tool identity and failure classes; this change keeps the per-call row it extends.

### Modified Capabilities
- `database-safety`: adds a requirement that pruned space is returned to the file through incremental auto-vacuum, enabled by a one-time startup compaction that runs outside any migration transaction and never prevents startup.

## Impact

- Code:
  - `src/server/metrics/observations/`: `chatTracker.ts` (phase totals, no tool or request start rows, orphan rule, key checks against `process_observations`), `store.ts` (no team table, ledger only for durable keys), `service.ts` (`incremental_vacuum` after prune), `schema.ts`;
  - `src/shared/processObservations.ts`: the `turn_ended` data fields and the durable-key predicate;
  - `src/server/dbSafety/`: the new migration, and a post-migration compaction step in the startup order.
- Database: one new numbered migration, plus a one-time full `VACUUM` at the first startup after it. That startup takes longer, from seconds up to about a minute on a 730 MB file, and needs free disk space about the size of the compacted file.
- Docs: `docs/operations/process-observability.md` and `docs/architecture/metrics.md` and `database.md` (storage shape, compaction) and `docs/recovery-matrix.md` (an interrupted or failed compaction).
- Coordination: `process-observability`'s spec delta wording on activity intervals. `tool-call-metrics` is unaffected: its per-call rows, `turn_ended` carrier, `turn` index and ephemeral-key pruning semantics all remain.
- Expected result: about 14k observation rows a day instead of about 50k. Interval detail at 14 days drops from about 640k rows to about 150k. Fact kinds (mail, settings, usage, turn outcomes) are kept for 90 days and are untouched here; at about 3.7k a day they reach about 330k rows. Steady-state observation storage is roughly 300 MB instead of about 1.2–1.3 GB. Right after the upgrade the file and every new backup drop from about 730 MB to about 150 MB. Shrinking the 90-day facts (mail and settings rows above all) is a possible follow-up, not part of this change.
