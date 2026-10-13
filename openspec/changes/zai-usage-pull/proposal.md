# Proposal

## Why

Gateway-routed GLM profiles never show a real usage bar: the SDK usage pull follows the host claude.ai login rather than the session's provider, so API-key profiles get a permanent no-data verdict and logged-in gateways get the wrong account's plan. Z.AI's coding-plan dashboard is backed by a quota endpoint on the same base URL the sessions already use, keyed by the same credentials, so kawai can pull true plan usage for these profiles directly.

## What Changes

- The server pulls `{profile base URL}/api/monitor/usage/quota/limit` with the credentials sessions of that profile already use, when a session's agent starts and the profile holds no usage data — the same gap-fill slot the SDK usage pull occupies today.
- A response matching the Z.AI quota shape (a `limits` array of rows with percent used and an epoch-millisecond reset time) is parsed into plan windows keyed and labelled distinctly from Claude plan windows (labels derive from the payload's own row `type`; the endpoint is undocumented, so its `unit`/`number` semantics are not assumed). Such a profile is remembered as provider-routed and the host-login SDK pull is suppressed for it, ending the wrong-account readings.
- A provider-sourced report is marked with a new usage source value so its origin stays distinguishable from pushed, reported, and SDK-pulled reports.
- While a provider-routed profile has a live chat session, the server re-pulls on a fixed cadence so window resets show up without a turn; these profiles get no push updates.
- No client changes: the usage bar already renders whatever windows a report carries.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `chat-usage-limits`: provider-routed profiles gain a direct provider usage pull (no agent login required), take precedence over the host-login SDK pull, keep fresh on a cadence while sessions are live, and are marked with their own source; profiles whose provider does not serve the quota endpoint behave exactly as today.

## Impact

- `src/server/chat/usageLimits.ts` — new pure parser for the quota response.
- New `src/server/chat/zaiUsage.ts` — the HTTP pull and shape check (HTTP stays out of the pure parser, per module convention).
- `src/server/chat/ChatSessionManager.ts` — pull trigger on agent start, provider-routed detection, per-profile refresh timer.
- `src/shared/chat.ts` — one added value on `ChatUsageSource`.
- Tests under `src/server/chat/__tests__/`. No client code, no database, no wire-protocol shape changes; the snapshot's `usage` payload keeps its shape.
