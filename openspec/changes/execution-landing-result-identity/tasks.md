# Tasks

Planning-only proposal: every task below is a future obligation. Nothing here is implemented or claimed as passing until a separately approved implementation task completes it.

## 1. Oracles first (before production code)

- [x] 1.1 Commit the decision table O1–O16 verbatim as table-driven tests — the production-composition rows (O1, O2, O3, O6, O9, O16) in `src/server/__tests__/landingResultIdentity.integration.test.ts`, the seam rows (O4, O5, O7–O15) beside the one reference model in `src/server/__tests__/landingResultIdentityProperties.test.ts` (Lead decision, local placement) — one test per row whose title starts with the oracle id, each with its `// @covers: plan-landing › Kawai accepts the authorizing round's own result › <scenario>` annotation where a scenario applies. Verify: on the base head, O2 and O3 fail (the earlier same-commit result is accepted) and O1, O12–O15 pass; record that negative-control run with its head.
- [x] 1.2 Commit properties P1–P3 in `src/server/__tests__/landingResultIdentityProperties.test.ts` with their seeds and `propertyCases(64)`, using the in-tree mulberry32 pattern and no new dependency. Verify: P1 fails on the base head with a printed seed and case.

## 2. Bind acceptance to the authorizing round

- [x] 2.1 Add `authorizingRound` (D2) in `src/server/plans/execution/landingRound.ts`, returning the round or one of `no-round`, `round-missing`, `round-mismatch`, `commit-mismatch`. Verify: O8–O11 and P2 pass; mutants M3 (drop commit check), M4 (drop execution/change check) are each killed by a named test.
- [x] 2.2 Change `afterLanded` to take a `LandedStep` and accept `authorizingRound(...).round.resultId` after the existing status guard, logging `plan_execution_accept_identity_refused` on refusal with no commit-search fallback; keep `executionLanding.ts` under 500 lines. Verify: O1, O2, O4–O7, O12–O15 and P1, P3 pass; mutants M1 (first same-commit `find`), M2 (last same-commit round), M5 (fallback to commit search), M8 (identity before the status guard) are each killed by a named test.
- [x] 2.3 Pass `{ head, roundId: effect.roundId ?? null }` from the direct merge follow-on and `{ head: sha, roundId: effect.roundId }` from `fastForwarded`. Verify: O1, O2, O3, O6, O16 pass through the production executor composition; wiring mutants M6 (direct passes null) and M7 (integration passes null) are each killed by a production-composition test.

## 3. Recovery matrix and existing workflows

- [x] 3.1 Add the "Landing follow-on replayed after a restart" row to `docs/recovery-matrix.md` citing the O15 and O16 test titles literally. Verify: `src/server/__tests__/recoveryMatrix.test.ts` passes.
- [x] 3.2 Run the existing landing and execution suites that exercise acceptance (`executionLandingMatrix.integration.test.ts`, `integrationLifecycleTable.test.ts`, `executionComposition.test.ts`, `effectResumeRounds.integration.test.ts`, `landingMechanisms.test.ts`) unchanged, except the one afterLanded call in `integrationLifecycleTable.test.ts` adapted to `LandedStep` (contract I5). Verify: all pass on the fix head; any other edit to them is reported as a regression question, not silently changed.

## 4. Result

- [x] 4.1 Run `bun run check --full-properties` on the clean committed head through the shared suite runner and `bun scripts/verify-result.ts --commit <head> --coverage <map.json>`. Verify: the check exits 0 under the selected latest stable Bun; the complete, unfiltered verifier's exit code and every diagnostic are disclosed, and commit identity, current HEAD, clean state, the matching recorded certificate and toolchain, the authoritative base/integration checks, scope and all cited test outcomes pass with zero unresolved citations. An exit of 1 is allowed only when its sole failed category is comparison against unrelated open-task branches and the Lead records evidence that those conflicts pre-exist and are neither introduced nor worsened by this change; a conflict with the authoritative base or a required dependency, any new or worsened conflict, any result-owned verification failure, and any omitted required check still block completion, with no suppressed diagnostic, weakened verifier or guard, invented filter flag, skipped failing test, modified held branch, or claim that the global verifier passed. The result maps every oracle id and property to a literal test title and every mutant M1–M8 to the test that killed it, and states that no historical acceptance was read for repair or rewritten.

## Workflow follow-up

- The implementation is a separate, scoped task created after this proposal's approval; it inherits no review verdict from the proposal review.
- One cross-model review of the implementation result on its exact commit, then the normal landing path. Archiving syncs the ADDED requirement into `openspec/specs/plan-landing/spec.md` with its covering annotations.
- Correcting the already-recorded wrong acceptance, if wanted, is an owner decision through supported human task actions and is not part of this change.
- Follow-up candidates recorded in design Risks (the pre-existing crash window between the `landed` transition and the acceptance; head pinning versus the round's commit) are proposals for separate review, not part of this change.
