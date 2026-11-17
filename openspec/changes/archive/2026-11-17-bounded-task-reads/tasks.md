# Tasks

All implementation and tests below are PLANNED, not executed. Owner review of the breaking proposal/refinements and later registration/approval precede implementation. Preserve all legacy checkboxes and holds.

## 1. Child and message projections (legacy 3.1–3.2a)

- [x] 1.1 Extract shared taskAgentRow projection and add child SQL window/anchor; commit G1/G2 and P3 child rows in taskReadWindows.test.ts. Verify equality with task_list derived assignee/result and exact once tied-time walk; kill duplicate derivation, foreign-parent anchor and missing rowid mutants. Update task architecture and tests with this mechanism.
- [x] 1.2 Add SQL body byte projection, messages_before and full_messages through taskTools. Commit G3–G5c/H6 and message P3. Verify exact UTF-8 and unchanged other sections/full-mode page ids; kill character-count truncation, replacement decode, truthy flag, flag-widens-window and foreign-message anchor mutants. Document full-mode size exception with tool change.

## 2. Results and byte reader (legacy 3.4–3.4a)

- [x] 2.1 Add bounded historical result rows and result_id/resultDetail, exact diff preview, same-transaction current seal and immutable pins. Commit G9–G13g/H3/H5/H7 with P3/P6; verify selected and default seal including comparisons/check outcomes, no-outstanding case and supersession between reads. Kill unsealed resultDetail, historical maps leaking, outstanding counted/dropped, wrong diff threshold, current revision substituted for pin, stale handoff predicate. Keep baseline revision G6–G8 assertions passing; demonstrate registered production success and foreign-anchor refusal before expansion.
- [x] 2.2 Add taskResultDiffRead and register task_result_diff_read with current caller/team rules. Commit G13a–f/P5 through real adapters, including equal-total/unsafe offsets and diff-only results. Verify base64 round-trip and null invalid text; kill wrong task predicate, off-by-one resume and equality-at-end refusal. Publish description/architecture with the reader.

## 3. Histories and guidance (legacy 3.5–3.6)

- [x] 3.1 Add SQL windows and proposed H1 anchors for assignment/publication/ack histories, preview rationales and omit history instruction. Commit G14/G15/H1/H2/H4 with P3/P4. Verify 0/1/49/50/51/70 counts, ties, all anchor membership/type failures, independent delivered/ack state and byte-identical stores; kill post-load slicing, dropped acks, unknown anchor ignored, full rationale retained and writeback mutants. Extend architecture with continuation/full-rationale routes.
- [x] 3.2 Extend tool schemas/descriptions and teamPrompt guidance with every bound/route and old-Codex limitation. Preserve header generations 1/2 byte-for-byte. Commit H8/H9 in registered Claude/Codex adapter, prompt and existing envelope tests. Verify unknown extra args cannot bypass membership, a bad anchor among valid args refuses, old receipts still parse and no DB/log bypass is advised; kill silent invalid-anchor handling and altered old-header mutants. No new header generation is needed.

## 4. Integration

- [x] 4.1 Commit G16 deterministic fixture byte budget and G17 human connection regression plus P4. Verify <256 KB only on the specified fixture, report measured size, and compare whole human payload and stored row hashes across each read/refusal. Kill shared-human compaction and unbounded default history projection. Update the exact task_get schema keys in src/server/__tests__/codexTeamPath.integration.test.ts and exact registered tool catalogue in src/server/__tests__/teamTaskService.test.ts; include src/server/__tests__/teamEnvelope.test.ts and existing taskEnvelopeCompatibility/taskEnvelopeV2Compatibility tests for H9. Run these consumers and affected revision/journal/list/seal/ledger/connection suites in isolation; tests reading repository prose declare @reads. Preserve taskRevisionWindow G6–G8 and whole revisionText exactly.
- [x] 4.2 Add exact @covers for EVERY delta scenario, map each G/H/P id to literal test title and killed mutant, run tests on base or remove protections to prove effectiveness, resolve citations before expensive checks, then run required clean committed full check and exact-commit result verifier. Record real outcomes and remaining limitations; never cite planned titles as passing. No product build/native/live-data campaign is required for these server read changes unless later scope changes.

## Workflow follow-up

- After owner acceptance and formal review, wait for the explicit owner-selected spec-reconciliation/archive order in design.md: this slice and the legacy delta MODIFY the same bounds/guidance requirements, and the landed revision definitions still need a main-spec home. Do not sync/archive this slice alone before that reconciliation; no legacy edit or revision reimplementation is authorized here. No task checkbox is ticked by implementation.
