# Tasks

## 1. Derive the context name

- [ ] 1.1 Extract `owningRepository(path, repositories)` in `src/client/utils/teamKey.ts` (design Decision 1) and rewrite `teamKeyOf` on top of it. Verify: `bun run test src/client/__tests__/teamKey.test.ts src/client/__tests__/teamKeyChatView.test.tsx` passes unchanged (A3); the mutant "`teamKeyOf` keeps its own matcher loop" fails I2 review, and the mutant "shallowest match wins" fails an existing nested-worktree case, or a new one you add there.
- [ ] 1.2 Add `src/client/utils/contextName.ts` with `contextName` and `brandLabels` (Decision 2), and `src/client/__tests__/contextName.test.ts` with tables C and B verbatim, plus the C7b assertion that the lookup is never called for a remote session. Annotate them with `@covers` for the workspace-navigation scenarios "A linked worktree names its repository", "A sibling path is not inside a worktree by prefix", "A remote session uses its directory name", "A Team page names the team's repository", and "Nothing selected has no context name". Verify with `bun run test src/client/__tests__/contextName.test.ts`. Mutants:
  - C6 kills "prefix match without the `/` boundary".
  - C9 and C10 kill "shallowest worktree wins".
  - C7b kills "remote sessions use the snapshot".
  - C3 kills "the selected chat outranks the team route".
  - C8 kills "null snapshot yields null".
  - C11 kills "trailing slash empties the name".
  - C12 kills "the main worktree basename instead of `repository.name`".
  - C13 kills "`/` yields an empty-string name".
  - C14 kills "no input yields a name".
  - B2 and B4 kill "workspace name outranks the context name" and "context name requires server information".
  - B3 kills "an empty heading instead of `KAWAI`".
- [ ] 1.3 Split `workspaceName(info)` out of `src/client/utils/pageTitle.ts` and have `pageTitle` return `brandLabels(null, workspaceName(info)).title`. Verify: `bun run test src/client/__tests__/pageTitle.test.ts` passes with T1–T7 unchanged (A5); the mutant "`workspaceName` reads `cwd` first" fails T1.

## 2. Show it in the app

- [ ] 2.1 In `src/client/App.tsx`, compute `labels` once with `useMemo` from the team route key, `selectedSession`, the snapshot's repositories, and the last successful `serverInfo`. Write `labels.title` to `document.title` and pass `labels.heading` to `Header` as a new `contextLabel` prop (Decision 3). In `src/client/components/Header.tsx`, render the prop, add `min-w-0 truncate` to the `h1` and `min-w-0` to its container, drop `text-balance`, and keep the `Kawai v<version>` tooltip (Decision 4). Replace the "App workspace title" table in `src/client/__tests__/app.test.tsx` with table L verbatim, one case per L1 and L5 alternative, each asserting both `document.title` and the heading text. Update `src/client/__tests__/header.test.tsx` to cover the prop and the tooltip. Verify with `bun run test src/client/__tests__/app.test.tsx src/client/__tests__/header.test.tsx`. Mutants:
  - L3a kills "the title effect depends only on `serverInfo`".
  - L3a (heading) kills "Header still renders the literal `KAWAI`".
  - L3b and L3c kill "the team route is ignored" and "leaving the route keeps the team name".
  - L3d and L3e kill "filters or the browser default feed the name".
  - L3f kills "a cleared selection keeps the stale name".
  - L3g kills "repositories omitted from the memo dependencies".
  - L3h kills "labels gated on server information".
  - L4 kills "no refresh after reconnect".
  - L5 kills "a failed refresh clears the workspace name".
  - L6 kills "a nameless refresh keeps the stale name".
  - L1 kills "an empty prefix while loading".
  - The I1 check (the heading equals the title's name part in every L row) kills "Header derives its own name".
- [ ] 2.2 Re-annotate the tests with the delta's `instance-identity` scenarios: the three MODIFIED "Workspace name leads the browser title" scenarios and the four "Title has a usable loading and missing-name fallback" scenarios, including "A context name needs no server information" (L3h). Add the four ADDED "Title follows the current context" scenarios (L3a, L3b, L3f, L3d/L3e), "Reconnect refreshes instance information" under "Workspace fallback follows server information" (L4), and the workspace-navigation scenarios "The heading follows the selected chat", "The heading falls back to the server workspace", "The heading has a last-resort fallback", "Archived chats name their repository too", and "The repository name replaces the directory name once discovered" (L3g). Remove every annotation naming the REMOVED requirement "Title follows the server instance across navigation". Verify: `bun run test scripts/__tests__/specCoverageGuard.test.ts` passes, and `grep -rn "Title follows the server instance" src` finds nothing.
- [ ] 2.3 Add a Playwright check under `tests/e2e/` for A4: with a chat whose repository name is longer than the navigator, the heading stays on one line, the navigator keeps its width, and the heading's `title` attribute is `Kawai v<version>`. Verify: `bun run build` then `bun run test:e2e` runs that spec and it passes. The mutant "drop `truncate`" fails it.

## 3. Integration

- [ ] 3.1 Run `bun run check` on the clean committed tree. Report the result with a map from every oracle id (C1–C14 and C7b, B1–B4, L1–L6 with each alternative, T1–T7, A1–A5, I1–I4) to its test title and killed mutant. Confirm each named mutant fails before reporting it killed. Verify: the check passes, the map has no unmapped id, and `openspec validate chat-context-name --strict` passes.

## Workflow follow-up

- If `team-workspace-redesign` lands first, rebase this change onto its shells and re-run table L under both `SessionsShell` and `TeamShell`. If it lands second, its task 1.3 keeps the labels computation and the title effect mounted in both shells.
- Archive after review. The archived MODIFIED and ADDED scenarios need their `@covers` annotations, which task 2.2 already adds.
