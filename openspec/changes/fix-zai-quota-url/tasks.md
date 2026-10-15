# Tasks

## 1. Quota URL and failure classification

- [x] 1.1 Resolve the quota URL from the provider origin in `src/server/chat/zaiUsage.ts` (design D1) and update its comments. Extend `zaiUsage.test.ts` with origin-only bases, trailing slashes, `/api/anthropic`, `/api/anthropic/`, `/v4`, a non-default port, and query/fragment cases. Verify the exact request URL, unchanged Authorization behavior, one request per pull, and that a malformed base yields a failed pull without throwing.
- [x] 1.2 Replace blanket `success: false` classification with design D2's outcome table. Add fetch tests for the observed HTTP 200 wrapped 404, numeric body codes 404/405, authentication codes 401/403/1001, a service-error envelope, an unknown code, and a missing code. Verify existing HTTP, foreign-body, and network cases still pass, and diagnostics reveal neither credentials nor raw response/exception text.

## 2. Provider usage integration

- [x] 2.1 Extend the provider harness cases in `src/server/__tests__/chatSessionManager.test.ts` to use an effective base ending in `/api/anthropic`. Verify an agent start without a prompt obtains a provider report at the origin-relative URL, the snapshot carries `source: 'provider'` and window rows, the SDK pull never runs, and scheduled refresh uses the same URL and updates the held report.
- [x] 2.2 Add manager regressions for a wrapped missing route and explicit authentication refusal: the former permits the SDK usage pull, the latter records no data and skips it. Verify unknown/service envelopes also permit fallback; a failed scheduled provider refresh keeps the prior provider report without invoking the SDK. Retain no-base-URL, archive, shutdown, and stale-report coverage, and make no new first-pull retry policy.

## 3. Integration checks

- [ ] 3.1 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate fix-zai-quota-url --strict`. Verify all pass and the implementation changes are limited to the quota helper and its affected tests/comments; inspect the diff for credentials or captured account values before committing.

## Workflow follow-up

- Apply and review this change before syncing its delta and archiving it; do not mark implementation tasks complete while only planning artifacts exist.
- After a normal release with a server restart, verify a GLM chat receives Z.AI plan-window meters on attach. A reconnect alone cannot recover a first-pull claim already consumed by the previous implementation. Keep release/restart actions separate from this planning request.
