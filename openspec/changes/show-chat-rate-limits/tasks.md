# Tasks

## 1. Shared report shape

- [x] 1.1 Add `ChatUsageWindow` (`key`, `label`, `percentUsed`, `resetsAt`) and `ChatUsageReport` (`status`, `windows`, `receivedAt`) to `src/shared/chat.ts`, and add `usage: ChatUsageReport | null` to `chat-snapshot` plus a `chat-usage` server message in `src/shared/types.ts`; verify with `bun run typecheck` and the existing shared-type tests still passing

## 2. Normalize pushed reports

- [x] 2.1 Implement the `rate_limit_event` parser in `src/server/chat/usageLimits.ts` (prefer `unifiedWindows` for both windows, fall back to `rateLimitType`/`utilization`/`resetsAt`, normalize 0–1 fractions to percent, reject non-finite or out-of-range values, map unknown status to allowed); verify with unit tests using the 2026-10-07 probe payload, a single-window payload, the GLM status-only payload, and malformed values
- [x] 2.2 Implement the `SDKUsageReport` parser in the same module (map `limits[]` rows to windows keyed by `kind`, take `percent` and `resets_at`, label from `scope.model.display_name` or the row's own label, status from `severity`); verify with unit tests covering a full `limits[]` array, a scoped weekly row, and an empty array

## 3. Store and capture

- [x] 3.1 Implement `UsageLimitStore` in `usageLimits.ts` (latest report or "no data" verdict per profile, keep windows when a report has none, never let older data overwrite newer, change listener); verify with unit tests for merge, ordering, verdict recording, and notification
- [x] 3.2 Add `onUsageReport` and `onRateLimit` options to `ChatSessionDriver`, called for `rate_limit_event` and for messages carrying `usage_report`, and wire them in `ChatSessionManager` to the store with the session's profile id; verify with driver and manager tests using a fake query that emits both message kinds

## 4. Pull fallback

- [x] 4.1 Call `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` from the driver after a query spawns, and parse its `rate_limits` into the same report shape (windows from `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`, and `model_scoped[]`); verify with unit tests covering a full pull response, `rate_limits_available: false`, and a thrown call
- [x] 4.2 Record the "no data" verdict when a pull yields no windows, and skip later pulls for that profile while still accepting later pushes; verify with store and driver tests that a second spawn does not re-pull and that a subsequent `rate_limit_event` replaces the verdict

## 5. Deliver to clients

- [x] 5.1 Fill `usage` in `getSnapshot` from the session's profile; verify with manager snapshot tests for a profile with a report, with a verdict, and with neither
- [x] 5.2 Push `chat-usage` from `ChatConnections` once per connection subscribed to any session of the changed profile; verify with connection tests for two sessions of one profile on one connection, and a session of another profile not receiving it

## 6. Usage bar

- [x] 6.1 Store reports per profile in `chatStore` from `chat-snapshot` and `chat-usage`, following the existing activity handling; verify with store tests
- [ ] 6.2 Implement `UsageBar.tsx` (one thin meter per window with label, fill from percent, rounded percent, locale reset time with weekday past a day, warning and limited styles, nothing rendered without window data) and render it under the `ChatView` header; verify with component tests for two windows, a scoped weekly window, one window, none, warning, limited, and reset-time formatting using fake timers

## 7. Planning and docs

- [ ] 7.1 Add `rate_limit_event`, `usage_report`, and the usage control request to the messages `replace-claude-sdk-with-cli` design Decision 4 must surface to the driver; verify with `openspec validate replace-claude-sdk-with-cli`
- [ ] 7.2 Update `CLAUDE.md` "How It Works" to describe per-profile plan usage from pushed reports with the SDK pull as fallback; verify the text matches the implemented behavior

## 8. Integration

- [ ] 8.1 Run `bun run lint && bun run typecheck && bun run test` and verify all pass
- [ ] 8.2 With the `dev-browser` skill against `bun run dev`: send a message in a default-profile chat and see the usage bar appear under the header with 5-hour and 7-day meters and reset times; open a GLM-profile chat and see no usage bar; reload and see the default-profile bar restored; capture screenshots
