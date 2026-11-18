# Tasks

## 1. Model families in the catalog

- [x] 1.1 Accept `family` on providers, provider models, and `profiles.json` entries in `catalogParse.ts` as a trusted-tier field (rejected below the user level like `codexHome`), with model-over-provider-over-profile-id resolution exposed as `familyOf` from the catalog memo and on browser profile metadata. Verify: Table F (F1–F5) committed verbatim as a table-driven test passes; the mutant that accepts `family` from a project-level file fails F4 (V3).
- [x] 1.2 Add `family` to every entry of `config/providers.default.json` and `config/profiles.default.json` (`claude`, `gpt`, `glm`, `minimax`, `mimo`, `kimi`, `deepseek`). Verify: F6 asserts every shipped model resolves to an explicit family, and the mutant that drops `openrouter-opus`'s family fails it.
- [x] 1.3 Document `family`, its trust tier, the id fallback, and the downgrade note in `docs/claude-session-profiles.md` and the chat-profiles bullet of `docs/architecture/chat.md`. Verify: the `@reads` guard and `bun run lint` pass.

## 2. Result authorship

- [x] 2.1 Add nullable `team_task_results.submitted_by_profile`, set in `TaskResultService.submit` from the caller's session record, and `reviewAuthors(taskId)` returning author families and unknown authors over all results (human submissions add none). Verify: tests cover the three `task-results` scenarios, and a mutant that reads only the latest result fails the "every round's author counts" row (V2).
- [x] 2.2 Update the Task results bullet in `docs/architecture/tasks.md`. Verify: `bun run lint` passes.

## 3. Cross-model eligibility

- [x] 3.1 Parse `crossModelReview` as a strict boolean in `groupFile.ts` and carry it on `GroupDefinition`. Verify: the routing-spec scenarios "The flag is read" and "A non-boolean rejects the file" pass.
- [x] 3.2 Add the `crossModel` input and `cross-model` exclusion to `evaluateEligibility`, `crossModelState(message)` (assignment → result → `reviewAuthors`), and wire it into `ProfileRouter`, `groupDispatchPreview`, and `candidates`. Verify: Table E rows E1–E7, E10, E11 committed verbatim pass (V2); the profile-id-comparison mutant fails E3/families scenario; P1 (seed `0x5eed01`, 400 cases) and P3 (seed `0x5eed03`, 200 cases) pass; the production-composition router test fails with the `crossModelState` wiring removed (V5).
- [x] 3.3 Refuse review handoffs whose worker choice lies entirely within the authors' families in `TaskResultService.handoff`. Verify: E8 and E9 pass, and E8 asserts no assignment or mail row is written; a mutant that checks only the first chosen profile fails E9.
- [x] 3.4 Add `cross-model` to `WaitingConstraintKind` and `KIND_ORDER`, with detail naming families, unknown authors, and other-family capacity constraints, and its label in `waitingLabels.ts`. Verify: the three `team-waiting-reasons` scenarios pass; a mutant that omits the capacity detail fails "The other-family worker is at its cap".
- [x] 3.5 Update `docs/architecture/routing.md` (Profile routing, Worker choice), `docs/architecture/mailbox.md` (Waiting reasons), and `docs/routing/README.md` (tags remain; built-in filter added). Verify: `bun run lint` passes and the docs name the flag and the reason kind.

## 4. Starter templates and setup operation

- [x] 4.1 Write `config/groups/lead.md`, `devs.md`, `reviewers.md` with the D1 frontmatter and generic role prompts, embedded as text imports. Verify: a test loads them as project groups with the shipped catalogs and asserts no error or warning and the D1 workers, caps, and flags (A5).
- [x] 4.2 Implement `setupAvailable(groupsRoot)` and the setup operation (lstat guard, D2 re-check, temp-file + `link()` per file, created/skipped/error result) in `src/server/team/teamSetup.ts`. Verify: Table S (S1–S8) and Table O committed verbatim pass over `/tmp` roots (V1); the dropped-symlink-check (stat for lstat), `flag: 'w'` (killed by S6b, a link planted at the temp name), link-for-rename, and dropped-re-check mutants each fail a row; P2 (seed `0x5eed02`, 200 cases) passes.
- [x] 4.3 Add `team-workspace-setup-preview` / `team-workspace-setup-run` and their result messages to the workspace WS handler (and the router whitelist), publishing the team after a run; add `setupAvailable` to `GET /api/team-groups` (the client already derives the team key with `teamKeyOf`, so the route carries no `teamKey`). Verify: the production-composition test sends `team-workspace-setup-run` through the real handler and observes the files and a `team-workspace` push (V5); a route test covers the new field; S9 asserts no agent tool writes group files.
- [x] 4.4 Update `docs/architecture/team-page.md` (Members bullet: the setup exception) and add a recovery-matrix row only if the operation gains a startup reconciliation (it should not: temp files are skipped by the catalog). Verify: `src/server/__tests__/recoveryMatrix.test.ts` and `bun run lint` pass.

## 5. Client

- [x] 5.1 Members tab: Set up team above the group rows or in place of an empty list, disabled while disconnected, opening a preview dialog (groups, workers, flag, target directory, missing-worker warnings) with Confirm and Cancel, showing the result inline. Verify: client tests cover the `team-workspace` ADDED scenarios, the preview, cancel-writes-nothing, and inline refusal.
- [x] 5.2 New Session dialog: the missing-groups notice for chat sessions whose project has `setupAvailable`, with a link that closes the dialog and navigates to `{ teamKey, tab: 'members' }`, following project-path changes. Verify: `newSessionMissingGroups.test.tsx` (beside `newSessionModal.test.tsx`) covers the five New Session scenarios (V6).
- [ ] 5.3 Playwright walkthrough: from the New Session notice to the Members tab, Set up team, confirm, and the three listed groups naming their files. Verify: `bun run build` then the e2e spec passes (V6).

## 6. Integration

- [ ] 6.1 Annotate every covering test with `// @covers:` for the delta scenarios, run `openspec validate starter-team-setup --strict`, and run `bun run check` on the clean committed tree. Verify: both pass, and the result maps each oracle id (S1–S9, O1–O4, E1–E11, F1–F6, P1–P3) to a test title and its killed mutant.

## Workflow follow-up

- Before archiving, rebase the `team-workspace` MODIFIED block onto `team-workspace-redesign` if that change archived first.
- Archive with `/openspec-archive-change`, adding coverage annotations for the main-spec scenarios it leaves.
