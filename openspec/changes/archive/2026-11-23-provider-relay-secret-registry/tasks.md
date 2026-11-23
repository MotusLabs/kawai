# Tasks

Closeout of landed `provider-relay-setup` §1 (9e91a8dc, 6c1a3b04). No
production code. Oracle ids are this change's design rows (R-W1, R-W2,
R-W5, R-W7, R-RF, R-MW, R-MK, P7r). Never tick or edit
`provider-relay-setup/tasks.md`.

## 1. Evidence map and archive

- [x] 1.1 Build the result's coverage map from design "Scenario → evidence map": every scenario of the delta cites existing tests by literal title (`file` › `title`), and umbrella tasks 1.1 and 1.2 are recorded as landed by 9e91a8dc/6c1a3b04 with the R-* rows as their evidence. Verify: run the literal-citation preflight on the map (zero unresolved) before any expensive check; cites R-W1, R-W2, R-W5, R-W7, R-RF, R-MW, R-MK, P7r.
- [x] 1.2 Add `// @covers: provider-credentials › Registered secret names stay withheld › A dropped entry's variables stay withheld` above each test the map cites for that scenario (`registeredNamesWithholding.test.ts`, `registeredNameSurvivesRemoval.test.ts`), stacked with the existing annotations; no other test edit. Verify: `scripts/__tests__/specCoverageGuard.test.ts` passes; the mutant "annotation names a scenario that does not exist" (one typo in the scenario name) fails that guard.
- [x] 1.3 Run at most five registry-wiring mutants in a disposable checkout (design A3: drop `retainedNamesDb` in `catalogRegisteredNames`; skip the credentialed refusal throw at `ClaudeProfiles.ts:215`; skip the Codex `CODEX_HOME` refusal at `codexProfiles.ts:76`; make `observeRegisteredNames` stop persisting growth; make `withoutCredentials` a no-op). Verify: each mutant fails at least one cited test (R-RF, R-MW, R-W2, R-W7, R-MK); record mutant → failing title in the result.
- [x] 1.4 Checkpoint: clean committed head passes `bun run check --full-properties` (pinned Bun 1.4.3) and `bun scripts/verify-result.ts --commit <head> --coverage <map>` exits 0; submit one complete result for review (V1, V2).
- [x] 1.5 Sync and archive this change in one commit, creating `openspec/specs/provider-credentials/spec.md`, before the complete replacement result and its final review. Verify: `openspec validate --specs --strict` passes; the archived spec holds exactly the four scenarios (A4); `provider-relay-setup/**` is byte-identical to f52963d0 (I2).
