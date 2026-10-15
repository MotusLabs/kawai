# Tasks

## 1. Window period lengths (server)

- [x] 1.1 Add optional `periodMs?: number` to `ChatUsageWindow` in `src/shared/chat.ts` with a doc comment (server-owned, absent when the length is not known); verify `bun run typecheck` passes.
- [x] 1.2 In `src/server/chat/usageLimits.ts`, add the base-kind → period table from design D1 (strip `:scope` and `#n` suffixes before lookup) and set `periodMs` in `parseRateLimitEvent`, `parseUsageReport`, and `parseUsagePull` through one helper; leave `parseZaiQuotaLimit` without it. Update the file header comment. Verify with new cases in `src/server/__tests__/usageLimits.test.ts`: push `five_hour`/`seven_day` → 5 h / 7 d; `/usage` `session`/`weekly_all`/`weekly_scoped:<model>` → 5 h / 7 d / 7 d; pull `seven_day_opus` and `model_scoped:<name>` → 7 d; `overage`, an unknown kind, and every `zai:*` row → no `periodMs`.
- [x] 1.3 Update existing exact-shape assertions in `usageLimits.test.ts` (and any `UsageLimitStore`/snapshot tests that compare whole windows) to include the new field; verify `bun test src/server/__tests__/usageLimits.test.ts` passes.

## 2. Time marker on the meter (client)

- [x] 2.1 Generalize `useTickingClock(active, intervalMs = 1000)` in `src/client/components/chat/chatElapsed.ts`; verify existing callers (`ChatWorkersStrip`, `ChatTaskRow`) and their tests are unchanged in behaviour.
- [x] 2.2 Add pure helpers beside `formatUsageReset` in `UsageBar.tsx`: `usageElapsedShare(window, now)` (design D2: null for missing/unparsable `resetsAt`, missing or non-positive `periodMs`, or reset already passed; otherwise clamped 0–1) and a time-left formatter (`2h 30m`, `3d 4h`, `45m`, `<1m`). Verify with unit tests in `src/client/__tests__/usageBarPace.test.tsx` (new file; `chatComponents.test.tsx` is already 1,400+ lines): 5-hour window resetting in 2 h 30 m → 0.5; reset passed → null; no period → null; remaining longer than the period → 0.
- [x] 2.3 Render the marker (design D3): a `data-testid="chat-usage-time"` tick inside the track at `left: <elapsed>%`, only when the share is non-null; restructure `.chat-usage-meter`/`.chat-usage-fill` CSS so the tick overhangs the 4px track while the fill stays clipped and rounded, and style `.chat-usage-time` in plain CSS with a foreground colour distinct from the status fills. Verify with render tests: marker present at 50% for the halfway case; absent for a provider (`zai:`) window, a null reset, and a passed reset; fill width and marker position give "ahead" (70% used / 40% elapsed) and "behind" (20% / 60%) orderings; the row's label, percent, and reset text are unchanged.
- [x] 2.4 Add hover and accessible text (design D4): `title` on the meter row and `aria-label` on the track when a marker exists (`22% used · 50% of the 5-hour window elapsed · resets in 2h 30m`), `22% used · resets <local time>` otherwise. Verify with render tests asserting both strings.
- [x] 2.5 Drive the bar from `useTickingClock(anyMarkerEligible, 60_000)` (design D5). Verify with fake-timer render tests: advancing one minute moves the marker; advancing past `resetsAt` removes it; no interval runs when no window is marker-eligible.

## 3. Documentation and integration

- [x] 3.1 Update the usage-bar bullet in `CLAUDE.md`/`AGENTS.md` and the `UsageBar.tsx` header comment to describe the elapsed-time marker and server-supplied `periodMs`; verify the text matches the shipped behaviour.
- [x] 3.2 Run `bun run lint && bun run typecheck && bun run test`; verify all pass.
- [x] 3.3 Build (`bun run build`) and check the bar in a browser with the `dev-browser` skill against a chat whose profile has 5-hour and 7-day windows: screenshot shows a tick on each meter at the expected position, bar height is the same as on master, and the hover text reads as specified.
- [x] 3.4 Run `openspec validate usage-bar-time-pace --strict`; verify it passes.

## Workflow follow-up

- Archive the change after review, syncing the `chat-usage-limits` delta into the main spec.
