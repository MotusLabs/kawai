# API differences from Kawai's in-tree driver

For agent-host (SmartFactory) authors moving off a fake driver, and for
Kawai's adapter. Compares the frozen package contract (`src/contract.ts`,
`src/options.ts`, `src/events.ts`) with Kawai's `ChatAgentDriver`
(`src/server/chat/provider/driver.ts` at `9e13f4d8`).

| Topic | Kawai today | Package |
| --- | --- | --- |
| Construction | `createChatDriver({ runtime, options })` with Kawai catalog, team and audit options | `createClaudeDriver(options)` / `createCodexDriver(options)`; inert until `start()`, so callbacks may reference the driver |
| Start | `start(): void`, also an internal respawn | `start(): Promise<void>`; resolves when ready, sends no prompt, shared by concurrent callers; required again after an unexpected exit, which resumes the same conversation |
| Submit | `send(text): void`, `deliver(envelope)`, `sendWorkspaceContext()` | `send(text, { messageUuid?, continuation?, context? }): Promise<TurnHandle>`; peer mail and workspace context are Kawai adapters over `context` and `beforeSubmit` |
| Turn result | `turn_completed` event only | `TurnHandle.result` and `onTurnResult` receive one `TurnResult` value: outcome, final text, model, usage, unique tool-call count, compaction count, typed error |
| Continuation | Claude queues while busy; Codex steers | Explicit `continuation`: `new-turn` (default, refused with `busy` while active), `queue` (Claude), `steer` (Codex, joins the active turn's handle); others refused with `unsupported` |
| Interrupt | `interrupt(): Promise<void>` | `interrupt(): Promise<InterruptReceipt>`; `processExit: false` always |
| Stop | `kill(): void`, `shutdown(): void`; fire-and-forget | `kill()` / `shutdown(): Promise<ProcessExitReceipt>`; one memoized terminal stop that resolves only after every owned process generation actually exited and owned work joined; rejects with category `stop` otherwise. A stopped driver is terminal |
| Unexpected exit | `onProcessEnd()` with no facts | `onProcessEnd({ generation, code, signal, reason })` once per generation; affected turns resolve `process-ended` |
| Runtime identity | `onSdkSessionId`, `onTranscriptPath` | `onCheckpoint({ runtime, runtimeSessionId, transcriptPath? })`, awaited before dependent work is acknowledged; a rejection refuses that work with category `checkpoint` and stops the driver; `resume` option never falls back to a fresh conversation. Claude reports no `transcriptPath` |
| Requests | UI answers later; question auto-answer timers in the driver | `onRequest(request)` fires after registration and the request event, and may answer inline. `unansweredRequests: 'deny'` (default) settles anything left pending; Kawai passes `wait` and keeps its timers in its adapter |
| Events | `ChatEvent` with server-assigned `sequence`, replay `sequence: 0` | `AgentEvent` adds `streamId`; `sequence` is 1-based per stream; a resumed driver gets a new stream, so stored ids never collide. Peer, workspace and auto-answer events are Kawai extensions |
| Usage | `ChatTurnUsage` fields default to 0 | `TokenUsage` fields are `number \| null` (null = not reported); `cacheCreationTokens` keeps Kawai's meaning: cache-write input tokens |
| Quota | `onRateLimit`, `onUsageReport`, `onUsageNoData` | `onQuotaReport(report)` with `source` (`push`, `report`, `host-login-pull`, `host-supplied`) and `accountScope`, independent of turn state; the host-login pull is off unless `quotaSource: 'host-login'`; Codex's one account read can be shared across drivers through the host's own `claimRateLimitsRead`; an unavailable source reports nothing (unknown) |
| Rate-limit waits | `onLimitEvent` failure signals only | `LimitEvent` adds `wait-start`/`wait-end` per turn, each end naming its `waitId`; `resumed` only on that turn's next observed progress (or its success), never because a reset time passed or a quota push arrived |
| Environment | Server environment merged with profile env | `launch.childEnv` is the complete child environment; nothing ambient is read or merged |
| Claude permissions | Manual/auto approval policy | `ClaudePermissions { mode, enabledTools, disallowedTools }`; the restricted profile (bypass mode, read tools, `Bash` denied entirely) is enforced by a fail-closed PreToolUse policy, not by an allow-list |
| Codex permissions | `on-request` approvals, user reviewer, Kawai sandbox roots | `CodexPermissions { approvalPolicy, sandbox, networkAccess, writableRoots, userInput, elicitation }`, reapplied on resume; `sandbox: 'none'` is danger-full-access, never silently workspace-write |
| Codex elicitation | Not routed to the host | `url` and `openai/userVerification` are approvals (allow accepts with no content); `form`, `openai/form` and `openaiForm` are one question answered with typed JSON, validated against the captured schema (or `Decline`/`Cancel`); a schema that can't be validated exactly is declined and reported once as `unsupported` |
| Tools | Kawai team tools (`kawai-team` namespace) | `tools: { namespace, tools: [{ name, description, inputSchema (zod), handler }] }`; default none |
| Logger, wire, audit | Kawai logger, always-on wire log, outbound audit | Required `logger`; optional `wire` and `auditHooks`; absent seams change nothing |
| Errors | Strings | `AgentRuntimeError` with a category (`authentication`, `quota`, `rate-limit`, `transport`, `not-ready`, `busy`, `stopped`, `resume`, `checkpoint`, `stop`, ...) and a serializable `toJSON()` |

Kept on the Claude driver (`ClaudeAgentDriver`): `getTaskOutput(taskId)` and
`stopTask(taskId)`, the SDK's background-task probes. `pendingRequests()` is
on every driver.

Moved into Kawai's adapter, because they are policy or caches over callbacks:
`holdQuestion` and question deadlines, `onApprovalPolicyChanged` (manual/auto
is the adapter's `onRequest` decision), `setProjectPath` and
`setClaudeExecutablePath` (read through the `launch` callback on the next
generation), `getSeenToolCallIds`, `getCommandState`, `getWorkers` and
`getBackgroundTasks` (cached from events and roster callbacks).

Agent-started turns (no `send`, e.g. after a background task ends) arrive as
`turn_started` with a `TurnTrigger` — the same shape as Kawai's
`ChatTurnTrigger` — and settle through `onTurnResult`, since no `TurnHandle`
exists for them.
Their `TurnResult.messageUuid` is null. Interrupt settles the active turn and
any queued submissions at once (one `turn_interrupted`, as Kawai does today),
and on Claude refuses every send not yet acknowledged (`not-ready`,
`interrupted`; receipt `requested`), also while idle;
an unexpected exit ends the active turn with one failed `turn_completed` and
one `error` event on both runtimes (Kawai's Claude driver emits only the error).
