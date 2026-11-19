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

Pending the clean committed implementation-tree check required by task 2.2.

No production service or database was modified.
