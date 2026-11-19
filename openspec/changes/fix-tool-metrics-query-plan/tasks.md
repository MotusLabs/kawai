# Tasks

## 1. Correct both lookup plans with their regression coverage

- [x] 1.1 Prepare an isolated implementation checkout containing `3279b2c793c3703c02f6189e6f68adb0eb95e967` or a descendant, carry this change's planning artifacts into it, and verify the loader and preserved session/turn index exist. Leave the older planning checkout's unrelated edits intact; verify the implementation base and scoped diff before committing.
- [x] 1.2 Add the two index requirements in `toolMetricInputs.ts` and P1/P2 checks in `toolMetricInputs.test.ts` using the fully migrated synthetic history and SQL/bindings intercepted through production `readMetrics`. Verify P1 kills a closure-only `INDEXED BY process_observations_team` mutant and P2 kills the equivalent live-only mutant before executing the bad query. Keep other predicates, output shapes, ordering, and transaction ownership unchanged.
- [x] 1.3 Commit the design's O1–O7/O9 rows verbatim as table-driven tests and add G1/G2 with the specified seeds, 128 cases each, and independent array references. Add `@covers` annotations for the delta scenarios directly above their tests. Verify the focused suite kills the cohort mutants in the oracle map below; never derive expected rows by executing the production SQL again.
- [x] 1.4 Preserve and exercise O8 through the existing concurrent-WAL `readMetrics` test in `toolMetrics.test.ts`, adding the new scenario annotation or narrow assertions as needed. Verify O8 kills removal of the enclosing read transaction: the initial read stays pending, while a fresh read sees the committed closure.
- [x] 1.5 Update the metrics architecture bullet with both index dependencies and the remaining session-history scaling limit. Verify A4 against the actual loader and migrated schema, rejecting documentation that claims constant-time reads or a captured incident-triggering request. Land the query correction, its tests, and this documentation together.

- [x] 1.6 Apply the owner-approved test-only stabilization in `chatSessionManager.observations.test.ts`: wait for the observed startup status publication before opening subscriptions, preserving the budget-refusal and cache assertions. Verify the existing status-change scenario passes with the usual callback and with a delayed startup publication; the original initial count assertion must remain exact rather than being weakened.

## 2. Integration verification


- [x] 2.1 Verify P1/P2, O1–O9, and G1/G2 with `bun run test src/server/__tests__/toolMetricInputs.test.ts src/server/__tests__/toolMetrics.test.ts src/server/__tests__/metricsQuery.test.ts src/server/__tests__/metricsConnections.test.ts src/server/__tests__/metricsTools.test.ts src/server/__tests__/toolDrillPaging.test.ts`; demonstrate the listed plan and semantic mutants are killed, and restore every mutant before the final checks.
- [ ] 2.2 Run `openspec validate fix-tool-metrics-query-plan --strict` and `bun run check` on the clean committed isolated implementation tree. Verify all acceptance clauses, the restored passing versions of the P1/P2 and O1–O9/G1/G2 tests, and a diff limited to design Scope. Include an oracle-to-exact-test-title-to-killed-mutant map in the result; optional bounded read-only backup replay supplements these checks without a private fixture dependency.

## Oracle and mutant map

Record the actual test titles alongside these IDs in the implementation result.

| Oracle | Mutant the test must kill |
| --- | --- |
| P1 | Force the closure inner table to the broad team index |
| P2 | Force the live inner table to the broad team index |
| O1 | Read a non-closure kind instead of `turn_ended` |
| O2 | Filter closure timestamp to the tool-completion interval |
| O3 | Independently remove team, session, or turn equality, or allow null identities to match |
| O4 | Replace `>= from` with `> from`, or `< to` with `<= to` |
| O5 | Require the live tool row's turn to equal the current live turn |
| O6 | Bypass scope-session validation or the string turn-id requirement |
| O7 | Accept a streak row as a qualifying tool, or omit the requested-team constraint |
| O8 | Remove the caller's shared read transaction |
| O9 | Replace existence matching with a duplicating join, or order closures by timestamp |
| G1 | Drop one closure matching predicate or change either interval bound |
| G2 | Broaden live matching across sessions or tighten it to the current turn |

## Workflow follow-up

- Deployment/restart requires a later operational request and is not a task of this planning change.
- Archive only after implementation and the project's review requirements; carry covering annotations for every added scenario when syncing/archiving.
