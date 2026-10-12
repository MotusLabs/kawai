# Tasks

## 1. Parser and source value

- [ ] 1.1 Extend `ChatUsageSource` in `src/shared/chat.ts` with `'provider'` (doc comment: pulled from the session provider's own quota endpoint) and confirm `bun run typecheck` passes with no client fallout
- [ ] 1.2 Add `parseZaiQuotaLimit` to `src/server/chat/usageLimits.ts` (pure: shape check per design D1, `zai:`-prefixed keys, type-map labels with raw-type fallback, epoch-ms `nextResetTime` → ISO, unusable rows dropped, status always `allowed`, `source: 'provider'`), with unit tests pinning the captured live shape — both rows, a row missing `percentage` (dropped), non-`success`/non-array bodies (null), and ms-vs-s reset conversion; verify with `bun test src/server/chat/__tests__/usageLimits`

## 2. HTTP pull

- [ ] 2.1 Create `src/server/chat/zaiUsage.ts`: `fetchZaiUsage(baseUrl, token, fetchImpl)` per design D3 — `Authorization` raw token header, ~10 s abort timeout, JSON-only accept, discriminated never-throwing result carrying the parsed report; unit tests with an injected fetch covering success, 401/1001 bodies, HTML body, network throw, and that the token never appears in a returned error message; verify with `bun test src/server/chat/__tests__/zaiUsage`

## 3. Manager wiring

- [ ] 3.1 In `ChatSessionManager.ts`, intercept the `claimUsagePull` slot per design D4: resolve the profile's effective `ANTHROPIC_BASE_URL`/token through the existing profile resolution, run the Z.AI pull in place of the SDK pull when a base URL exists, record provider-routed profiles in an in-memory set, and `recordNoData` on failure — tests with a fake fetch covering: no base URL never probes, shape match records a provider-sourced report, failure records no-data, and a host-login SDK pull is suppressed for a provider-routed profile; verify with `bun test src/server/chat/__tests__/` (manager tests)
- [ ] 3.2 Add the per-profile refresh timer per design D5: 10-minute cadence while at least one non-archived session of a provider-routed profile has a started agent, stopping when none qualify and clearing on shutdown — tests with fake timers covering reset-visible-without-a-turn, pulls stopping when sessions archive/end, and no pulls for profiles without a provider route; verify with `bun test src/server/chat/__tests__/` (manager tests)

## 4. Integration and docs

- [ ] 4.1 Update the CLAUDE.md chat usage bullet: provider quota pull for Z.AI-routed profiles (endpoint path, precedence over the host-login pull, 10-minute refresh while sessions are live, `provider` source)
- [ ] 4.2 Run `bun run lint && bun run typecheck && bun run test` and fix anything the new work broke
