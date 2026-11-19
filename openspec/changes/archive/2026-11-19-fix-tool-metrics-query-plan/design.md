# Design

## Context

See proposal.md for motivation and the capability delta for required behavior. This design is included because the defect involves query-planning performance and preservation of a concurrent read snapshot.

The inspected release is `v1.0.0-3720`, commit `3279b2c793c3703c02f6189e6f68adb0eb95e967`. `loadMetricsInputs` calls `loadToolMetricInputs` inside its read transaction. The loader reads in-window tool/streak detail, matching retained closures, live identities, and retention checkpoints. `readMetrics` serves the tab, agent tool, and fresh report snapshots.

The closure query's inner alias `t` is correlated by team, session, and turn. The live query correlates by session, deliberately not turn. Both can select `process_observations_team(team_id, seq)` for `t`. The schema also has `process_observations_turn(session_id, turn_id, seq)`; migration 21 preserves it. Existing tests cover correctness with small histories and a concurrent WAL closure commit, but do not protect the access path.

Investigation against the pre-freeze backup found 179,146 observations and 10,502 `turn_ended` rows. Bun 1.4.4's original closure plan selected the team index for the inner search, generated about 2.32 GB/s of cached reads, and remained unfinished at the three-second diagnostic cutoff. With the session/turn index it returned 3,479 rows in 75.69 ms for the 14-day interval. These are diagnostic measurements, not CI thresholds, and do not establish which incident request invoked the query.

The planning checkout is older than this release. Apply on an isolated checkout containing the release or a descendant; do not restore missing implementation files into the old checkout or disturb unrelated edits.

## Goals / Non-Goals

**Goals:** prevent repeated team-wide inner searches at both loader sites, retaining all predicates, bindings, transaction ownership, ordering, and output shapes. Make a regression fail before it can perform a costly large-history query in CI.

**Non-Goals:** constant-time metrics, eliminating the loader's one-pass team scans or sorts, bounding a single session's retained history, worker execution, global database instrumentation, and the separate `bounded-metrics-reads` feature. No schema or metric-definition changes.

## Decisions

### D1 — Require the existing index at both correlated inner searches

Add `INDEXED BY process_observations_turn` to the inner `process_observations t` table reference of the closure and live-session queries. Keep the team and kind predicates and `[from,to)` time filters. Closure probes use both `session_id` and `turn_id`; live probes use the session prefix of the same index. The outer closure scan and `ORDER BY c.seq` remain as they are.

This removes the demonstrated team-history-times-turns access pattern without a migration. It does not promise that live matching is bounded independently of a session's own history.

Alternatives: a new composite index adds storage and recording overhead despite an already useful index; `ANALYZE` alone leaves behavior dependent on local statistics; rewriting the cohort construction increases semantic surface; a worker would isolate the HTTP loop but still run the expensive plan. Prefer the demonstrated narrow correction.

### D2 — Preserve cohort semantics exactly

A closure is retained only when an in-window `kind='tool'` row matches its team, session, and turn. Do not constrain the closure's own timestamp. Do not substitute `tool_streak` for the qualifying tool row. Multiple qualifying tool rows do not duplicate a closure. SQL equality with null identities must not become a new match.

The live query retains its existing scope/session validation and string turn-id requirement. Its qualifying tool row matches the session, even when that row belongs to a different turn of the session. Tightening it to the current turn would change existing semantics and is excluded here. All reads remain inside the caller's transaction.

### D3 — Inspect the SQL production actually executes

Add focused tests in `src/server/__tests__/toolMetricInputs.test.ts`, using the migrated `schemaDb` fixture and a narrow `prepare` interception like the existing WAL test in `toolMetrics.test.ts`. Drive at least one check through `readMetrics`, intercept the two correlated SELECTs, and run `EXPLAIN QUERY PLAN` with their real bindings through the saved original `prepare` method before executing their `.all` calls.

For the inner observation table, assert a search constrained by session and turn for closures, and by session for live rows. Reject team-only inner searches. Do not snapshot full plan text, numeric node ids, or the `EXISTS`/subquery presentation: SQLite versions render them differently. Do not assert the outer scan's index. Assertions inspect executable plans rather than copied SQL or the mere presence of an index hint.

Use a synthetic migrated database with at least 128 closure identities, 5,000 unrelated same-team observations, and 16 live sessions. Plan assertions run before executing the correlated SELECTs so the known bad plan fails promptly. No production backup, private transcript, wall-clock threshold, or new package belongs in CI.

### Acceptance oracles

Commit these observable-result rows verbatim as table-driven tests. `from` is inclusive and `to` exclusive. Matching identities include the requested team; closures are returned by ascending sequence.

| ID | Input | Expected result |
| --- | --- | --- |
| O1 | In-window tool and same-team/session/turn closure | Closure included once |
| O2 | As O1, closure timestamp before `from` or at/after `to` | Closure still included once |
| O3 | Only another team's, session's, or turn's tool; or a null closure session/turn | Closure excluded for each variant |
| O4 | Matching tool completion at `from`, then at `to` in separate fixtures | Included at `from`; excluded at `to` |
| O5 | Valid live identity; same-team/session tool is in-window but belongs to another turn | Current live identity included |
| O6 | Live scope session mismatches its row key, or its scope turn id is not a string | Live identity excluded for each variant |
| O7 | No qualifying tool row, including a streak-only row or another team's tool | Neither a closure nor a live identity is qualified |
| O8 | Concurrent closure commit and live-row deletion after read snapshot starts | First read stays pending; subsequent fresh read sees closure |
| O9 | Two tool rows qualify one closure; several closures are inserted out of time order | No duplicate closures; ascending sequence order |

P1 is the production closure-plan oracle: the inner lookup uses session and turn equality, rather than a team-only search, on the synthetic large history. P2 is the analogous live-plan oracle for session equality. These guard actual production wiring, addressing the test-seam hazards in `docs/oracle-hazards.md`.

G1 is closure-result equivalence: generate 128 small fixture cases with seed `0x19A11`, varying team/session/turn, nullable identities, tool versus streak rows, duplicates, and interval boundaries; compare `loadToolMetricInputs` closure sequences with an independent array-filter reference for D2's predicate. The reference must not call SQL or the production matcher. G2 is live-result equivalence: use seed `0x19A12`, 128 cases, varying live scope validity and same-session tools from current/other turns; compare the returned live set with an independent array reference. Reuse the test suite's seeded generator if available, otherwise a small deterministic generator; add no dependency.

## Risks / Trade-offs

- A future migration could rename/drop the required index. Mitigation: run the plan tests against the fully migrated schema; do not fall back silently to a team scan.
- Plan display differs by SQLite version. Mitigation: check the inner table's search constraints, not a whole-string snapshot.
- Runtime still depends on relevant history and concurrent CPU load. Mitigation: claim elimination of the demonstrated multiplicative scan, not a universal response deadline.
- Output-only tests could miss the performance defect. Mitigation: P1/P2 independently reject forced team-index mutants before executing them, while O1–O9 and G1/G2 guard semantics.

## Migration Plan

No database migration or data repair. Ship the query-only correction through the normal release process after checks. Deployment/restart is a separate operational action, not part of proposal creation. If a rollback is required, reverting the code restores the old plan risk; avoid metrics reads until a corrected release is available. Never use the live database as a destructive test fixture.

## Approved verification adjustment

The first full check passed 11,451 tests and failed the existing observation-status subscription test: an initial snapshot count was three rather than two. That test passes in isolation on both this branch and the unmodified release. Its startup status notification can overlap the asynchronous subscription opens. The owner explicitly approved extending scope to stabilize this test only. Wait for an observed startup publication before opening subscriptions, using the existing `waitForCondition` helper; retain every budget-refusal, cache-identity, and two-team delivery assertion. No production notification behavior changes.

## Implementation contract

### Acceptance

- A1: P1 and P2 inspect both queries reached through production `readMetrics` and reject team-only inner searches on the migrated synthetic history.
- A2: O1–O7 and O9, plus G1/G2, preserve closure and live sets, boundary behavior, team isolation, null handling, uniqueness, and sequence ordering.
- A3: O8 preserves the existing WAL single-snapshot result through `readMetrics`; the fresh read sees the later commit.
- A4: The metrics architecture bullet names both lookup/index dependencies and their scaling limit; release evidence identifies the inspected source base without claiming the incident trigger was captured.

### Invariants

- I1: Closure membership and ordering equal D2's predicate; G1 supplies the generator, independent reference, seed, count, and loader seam.
- I2: Live membership equals the existing session-level rule; G2 supplies the generator, independent reference, seed, count, and loader seam.

### Scope

- `src/server/metrics/toolMetricInputs.ts`
- `src/server/__tests__/toolMetricInputs.test.ts`
- `src/server/__tests__/toolMetrics.test.ts`
- `src/server/__tests__/chatSessionManager.observations.test.ts`
- `docs/architecture/metrics.md`
- `openspec/changes/fix-tool-metrics-query-plan/**`

### Verification

- V1: Run the focused loader and existing metrics/WAL tests via `bun run test`; P1/P2 must kill separate forced-team-index mutants and O1–O9/G1/G2 must kill the semantic mutants listed in tasks.md.
- V2: Validate this change with `openspec validate fix-tool-metrics-query-plan --strict`, run `bun run check` on the isolated clean committed implementation tree, and report the result with an oracle-to-test-title-to-killed-mutant map.
- V3: Optional local replay uses only a read-only backup connection, with bounded diagnostic execution; the backup is not a required test dependency and cannot replace V1/V2.

### Excluded

- X1: No migrations, new indexes, dependencies, tracing infrastructure, worker architecture, API changes, or production database writes.
- X2: No rewrite of live matching to require the current turn and no closure-time filter.
- X3: No edits to the other active metrics proposals, unrelated workspace changes, or service deployment during implementation verification.
