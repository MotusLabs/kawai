# Proposal

## Why

The usage bar shows how much of each plan window is used and when it resets, but not how far through the window the user is. "40% used" is fine with 4 hours of a 5-hour window gone and alarming with 30 minutes gone, and today the user has to do that arithmetic from the reset clock time. Showing elapsed time on the same meter lets them see at a glance whether usage is ahead of or behind an even pace — without the bar growing.

## What Changes

- Each usage window the server reports gains an optional period length (`periodMs`), set from the window's known kind: 5 hours for the session/5-hour window, 7 days for the 7-day and per-model weekly windows. Kinds whose length is not known (overage, provider quota rows, any new server kind) carry none. Additive: older clients ignore it.
- Each meter in the usage bar draws a thin **time marker** on its existing track at the share of the window already elapsed (`1 − time left ÷ period`; e.g. a 5-hour window resetting in 2 h 30 m puts the marker at 50%). The fill is the usage; the marker is the time — fill past the marker means usage is ahead of pace, fill short of it means behind. No new row, column, or text is added to the bar; its height and layout stay the same.
- The meter's hover text and accessible label state the comparison in words, e.g. "22% used · 50% of window elapsed · resets in 2h 30m".
- The marker moves on its own: the bar re-renders on a slow client clock (once a minute) so the marker advances between usage updates.
- No marker is drawn when the window has no reset time, no known period, or a reset time that has already passed (the held usage is stale until the next update).

Non-goals: no projection or "you will run out at …" estimate, no new colours or status for being ahead of pace (the warning/limited tints stay the server's verdict), no change to how usage is captured, pulled, or delivered, and no guessed period for provider quota rows whose semantics are undocumented.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `chat-usage-limits`: usage windows carry a known period length, and the usage bar shows elapsed window time as a marker on each meter's track alongside the percent used.

## Impact

- `src/shared/chat.ts`: optional `periodMs` on `ChatUsageWindow`.
- `src/server/chat/usageLimits.ts`: a kind → period table applied by every parser (push, `/usage` report, SDK pull); `parseZaiQuotaLimit` sets none.
- `src/client/components/chat/UsageBar.tsx` and the `.chat-usage-*` styles in the client stylesheet: marker element, elapsed computation, hover/aria text, minute clock (reusing or generalizing `useTickingClock` in `chatElapsed.ts`).
- Tests: parser tests in the usage-limits suite; `UsageBar` rendering tests in `src/client/__tests__/chatComponents.test.tsx`.
- No wire message, persistence, or server lifecycle change; the field rides the existing `chat-snapshot.usage` and `chat-usage` payloads.
