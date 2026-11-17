# Tasks

Closeout of landed behavior (original `process-observability` tasks 1.1–1.5,
2.1–2.4, 9.1–9.5, ticked there). Test-only and docs work; no production
change.

## 1. Evidence

- [ ] 1.1 Add `@covers: <capability> › <requirement> › <scenario>` above each `M` test of design "Closeout map", after a citation preflight that resolves every literal title. Before annotating, re-read each cited test body and confirm it asserts the row's named outcome; a row that does not becomes a candidate (task 1.2). For each `M` row, record one negative control (remove that named outcome in a scratch copy, or run on the pre-foundation base) and the assertion that fails. Verify: `scripts/__tests__/specCoverageGuard.test.ts` and the annotated files pass.
- [ ] 1.2 Write the 15 candidate tests or assertions of design "Closeout map" (Task-less coordination, External terminal activity, Duplicate completion, Recording fails, Integration acceptance, Task reopened, Interrupted turn, Existing history, No Prometheus, Scraper unavailable, Repeated scrape, Completion distribution, Missed scrape interval, A killed session's usage, Different percentile methods) through the production composition each row names, against unchanged production code, with `@covers` and `@reads` headers as needed. Verify: each passes and fails under its named negative control; a candidate that fails on the base stops here and is reported to the coordinator as a contract question (design D2), without production edits.

## 2. Closeout

- [ ] 2.1 Citation preflight (zero unresolved), `bun run check --full-properties` on the clean committed head under pinned Bun 1.4.3, `scripts/verify-result.ts`, and `openspec validate process-observability-foundation --strict`. Map every scenario to its literal title in the result.
- [ ] 2.2 Sync and archive this change; it does not wait for `openrouter-provider` or its owner-gated task 5.2 (disjoint capabilities, design D3). `process-observability` stays unticked and unarchived; its retirement is an owner decision after all three partition changes archive.
