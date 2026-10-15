# Design

## Context

See proposal.md for the user-visible failure. The current implementation and its tests establish these seams:

- `zaiQuotaUrl` in `src/server/chat/zaiUsage.ts` concatenates the entire effective `ANTHROPIC_BASE_URL` and the quota path. Existing URL cases cover only origin-shaped bases.
- `fetchZaiUsage` accepts injected fetch, sends the effective token unchanged, times out after 10 seconds, and returns `provider-refused`, `not-provider`, or `unreachable` on failure. It currently classifies every JSON `success: false` as `provider-refused`.
- `ChatSessionManager.claimProfileUsagePull` records successful provider data and suppresses the SDK pull. Only `provider-refused` records a no-data verdict; the other failures permit the SDK pull. Successful provider profiles refresh every 10 minutes while agents are live. A failed refresh keeps the held report.
- The first-pull slot is claimed once per profile per server lifetime. No-data and fallback results do not establish provider refresh timers.

Read-only, unauthenticated probes on 2026-10-15 against the configured GLM gateway returned:

| Path | HTTP | Result |
| --- | --- | --- |
| `/api/anthropic/api/monitor/usage/quota/limit` | 200 | `success: false`, `code: 500`, `msg: "404 NOT_FOUND"` |
| `/api/monitor/usage/quota/limit` | 200 | `success: true`, `data.limits` with two usable rows |

These observations demonstrate URL routing and response shape on this gateway, not the deployed process's authenticated request or every Z.AI gateway's behavior. Account values and credentials are not needed as fixtures.

The current main spec's non-matching-response scenario says every quota error leaves no bar, while its fallback requirement and manager permit host-login data when the quota route is unavailable. The delta explicitly reconciles that scenario: a failure creates no *provider* windows, and the separate fallback rules decide whether host-account windows exist.

## Goals / Non-Goals

**Goals:**
- Make a model API path irrelevant to the origin-relative monitor endpoint.
- Give each recognized failure the existing manager outcome it actually represents.
- Keep tests independent of gateway availability, accounts, and live model turns.

**Non-Goals:**
- New profile fields, endpoint discovery, path-prefix heuristics, or a second HTTP probe.
- New first-pull retries, usage persistence, UI changes, or provider limit/cooldown changes.
- Changing the existing SDK fallback policy for unavailable quota services.

## Decisions

### D1. Resolve one origin-relative quota URL

Build the URL with the standard URL parser, using the absolute quota path and the parsed base URL's origin (for example, `new URL(ZAI_QUOTA_PATH, new URL(baseUrl).origin)`). The resulting request retains scheme, host, and port, but discards the model path, query, fragment, and URL userinfo. Credentials continue to come from the manager's existing effective environment and Authorization header, never from URL userinfo.

Origins and bases ending in `/`, `//`, `/api/anthropic`, `/api/anthropic/`, or `/v4` all resolve to the same monitor path on their own origin. An invalid base must still become a non-throwing failed pull through `fetchZaiUsage`'s existing catch path. Update the URL helper and header comments to state the origin-relative contract.

**Alternatives:** stripping just `/api/anthropic` misses other model API paths; trying both the appended and origin-relative paths adds requests and keeps the known-bad behavior. Neither is needed for the observed endpoint. Gateways exposing quota only beneath a private path prefix are outside this fixed endpoint contract; no configurable override is introduced here.

### D2. Classify explicit signals, not the boolean alone

Keep the public `ZaiUsagePull` union. Keep HTTP status handling first, then classify an HTTP-success JSON failure envelope before attempting the quota parser:

| Signal | Outcome | First-pull manager behavior |
| --- | --- | --- |
| HTTP 401/403 | `provider-refused` | No-data verdict; no SDK pull |
| HTTP 404/405 | `not-provider` | Existing SDK fallback |
| Other non-OK HTTP, transport failure, or timeout | `unreachable` | Existing SDK fallback |
| `success: false` with numeric `code` 401, 403, or 1001 | `provider-refused` | No-data verdict; no SDK pull |
| `success: false` with numeric `code` 404/405, or numeric `code: 500` and trimmed `msg === "404 NOT_FOUND"` | `not-provider` | Existing SDK fallback |
| Any other `success: false` envelope | `unreachable` | Existing SDK fallback |
| Foreign JSON, non-JSON, or missing quota shape | `not-provider` | Existing SDK fallback |

The exact wrapped-404 match is deliberately narrow: do not search arbitrary error text for digits, infer authentication from generic failure, or assume every provider uses the same application error codes. Code 1001 is the authentication fixture already used by this project. Unknown envelopes carry no affirmative credential-refusal signal and therefore retain the existing non-authentication fallback policy.

**Alternative:** preserving the blanket `success: false` rule keeps turning missing routes and upstream service failures into permanent no-data verdicts. Parsing arbitrary error prose would trade that mistake for fragile classification.

### D3. Reuse credentials, parsing, and lifecycle

Leave credential precedence, omitted Authorization for gateway-injected keys, the 10-second timeout, and `parseZaiQuotaLimit` unchanged. Never include the token, raw URL query, response body, or exception text in failure reasons; continue using host-only diagnostics. The manager's outcome branches already implement the desired policy and should require only regression coverage unless integration identifies a direct mismatch.

Extend `zaiUsage.test.ts` with path-prefixed URL cases and the response table. Extend the existing injected-fetch manager harness with a path-prefixed first pull, an origin-relative scheduled refresh, a wrapped missing route allowing the SDK pull, and an explicit auth refusal suppressing it. Assert `source: 'provider'` in the successful snapshot and no SDK usage call, not merely that some data arrived.

## Risks / Trade-offs

- [An undocumented provider changes its envelope] → Recognize only the stated codes and captured wrapper; unknown failures produce no provider windows and follow the existing SDK fallback policy.
- [Fallback shows the host Claude account rather than Z.AI] → This remains the documented behavior only when a provider report is unavailable. A successful origin-relative response takes precedence and suppresses that fallback.
- [An existing process retains its failed first-pull claim] → Deploy with a server restart. Reconnecting or sending another turn alone does not clear the store's claim; do not imply that it does.
- [Custom gateway exposes only a prefixed quota route] → Document the origin-relative contract and avoid silently probing multiple paths or hosts.

## Migration Plan

No schema or persisted-data migration is needed. After implementation, restart the server through the normal release process so the profile usage store starts empty. On the next attach, a GLM profile should request the origin-relative endpoint and receive provider rows before a model turn. Verify that result using metadata and the displayed meters without recording tokens or account usage values in repository artifacts. This proposal authorizes no deployment or restart.

Rollback is a code revert and normal restart; existing chat sessions, profile files, and stored context-token readings need no changes.
