# Tasks

Split from revision-control (proposed 2026-11-18): 1.x–2.x carry its tasks 5.1–5.3, plus the first slice of its 6.1 and 7.1 that the 2.2 checkpoint needs (the Apply message, its whitelist entry, the executions' revision rows in the detail); 3.x carry the rest of the executions' revisions of its 6.1 and the Apply parts of its 7.1–7.3. Order (shared paths): 1.1 and 2.1 run any time; 2.2–2.4 and 3.1 after revision-control 9.1–9.2 have landed (`planMessages.ts`, `chatConnectionTypes.ts`, `planSupervisionDetail.ts`); 3.2–3.3 after revision-control 9.4–9.5 (`teamPlanStore.ts`, `PlanExecutionSection.tsx`). Every checkpoint's prerequisites are in tasks at or before it. Builds on revision-control's landed groups 1–4. Every file stays under 500 lines. Tests that spawn git use `cleanGitEnv`; tests never reach GitHub. Contract at the end of design.md.

## 1. Oracles first

- [ ] 1.1 Blind second reading (state machine with recovery): commit the AP, AK, DL, CH, and CR tables with inputs only and every output `?`; a cross-model advisor fills the outputs from the specs alone; commit the author's outputs; resolve each disagreement in the tables. Verify: the Lead records the resolved tables as binding in the task journal before any code of 2.x.

## 2. Apply on the server (revision-control 5.1–5.3)

- [ ] 2.1 Implement `applyPreconditions.ts` (`APPLY_PRECONDITIONS`, append-only) and `ApplyService.preview` in `applyService.ts`: reads only, the delta from `revisionDelta`, the needed choices, the generated Adapt texts, and every entry's standing. Verify AP1–AP17 and DL1–DL13 as table-driven tests; mutants: a failing entry left out of the list (AP16), `landed-unchanged` skipped (AP10), metadata misread as changed (DL6).
- [ ] 2.2 The first production path, after revision-control 9.1–9.2. Implement `ApplyService.apply`: refuse a non-human caller first; the prepare phase (standing, group files, base head, blob reads, and `prepareStatus` for each removed unlanded change's open task); then one synchronous transaction through `PlanService.recordRevisionControlEvent` running the checks, `applyWrites.ts`, and the event; after commit, wake the executor and push the detail. In `applyWrites.ts`, the writes PC1 exercises: the revision row and columns, publication rows, unchanged (CH1), continue (CH3), and adapt through `TaskStore.publish` with request key `apply:<commandId>:<change>` and notify (CH4). Add `team-plan-execution-apply` to `src/shared/planMessages.ts` and `CHAT_CONNECTION_TYPES`, its handler in `applyConnections.ts` composed in `planComposition.ts`, and each execution's `revisions` rows (seq, revision, content hash, applied at, rationale) in `team-plan-detail`. Verify AK1–AK6, CH1, CH3, CH4, and PC1–PC2 through the composed server; mutants: the CAS dropped (AK4), the type left out of the whitelist (PC1), `applyConnections.ts` not composed (PC1), the post-commit wake removed (PC1), the detail push removed (PC1). Checkpoint: PC1/PC2 at a pinned commit, reviewed before 2.3; nothing PC1 needs comes later.
- [ ] 2.3 Complete the per-change writes in `applyWrites.ts`: metadata (CH2), restart (CH5), no task (CH6), added (waiting or landed by fact, CH7–CH8), removed (cancelled, effects cancelled, slot given up, the prepared cancel committed, CH9–CH10). Verify CH1–CH10 as table-driven tests, completion reading the current revision (D4), and manifests keeping their revision; mutant: publishing without the request key (P2).
- [ ] 2.4 Write the crash and replay tests: CR1–CR4 as rows, the CR/CH model-based test, and properties P1–P4 at their seeds through `propertyCases`; the S4 forward-fix tests FX1–FX3. Replace the recovery matrix's "R4 — Apply crash" gap row with this change and its CR tests. Verify: all pass; the mutant writing the event outside the transaction fails CR2; `src/server/__tests__/recoveryMatrix.test.ts` passes.

## 3. Protocol, history, and view (revision-control 6.1 revisions, 7.1–7.3 Apply parts)

3.1 runs after revision-control 9.1–9.2 (shared `planMessages.ts`, `CHAT_CONNECTION_TYPES`, the detail builder); 3.2–3.3 after revision-control 9.4–9.5 (shared `teamPlanStore` and `PlanExecutionSection.tsx`).

- [ ] 3.1 Add `team-plan-execution-apply-preview` to `src/shared/planMessages.ts` and `CHAT_CONNECTION_TYPES` with its handler in `applyConnections.ts`, the publication rows under each revision in `team-plan-detail`, and the revisions with publication rows in `plan_get`. Verify with router, connection, and tool tests: both Apply types are whitelisted, `unknown-team` is refused, each result carries its record or error, another team's ids read as not found, and a push follows every Apply.
- [ ] 3.2 Add `PlanApplyRevisionDialog.tsx`, its `teamPlanStore` slot, and the history in `PlanExecutionSection.tsx`. Verify with component tests: a choice is asked only for changed changes with tasks, one command id is reused while the payload is unchanged, refusals render every failing check, and controls disable while disconnected; every store apply method has a dispatch caller.
- [ ] 3.3 Write `tests/e2e/chat-plan-revision-apply.spec.ts`, skipped unless `AGENTBOARD_CHAT_FIXTURE=1`, so `scripts/e2e-fixture-specs.ts` lists it for CI's fixture step: apply a revision with one adapted change and see the history. Verify: the lister names the file, and CI's fixture job passes it. Local runs only in a disposable checkout with its own build, database, and spare `E2E_PORT`; never `bun run test:e2e`.

## 4. Docs and checks

- [ ] 4.1 Add the AGENTS.md Apply bullet and the plans architecture bullet (D3–D8), and `@covers: plan-revision-apply › …` and `@covers: plan-execution › A running execution keeps its revision › …` annotations above the covering tests. Verify: `scripts/__tests__/specCoverageGuard.test.ts` passes, and the bullets read against D3–D8.
- [ ] 4.2 Map every oracle id (AP, AK, DL, CH, CR, P1–P4, PC, FX) and every scenario below to a literal test title and a killed mutant, run the citation preflight, then `openspec validate plan-revision-apply --strict` and `bun run check --full-properties` on the clean committed head under the pinned Bun, and `scripts/verify-result.ts`. Verify: zero unresolved citations, all pass.

## Scenario partition

| Requirement › scenario | Task |
| --- | --- |
| Only the owner applies a revision to a running execution › A lost Apply result replays; Agents cannot apply | 2.2 (AK2, AK1) |
| Apply evaluates named preconditions › A concurrent Apply wins; The target revision lacks standing | 2.2 (AK4), 2.1 (AP6) |
| Kawai classifies every change against the running revision › The preview shows the delta; Only the lead group changed; A missing choice is refused | 2.1 (DL), 3.2, 2.1 (DL12), 2.1 (AP12) |
| Landed work is never redefined › A landed change was edited; A landed change gains a fix reference; A forward fix is applied | 2.1 (AP10), 2.3 (CH2), 2.4 (FX1) |
| Each choice publishes or dispatches as recorded › Adapt notifies the developer; A removed change is cancelled | 2.2 (CH4, PC1), 2.3 (CH9) |
| The publication commits atomically › Crash before commit; Retry after commit | 2.4 (CR2), 2.4 (CR3) |
| The execution keeps its revision history › Manifests keep their revision; Completion after Apply | 2.2 (revision rows), 2.3, 2.4 (P4), 3.1 (publication rows, `plan_get`) |
| plan-execution › A running execution keeps its revision › Approval during an execution; Later instructions keep the revision; Apply moves the execution forward | 2.2 (preserved Start refusal), 2.3, 3.1 |

## Workflow follow-up

- Archive with revision-control after both land; the `plan-execution` delta then modifies the main spec's requirement.
