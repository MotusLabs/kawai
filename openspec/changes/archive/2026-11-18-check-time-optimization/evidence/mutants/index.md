# Mutant evidence (closeout task 7.3, contract A3)

Each directory holds one named mutant of the landed contract: `mutant.patch`
is the temporary edit (applied to the working tree only, reverted before any
commit; the production files are byte-identical at the closeout head), and
`run.log` is the test run under the mutant. Every named row fails; exit
codes are non-zero.

| Mutant | File mutated | Named row(s) run | Result |
| --- | --- | --- | --- |
| 01-rerun-removed | `scripts/runPlan.ts` | RT3 (both rows) | 0 pass, 2 fail |
| 02-bound-removed (`MAX_REAL_TMUX_RETRIES` 2 → 7) | `scripts/runPlan.ts` | RT5 F=3, retries on | 0 pass, 1 fail |
| 03-main-batch-guard-removed | `scripts/runPlan.ts` | RT1 (both rows) | 0 pass, 2 fail |
| 04-profile-check-removed (`recordAnswers` → `true`) | `scripts/lib/checkRun.ts` | RU4 | 0 pass, 1 fail |
| 05-ci-check-removed | `src/server/__tests__/helpers/propertyCases.ts` | PC1 | 0 pass, 1 fail |
| 06-ceil-to-floor | `src/server/__tests__/helpers/propertyCases.ts` | PC1 | 0 pass, 1 fail |
| 07-seed-offset-shifted (fixture writes `SEED + index + 1`) | `scripts/__tests__/fixtures/caseProfile/caseCount.test.ts` | the three probe rows | 0 pass, 3 fail |
| 07b-seed-window-shifted (`ceil(n/4) + 1`) | `src/server/__tests__/helpers/propertyCases.ts` | PC1 | 0 pass, 1 fail |
| 08-copy-skipped | `src/server/__tests__/helpers/testDatabase.ts` | TD1 | 0 pass, 1 fail |
| 09-shared-trigger-removed | `scripts/lib/realTmuxSelection.ts` | SE3 (both rows) | 0 pass, 2 fail |
| 10-no-merge-base-removed | `scripts/lib/realTmuxSelection.ts` | SE2 (both rows) | 0 pass, 2 fail |
| 11-own-file-match-dropped | `scripts/lib/realTmuxSelection.ts` | SE4 own-file row | 1 pass (the glob row, unaffected by design), 1 fail (the own-file row) |

The seed offset of the landed contract's third L-V2 mutant lives in the
probe fixture, whose rows assert `SEED + 0 … SEED + k-1` (task 4.3: "the
probe's seed offset shifted by one fails all three"); 07b is the same shift
read on the propertyCases side, which PC1's count assertions also reject.
PC1 itself asserts case counts only and imports no fixture, so mutant 07
leaves it passing by construction.
