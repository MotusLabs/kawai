# Tasks

## Delivery order

The approved foundation is implementable without the provider/dispatch/context prerequisites. Execute groups 1 and 2, then tasks 9.1-9.5. Next satisfy integration gate 3.1 and continue groups 3-8, task 9.6 and group 10. Numeric section order preserves the existing feature grouping; this dependency order controls execution.

Missing prerequisites leave only their consuming integration tasks pending. Foundation availability/unknown-source handling is not completion of those integrations, and the full change cannot archive until every remaining task/spec is satisfied. Task 1.1 is a baseline audit; the original requirement to verify landed provider/dispatch/context contracts is retained in the separate task 3.1.

## 1. Contracts and observation persistence

- [x] 1.1 Refresh/rebase the dedicated branch onto the current default branch, preserving planning commits, and audit the existing managed-chat/task/result/usage and DB-safety source/spec versions in implementation notes; verify the foundation sources and archived `chat-turn-usage`/`process-reports` capabilities exist. Record unavailable integrations against gate 3.1 instead of blocking the foundation or archiving another change.
- [x] 1.2 Add SDK-free observation, coverage, identity and measurement-version types plus frozen schema exports and numbered migrations for observations, team associations, source processing identities and collection checkpoints; verify migration upgrade/restart and duplicate-source-key tests with `schemaDb()`.
- [x] 1.3 Implement the protected recorder and post-commit hooks for task/result/assignment/mail/limit facts, including acceptance actor/mechanism and preserved handoff/result/revision identity; verify duplicate callbacks count once and recorder failure cannot roll back acceptance or mailbox settlement.
- [x] 1.4 Implement durable-source reconciliation and gap/health reporting; verify crash/replay recovery restores known facts, marks irrecoverable live gaps and cannot create measured activity from old chat text.
- [x] 1.5 Extend `chatTurnUsageStore.ts` retention and all `metricsQuery.ts`/outcome horizon calculations to 90 days, with bounded pruning and immutable evidence retention; verify 75-day usage survives, already-pruned history stays partial, and document the retention/coverage contract.

## 2. Managed turn and context measurements

- [x] 2.1 Feed task/start-pinned turn lifecycle observations from the driver/manager, including failure, interruption, process exit and restart uncertainty, using only outcome classifications actually provided by the landed driver; verify task-less/mid-turn reassociation cases and that incomplete usage never becomes measured zero consumption.
- [x] 2.2 Record activity, request-card and tool interval edges independently of the live activity projection; verify approval wait subtraction, overlapping tool union versus summed work, and background shells/Monitors not inflating active development time.
- [x] 2.3 Preserve structured compaction trigger/pre/post metadata, observed start/end, available source failure metadata and threshold source/settings provenance; canonical context-recovery episode linkage remains in 4.4 after gate 3.1, rather than being reimplemented here; verify missing post size/duration and approximate context-window fallbacks remain unknown/approximate.
- [x] 2.4 Add context sampling/coalescing and actually available settings/account-version snapshots at exact lifecycle boundaries (unknown account identity stays unknown until the provider adapter in group 3); verify high-frequency deltas are bounded, compaction/failure boundaries remain exact and catalog edits cannot relabel historical observations. Document the timing/token scope and omitted subagent usage.

## 3. Provider quota history and eligible alternatives

This integration group follows the foundation milestone; its prerequisite gate does not block groups 1-2 or tasks 9.1-9.5.

- [ ] 3.1 Verify/rebase the actual landed provider-scoped usage/cooldown, worker-choice/capacity and context-exhaustion episode interfaces required by D12; record consumed versions and verify provider-scoped main-spec requirements before applying the usage delta. Keep this task and dependent integration behavior pending while contracts are unavailable; do not use stubs, fixture-only substitutes, partial upstream task counts, or an automatic archive as proof.

- [ ] 3.2 Extract shared quota readers from `ChatSessionManager.ts` with live-session and configured-team-worker subscriptions, effective account-context deduplication and team access associations; verify an unused eligible quota-serving provider is polled without starting an agent and shared accounts are pulled once.
- [ ] 3.3 Implement configurable cadence/freshness, timeout, jitter, one-in-flight polling, backoff and configuration/shutdown cleanup; verify failures preserve original window timestamps, status-only pushes do not freshen windows, and removing the last subscription stops requests.
- [ ] 3.4 Record supported/unavailable/auth-refused/failed quota outcomes through the existing parsers and source rules; verify unrelated host-login quota, passed resets and unsupported standalone readers cannot establish routed-provider headroom, with no credential or raw response persistence.
- [ ] 3.5 Freeze incident alternatives using dispatch-worker-choice and routing/staffing predicates with evidence available at the incident cutoff; verify shared account/model windows, hard selectors, review restrictions, caps, writer occupancy and later quota observations. Document the revised background polling behavior and the unchanged read-only `team_capacity` contract.

## 4. First useful incident recommendations

Enable these after group 3 and its prerequisite gate. The foundation may already be delivered; no recommendation task is complete merely because its storage types or test fixtures exist.

- [ ] 4.1 Add migrations/stores for stable recommendations, immutable assessments, frozen evidence, human decisions and explicit interventions; verify team isolation, material-change deduplication and restart-safe episode identity.
- [ ] 4.2 Implement the versioned quota/context evaluator and supported-term switch-versus-wait comparison from D6; verify first-incident provisional advice appears without a baseline, numeric savings remain unknown when a material cost is unknown, and context exhaustion is never treated as account exhaustion.
- [ ] 4.3 Queue/coalesce evaluation after incident commits and on relevant quota/reset updates, targeting five-second normal-load publication; verify evaluator failure leaves work running and a later refresh produces a new assessment rather than rewriting incident evidence.
- [ ] 4.4 Attach advice to canonical context-exhaustion episodes and existing attention links, and create deduplicated in-app standalone quota entries; verify no duplicate recovery requests/alerts across restart. Add operator/user documentation for provisional versus demonstrated advice.
- [ ] 4.5 Add team-scoped recommendation snapshots/detail and the read-only `process_recommendations_list`/`process_recommendation_get` tools; verify parity with the stored assessment and that no agent approve/apply tools or execution rights are introduced.
- [ ] 4.6 Ship an initial recommendation list/detail and incident drill-down in the existing Metrics view; verify a fixture quota incident shows alternatives, freshness, constraints and uncertainty without Prometheus. This completes the first useful delivery slice before bottleneck or compaction comparisons.

## 5. Acceptance and process bottleneck measurements

- [ ] 5.1 Extend the shared registry/query layer with first-acceptance cohorts, token/quality guards and acceptance mechanism; verify done-without-acceptance, creator/system acceptance, first acceptance outside the window, reopens and post-acceptance rework without changing existing lead-time IDs.
- [ ] 5.2 Implement canonical stage/wait boundary observations and D4's non-overlapping task-time partition with concurrent-cause detail; verify queued review, competing blockers, parallel reviewers, supersession, unknown intervals and accumulated agent time exceeding task elapsed time.
- [ ] 5.3 Add unfinished age/count and closed-without-acceptance/usage/interval coverage alongside completion distributions; verify stalled long work remains visible while short tasks finish and mixed-model tasks are not credited wholly to the last worker.
- [ ] 5.4 Add bottleneck assessment rules and Metrics/tool/report representations; verify review queueing produces a queue investigation while intentional holds/dependencies do not produce unsupported faster-model advice. Document definitions, primary-cause priority and statistical sufficiency.

## 6. Human choices, interventions and report compatibility

- [ ] 6.1 Add team-bound idempotent human accept/reject/defer and explicit intervention-link commands with stale-assessment checks; verify changed payload replays and cross-team links are refused, superseded choices remain visible and accepting advice dispatches/edits nothing.
- [ ] 6.2 Link group/memory advice to existing process proposals as the single approval path, and allow change/revert proposals in every supported report window; verify final prior decisions and explicit hash implementation links remain intact, updating the existing report-rule tests and lead documentation.
- [ ] 6.3 Add frozen assessment references to report submission and definition-version compatibility for snapshots; verify later reassessment cannot rewrite old reports, unknown/other-team references write nothing and existing reports remain readable.
- [ ] 6.4 Add decision/intervention UI and assessment history to the Metrics view; verify changed actions need fresh approval, expired detailed evidence is identified and real actions still use existing dispatch/configuration flows. Document approval versus implementation versus observed outcome.

## 7. Daily reassessment and durable digests

- [ ] 7.1 Persist validated per-team schedule/time-zone and collection/retention settings with documented defaults; verify invalid zones/times/cadences are refused, completed usage cannot be retained below its 90-day contract and schedule edits do not overwrite dated digests.
- [ ] 7.2 Implement the minute scheduler, daily reassessment and digest/checkpoint transaction; verify one digest per local date, daylight-saving repeats, restart catch-up of only the latest due date, unchanged-assessment deduplication and generation without a running lead or Prometheus.
- [ ] 7.3 Display typed system digests beside agent reports with period/freshness and changed/resolved advice; verify no agent impersonation or duplicate scheduled lead message and add daily-operation/catch-up documentation.

## 8. Human-scoped model and compaction experiments

- [ ] 8.1 Add versioned experiment definitions, human scope/guardrails/stopping criteria and explicit assignment/start membership links; verify cross-team/mismatched settings refusals and that create/stop/complete never starts, switches, compacts or interrupts a chat.
- [ ] 8.2 Implement observational intervention/experiment outcomes for acceptance time, tokens, first-pass yield, fixes, reopens and unfinished ages; verify small/mixed/confounded cohorts remain identified, n<10 yields undetermined comparison and later reopens revise quality evidence.
- [ ] 8.3 Implement compaction experiment suggestions and comparison views using actual loaded thresholds/context metadata; verify missing duration/post-size and window fallbacks cannot establish a measured optimum and guard degradation changes advice without stopping work.
- [ ] 8.4 Add experiment creation, membership, comparison and outcome UI linked to recommendations/digests; verify one fixture tracks a human-recorded threshold change through acceptance and rework, and document observational limitations and safe interpretation.

## 9. Optional Prometheus export

Tasks 9.1-9.5 are the independent foundation export milestone after groups 1-2; they do not depend on group 3, recommendations, daily digests or experiments. Task 9.6 retains the full integration-dependent families. All families share versioned observation definitions; supported core samples and explicit source availability can ship without fabricated quota or incident facts.

- [x] 9.1 Add durable counter/histogram accumulation and the D10 processed-source ledger in the observation transaction; verify restart, rollback/retry, duplicate replay and detail pruning preserve exactly-once totals, with explicit definition/startup coverage.
- [x] 9.2 Implement the bounded metric/label registry, persistent aliases, bucket/series budgets and overflow diagnostics; verify thousands of task/session IDs create no task-specific series, catalog churn stays bounded and bucket expansion respects the budget.
- [x] 9.3 Implement the pure Prometheus renderer and consistent cached snapshot for supported task-acceptance, managed turn/token/context/compaction, existing queue and health sources, with documented families/units/buckets and bounded source-availability gauges; verify escaping, HELP/TYPE, cumulative buckets/count/sum and missing-adapter behavior without inventing quota, canonical incident or stage samples. The provider/stage/incident completion criteria remain explicitly in 9.6.
- [x] 9.4 Register optional authenticated `GET /metrics` on the existing listener with `KAWAI_METRICS_ENABLED` and `KAWAI_METRICS_TOKEN`; verify disabled/misconfigured/auth-failed/scrape-error cases cannot disrupt core routes or trigger provider/model calls, and document scrape configuration using reserved examples.

- [x] 9.5 Verify and document the independent foundation milestone against the implementation branch: record a managed task/turn and available context/compaction observations, restart/replay/prune, inspect core export/coverage with provider/dispatch/context adapters absent, and verify normal operation when export is disabled or unavailable. Run the repository lint/typecheck/test checks for the foundation changes; retain group 3, recommendation and full-family integration tasks as unchecked.
- [ ] 9.6 After gate 3.1 and the canonical source adapters are satisfied, connect and document provider-account quota, canonical limit/context incidents and canonical stage/wait metric families; verify shared-account quota is not duplicated by team, status-only/failing updates retain original freshness, source support changes correctly and final exported definitions match the complete Metrics/incident contracts. The initial endpoint and fixture absence checks do not satisfy this task.

## 10. Cross-change adapters and end-to-end verification

- [ ] 10.1 Add capability adapters for canonical plan stage/wait/stall/hold/revision facts and landing acceptance when those interfaces are available; verify fixtures for named waits versus stalls, no duplicate episode alerts, integration acceptance before promotion and absence of plan capabilities. Document the consumed contract versions without implementing the prerequisite features here.
- [ ] 10.2 Map neutral managed-driver observations for Codex when its driver contract is available; verify cumulative/delta token normalization, supported-field coverage and shared-login limits with fixtures, and verify managed-Claude collection works when no Codex adapter is installed. Document capabilities and defer unsupported measurements explicitly.
- [ ] 10.3 Run an isolated managed-task walkthrough from dispatch through quota incident, recorded human handoff, review and acceptance, then restart/daily reassessment/pruning; verify evidence and outcomes remain inspectable with Prometheus disabled, and repeat the export branch with scrape downtime and unauthorized requests.
- [ ] 10.4 Run `bun run lint && bun run typecheck && bun run test`, the relevant browser walkthrough and strict OpenSpec validation; verify no regressions to acceptance, mailbox delivery, notification sounds or background-task session status, and record any prerequisite availability limits honestly.

## Workflow follow-up

- Review the planning defaults (90-day detail, 09:00 UTC digest, ten-minute quota cadence) before implementation rollout.
- Foundation delivery is a milestone within this change, not completion or archive; no acceptance criterion is removed by the approved staging.
- Archive this change only after its modified capability prerequisites exist and implementation/review are complete; preserve the explicit cross-change ordering in design D12.
- Reassess retention volume, recommendation usefulness and metric cardinality from actual operation; do not wait for 90 days of data to begin issuing provisional advice.
