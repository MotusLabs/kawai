# Proposal

## Why

GLM chats can show a context meter but no Z.AI plan limits because the quota URL is appended to the model API path. A gateway response wrapping a missing route is then mistaken for an authentication refusal, suppressing the existing SDK fallback.

## What Changes

- Resolve `/api/monitor/usage/quota/limit` from the effective provider base URL's origin, regardless of its model API path, trailing slashes, query, or fragment. Keep the scheme, host, and port and the existing session credentials.
- Classify a missing quota route separately from an authentication refusal, including the observed HTTP 200 envelope `{ "success": false, "code": 500, "msg": "404 NOT_FOUND" }`. Only explicit authentication failures produce `provider-refused`; other failures retain the existing fallback behavior.
- Add fetch and manager regressions using path-prefixed GLM base URLs, preserving provider-report precedence, refresh behavior, and credential-safe diagnostics.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-usage-limits`: define origin-relative quota lookup and distinguish unavailable routes from authentication refusals, including gateway error envelopes.

## Impact

- `src/server/chat/zaiUsage.ts`: quota URL resolution and error classification; its public outcome union stays unchanged.
- `src/server/__tests__/zaiUsage.test.ts` and provider-usage cases in `chatSessionManager.test.ts`: URL, envelope, fallback, and provider refresh regressions.
- No client, profile configuration, persistence, credential source, or wire-message changes. The manager's existing first-pull and refresh lifecycle is reused.
- No automatic retry policy or custom quota URL setting is added. A running server that already consumed its profile pull claim must restart before the corrected lookup runs.
