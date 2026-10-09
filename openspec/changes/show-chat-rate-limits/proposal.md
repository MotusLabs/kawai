# Proposal

## Why

Chat users cannot see how much of their Claude plan allowance is left until a turn fails on a limit. Claude Code already reports plan utilization for the 5-hour and 7-day windows (and per-model weekly windows) during chat turns, and the Agent SDK exposes the same data as a pull request, but Kawai's chat driver drops all of it.

## What Changes

- Capture the plan usage data Claude Code already sends during chat turns (`rate_limit_event`, and `SDKUsageReport` when a turn delivers one) and keep the latest report per Claude profile on the server.
- When nothing has arrived yet, fall back to the SDK's usage control request so a session can show its plan windows without waiting for a turn.
- Show a persistent usage bar under the chat header for sessions whose profile has data: a thin utilization meter per plan window — the 5-hour window, the 7-day window, and any per-model weekly windows — each with percent used and its local reset time. Warning and limited states are visibly distinct from normal.
- Deliver the latest report in the chat snapshot and push updates to attached clients.
- Show nothing when plan limits do not apply (API key, Bedrock, Vertex, and providers that report no usage, such as GLM, MiMo, Kimi, LAN, MiniMax).

Assumptions recorded for review:

- The original request named the `anthropic-ratelimit-input-tokens-remaining`, `-output-tokens-remaining`, and `-input-tokens-reset` headers. Kawai does not see HTTP responses: Claude Code makes the requests and reports only its own summary. Those token headers are sent for API-key traffic, not for the subscription used here, and Claude Code does not forward them. This change shows utilization percentages and reset times, not token counts.
- Probing on 2026-10-07 found no usage or rate-limit headers from the GLM, MiMo, and Kimi endpoints; MiniMax could not be checked without a key. Provider-specific quota APIs are out of scope.
- Limits are per account and provider, so the display is per profile, not per session. Terminal sessions are unchanged.
- "Always-visible" means glanceable chrome rather than a control the user must open: the bar renders whenever the profile has usage data, and is absent entirely when it does not. It never shows a placeholder for an unavailable meter.

## Capabilities

### New Capabilities

- `chat-usage-limits`: capturing provider plan-usage reports from chat sessions and displaying remaining allowance per profile in the chat view.

### Modified Capabilities

None.

## Impact

- Shared: `src/shared/chat.ts` (usage report and window types), `src/shared/types.ts` (snapshot field, `chat-usage` server message).
- Server: a new `src/server/chat/usageLimits.ts` (defensive parsing and the per-profile store), `ChatSessionDriver.ts` (forward `rate_limit_event`, call the usage control request), `ChatSessionManager.ts` and `ChatConnections.ts` (snapshot field and push).
- Client: `src/client/stores/chatStore.ts`, a new `src/client/components/chat/UsageBar.tsx`, and `ChatView.tsx` (render the bar under the header).
- Depends on the SDK's `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, which is explicitly unstable; see design. Overlaps with `add-chat-slash-commands` and the landed `add-chat-activity-indicator` in the snapshot type and chat chrome; follow the activity-indicator's additive `chat-activity` delivery pattern, and whichever of this change and `add-chat-slash-commands` lands second rebases.
