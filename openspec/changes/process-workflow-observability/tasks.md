# Tasks

Planned work. Numbers are `process-observability`'s (its boxes stay
unticked). Starts after `process-quota-history-and-incident-advice` lands;
archives after it and after `process-observability-foundation`.

## 5. Acceptance and process bottleneck measurements

- [ ] 5.1 Extend the shared registry/query layer with first-acceptance cohorts, token/quality guards, and acceptance mechanism (D1); existing lead-time ids unchanged. Verify scenarios "Done without acceptance" and "Reaccepted task", creator/system acceptance, first acceptance outside the window, and post-acceptance rework; mutant "acceptance replaced by first done" fails.
- [ ] 5.2 Implement canonical stage/wait boundaries and the Table P partition (D2) with concurrent-cause detail. **Checkpoint 1** (design). Commit Table P and property PP1 (seed `0x9A27`, 200 cases). Verify queued review, competing blockers, parallel reviewers, supersession, unknown intervals, agent time above elapsed; mutant "overlaps summed" fails PP1.
- [ ] 5.3 Add unfinished age/count and closed-without-acceptance/usage/interval coverage beside completion distributions. Verify "Completion bias", "Long-running incomplete task", and mixed-model tasks not credited wholly to the last worker.
- [ ] 5.4 Add bottleneck assessment rules and Metrics/tool/report representations; document definitions, cause priority, and sufficiency. Verify review queueing yields a queue investigation while holds and dependencies yield no faster-model advice ("Fast model causes rework").

## 6. Human choices, interventions and report compatibility

- [ ] 6.1 Add the human `process-advice-decide` and `process-intervention-link` commands (D3) with replay keys and stale-assessment checks. Commit Table H and property PP3 (seed `0xDEC1`, 200 cases, crash at each transaction boundary). Verify "Recommendation accepted" and "Revised action"; mutant "accept dispatches" fails H1.
- [ ] 6.2 **Proposed behavior change, after approval only:** link group/memory advice to existing process proposals and allow change/revert proposals in every window (D4, Table W), updating `src/shared/processReports.ts`, the `reportTools.ts` description, the existing window-role test, and lead documentation together. Verify Table W and "Already approved prompt edit"; prior decisions and links intact.
- [ ] 6.3 Add frozen assessment references to report submission and definition versions to snapshots. Verify "Recommendation later changes", "Definition changes after a report", unknown/other-team references writing nothing, and old reports readable.
- [ ] 6.4 Add decision/intervention UI and assessment history to the Metrics view; document approval versus implementation versus observed outcome. Verify changed actions need fresh approval and expired evidence is identified ("Digest after pruning" for records).

## 7. Daily reassessment and durable digests

- [ ] 7.1 Persist validated per-team schedule/time zone and collection/retention settings with documented defaults. Verify Table D row DG-7 and that completed usage cannot go below 90 days; schedule edits keep dated digests (DG-6).
- [ ] 7.2 Implement the minute scheduler, daily reassessment, and digest/checkpoint transaction (D5). **Checkpoint 2.** Commit Table D (DG-1–DG-10, including the reviewer's Jan 1–3 downtime example as DG-8) and property PP2 (seed `0xD16E`, year sweep in three zones over generated running and downtime spans, design "Properties"). Verify "Restart after scheduled time", "No new evidence", generation without a lead or Prometheus; mutant "catch up every missed date" fails DG-4, DG-8 and PP2; mutant "skip a date due while running" fails DG-9 and PP2; mutant "no missed-interval record" fails DG-8.
- [ ] 7.3 Display typed system digests beside agent reports with period/freshness and changed/resolved advice. Verify "Lead unavailable", no agent impersonation, no duplicate scheduled lead message; add daily-operation docs.

## 8. Human-scoped model and compaction experiments

- [ ] 8.1 Add versioned experiment definitions, human scope/guardrails/stopping criteria, and explicit membership links. Verify X-1, X-2 and "Compaction experiment proposed".
- [ ] 8.2 Implement observational outcomes for acceptance time, tokens, first-pass yield, fixes, reopens, unfinished ages. Verify X-3 and "Small compaction sample"; later reopens revise quality evidence.
- [ ] 8.3 Implement compaction experiment suggestions over actual loaded thresholds/context metadata. Verify X-4; guard degradation changes advice without stopping work.
- [ ] 8.4 Add experiment creation, membership, comparison and outcome UI linked to recommendations/digests; document observational limits. Verify one fixture tracks a human-recorded threshold change through acceptance and rework.

## 9. Export

- [ ] 9.6 Connect and document provider-account quota, canonical incident, and stage/wait families plus blocked-work, open-age and quota gauges (D7). Verify shared-account quota is not duplicated by team (I3), status-only/failing updates keep freshness, source support changes, and exported definitions match the Metrics/incident contracts; mutant "series per team" fails.

## 10. Cross-change adapters and end-to-end verification

- [ ] 10.1 Add adapters for revision-control hold/pause/checkpoint facts, plan stage/wait/stall, and landing acceptance; report revision-apply facts as an absent capability until `plan-revision-apply` lands. Verify named waits versus stalls, no duplicate episode alerts, integration acceptance before promotion, and plan capabilities absent.
- [ ] 10.2 Map Codex observations from the Kawai adapter over the package session's turn finalization; verify cumulative/delta tokens, supported-field coverage, shared-login limits, and, as an integration fixture, one logical turn when `codex-capacity-retry` attempts are present. Managed-Claude collection works without a Codex adapter.
- [ ] 10.3 Run an isolated walkthrough from dispatch through quota incident, human handoff, review and acceptance, then restart/daily reassessment/pruning, with Prometheus disabled, and repeat the export branch with scrape downtime and unauthorized requests. Run it as a fixture-gated spec listed by `scripts/e2e-fixture-specs.ts` in private CI with a disposable checkout, database and port (never `bun run test:e2e`, never live data).
- [ ] 10.4 Citation preflight, `bun run check --full-properties` on the clean committed head under pinned Bun 1.4.3, `scripts/verify-result.ts`, strict validation; verify no regressions to acceptance, mailbox delivery, notification sounds, or background-task session status, and record prerequisite availability limits. Map every oracle id to its literal title and killed mutant; add `@covers` at archive.
