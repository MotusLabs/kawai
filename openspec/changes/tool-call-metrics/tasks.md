# Tasks

## 1. Pure model

- [ ] 1.1 Add `src/server/metrics/observations/toolCalls.ts` with `toolName` (D1), `failureClass` (D2), and the streak reducer (D3). Capture one real failure line per FC2–FC5 row from the local chat-wire logs into `src/server/__tests__/fixtures/toolFailureTexts.ts`, with paths and secrets replaced. Confirm how a denied approval links to its tool call, and record the link used.
  - Verify: commit the FC, TN, and ST tables verbatim as table-driven tests in `src/server/__tests__/toolCalls.test.ts`. Kill these mutants:
    - the denial check moved after the prefix checks (FC1);
    - the `Invalid arguments for ` prefix removed (FC3, so Codex refusals read `refused`);
    - the team-table lookup replaced by a prefix test (TN4);
    - another tool's result closing a streak (ST5);
    - turn end closing as `recovered` (ST6).

## 2. Tracker and storage

- [ ] 2.1 In `chatTracker.ts`, write `tool` and `failureClass` on `tool` rows. Keep the streak state per live turn, close streaks at turn end, interruption, and process end, and carry open streaks in the live checkpoint. Recovery closes them `unknown`.
  - Verify: P1 through the real tracker, seed `0x7001`, 300 cases (ST1–ST9). Kill the mutant that leaves checkpointed streaks out (ST8).
- [ ] 2.2 Make `tool_streak` a 90-day fact kind in the retention lists, and keep `tool` detail at 14 days.
  - Verify: a retention test shows a 20-day-old `tool_streak` survives the prune and a 20-day-old `tool` row does not. Kill the mutant that classifies `tool_streak` as detail.
- [ ] 2.3 Confirm that no output text reaches storage.
  - Verify: a test feeds a failed result carrying a canary string and asserts the canary appears in no observation row. Kill the mutant that stores `output`.

## 3. Export

- [ ] 3.1 Add the three D5 families to `registry.ts`, the `tool`, `failure_class`, and `resolution` labels to `boundedLabels.ts` (tool cap 96), and the `tool` and `tool_streak` cases to `ExportAccumulator.observe`. Bump the definition version.
  - Verify:
    - P2 (totals equal results and facts, unchanged by pruning);
    - the spec scenario "Many distinct foreign tools" with 500 names, exported as one `mcp:other` series;
    - a render test of HELP/TYPE and buckets.
    - Kill these mutants: counting `tool_call` rows (P2), and no overflow for `tool`.

## 4. Process metrics and UI

- [ ] 4.1 Add the `tools` family and its four metrics to `src/shared/processMetrics.ts`, read the window's tool observations in `metricsQuery.ts`, and compute them in `computeMetrics.ts` with the turn attribution side. Rows recorded before the deploy count as unrecorded.
  - Verify: the `team-process-metrics` scenarios "Misleading schema shows up" and "Weak model gives up more" as tests. Kill the mutants that count every call instead of each turn's first, and that treat unrecorded rows as successes.
- [ ] 4.2 Render the family in the Metrics tab and add the streak drill-down, which selects the chat and sets `pendingReveal` to `tool:<firstCallId>`.
  - Verify: a client test for "Open an abandoned streak". Kill the mutant that reveals the last failed call instead of the first.
- [ ] 4.3 Make `team_metrics` return the family.
  - Verify: a tool test through the production `teamToolTable` (hazard M1).

## 5. Docs and check

- [ ] 5.1 Update `docs/operations/process-observability.md` (families, labels, failure classes, turn-scoped streaks, `unknown` as a lower bound, and the two example alert rules) and AGENTS.md's observability bullet.
- [ ] 5.2 Run `bun run check` on the clean committed tree. The result maps FC1–FC10, TN1–TN6, ST1–ST9, P1, and P2 to test titles and killed mutants.
