# Tasks

## 1. Contracts and observation persistence

- [ ] 1.1 Confirm the D12 prerequisite versions and landed provider/dispatch/context interfaces, and record them in implementation notes; verify `chat-turn-usage`, `process-reports` and provider-scoped usage requirements exist before applying their deltas, without silently archiving another change.
- [ ] 1.2 Add SDK-free observation, coverage, identity and measurement-version types plus frozen schema exports and numbered migrations for observations, team associations, source processing identities and collection checkpoints; verify migration upgrade/restart and duplicate-source-key tests with `schemaDb()`.
- [ ] 1.3 Implement the protected recorder and post-commit hooks for task/result/assignment/mail/limit facts, including acceptance actor/mechanism and preserved handoff/result/revision identity; verify duplicate callbacks count once and recorder failure cannot roll back acceptance or mailbox settlement.
- [ ] 1.4 Implement durable-source reconciliation and gap/health reporting; verify crash/replay recovery restores known facts, marks irrecoverable live gaps and cannot create measured activity from old chat text.
- [ ] 1.5 Extend `chatTurnUsageStore.ts` retention and all `metricsQuery.ts`/outcome horizon calculations to 90 days, with bounded pruning and immutable evidence retention; verify 75-day usage survives, already-pruned history stays partial, and document the retention/coverage contract.

## 2. Managed turn and context measurements

- [ ] 2.1 Feed task/start-pinned turn lifecycle observations from the driver/manager, including failure, interruption, process exit and restart uncertainty; verify task-less/mid-turn reassociation cases and that incomplete usage never becomes measured zero consumption.
- [ ] 2.2 Record activity, request-card and tool interval edges independently of the live activity projection; verify approval wait subtraction, overlapping tool union versus summed work, and background shells/Monitors not inflating active development time.
- [ ] 2.3 Preserve structured compaction trigger/pre/post metadata, observed start/end, context-failure linkage and threshold source/settings provenance; verify missing post size/duration and approximate context-window fallbacks remain unknown/approximate.
- [ ] 2.4 Add context sampling/coalescing and settings/account-version snapshots at exact lifecycle boundaries; verify high-frequency deltas are bounded, compaction/failure boundaries remain exact and catalog edits cannot relabel historical observations. Document the timing/token scope and omitted subagent usage.

## 3. Provider quota history and eligible alternatives

- [ ] 3.1 Extract shared quota readers from `ChatSessionManager.ts` with live-session and configured-team-worker subscriptions, effective account-context deduplication and team access associations; verify an unused eligible quota-serving provider is polled without starting an agent and shared accounts are pulled once.
- [ ] 3.2 Implement configurable cadence/freshness, timeout, jitter, one-in-flight polling, backoff and configuration/shutdown cleanup; verify failures preserve original window timestamps, status-only pushes do not freshen windows, and removing the last subscription stops requests.
- [ ] 3.3 Record supported/unavailable/auth-refused/failed quota outcomes through the existing parsers and source rules; verify unrelated host-login quota, passed resets and unsupported standalone readers cannot establish routed-provider headroom, with no credential or raw response persistence.
- [ ] 3.4 Freeze incident alternatives using dispatch-worker-choice and routing/staffing predicates with evidence available at the incident cutoff; verify shared account/model windows, hard selectors, review restrictions, caps, writer occupancy and later quota observations. Document the revised background polling behavior and the unchanged read-only `team_capacity` contract.

## 4. First useful incident recommendations

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

This group depends on observation/metric definitions, not the daily digest or experiment UI. It can land independently without gating the first incident-recommendation slice.

- [ ] 9.1 Add durable counter/histogram accumulation and the D10 processed-source ledger in the observation transaction; verify restart, rollback/retry, duplicate replay and detail pruning preserve exactly-once totals, with explicit definition/startup coverage.
- [ ] 9.2 Implement the bounded metric/label registry, persistent aliases, bucket/series budgets and overflow diagnostics; verify thousands of task/session IDs create no task-specific series, catalog churn stays bounded and bucket expansion respects the budget.
- [ ] 9.3 Implement the pure Prometheus renderer and consistent cached gauge snapshot with documented families/units/buckets; verify escaping, HELP/TYPE, cumulative buckets/count/sum, unknown/stale quota and shared-account quota not duplicated by team.
- [ ] 9.4 Register optional authenticated `GET /metrics` on the existing listener with `KAWAI_METRICS_ENABLED` and `KAWAI_METRICS_TOKEN`; verify disabled/misconfigured/auth-failed/scrape-error cases cannot disrupt core routes or trigger provider/model calls, and document scrape configuration using reserved examples.

## 10. Cross-change adapters and end-to-end verification

- [ ] 10.1 Add capability adapters for canonical plan stage/wait/stall/hold/revision facts and landing acceptance when those interfaces are available; verify fixtures for named waits versus stalls, no duplicate episode alerts, integration acceptance before promotion and absence of plan capabilities. Document the consumed contract versions without implementing the prerequisite features here.
- [ ] 10.2 Map neutral managed-driver observations for Codex when its driver contract is available; verify cumulative/delta token normalization, supported-field coverage and shared-login limits with fixtures, and verify managed-Claude collection works when no Codex adapter is installed. Document capabilities and defer unsupported measurements explicitly.
- [ ] 10.3 Run an isolated managed-task walkthrough from dispatch through quota incident, recorded human handoff, review and acceptance, then restart/daily reassessment/pruning; verify evidence and outcomes remain inspectable with Prometheus disabled, and repeat the export branch with scrape downtime and unauthorized requests.
- [ ] 10.4 Run `bun run lint && bun run typecheck && bun run test`, the relevant browser walkthrough and strict OpenSpec validation; verify no regressions to acceptance, mailbox delivery, notification sounds or background-task session status, and record any prerequisite availability limits honestly.

## Workflow follow-up

- Review the planning defaults (90-day detail, 09:00 UTC digest, ten-minute quota cadence) before implementation rollout.
- Archive this change only after its modified capability prerequisites exist and implementation/review are complete; preserve the explicit cross-change ordering in design D12.
- Reassess retention volume, recommendation usefulness and metric cardinality from actual operation; do not wait for 90 days of data to begin issuing provisional advice.
