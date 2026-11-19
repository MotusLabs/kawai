# Verification evidence

The six focused files passed: 37 tests, 705 assertions. G1 and G2 each ran all 128 cases with `KAWAI_FULL_PROPERTIES=1` under the pinned Bun 1.4.3. Typecheck and strict OpenSpec validation passed. All 18 temporary mutants were killed and restored.

## Oracle-to-test-title-to-mutant map

Each failed title below is the exact test title without the runner timing suffix. O8 is the existing concurrent WAL test; the other titles are in `toolMetricInputs.test.ts`.

| Mutant (oracle IDs) | Exact test title(s) that rejected it |
| --- | --- |
| P1-team-index | P1/P2: production tool lookups search session identities before executing on large history |
| P2-team-index | P1/P2: production tool lookups search session identities before executing on large history |
| O1-wrong-closure-kind | O1: In-window tool and same-team/session/turn closure -> Closure included once |
| O2-filter-closure-time | O2: As O1, closure timestamp before `from` or at/after `to` -> Closure still included once |
| O3-G1-drop-team | O3: Only another team's, session's, or turn's tool; or a null closure session/turn -> Closure excluded for each variant<br>G1: closure cohorts equal an independent array oracle (128 cases, seed 0x19A11) |
| O3-G1-drop-session | O3: Only another team's, session's, or turn's tool; or a null closure session/turn -> Closure excluded for each variant<br>G1: closure cohorts equal an independent array oracle (128 cases, seed 0x19A11) |
| O3-G1-drop-turn | O3: Only another team's, session's, or turn's tool; or a null closure session/turn -> Closure excluded for each variant<br>G1: closure cohorts equal an independent array oracle (128 cases, seed 0x19A11) |
| O3-null-session-equality | O3: Only another team's, session's, or turn's tool; or a null closure session/turn -> Closure excluded for each variant |
| O3-null-turn-equality | O3: Only another team's, session's, or turn's tool; or a null closure session/turn -> Closure excluded for each variant |
| O4-G1-exclude-start | O4: Matching tool completion at `from`, then at `to` in separate fixtures -> Included at `from`; excluded at `to`<br>G1: closure cohorts equal an independent array oracle (128 cases, seed 0x19A11) |
| O4-G1-include-end | O4: Matching tool completion at `from`, then at `to` in separate fixtures -> Included at `from`; excluded at `to`<br>G1: closure cohorts equal an independent array oracle (128 cases, seed 0x19A11) |
| O5-G2-tighten-live-turn | O5: Valid live identity; same-team/session tool is in-window but belongs to another turn -> Current live identity included<br>G2: live cohorts equal an independent array oracle (128 cases, seed 0x19A12) |
| O6-bypass-live-scope | O6: Live scope session mismatches its row key, or its scope turn id is not a string -> Live identity excluded for each variant |
| O6-bypass-string-turn | O6: Live scope session mismatches its row key, or its scope turn id is not a string -> Live identity excluded for each variant |
| O7-accept-streak | O7: No qualifying tool row, including a streak-only row or another team's tool -> Neither a closure nor a live identity is qualified |
| G2-broaden-live-session | G2: live cohorts equal an independent array oracle (128 cases, seed 0x19A12) |
| O9-order-by-time | O9: Two tool rows qualify one closure; several closures are inserted out of time order -> No duplicate closures; ascending sequence order |
| O8-remove-read-transaction | S3 detail and retained carrier share one real WAL read snapshot across a concurrent closure commit |

## Full-tree check

The first clean committed-tree check passed lint/typecheck and 11,451 tests but failed one existing status-subscription test (11,452 tests across 1,039 files; 382,908 assertions). That test passed in isolation on both this branch and the unmodified release. Its initial snapshot count was timing-sensitive (three instead of two).

The owner approved test-only setup synchronization: observe the startup publication before opening subscriptions. The unchanged budget-refusal, cache-identity, and exact snapshot-count assertions pass normally and with the first publication deliberately delayed by 500 ms. The two affected files pass together (15 tests, 354 assertions, all 256 seeded cases). The unused type import has also been removed. The fresh full check passed on clean implementation commit `289aa1bc`: **11,452 tests passed, 0 failed, 382,922 assertions across 1,039 files**. Lint and typecheck passed. The repository recorded certificate `706dd09425e3f2f56df7e5222baf9f940eadc2cc07bb29a1bb25bdde2be29fca` under pinned Bun 1.4.3. Seven unaffected real-tmux files were skipped by the standard change-aware runner. The subsequent completion commit records only task status and this evidence; it changes no implementation code.

No production service or database was modified.
