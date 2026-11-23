# Verification: fixed Team document scrolling

The implementation is `26bbeb26`, with fixture guard correction `bc32e32f`, based on primary-branch commit `d2c8c297`; its containment commit is `0d927412`. The branch diff against that base contains only the design's scoped client code, tests, architecture notes, and this change's OpenSpec artifacts. Implementation followed the completed proposal; this record does not expand its scope.

## Observed failure and fixed geometry

The supplied browser capture showed a 758 px viewport with document scroll changing from 0 to 190.4 px, app top from 0 to −190 px, and app bottom from 758 to 568 px. The app height did not shrink: the document moved. Hidden absolute accessibility labels escaped their scrolled owners' containing blocks; native plan reveals could then scroll the document.

Before the fix, the isolated standards-mode browser fixture failed O1 with document extent 4160 px (the early assertion allowed at most 759 px). Its actual Answer attention action also failed O3's independent viewport predicate. Logs: `/tmp/kawai-scroll-red.log` and `/tmp/kawai-scroll-red-navigation.log`. The early O1 setup used Playwright's default viewport; the final suite explicitly sets 1200×758 and derives the extent limit from the measured viewport.

A fresh capture on `26bbeb26`, before and after clicking **Answer the question**, produced identical facts:

```json
{"mode":"CSS1Compat","height":758,"extent":758,"documentScroll":0,"appScroll":0,"top":0,"bottom":758}
```

Raw capture: `/tmp/kawai-scroll-current-geometry.json`. Browser geometry assertions tolerate 1 CSS px. Fixtures use private temporary databases, repositories, homes, tmux sockets, and loopback servers; no live database or model provider is exercised.

## Checks

- `openspec validate fix-team-document-scroll --strict`: passed.
- Original focused six-file client/spec-guard run: **55 passed, 0 failed** (`/tmp/kawai-scroll-focused-final.log`).
- After replay onto the current primary branch, focused `scrollAccessibility`, `scrollWithinContainer`, `planDecisionUi`, and `specCoverageGuard` run: **29 passed, 0 failed** (`/tmp/kawai-scroll-current-focused.log`).
- `bun run build`: passed after integration (`/tmp/kawai-scroll-current-build.log`); the fixed client was also built in the primary workspace under pinned Bun (`/tmp/kawai-scroll-primary-build.log`).
- `PLAYWRIGHT_BROWSERS_PATH=/tmp/kawai-scroll-browsers AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=5389 bun run test:e2e tests/e2e/team-document-scroll.spec.ts --workers=1`: **11 passed** in 41.9 s (`/tmp/kawai-scroll-current-browser-final.log`). Includes both viewport sizes, larger text, actual mouse/keyboard controls, and seeded properties.
- Fixture guard `scripts/__tests__/e2eFixtureSpecs.test.ts`: **40 passed, 0 failed** after moving the fixture switch from the helper to its owning spec (`/tmp/kawai-scroll-fixture-guard.log`).
- Final browser rerun on the corrected fixture, pinned Bun, port 5399: **11 passed** in 47.3 s (`/tmp/kawai-scroll-browser-owned-env.log`).
- Pinned-runtime packaging tests: **9 passed, 0 failed** (`/tmp/kawai-scroll-pinned-consumer.log`).
- Isolated Git-hook integration tests: **42 passed, 0 failed** (`/tmp/kawai-scroll-hooks-isolated.log`); this diagnoses the previous full-run timeouts without claiming those interrupted runs passed.
- `KAWAI_TEST_WORKERS=2 PATH=/tmp/kawai-scroll-bun-1.4.3/bun-linux-x64:$PATH bun run check` on clean committed source **`bc32e32f`**: **passed** — lint 0 errors (47 existing warnings), typecheck passed, **11,463 tests passed, 0 failed, across 1,041 files**. Test step 2,714,466 ms; pass recorded with key prefix `945857489e7e` (`/tmp/kawai-scroll-final-full-check.log`). This uses the normal repository check profile and selection. Subsequent completion bookkeeping changes only the task checkboxes and this evidence record, not the checked source.

The older-base full-check attempt was interrupted after unrelated Git-hook integration timeouts; it is not counted as a pass. An integrated attempt under the workspace Bun 1.4.4 hit the packaging test that explicitly accepts only Bun 1.3.0 or 1.4.3 and was stopped. The repository pin is 1.4.3; its runtime was downloaded to `/tmp/kawai-scroll-bun-1.4.3`, and the packaging version assertion passes under that pin without source changes. Neither interrupted run is counted as a pass. A subsequent pinned run found the new fixture helper was not permitted to own the fixture switch; `bc32e32f` moves the literal switch to its listed spec and passes the readers guard. That run also hit Git-hook test timeouts under concurrent load. The final full run uses the documented `KAWAI_TEST_WORKERS=2` setting with unchanged coverage; interrupted attempts are not counted as passes. An initial integrated browser launch found the workspace's matching Chromium absent; installing it under `/tmp/kawai-scroll-browsers` resolved that setup failure. No product workaround or test skip was added.

## Oracle and negative-control map

Browser titles below are in `tests/e2e/team-document-scroll.spec.ts`; the eight literal oracle rows live in `tests/e2e/fixtures/teamDocumentScroll.ts`. Unit geometry titles are in `src/client/__tests__/scrollWithinContainer.test.ts`, reveal/form titles in `src/client/__tests__/planDecisionUi.test.tsx`, and P-I2 in `src/client/__tests__/scrollAccessibility.test.tsx`.

| Id | Passing test title | Observed rejected mutant or negative control |
| --- | --- | --- |
| O1 | `O1: Open Team` | Browser `O1/O2 controls: removing local label containment recreates document overflow` removes navigator containment and observes excess document extent; restoring it restores viewport bounds. |
| O2 | `O2: Open Team and return to chat` | Same browser control independently removes metadata/time/copy containment and observes excess document extent while retaining labels. |
| O3 | `O3: Activate Answer the question by mouse and keyboard` | `no-card-wiring` fails `a card attention link opens the plan scrolled to and focused on the decision card (§10.5)`; the hostile-boundary browser control also proves native ancestor scrolling moves the document. |
| O4 | `O4: Activate Retry or stop execution` | `no-change-wiring` fails `a plan attention link with a change opens the plan scrolled to and focused on the change row (§10.5)`; the hostile-boundary browser control repeats the native-scroll negative control for the change row. |
| O5 | `O5: Reveal target` | `tall-always-center` fails `O3–O6/O8 geometry: tall target begins at pane top`. |
| O6 | `O6: Follow attention link, then push plan update` | `missing-target-no-fallback` fails `O6: an unknown reveal on an already loaded plan returns focus to its title once`; `reveal-not-consumed` fails P-I3. |
| O7 | `O7: Open and cancel inline task action, Answer form, and Retry confirmation` | `missing-answer-form` fails `Answer takes a chosen option or written text with an optional rationale`. Browser coverage also opens and cancels the real task reassignment and Retry confirmation controls. |
| O8 | `O8: Open plan from list` | `no-title-focus` fails `a card the detail cannot render yet (no revision shown) leaves the focus on the title` and the unknown-target title tests. The ordinary-opening browser test independently checks title focus and start alignment. |
| P-I1 | `P-I1: 32 seeded production reveals preserve every non-owning scroll offset` | Seed `0x51c011`; positive property run. Associated negative controls are the separately observed card/change unrestricted-scroll browser controls, not a claimed direct mutation run of this property test. |
| P-I2 | `P-I2: hidden labels and live feedback retain their semantics (seed 0x51c012, 16 cases)` | Positive semantic property run. O1/O2's separate containment controls preserve metadata while demonstrating the layout failure. A metadata-deletion source mutant was **not run**. |
| P-I3 | `P-I3: data-only updates never replay consumed present/missing reveals (seed 0x51c013, 32 cases)` | `reveal-not-consumed` directly fails this property. |

Additional observed geometry kills: `unclamped-offset` fails `O3–O6/O8 geometry: top limit` and `bottom limit`; `ignore-pane-border` fails `below` and `above`; `missing-boundary` fails `O6 geometry: null, detached, absent boundary, and zero-height pane never scroll an ancestor`.

Ten source mutants were run against the implementation before its replay onto the current primary branch (original source commit `82e9e906`); each produced the failures named above, and original bytes were restored after every run. Their logs are `/tmp/kawai-scroll-mutant-<name>.log`. Runtime containment and hostile card/change scrolling controls were rerun in the final integrated browser suite. The actual code paths covered by these source mutants retain the same fix after replay; the new browser/focused runs verify integration, not a second claimed run of every source mutant.

Not run: independent source mutants deleting accessibility metadata, removing only `preventScroll`, or breaking only task/Retry form mounting; and a title-only native-scrolling replacement. No claim is made that those variants were executed. The direct assertions and the observed alternative mutants/controls above are the evidence provided. Temporary `/tmp` logs are local run artifacts, not durable repository fixtures; the committed test cases and this record retain the reproduction commands, expected geometry, and observed outcomes.
