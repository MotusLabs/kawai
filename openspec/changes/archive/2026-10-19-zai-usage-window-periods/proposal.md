# Proposal

## Why

GLM (Z.AI coding-plan) usage meters draw no elapsed-time marker, because provider quota rows are treated as windows of unknown length. They are not: each row of the quota reply states its own window length as `unit` + `number`. A live reply (2026-10-18) shows `TOKENS_LIMIT` with `unit: 3, number: 5` resetting 1.5 h ahead (a 5-hour token window) and `TIME_LIMIT` with `unit: 5, number: 1` resetting 16 days ahead, counting MCP tool calls (`search-prime`, `web-reader`, `zread`) — a monthly tool-call quota. The same reply shows that the shipped labels are wrong: "Weekly tokens" is a 5-hour window, and "Prompts" counts tool calls, not prompts. The `zai-usage-pull` change had only a capture without these fields, so it guessed the labels and gave the rows no length.

## What Changes

- Provider quota rows carry a period length derived from the row's own `unit` and `number` when the unit is one the server knows (observed: `3` = hours, `5` = months); a missing, unknown, or unusable unit or count still yields no period length, never a guess.
- A monthly row's period is the calendar month ending at its reset time (the reset minus one calendar month, clamped to the shorter month's last day), so the marker matches the provider's real window start.
- With a period length, GLM meters get the same elapsed-time marker and used-vs-elapsed hover text as Claude windows — no client change: the usage bar already draws a marker for any window with a period and a future reset.
- Provider row labels name what the row counts and, when known, the window: `TOKENS_LIMIT` → "5-hour tokens", `TIME_LIMIT` → "Monthly tool calls" (built from the row's own length; "Tokens" / "Tool calls" when the length is unknown; the raw kind for an unknown kind, as today).
- Claude plan windows and their fixed period table are unchanged.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `chat-usage-limits`: provider quota rows may now carry a period length taken from the row itself (the "Usage windows carry their known period length" requirement no longer excludes every provider row), and provider rows are labelled by what they count and their window rather than by guessed kind names.

## Impact

- `src/server/chat/zaiQuotaLimit.ts` — `ZaiQuotaLimitRowSlice` gains `unit`/`number`; `parseZaiQuotaLimit` sets `periodMs` and builds labels from them.
- A small pure helper for provider row periods (unit table, calendar-month arithmetic), beside `usageWindowPeriods.ts`.
- Tests: `zaiQuotaLimit.test.ts`, `zaiUsage.test.ts`, `usageBarPace.test.tsx` (labels and the provider-row marker case).
- `AGENTS.md` usage-bar bullet (it states `periodMs` is never set for provider quota rows).
- No wire-format change: `periodMs` is already an optional field of `ChatUsageWindow`; older clients ignore it.
