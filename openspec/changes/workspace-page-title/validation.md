# Validation results

All 19 temporary production-code mutations were rejected by the focused tests. Each mutated file was restored immediately after its run. No mutation-testing dependency was added.

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
| L5 HTTP failure | L5 HTTP failure: reconnect HTTP failure yields anime-studio - Kawai | accept server-info JSON from an HTTP 503 response |

## Project checks

- `bun run test src/client/utils/__tests__/pageTitle.test.ts src/client/__tests__/app.test.tsx`: 59 passed (10 formatter cases and 49 App tests, including 12 title lifecycle cases).
- HTTP 503 regression: the reconnect test fails without the response-status guard and passes with it. Network and HTTP failures both retain the last successful title; initial failures keep `Kawai`.
- All 19 temporary mutations were rejected by the focused tests. The Team-route mutant reads the production route state; the alternative-source mutants react to those sources so their behavior is exercised.
- Chromium/Playwright smoke with stubbed server metadata and an inert WebSocket: initial `Kawai`, loaded `anime-studio - Kawai`, unchanged after Team navigation; no page errors. Screenshot captured and inspected locally.
- `openspec validate workspace-page-title --strict`: passed.
- `git diff --check`: passed.
- Final repository validation uses `bun run check` on the clean committed tree and the repository's required pre-push certificate; the PR validation summary reports the final result.
