# Validation results

All 18 temporary production-code mutations were rejected by the focused tests. Each mutated file was restored immediately after its run. No mutation-testing dependency was added.

| Oracle | Test title (suite prefix omitted) | Rejected mutation |
| --- | --- | --- |
| T1 | T1: workspace title is anime-studio - Kawai | reverse directory precedence |
| T2 | T2 undefined: workspace title is anime-studio - Kawai | omit cwd fallback |
| T2 | T2 null: workspace title is anime-studio - Kawai | omit cwd fallback |
| T3 | T3: workspace title is anime-studio - Kawai | empty default suppresses cwd |
| T3/T5 | T3: workspace title is anime-studio - Kawai | keep trailing empty components |
| T3/T5 | T5: workspace title is Anime Studio 日本 - Kawai | keep trailing empty components |
| T4 | T4: workspace title is anime-studio - Kawai | accept root as a name |
| T5 | T5: workspace title is Anime Studio 日本 - Kawai | lowercase directory names |
| T5 | T5: workspace title is Anime Studio 日本 - Kawai | strip spaces and Unicode |
| T6 | T6 undefined: workspace title is Kawai | render absent name |
| T6 | T6 null: workspace title is Kawai | render absent name |
| T6 | T6: missing server information uses Kawai | render absent name |
| T7 | T7: workspace title is Kawai | render separator-only name |
| L1 | L1 pending: initial pending yields Kawai | render absent prefix while loading |
| L1 | L1 failure: initial failure yields Kawai | render absent prefix while loading |
| L2 | L2: initial success yields anime-studio - Kawai | remove title effect |
| L3 selection | L3 selection: selection yields anime-studio - Kawai | use selected session project |
| L3 Team route | L3 Team route: Team route yields anime-studio - Kawai | use Team route project |
| L3 filter | L3 filter: filter yields anime-studio - Kawai | use project filter |
| L3 browser default | L3 browser default: browser default yields anime-studio - Kawai | use browser project default |
| L4 | L4: reconnect success yields manga-studio - Kawai | omit server-info effect dependency |
| L5 | L5: reconnect failure yields anime-studio - Kawai | clear title on fetch failure |
| L6 | L6: reconnect nameless yields Kawai | retain old title for nameless success |

## Project checks

- `bun run test src/client/utils/__tests__/pageTitle.test.ts`: 10 passed.
- `bun run test src/client/__tests__/app.test.tsx`: 47 passed, including all 10 title lifecycle cases.
- `openspec validate workspace-page-title --strict`: passed.
- `git diff --check`: passed.
- `bun run check`: lint passed with 27 warnings; typecheck passed; the non-tmux suite reported 7,905 passed and 3 failed across 724 files. The runner stopped before the serial real-tmux tier, and no full-pass certificate was recorded.

The three failures are in unchanged backend code in `src/server/__tests__/codexChatLifecycle.test.ts` and also reproduce with `bun run test src/server/__tests__/codexChatLifecycle.test.ts`:

1. `a login limit cools both profiles on the home and none on another home`: cooldown is null at line 290.
2. `a session budget failure records for its profile alone, with no provider`: cooldown is null at line 308.
3. `a Codex launch withholds the catalog-named credentials (openrouter-provider 1.8)`: the child environment still names `OPENROUTER_API_KEY` at line 359.

Full validation remains open (task 3.1); these backend failures require work outside the page-title change. Existing unrelated working-tree edits were preserved. Implementation and tests are uncommitted.
