# Refactor analysis — 2026-10-11

Full-codebase analysis of whether kawai needs refactoring, run as a three-phase tiered pass:
mechanical triage (phase 1), architecture/business-logic review with verification (phase 2),
and synthesis. Verdict: targeted refactor, not a rewrite — see `synthesis.md`.

- `synthesis.md` — verdict, P0/P1/P2/P3 priorities, what not to refactor, corrections log
- `phase1/` — per-slice metrics (LOC, long functions, duplication, dead exports, layering)
- `phase2/` — server and client architecture reviews, dead-code/test-suite verification

Phase 1 numbers were produced by cheap mechanical agents and deliberately unverified; the
corrections log in `synthesis.md` lists every phase 1 claim that phase 2 disproved. Trust the
phase 2 documents where they disagree.
