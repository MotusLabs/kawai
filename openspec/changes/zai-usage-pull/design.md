# Design

## Context

The usage bar today is fed by three Claude-Code-shaped sources (`usageLimits.ts`): pushed `rate_limit_event` frames, `/usage` report twins on assistant messages, and the SDK usage control pull. The pull follows the host CLI login, so Z.AI-routed GLM profiles — typically API-key sessions through a gateway — get a no-data verdict, and logged-in gateways get the wrong account's plan. The Z.AI coding-plan dashboard is backed by an undocumented quota endpoint on the same base URL the sessions already use. Verified live on 2026-10-12 against the operator's own gateway:

```
GET {base}/api/monitor/usage/quota/limit
Authorization: <token>            (raw works; Bearer also accepted)

200 {"success":true,"data":{"level":"pro","limits":[
      {"type":"TIME_LIMIT","usage":1000,"currentValue":25,"remaining":975,
       "percentage":2,"nextResetTime":1793701399997,"usageDetails":[…]},
      {"type":"TOKENS_LIMIT","percentage":30,"nextResetTime":1791845403778}]}}
401/missing auth: {"code":401|1001,"msg":"…","success":false}
```

Constraints: `usageLimits.ts` is deliberately pure and SDK-free; credentials never live in catalog files (they enter via the server provider env); the store is in-memory, one report per profile, with no-data verdicts and stale-never-downgrades semantics already in place.

## Goals / Non-Goals

**Goals:**
- Real plan windows for Z.AI-routed profiles with no host login, and no wrong-account data for ones with one.
- Keep the bar truthful over time without pushes (resets show up on a cadence).
- Fail silent: any endpoint weirdness degrades to "no bar", never to a session error.

**Non-Goals:**
- Absolute numbers (`usage`/`currentValue`/`remaining`) and per-tool `usageDetails` rows — the bar shows percent + reset only (a later change could feed tooltips).
- Status severity from provider data (payload carries none; no invented thresholds).
- Feeding routing cooldowns (`limitSignals.ts`/`profile_limit_events` stay keyed to real API failures).
- Designing for other gateways (MiMo etc.); a non-Z.AI gateway simply fails the shape check.
- Persistence; provider usage stays ephemeral like every other usage source.

## Decisions

**D1 — Strict shape check.** Accept only HTTP 200 + `success === true` + `data.limits` as an array. Everything else (401, `code:1001`, HTML, refactors upstream) records no data. The endpoint is undocumented, so the parser trusts nothing beyond the captured shape, and extra fields are ignored. Alternative considered: detecting Z.AI by host suffix (`api.z.ai`, `open.bigmodel.cn`) — rejected because gateways on custom domains (the operator's own proxy is one) would never match; a shape probe covers them for free.

**D2 — Row mapping.** Each `limits[]` row becomes one `ChatUsageWindow`: key `zai:<lowercased type>` (`zai:time_limit`, `zai:tokens_limit`) namespaced against Claude kinds; label from a small type map (`TIME_LIMIT` → "Prompts", `TOKENS_LIMIT` → "Weekly tokens") with the raw type as fallback; `percentUsed` from `percentage` (already 0–100); `resetsAt` from `nextResetTime` epoch-ms → ISO. The observed `TIME_LIMIT` row resets on a ~3-week horizon — not a 5-hour window — so labels and docs must not bake in Claude window semantics, and the epoch-ms conversion needs its own helper (the existing `toIsoResetsAt` is epoch-seconds/ISO). Status is always `allowed`.

**D3 — Purity boundaries.** `parseZaiQuotaLimit(payload, receivedAt)` lives in `usageLimits.ts` beside the other parsers (pure, structural, fixture-testable). The HTTP call lives in a new `src/server/chat/zaiUsage.ts`: `fetchZaiUsage(baseUrl, token, fetchImpl)` with a ~10 s `AbortController` timeout, returning a discriminated `{ ok, report? } | { ok: false }` — never throws.

**D4 — Trigger and precedence (manager).** On the driver's existing `claimUsagePull` slot (agent start, profile holds no data), the manager — which already resolves profile launch env via `resolveClaudeProfile` — checks the profile's effective `ANTHROPIC_BASE_URL`: none → never contacted (claim flows to the SDK pull as today). With a base URL, the manager runs the Z.AI pull instead of letting the SDK pull fire (consuming the claim): shape match → `usageLimits.record(profile, report)` and the profile is remembered provider-routed (in-memory set, store lifetime); failure → `recordNoData` exactly as today. A host login therefore can never overwrite provider data with wrong-account windows. Cost: one probe per profile per store lifetime until it matches.

**D5 — Refresh cadence.** One timer per provider-routed profile, every 10 minutes while at least one non-archived session of the profile has a started agent, re-evaluated on the session lifecycle events the manager already handles (spawn, archive, kill, process end). 10 minutes keeps a 5-hour-scale window visibly fresh at ~6 requests/hour/profile — well under anything a monitor path would mind; alternatives rejected: pull-on-reset-time scheduling (extra per-window timers for no real gain) and reusing accountNotices' 30-minute tick (a 5-hour window can sit half-wasted before a reset shows). No qualifying session → timer stops; server shutdown clears it.

**D6 — Source value.** `ChatUsageSource` gains `'provider'`. The client never switches on `source` today (the bar renders any windows), so this is additive; old snapshot consumers already treat it as optional.

**D7 — Credentials.** The token is the same effective `ANTHROPIC_AUTH_TOKEN` the profile's SDK spawn receives (provider env layered under profile env via the existing resolution); gateways that inject their own upstream key work with no local token at all. It is sent only to the profile's own base URL — the host every turn already sends it to — so no new trust boundary is created, and it never reaches logs or error messages (errors carry status and host only).

## Risks / Trade-offs

- [Undocumented endpoint changes shape or auth] → strict check degrades to no bar; sessions unaffected; captured-shape fixtures pin today's contract and make regressions obvious.
- [A gateway dislikes monitor-path traffic] → 10-minute cadence and silent failures; a failed refresh keeps held data (store semantics), and unconfirmed profiles probe once ever.
- [Provider reports a window whose semantics we mislabel] → labels come from the payload's own type, never from assumed plan windows; worst case is a cosmetic label.
- [Probe races a push] → store already never displaces a held report and clears no-data on the next record.

## Migration Plan

Purely additive, no persisted data, no wire-shape change: deploy, and Z.AI-routed profiles gain a bar on their next agent start; revert to roll back. Nothing to backfill.

## Open Questions

None blocking. Absolute-usage display and severity mapping are deferred follow-ups, per Non-Goals.
