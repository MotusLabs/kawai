# Tasks

## 1. Provider row periods

- [x] 1.1 Add the pure `providerRowPeriodMs(unit, number, resetsAtMs)` to `src/server/chat/usageWindowPeriods.ts` (design D1–D3: unit 3 = hours, 5 = calendar months back from the reset in UTC with the day clamped; anything else, a non-positive or non-integer count, or a missing reset → undefined) and update the file's header comment; verify with new cases in `src/server/__tests__/usageWindowPeriods.test.ts` (create it if absent): 5 hours, 1 month (Nov 3 → Oct 3), 31 Mar → Feb 28 and Feb 29 in a leap year, 2 months, unknown unit, `number` 0 / -1 / 1.5 / string, missing reset.

## 2. Parser and labels

- [x] 2.1 In `src/server/chat/zaiQuotaLimit.ts`, add `unit`/`number` to `ZaiQuotaLimitRowSlice`, set `periodMs` in `parseZaiQuotaLimit` from 1.1, and replace `ZAI_ROW_LABELS` with the composed labels of design D4 ("5-hour tokens", "Monthly tool calls", "Tokens"/"Tool calls" without a length, the raw type for an unknown kind); update the parser's doc comment. Verify by updating `src/server/__tests__/zaiQuotaLimit.test.ts` (the 2026-10-12 capture with `unit`/`number` now expects `periodMs` and the new labels; add cases for a row without `unit`, with an unknown unit, and an unknown kind) and checking `src/server/__tests__/zaiUsage.test.ts` and `chatSessionManager.test.ts` still pass with the label change.
- [x] 2.2 Update `src/client/__tests__/usageBarPace.test.tsx`'s provider fixtures to the new labels, and add a case where a provider row with `periodMs` draws the marker, so the client claim in the proposal (no client change needed) is proven; run `bun test src/client/__tests__/usageBarPace.test.tsx`.

## 3. Documentation

- [x] 3.1 Update the usage-bar bullet in `AGENTS.md`: `periodMs` is set for known Claude kinds from `usageWindowPeriods.ts`, and for provider quota rows from the row's own `unit`/`number` (observed codes only); verify the bullet no longer says "never for provider quota rows".

## 4. Integration check

- [x] 4.1 Run `bun run lint && bun run typecheck` and the touched test files; then confirm against the live quota reply (`curl` the GLM profile's `/api/monitor/usage/quota/limit` through its proxy, fed to `parseZaiQuotaLimit` in a `bun -e` one-off) that the token row yields a 5-hour period and the tool-call row a calendar-month period with the new labels.
