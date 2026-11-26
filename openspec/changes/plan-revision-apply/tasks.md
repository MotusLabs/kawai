# Tasks

Split from revision-control (proposed 2026-11-18): 1.x–2.x carry its tasks 5.1–5.3, plus the first slice of its 6.1 and 7.1 that the 2.2 checkpoint needs (the Apply message, its whitelist entry, the executions' revision rows in the detail); 3.x carry the rest of the executions' revisions of its 6.1 and the Apply parts of its 7.1–7.3. Order (shared paths): 1.1 and 2.1 run any time; 2.2–2.4 and 3.1 after revision-control 9.1–9.2 have landed (`planMessages.ts`, `chatConnectionTypes.ts`, `planSupervisionDetail.ts`); 3.2–3.3 after revision-control 9.4–9.5 (`teamPlanStore.ts`, `PlanExecutionSection.tsx`). Every checkpoint's prerequisites are in tasks at or before it. Builds on revision-control's landed groups 1–4. Every file stays under 500 lines. Tests that spawn git use `cleanGitEnv`; tests never reach GitHub. Contract at the end of design.md.

## 1. Oracles first

- [x] 1.1 Blind second reading (state machine with recovery): commit the AP, AK, DL, CH, and CR tables with inputs only and every output `?`; a cross-model advisor fills the outputs from the specs alone; commit the author's outputs; resolve each disagreement in the tables. Verify: the Lead records the resolved tables as binding in the task journal before any code of 2.x.

## 2. Apply on the server (revision-control 5.1–5.3)

- [x] 2.1 Implement `applyPreconditions.ts` (`APPLY_PRECONDITIONS`, append-only) and `ApplyService.preview` in `applyService.ts`: reads only, the delta from `revisionDelta`, the needed choices, the generated Adapt texts, and every entry's standing. Verify AP1–AP17 and DL1–DL13 as table-driven tests; mutants: a failing entry left out of the list (AP16), `landed-unchanged` skipped (AP10), metadata misread as changed (DL6).
- [x] 2.2 The first production path, after revision-control 9.1–9.2. Implement `ApplyService.apply`: refuse a non-human caller first; the prepare phase (standing, group files, base head, blob reads, and `prepareStatus` for each removed unlanded change's open task); then one synchronous transaction through `PlanService.recordRevisionControlEvent` running the checks, `applyWrites.ts`, and the event; after commit, wake the executor and push the detail. In `applyWrites.ts`, the writes PC1 exercises: the revision row and columns, publication rows, unchanged (CH1), continue (CH3), and adapt through `TaskStore.publish` with request key `apply:<commandId>:<change>` and notify (CH4). Add `team-plan-execution-apply` to `src/shared/planMessages.ts` and `CHAT_CONNECTION_TYPES`, its handler in `applyConnections.ts` composed in `planComposition.ts`, and each execution's `revisions` rows (seq, revision, content hash, applied at, rationale) in `team-plan-detail`. Verify AK1–AK6, CH1, CH3, CH4, and PC1–PC2 through the composed server; mutants: the CAS dropped (AK4), the type left out of the whitelist (PC1), `applyConnections.ts` not composed (PC1), the post-commit wake removed (PC1), the detail push removed (PC1). Checkpoint: PC1/PC2 at a pinned commit, reviewed before 2.3; nothing PC1 needs comes later.
- [x] 2.3 Complete the per-change writes in `applyWrites.ts`: metadata (CH2), restart (CH5), no task (CH6), added (waiting or landed by fact, CH7–CH8), removed (cancelled, effects cancelled, slot given up, the prepared cancel committed, CH9–CH10). Verify CH1–CH10 as table-driven tests, completion reading the current revision (D4), and manifests keeping their revision; mutant: publishing without the request key (P2).
- [x] 2.4 Write the crash and replay tests: CR1–CR4 as rows, the CR/CH model-based test, and properties P1–P4 at their seeds through `propertyCases`; the S4 forward-fix tests FX1–FX3. Replace the recovery matrix's "R4 — Apply crash" gap row with this change and its CR tests. Verify: all pass; the mutant writing the event outside the transaction fails CR2; `src/server/__tests__/recoveryMatrix.test.ts` passes.

## 3. Protocol, history, and view (revision-control 6.1 revisions, 7.1–7.3 Apply parts)

3.1 runs after revision-control 9.1–9.2 (shared `planMessages.ts`, `CHAT_CONNECTION_TYPES`, the detail builder); 3.2–3.3 after revision-control 9.4–9.5 (shared `teamPlanStore` and `PlanExecutionSection.tsx`).

- [x] 3.1 Add `team-plan-execution-apply-preview` to `src/shared/planMessages.ts` and `CHAT_CONNECTION_TYPES` with its handler in `applyConnections.ts`, the publication rows under each revision in `team-plan-detail`, and the revisions with publication rows in `plan_get`. Verify with router, connection, and tool tests: both Apply types are whitelisted, `unknown-team` is refused, each result carries its record or error, another team's ids read as not found, and a push follows every Apply.
- [x] 3.2 Add `PlanApplyRevisionDialog.tsx`, its `teamPlanStore` slot, and the history in `PlanExecutionSection.tsx`. Verify with component tests: a choice is asked only for changed changes with tasks, one command id is reused while the payload is unchanged, refusals render every failing check, and controls disable while disconnected; every store apply method has a dispatch caller.
- [x] 3.3 Write `tests/e2e/chat-plan-revision-apply.spec.ts`, skipped unless `AGENTBOARD_CHAT_FIXTURE=1`, so `scripts/e2e-fixture-specs.ts` lists it for CI's fixture step: apply a revision with one adapted change and see the history. Verify: the lister names the file, and CI's fixture job passes it. Local runs only in a disposable checkout with its own build, database, and spare `E2E_PORT`; never `bun run test:e2e`.

## 4. Docs and checks

- [x] 4.1 Add the AGENTS.md Apply bullet and the plans architecture bullet (D3–D8), and `@covers: plan-revision-apply › …` and `@covers: plan-execution › A running execution keeps its revision › …` annotations above the covering tests. Verify: `scripts/__tests__/specCoverageGuard.test.ts` passes, and the bullets read against D3–D8.
- [x] 4.2 Map every oracle id (AP, AK, DL, CH, CR, P1–P4, PC, FX) and every scenario below to a literal test title and a killed mutant, run the citation preflight, then `openspec validate plan-revision-apply --strict` and `bun run check --full-properties` on the clean committed head under the pinned Bun, and `scripts/verify-result.ts`. Verify: zero unresolved citations, all pass.

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

## Landed evidence (archive reconciliation, 2026-11-27)

Landed as PR #458 (`07d62161ecd6123ef68ec374777589923a14ac7a`), the merge of the reviewed head `093dbdd8`; the two commits have the same tree. The boxes above were ticked at the joint archive with `plan-revision-apply`'s sibling `revision-control`, each against the record named here. The task is task-e9eda725-73b7-4a5b-a4fc-c92692a3b058.

| Task | Commits | Tests and killed mutants |
| --- | --- | --- |
| 1.1 | `bf85c038`, `56477fdc`, `090e05c3`, `7f2dcf88` | The inputs-only tables, the cross-model outputs read under seal before the author's outputs, and each disagreement resolved in the tables. The Lead's binding record is note-6e0bd9e3-7200-471f-83a3-61721ac30e45 at `7f2dcf88`; the first code of 2.x, `4baee945`, follows it |
| 2.1 | `4baee945` | AP1–AP17 and DL1–DL13 in `applyPreconditions.test.ts`, the preview in `applyPreview.test.ts`; `AP16`, `AP10`, `DL6` |
| 2.2 | `f9f22e85`, `e1dc3388` | AK1–AK6 and DC3 in `applyCommand.test.ts`, CH1, CH3 and CH4 in `applyChoices.test.ts`, PC1–PC2 in `applyComposition.test.ts`; the CAS (`m4`), whitelist (`m5`), composition (`m6`), post-commit wake (`m7`) and detail push (`m8`) mutants |
| 2.3 | `fceb0582`, `84db96b3`, `2cbe97ff` | CH2 and CH5–CH10 in `applyChoicesRows.test.ts`, completion and the readers in `applyRevisionReaders.test.ts`; `m9`–`m14` |
| 2.4 | `5932dedc`, `fa94e01d`, `7714ae76`, `be74d52b`, `4f209770`, `f62bb7f5` | CR1–CR4 in `applyCrash.test.ts`, P1, P2 and the CR/CH model in `applyProperties.test.ts`, P3 in `applyLandedProperty.test.ts`, P4 in `applyManifestProperty.test.ts`, FX1–FX3 in `applyForwardFix.test.ts`, and the recovery matrix's "R4 — Apply crash" row; the event written outside the transaction fails CR2 (`m15`); `m16`, `m17`, `m19` |
| 3.1 | `98fed6ce` | Router, connection and tool tests in `applyComposition.test.ts` for the preview message, the publication rows and `plan_get`; `m20`, `m21` |
| 3.2 | `93283f0b`, `0b60050d` | `planApplyRevisionUi.test.tsx` for the dialog and the history in the execution section; `m22`, `m23`, `m26` |
| 3.3 | `8474299e`, `42959f9c`, `bb3d0721` | `tests/e2e/chat-plan-revision-apply.spec.ts`; `scripts/e2e-fixture-specs.ts` lists it; CI's "Run chat fixture e2e tests" passed in 45815868542 |
| 4.1 | `6758f8ad`, `db120f51`, `b5c92f48` | `@covers` annotations over every delta scenario; the AGENTS.md Apply bullet and the architecture bullets; `m24`, `m25` |
| 4.2 | — | The accepted result's map holds 48 clauses and 217 citations; see the certificate below |

Review: eight rounds, all on Codex Sol. Round 1, findings-ac3e3a38-0dba-4849-b063-e67075c5b799 on result-33cc692d, raised F1–F5. Round 2, findings-625c4008-95c5-469a-bf7a-a7dd247e75b4 on result-7256b0c1, kept F1 and F3 open. Round 3, findings-7fbd6613 on result-a68cd91f, resolved both and raised F6. Round 4, findings-71f83e8e-6a2d-4e79-8825-b2f1b2a08ccb on result-df27d70b, raised F7 and opened diagnosis-54f2eac2, answered with a fix round. Round 5, findings-f652b935-8490-4600-96b8-bbc958159336 on result-415018af, raised F8; the owner chose one architectural fix round. Round 6, findings-000972fb-cc36-49a3-be6c-ac6dc6fd6165 on result-16939420, raised F9 and opened diagnosis-02b0ab30, answered Escalate; the owner then authorized one design-first correction. Round 7, findings-1785921f-38d0-48cd-990e-7eb4b050c3d4 on result-9b81f6bc, kept F9 open on the hold path; the owner authorized one focused correction. Round 8, result-b8c96a1b, passed: note-4641299e-0c06-4797-a597-df0fa7031dab reads "Approve", F9 resolved and no open blocker. The task's ledger holds F1–F9, all resolved, and result-b8c96a1b is the accepted result.

Certificate: `bun run check --full-properties` on the clean committed head `093dbdd8` under the pinned Bun 1.4.5, pass recorded as `fa9a211f7ce6` (12320 tests across 1139 files); `openspec validate plan-revision-apply --strict` valid; `scripts/verify-result.ts` exit 1 only on the peer-branch mesh, every citation ran-passed. CI 45815868542 passed on `093dbdd8` (lint, type check, tests, e2e and the fixture step), and so did each earlier round's run, the first being 45276484894 on `72583fb7`. Release 45884282821 passed on `07d62161`.

Limits, as the accepted result records them:

- The task's direction named Bun 1.4.3; the repository pins 1.4.5, and the check ran under the pin.
- The verifier's exit 1 is the peer-branch mesh alone: team branches outside this change conflict with each other.
- The full-check log carries "JUnit reports could not be merged" lines; they come from the check-machinery tests that exercise that path.
- No separate full check ran on the intermediate head `09caab72`: the 201-test affected run and the pre-commit hook covered it, and the certificate covers the combined head.
- The browser walkthrough was not rerun locally; CI's fixture step ran it on `093dbdd8` (45815868542).
