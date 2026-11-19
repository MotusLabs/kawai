# Tasks

## 1. Contain hidden accessibility metadata

- [x] 1.1 Add the isolated standards-mode browser fixture and O1/O2 cases in `tests/e2e/team-document-scroll.spec.ts` / `fixtures/teamDocumentScroll.ts`: long actual worktree headers, transcript metadata/copy-status regions, and scrolled navigator/chat content. Establish the pre-fix failure by measuring document extent independently of the app; verify O1/O2 reject removing navigator/transcript label containment, retain accessible text/live regions, and never touch a live database or provider.
- [x] 1.2 Establish local containing blocks at the verified navigator and transcript hidden-label owners, preserving names, timestamps, state labels, and copy feedback. Land the relevant existing accessibility-test updates, P-I2 (seed `0x51c012`, 16 cases), and the navigator/transcript architecture notes with this fix; verify O1/O2 and P-I2 pass and the containment-removal mutants from O1/O2 fail without removing any hidden metadata.

## 2. Confine plan navigation to its content pane

- [x] 2.1 Mark the existing plan content scroller and implement `scrollWithinContainer.ts` with explicit boundary lookup, fit-target centering, tall-target start alignment, scroll-range clamping, immediate scrolling, and null/missing-boundary no-ops. Land the geometry table tests and the separate hostile-document browser seam together; verify O3/O4/O5/O6/O8 geometry cases reject unrestricted ancestor scrolling, always-centering tall targets, unclamped offsets, and a fallback that scrolls the document when its boundary is missing.
- [x] 2.2 Wire the real decision-card/change-row reveals and plan-title opening/fallback to the bounded helper and `focus({ preventScroll: true })`, retaining one-shot consumption and target-versus-title priority. Land updates to plan view/decision/execution tests, P-I3 (seed `0x51c013`, 32 cases), and the Team/Plans architecture notes; verify O3/O4/O6/O8 and P-I3 reject missing production reveal wiring, absent title fallback, and a pending reveal replayed by a later detail update.

## 3. Lock down the production browser behavior

- [x] 3.1 Complete the actual attention-action browser cases for **Answer the question** and **Retry or stop execution**, target fit/tall boundaries, missing-target fallback, ordinary plan selection, and repeated activations. Commit oracle rows O1–O8 verbatim as table-driven case data alongside the implementation; add P-I1 (seed `0x51c011`, 32 cases), viewport sizes 1200×758 and 1024×600, and a larger-text case. Verify O3/O4/O5/O6/O8 and P-I1 through real controls, including keyboard activation, kill their listed reveal/tall-target/replay mutants, and assert document/app/other-pane offsets independently of target visibility.
- [x] 3.2 Cover opening and cancelling task inline actions plus plan Answer and Retry forms in the same isolated browser suite. Verify O7 rejects omitted form mounting or unreachable controls, document/app bounds remain stable, and accessible names/keyboard operation survive; add `@covers` annotations for every new delta scenario directly above its implementing test.

## 4. Integration checks and result evidence

- [ ] 4.1 Run `openspec validate fix-team-document-scroll --strict`, the focused client tests, `bun run build`, and the isolated Playwright regression with `AGENTBOARD_CHAT_FIXTURE=1` on spare ports, then `bun run check` on the clean committed implementation tree. Verify O1–O8 and P-I1–P-I3 remain green together and still reject their named containment, unrestricted-scroll, omitted-wiring, tall-target, fallback/replay, and missing-form mutants; do not claim a mutant run without recorded evidence.
- [ ] 4.2 Record the observed pre-fix document-shift failure, fixed browser geometry, focused/full-check outcomes, and a map from each O1–O8 / P-I1–P-I3 id to its test title and observed killed mutant (explicitly identify anything not run). Verify the map covers every oracle and the result's source commit contains only this change's scoped implementation and tests; no implementation begins as part of creating these planning artifacts.
