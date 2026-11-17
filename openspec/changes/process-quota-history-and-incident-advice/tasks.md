# Tasks

Planned work. Task numbers 3.1–4.6 are `process-observability`'s, moved here
unchanged in intent (that change keeps its boxes unticked). Groups 0 and 5
are new.

## 0. Oracles before code

- [ ] 0.1 Blind second reading of Tables S and F: commit A1 with inputs only (outputs `?`), have an advisor from another model family fill outputs from the specs alone, commit the author's outputs as A2, resolve every disagreement in the table, and have the coordinator record the binding tables. No production code before this.

## 3. Provider quota history and eligible alternatives

- [ ] 3.1 Re-verify the consumed contracts on the implementation branch: per-provider usage and cooldown (`usageLimits.ts`, `cooldownFor`), worker choice and caps (`routing/router.ts`, `capacityTools.ts`), the context-exhausted flag, plan-stall episodes. Record their file:line versions in the first note. No stubs or fixture-only substitutes count as a contract.
- [ ] 3.2 Extract `src/server/chat/quota/QuotaReaderService.ts` from `ChatSessionManager.ts` with live-session and configured-team-worker subscriptions, account-key reference counts, and team associations (D1). **Checkpoint:** design "Production composition checkpoint" (S1, S2, S11, main "Eligible alternative without a live chat"). Verify: the main background scenarios (`@covers` on main names) pass; every `chatSessionManager.provider-usage-*.test.ts` stays green; mutant "worker subscription unwired" fails.
- [ ] 3.3 Implement D2 scheduling: cadence, startup/config poll, one in flight, timeout, jitter, backoff, cleanup. Commit Table S (S1–S14) with its completeness test and property P1 (seed `0x51A7`, 200 cases). Verify mutants: two concurrent requests per key (P1/S3), backoff not reset (S6), timer kept after last unsubscribe (S7), result published after shutdown (S11).
- [ ] 3.4 Record supported/unavailable/auth-refused/failed/unsupported outcomes through the existing parsers, with observation-time basis (D3). Commit Table F and properties P2 (seed `0xF4E5`) and P4; add the "Background quota observation is bounded and credential-safe" scenarios. Verify mutants: status-only push refreshing window age (F6), unrelated host login granting headroom (F5), response body persisted (P4).
- [ ] 3.5 Freeze incident alternatives with the routing/staffing predicates at the cutoff (D4). Commit Table E. Document background polling and the unchanged `team_capacity` contract in `docs/operations/process-observability.md`. Verify mutants: later observation leaking into a frozen assessment (E7), shared account counted as an alternative (E2), context exhaustion treated as account exhaustion (E8).

## 4. First useful incident recommendations

- [ ] 4.1 Add migrations and stores for recommendations, immutable assessments, and frozen evidence (D5); team isolation and material-change deduplication. Verify R2, R7, R9 and property P3 (seed `0xA55E`, 200 cases, crash at each transaction boundary).
- [ ] 4.2 Implement the versioned quota/context evaluator and switch-versus-wait comparison; provisional advice without a baseline, numeric savings unknown when a material cost is unknown. Verify R1, E6, E8 and the "One handoff" scenario.
- [ ] 4.3 Queue and coalesce evaluation after incident commits and quota/reset updates, targeting five-second publication; startup reconciliation of unevaluated episodes. Add the recovery-matrix rows. Verify R3, R4, R5 and `recoveryMatrix.test.ts`.
- [ ] 4.4 Attach advice to canonical context-exhaustion episodes and existing plan-stall attention links, plus deduplicated standalone quota entries; document provisional versus demonstrated advice. Verify R6 and no duplicate alert across restart.
- [ ] 4.5 Add team-scoped snapshots and the read-only `process_recommendations_list`/`process_recommendation_get` tools through the team tool table. Verify R7, R8, "Agent reads advice", and parity with the stored assessment through both runtime registrations.
- [ ] 4.6 Ship the recommendation list/detail and incident drill-down in the Metrics view. Verify a client test and the private CI fixture browser step with a fixture quota incident showing alternatives, freshness, constraints, and uncertainty without Prometheus (never `bun run test:e2e`, never live data).

## 5. Integration

- [ ] 5.1 Citation preflight, `bun run check --full-properties` on the clean committed head under pinned Bun 1.4.3, `scripts/verify-result.ts`, and `openspec validate process-quota-history-and-incident-advice --strict`. Map every oracle id (S1–S14, F1–F6, E1–E8, R1–R9, P1–P4) to its literal test title and killed mutant. At archive (after `process-observability-foundation`), add `@covers` for every ADDED scenario.
