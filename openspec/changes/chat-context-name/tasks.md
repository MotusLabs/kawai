# Tasks

## 1. Derive the context name

- [x] 1.1 Extract `owningRepository(path, repositories)` in `src/client/utils/teamKey.ts` (design Decision 1) and rewrite `teamKeyOf` on top of it. Verify: `bun run test src/client/__tests__/teamKey.test.ts src/client/__tests__/teamKeyChatView.test.tsx` passes unchanged (A3). The mutant "shallowest match wins" must fail an existing nested-worktree case; add one to `teamKey.test.ts` if none exists. I2 (one matcher) is checked in review: `teamKeyOf` contains no containment loop of its own.
- [x] 1.2 Add `src/client/utils/contextName.ts` with `contextName` and `brandLabels` (Decision 2), and `src/client/__tests__/contextName.test.ts` with tables C and B verbatim. Annotate with `@covers` the workspace-navigation scenarios "A linked worktree names its repository" (C4), "A sibling path is not inside a worktree by prefix" (C6), "A remote session uses its directory name" (C7), "A Team page names the team's repository" (C1b, C3), "A plain-directory Team page uses its directory name" (C2), and "Nothing selected has no context name" (C14). Verify with `bun run test src/client/__tests__/contextName.test.ts`. Mutants:
  - C6 kills "prefix match without the `/` boundary".
  - C9 and C10 kill "shallowest worktree wins".
  - C7 and C7b kill "remote sessions use the snapshot".
  - C1b kills "Team key uses its basename instead of the repository".
  - C3 kills "the selected session outranks the team route".
  - C8 kills "null snapshot yields null".
  - C11 kills "trailing slash empties the name".
  - C12 kills "the main worktree's basename instead of `repository.name`".
  - C13 kills "`/` yields an empty-string name".
  - C14 kills "no input yields a name".
  - B2 and B4 kill "workspace name outranks the context name" and "context name requires server information".
  - B3 kills "an empty heading instead of `KAWAI`".
- [ ] 1.3 Split `workspaceName(info)` out of `src/client/utils/pageTitle.ts` and have `pageTitle` return `brandLabels(null, workspaceName(info)).title`. Verify: `bun run test src/client/__tests__/pageTitle.test.ts` passes with T1–T7 unchanged (A5). The mutant "`workspaceName` reads `cwd` first" must fail T1.

## 2. Show it in the app

- [ ] 2.1 In `src/client/App.tsx`, compute `labels` once with `useMemo` from the team route key, the displayed session (`selectedSession` as `{ projectPath, remote: remote === true }`, else `selectedHibernatingSession` as `{ projectPath, remote: false }`, else null), the snapshot's repositories, and the last successful `serverInfo` (Decision 3). Write `labels.title` to `document.title` and pass `labels.heading` to `Header` as a new `contextLabel` prop. Leave the filtered-selection fallback untouched (Decision 6). In `src/client/components/Header.tsx`, render the prop, add `min-w-0 truncate` to the `h1` and `min-w-0` to its container, drop `text-balance`, and keep the `Kawai v<version>` tooltip (Decision 4). Replace the "App workspace title" table in `src/client/__tests__/app.test.tsx` with table L verbatim. Each L1 and L5 alternative is its own case, every prior state is reached through the App, and every row asserts both `document.title` and the heading text. Update `src/client/__tests__/header.test.tsx` to cover the prop and the tooltip. Verify with `bun run test src/client/__tests__/app.test.tsx src/client/__tests__/header.test.tsx`. Mutants:
  - L3a kills "the title effect depends only on `serverInfo`".
  - L3a (heading) kills "Header still renders the literal `KAWAI`".
  - L3j kills "labels memoized without the selection".
  - L3i kills "archived rows skipped".
  - L3k kills "only `kind === 'chat'` supplies the name".
  - L3l kills "hibernating selection ignored".
  - L3m kills "`remote` dropped in the App mapping".
  - L3b and L3b2 kill "the team route is ignored" and "the Team key's basename instead of its repository".
  - L3c kills "leaving the route keeps the team name".
  - L3d and L3e kill "filters or the browser default feed the name".
  - L3d2 and L3d3 kill "labels pinned to the selection made before the filter changed".
  - L3d4 kills "a filter overrides the Team route".
  - L3f kills "a cleared selection keeps the stale name".
  - L3g kills "repositories omitted from the memo dependencies".
  - L3h kills "labels gated on server information".
  - L4 kills "no refresh after reconnect".
  - L5 kills "a failed refresh clears the workspace name".
  - L6 kills "a nameless refresh keeps the stale name".
  - L1 kills "an empty prefix while loading".
  - The I1 check (in every L row, the heading equals the title's name part) kills "Header derives its own name".
- [ ] 2.2 Re-annotate the App and header tests with the delta's scenarios, each placed above a table-L row that exercises it:
  - `instance-identity`: the three MODIFIED "Workspace name leads the browser title" scenarios (L2, plus T1–T7 in `pageTitle.test.ts`). The four "Title has a usable loading and missing-name fallback" scenarios (L1, L6, L5, L3h for "A context name needs no server information"). "Title follows the current context": "Selecting a chat titles its repository" (L3a), "A Team page titles the team's repository" (L3b), "Clearing the selection returns to the instance title" (L3f), "Filters and browser defaults leave the title alone" (L3d, L3e), and "A filter that moves the selection retitles" (L3d2, L3d3). "Reconnect refreshes instance information" (L4).
  - `workspace-navigation`: "The heading follows the selected chat" (L3a then L3j), "The heading falls back to the server workspace" (L2), "The heading has a last-resort fallback" (L1, L6), "Leaving a Team page shows the chat's heading" (L3c), "Archived chats name their repository too" (L3i), "Terminals and hibernating sessions name their repository" (L3k, L3l), and "The repository name replaces the directory name once discovered" (L3g).

  Remove every annotation naming the REMOVED requirement "Title follows the server instance across navigation". Verify: `bun run test scripts/__tests__/specCoverageGuard.test.ts` passes, `grep -rn "Title follows the server instance" src` finds nothing, and every scenario of both delta specs has an annotation (count them against the delta files).
- [ ] 2.3 Add a Playwright check under `tests/e2e/` for A4: with a chat whose repository name is longer than the navigator, the heading stays on one line, the navigator keeps its width, and the heading's `title` attribute is `Kawai v<version>`. Annotate it with "A long name keeps the navigator width". Verify: `bun run build` then `bun run test:e2e` runs that spec and it passes. The mutant "drop `truncate`" must fail it.

## 3. Integration

- [ ] 3.1 Run `bun run check` on the clean committed tree. Report the result with a map from every oracle id (C1–C14 with C1b and C7b, B1–B4, L1–L6 with every L3 row and alternative, T1–T7, A1–A5, I1–I5) to its test title and killed mutant. Confirm each named mutant fails before reporting it killed. Verify: the check passes, the map has no unmapped id, and `openspec validate chat-context-name --strict` passes.

## Workflow follow-up

- If `team-workspace-redesign` lands first, rebase this change onto its shells. Table L then runs once, and its Team rows (L3b, L3b2, L3d4) assert the title plus no navigator heading, while L3c asserts the heading is back. If it lands second, its task 1.3 keeps the labels computation and the title effect mounted in both shells and switches those rows' heading assertions to absent.
- Archive after review. The archived MODIFIED and ADDED scenarios need their `@covers` annotations, which tasks 2.2 and 2.3 already add.
