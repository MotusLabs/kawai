# Proposal

## Why

A synchronous tool-metrics read can stall Kawai's HTTP and WebSocket handling because SQLite repeatedly scans a team's observation history for each completed turn. The November 19 investigation reproduced heavy cached reads against a pre-freeze backup; selecting the existing session/turn index returned the 14-day closure cohort in about 76 ms.

## What Changes

- Constrain both correlated tool-observation lookups in `loadToolMetricInputs` to the existing session/turn index, preventing repeated team-wide scans.
- Preserve metric values, team boundaries, window boundaries, closure eligibility, live-session semantics, ordering, and the shared read transaction.
- Add production-query plan checks and synthetic-history correctness tests, including closures outside the tool-call window and concurrent closure commits.
- Document the lookup/index dependency in the metrics architecture bullet.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `team-process-metrics`: tool cohort reads must avoid multiplying a team's observation history by its completed turns or live sessions, while preserving the recorded cohort.

## Impact

Implementation targets `src/server/metrics/toolMetricInputs.ts`, focused server tests, and `docs/architecture/metrics.md`. There is no schema migration, new dependency, API change, or production-data mutation. The existing `process_observations_turn(session_id, turn_id, seq)` index is retained by migration 21.

The implementation base must include deployed release `v1.0.0-3720` (`3279b2c793c3703c02f6189e6f68adb0eb95e967`) or a descendant; the planning checkout at `972133ec` predates the affected loader. This is independent of `bounded-metrics-reads`, which addresses response projection and paging.

## Non-goals

Query tracing, worker-based metric execution, a general query timeout, response paging, new indexes, retention changes, and reconstructing the exact incident-triggering request are outside this change. The reproduced defect is strong incident evidence; the active incident SQL was not captured.
