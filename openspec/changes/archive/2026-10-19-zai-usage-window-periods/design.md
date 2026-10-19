# Design

## Context

See proposal.md (Why). Today `parseZaiQuotaLimit` (`src/server/chat/usageLimits.ts`) maps each row to `{ key, label, percentUsed, resetsAt }`, and labels come from a fixed kind map (`time_limit` → "Prompts", `tokens_limit` → "Weekly tokens"). Claude windows get `periodMs` through `planWindow` → `windowPeriodMs` (`usageWindowPeriods.ts`), which works from the window kind alone and never sees provider rows. The client (`UsageBar.tsx`) already draws the marker and the used-vs-elapsed text for any window with `periodMs` and a future `resetsAt`, so this change is server-only apart from tests.

The endpoint is undocumented. Live reply, 2026-10-18 (via the GLM profile's proxy):

```
TIME_LIMIT   unit 5, number 1, usage 1000, currentValue 25, usageDetails [search-prime, web-reader, zread], resets 2026-11-03 10:23Z
TOKENS_LIMIT unit 3, number 5, percentage 31, resets 2026-10-18 18:31Z (1.5 h ahead)
```

## Goals / Non-Goals

**Goals:** a row's period length comes from the row itself; labels say what the row counts and its window.

**Non-goals:** guessing unit codes nobody has observed; showing absolute counts (`usage`/`currentValue`/`remaining`) or `usageDetails`; any client or wire change; touching the Claude period table.

## Decisions

**D1 — Unit table holds only observed codes.** `3` → hours and `5` → months: two codes, each confirmed by a reset time that only fits that length (1.5 h ahead for 5 hours; 16 days ahead for 1 month, where hours, days, or weeks at `number: 1` could not hold). Other codes such as minutes, days, or weeks probably exist, but their numbers are guesses, and a wrong unit draws a wrong marker. A row whose `unit` is missing, not in the table, or whose `number` is not a positive integer gets no `periodMs` and a label without a length. *Alternative:* fill in a plausible 1…6 sequence. Rejected: the endpoint is undocumented, and "no marker beats a wrong one" is the shipped principle.

**D2 — Fixed units become milliseconds; months use calendar arithmetic from the reset.** Hours: `number × 3,600,000`. Months: the start is the reset moved back `number` calendar months in UTC, with the day clamped to the target month's last day (31 Mar → 28/29 Feb, same time of day), and `periodMs = reset − start`. That puts the marker at the provider's real window start rather than at a 30-day approximation, which would be off by up to a day. It uses UTC rather than the provider's zone (Asia/Shanghai), and the two give the same day count because neither zone observes DST. *Alternative:* a fixed 30-day month. Rejected: it is visibly wrong on the 31-day and February months.

**D3 — Period helper lives beside the Claude table, as a separate function.** A pure `providerRowPeriodMs(unit, number, resetsAtMs)` sits in `usageWindowPeriods.ts`, next to `windowPeriodMs` (the file stays small). Claude kinds keep their own table, and provider rows never enter `windowPeriodMs`, so a provider key cannot pick up a Claude period by accident.

**D4 — Labels are composed from a counted-thing word and the length.** Kind words: `tokens_limit` → "tokens", `time_limit` → "tool calls" (from `usageDetails`: search, web reader, zread). Length prefix: hours → "`<n>`-hour", months → "Monthly" for 1 and "`<n>`-month" otherwise. That gives "5-hour tokens" and "Monthly tool calls". Without a usable length the label is the capitalised word alone ("Tokens"); an unknown kind keeps the raw `type`, as today. Keys (`zai:<kind>`, `#n` for repeats) are unchanged, so held reports merge as before.

## Risks / Trade-offs

- [Z.AI changes a unit's meaning] → only two codes are trusted, and each is cross-checked by the live reset horizon. A mismatch draws a misplaced marker until the table is fixed. Nothing else depends on it.
- [`TIME_LIMIT` counts more than tool calls on other plan levels] → the label follows the observed `pro` reply. An unknown kind still falls back to its raw type.
- [A reply between pulls carries a different length] → each pull's row brings its own length, and the store already replaces windows wholesale by key.

## Migration Plan

None: `periodMs` is already optional on the wire, the usage store is in memory, and the next 10-minute pull carries the new fields. Rollback is a revert.
