# Design

## Context

See proposal.md (Why) for motivation. The current state that shapes this design:

- **The chat stack assumes Claude.** `ChatSessionDriver` (1561 lines) is a concrete class whose options and helpers use Claude Agent SDK types (`Options`, `Query`, `CanUseTool`, `SDKUserMessage`). The following types reach the SDK through it:
  - `TurnQueue` is an `AsyncIterable<SDKUserMessage>`.
  - `team/sessionMailbox.ts` types `getDriver` as `ChatSessionDriver`.
  - `ClaudeProfiles.ts` types launch config as `Pick<Options, …>`.
- **Several modules are already SDK-free** and match message shapes structurally: `chatActivity.ts` (a reducer over `ChatActivityInput`), `limitSignals.ts` (a neutral `ChatLimitSignal`), `usageLimits.ts`, `contextUsage.ts`, `chatCommands.ts`, and every client contract in `src/shared/chat.ts`.
- **The team tools only touch the SDK at the edge.** `mailboxHandlers(mailbox, sessionId)`, `taskHandlers`, and `strategyHandlers` are plain session-bound functions with Zod schemas. Only `createMailboxServer` wraps them in `createSdkMcpServer`.
- **Receipts and transcripts follow the Claude layout.**
  - `team/receipt.ts` acknowledges mail from a Claude transcript row (`type: "user"`).
  - `transcriptReplay.ts` and `transcriptTitleWatcher.ts` read `~/.claude/projects/**/<sdkSessionId>.jsonl`.
  - `logPoller` keeps chat transcripts out of terminal discovery by session id (`getChatSdkSessionIds`).
- **The profile catalog has no provider.** `profileCatalog.ts` validates entries against `ENTRY_FIELDS = {label, model, executable, env}` and an `ANTHROPIC_*`-only env allowlist.
- **Codex facts below come from `codex app-server generate-ts --experimental`, run against the installed codex-cli 0.162.1.**
  - Transport is JSON-RPC over stdio: `initialize` with `capabilities.experimentalApi`, then `thread/start`/`thread/resume`, `turn/start`/`turn/interrupt`.
  - Notifications include `item/started|completed`, `item/agentMessage/delta`, `item/reasoning/*`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, and `turn/completed` with `TurnError.codexErrorInfo`.
  - Server requests are `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, and `item/tool/call` for dynamic tools.
  - `ThreadStartParams` takes `cwd`, `approvalPolicy`, `sandbox`, `config`, `developerInstructions`, `ephemeral`, and (experimental) `dynamicTools`. `ThreadResumeParams` has no `dynamicTools`, and the binary stores them per thread (`thread_dynamic_tools`).
  - `Thread.path` is the rollout file. Its user turns are `response_item` rows with `payload.type: "message"` and `role: "user"`.

## Goals / Non-Goals

**Goals:**

- Claude chats behave exactly as before: the driver extraction is a refactor with its existing tests unchanged.
- The Codex driver feeds the same `ChatEvent`, activity, status, pending-request, context-usage, usage, limit, and wire-log outputs, so the client, mailbox, staffing, and routing never branch on provider.
- Codex protocol drift surfaces at upgrade time (generated types, version gate, registration refusal), not as silent runtime misbehavior.

**Non-Goals:**

- Slash commands for Codex beyond the client-side `/clear`, `/reset`, `/new`. Codex skills are not mapped into the `/` menu in this change. The command state reports `unavailable` for Codex chats.
- Background-task rosters, workers, and the subagent strip for Codex. Codex `collabAgentToolCall` and `subAgentActivity` items render as ordinary tool calls.
- A per-profile Codex executable. `KAWAI_CODEX_PATH` / `PATH` is server-wide.

## Decisions

### D1: A provider-neutral driver contract, Claude first

Introduce `ChatAgentDriver` in `src/server/chat/provider/driver.ts`. It is the subset of today's public driver surface the manager and mailbox use:

- `start`, `send`, `deliver(envelope)`, `interrupt`, `kill`, `shutdown`
- `resolveApproval`, `answerQuestion`, `onApprovalPolicyChanged`, `setProjectPath`
- `getPendingRequests`, `getSeenToolCallIds`, `getWorkers`, `getBackgroundTasks`, `getCommandState`, `isDead`

Output callbacks are a provider-neutral `ChatDriverCallbacks` type. These are today's `on*` options minus the SDK-typed ones. `ChatSessionDriver` implements the contract unchanged. `TurnQueue` becomes generic over its item type. `sessionMailbox` and `ChatSessionManager` hold `ChatAgentDriver`.

`createChatDriver(record, deps)` picks the class from the chat's stored provider. The Claude-only extras (`setClaudeExecutablePath`, the experimental usage pull, `getContextUsage`) move behind optional capability methods the manager probes for.

*Alternative:* a parallel Codex code path in the manager with `if provider` branches. Rejected because every later feature would grow two branches and the mailbox would still be Claude-typed.

The refactor lands first as its own commit with no behavior change, which keeps the review honest.

### D2: One app-server child per chat, own JSON-RPC client

`appServerClient.ts` spawns `<codex> app-server`, frames newline-delimited JSON-RPC, and routes the three message kinds:

- responses go to pending request ids
- notifications go to a handler
- server requests go to a handler whose result becomes the reply

Every inbound and outbound line goes through the existing `ChatWireRecorder`, so the Debug panel works for Codex chats unchanged. Initialization sends `clientInfo` and `capabilities: { experimentalApi: true }`. A child exit ends the driver like a Claude process end: `onProcessEnd`, notices cleared, and pending requests cancelled. The next send respawns and resumes.

*Alternatives:*
- `@openai/codex-sdk`: rejected because it wraps `codex exec` and has no approval or question requests.
- The installed app-server daemon: rejected because it is shared, has its own lifecycle and identity, and would make kill and archive cross sessions.
- One shared app-server for all Codex chats: rejected for crash isolation and lifecycle parity with Claude.

### D3: Generated protocol types, pinned baseline, explicit gate

Vendor the output of `codex app-server generate-ts --experimental` for the baseline version under `src/server/chat/codex/protocol/`, with a `VERSION` file. Only the types the driver uses are imported.

`codexExecutable.ts` mirrors `claudeExecutable.ts`:
- resolves `KAWAI_CODEX_PATH` or `codex` on `PATH`, as a single path with no shell
- checks `--version` against the baseline within a bounded time
- caches success per path and mtime, and discards failures

Bumping the baseline means regenerating the types and rerunning the driver's fake-server tests plus the live smoke script (D12).

### D4: Profiles carry the provider; Codex launch config

`profileCatalog.ts` gains `provider` with a per-provider field set:

- `claude`: today's fields.
- `codex`: `label`, `model`, `codexHome`, `network` (boolean, default true).
- `codexHome` follows the `executable` rule: user-level catalog only.
- A profile id whose entries disagree on provider across levels rejects the lower-level file.

Resolution returns a discriminated union: `{ provider: 'claude', …SDK launch config }` or `{ provider: 'codex', model?, codexHome, network }`.

`ClaudeProfiles.ts` keeps the Claude arm. `codexProfiles.ts` builds the Codex spawn:
- `env`: the server's environment with `CODEX_HOME` set
- `-c` overrides for the sandbox (D5)

`chat_sessions` gains `provider TEXT NOT NULL DEFAULT 'claude'`, written at creation, and `transcript_path TEXT`. The manager refuses to start a chat whose stored provider differs from its profile's current provider.

The Codex thread id lives in `sdk_session_id`, so resume, the discovery exclusion, and existing queries keep working. Renaming the column is not worth a migration.

### D5: One sandbox, policy decides who answers

Each Codex chat's threads start with these settings:
- `sandbox: "workspace-write"`
- `approvalPolicy: "on-request"`
- `config` holding:
  - `sandbox_workspace_write.writable_roots = [<git common dir>]`, from `git rev-parse --git-common-dir` resolved absolute; omitted outside a repository
  - `sandbox_workspace_write.network_access = <profile.network>`

Server requests map as follows:

| Codex request | Manual | Auto |
|---|---|---|
| `commandExecution` / `fileChange` / `permissions` approval | `approval_request` card; allow → `accept` (permissions: grant the requested profile for the turn), deny → `decline` | reply `accept` immediately; a `request_resolved` event records `decidedBy: policy` as for Claude auto |
| `requestUserInput` | `question_request` card; answers keyed by question id | same: never auto-answered |
| `item/tool/call` for namespace `kawai-team` | D6 | D6 |

Every Codex request reads `getApprovalPolicy()` when it arrives, so a live toggle applies without touching the thread. `acceptForSession` is never sent: one card covers one request, matching Claude's per-use cards.

*Alternative:* map manual to `untrusted` and auto to `never`. Rejected because `untrusted` floods a member with cards, and `never` turns escalations into silent failures rather than accepted work. It would also make the toggle need a thread setting change.

### D6: Team tools as dynamic tools

`team/mailboxTools.ts` gains `teamToolTable(mailbox, sessionId, services)`, returning `{ name, description, schema, handler }[]`. `createMailboxServer` (Claude) and `codexTools.ts` (Codex) both consume it, so the tool list cannot drift between providers.

`codexTools.ts` builds one `{ type: "namespace", name: "kawai-team", tools: [...] }` `DynamicToolSpec`. Each tool's `inputSchema` comes from Zod 4's `z.toJSONSchema`.

Dispatch on `item/tool/call`:
1. Refuse unless `threadId` is the session's own thread and `namespace` is `kawai-team`.
2. Validate `arguments` with the Zod schema.
3. Run the handler.
4. Return `{ success, contentItems: [{ type: "inputText", text }] }` with the same JSON text the MCP server returns today.

Dynamic tool calls bypass Codex approval, which is the spike's first question (D12). The driver never raises a Kawai card for them under either policy.

If `thread/start` rejects `dynamicTools`, the start fails with a chat error, so no Codex member runs without its team tools. On resume the stored per-thread tools are used. If the spike finds they are not restored, or the handler set changed, the driver starts a fresh thread only as an explicit, journaled fallback. That fallback is an open question below, not a silent default.

*Alternative:* a loopback streamable-HTTP MCP endpoint with a per-session bearer token. Rejected in exploration: identity would rest on a secret in the child's environment, a new listener would exist, and Codex would continue silently if the server failed to start. Its advantage, reuse by non-Codex agents, is not needed yet.

### D7: Event mapping is a pure module

`codexEvents.ts` turns notifications into `ChatEvent`s and `ChatActivityInput`s with no I/O, so it can be table-tested:

| Codex | Kawai |
|---|---|
| `turn/started` | `turn_started` (Kawai turn id), activity `turn_started` |
| `item/agentMessage/delta` | `assistant_delta` |
| `item/completed` `agentMessage` | `assistant_text` |
| `item/reasoning/*` | activity `block_start: thinking` |
| `item/started` `commandExecution` / `fileChange` / `mcpToolCall` / `dynamicToolCall` / `webSearch` | `tool_call` (`Bash`-like name and input for commands, `Edit`-like for file changes, `mcp__<server>__<tool>` / `mcp__kawai-team__<tool>` for tool calls) and activity `tool_call` |
| `item/completed` for those items | `tool_result` (output, exit code, or error) and activity `tool_result` |
| `thread/tokenUsage/updated` | `onContextUsage` |
| `turn/completed` | `turn_completed`; plus `error` when `turn.error` is set; activity `turn_end` |
| `account/rateLimits/updated` | D9 |

`userMessage` items echo what Kawai sent and are suppressed, like Claude's user echoes. Tool names reuse the transcript's existing renderers, so no client change is needed for Codex tool rows.

### D8: Receipts and replay from the rollout file

`thread/start` and `thread/resume` return `Thread.path`. The driver stores it through a new `onTranscriptPath` callback into `transcript_path`, as soon as it is known.

`team/receipt.ts` keeps `transcriptReceipt`/`reconcileMailbox` and takes the row parser per provider: `receiptMessageId` (Claude) or `codexReceiptMessageId`. The Codex parser accepts only `type: "response_item"`, `payload.type: "message"`, `role: "user"` rows whose `input_text` parses as an envelope, so AGENTS.md user rows never match. `transcriptFor` returns `transcript_path` for Codex chats.

Replay works as follows:
- With a live driver, use `thread/read` with turns for the history.
- For archived chats, or when no agent is running, `codexRollout.ts` parses the rollout file (`response_item` messages, function calls and outputs, `event_msg` items) into the same replay entries `transcriptReplay.ts` produces.

The title watcher ignores Codex chats, because their names come from Kawai.

`logPoller`'s chat exclusion set already holds every chat's `sdk_session_id`. The Codex log matcher has to honor `excludeSessionIds` against `session_meta.id`, so a Codex chat rollout in `~/.codex/sessions` never becomes a terminal session.

### D9: Usage and limits keyed by Codex home

`codexUsage.ts` normalizes `RateLimitSnapshot` into the existing `ChatUsageReport`:
- one window per `primary`/`secondary`
- `usedPercent`, `resetsAt`
- a label from `windowDurationMins` (300 → 5-hour, 10080 → weekly) plus `limitName`
- status `limited` when `rateLimitReachedType` is set

Reports are cached per Codex home, the resolved absolute `codexHome`, so every Codex profile and session on that home shares them. The fill-in uses `account/rateLimits/read` on the session's app-server when its home holds nothing.

`codexLimits.ts` maps limit signals:
- A `turn/completed` whose `codexErrorInfo` is `usageLimitExceeded`, `rateLimitExceeded`, `sessionBudgetExceeded`, or `serverOverloaded` becomes a final `ChatLimitSignal`.
- An item `error` notification marked as retrying becomes a non-final signal.
- The reset is the earliest `resetsAt` of a window that the latest snapshot marks as reached, else none (the 1 h default then applies).

The manager writes the event for every Codex profile whose resolved `codexHome` equals the session's. Cooldown, park, release, forward, and the urgent-mail refusal then work unchanged.

### D10: Role context and effort

`developerInstructions` on `thread/start` and `thread/resume` carries the same text `getSystemPromptAppend` builds today: role body, mailbox, task, and strategy notes. It is re-read at each agent start, so role edits reach later starts, as for Claude. The group's `effort` maps to `turn/start.effort`. Kawai's `max` maps to Codex's highest supported level, and an unsupported value is dropped with the existing group warning.

### D11: Delivery and status

`deliver(envelope)` sends the envelope text as a `turn/start` input with `clientUserMessageId` set to the message id, for debugging only: receipt still comes from the rollout file.

Status is derived from driver state, as for Claude:
- `working` while a turn runs
- `permission` while a card is pending
- `waiting` otherwise

Urgent interrupts call `turn/interrupt` and wait for `turn/completed` with status interrupted before delivering.

### D12: Spike first, then a live smoke script

The first task is a scripted spike against the baseline, recorded in this design before driver work continues. It answers the open questions below. A `scripts/codex-smoke.ts`, run by hand and not in CI, exercises start, a dynamic tool call, an approval round-trip, interrupt, and resume against a real Codex. It is rerun on every baseline bump. CI uses a fake app-server that replays recorded JSON-RPC transcripts.

## Risks / Trade-offs

- **[Risk] `dynamicTools` is experimental and could change or disappear in a Codex release.** → Mitigation:
  - The baseline is pinned with generated types.
  - Registration refusal fails the start loudly.
  - The smoke script runs on each bump.
  - The HTTP-MCP design is documented as the fallback (D6 alternative).
- **[Risk] `.git` may be read-only under `workspace-write` even with a writable-root override, so commits from linked worktrees escalate.** → Mitigation: the spike checks this. If it holds, members get one card or auto-accept per commit, and a `git` exec-policy rule in the Codex home can allow it. Both are acceptable; neither changes the specs' sandbox requirement.
- **[Trade-off] Manual Codex chats ask less than manual Claude chats,** because commands inside the sandbox run without a card. → Mitigation: this is accepted (exploration decision) and documented in CLAUDE.md, so the policy label is not misread.
- **[Risk] With network on, auto-accept means a Codex member can reach the network and escalate freely.** → Mitigation: this matches Claude auto today. Profiles can set `network: false`.
- **[Risk] Rollout rows may be written later than the turn push (buffering), briefly making receipts look absent.** → Mitigation: reconciliation already runs only at turn end, failure, archive, kill, and startup, and Codex flushes by turn end. The spike confirms this; otherwise reconciliation waits for `turn/completed`.
- **[Risk] The driver extraction touches the most central server file.** → Mitigation: it is a separate first commit with no behavior change, and the existing driver and manager tests must pass unmodified.
- **[Trade-off] Codex profiles that share a home cool down together, but Claude profiles that share a login still do not.** → Mitigation: this is accepted as a known gap (proposal non-goals). The fan-out code is a pattern a later change can reuse.

## Migration Plan

- The `provider` and `transcript_path` columns are additive (default `claude` / null). Existing chats restore as Claude.
- No Codex profile ships in `config/profiles.default.json`. Operators add one to `~/.kawai/profiles.json`, so nothing changes for installations without Codex.
- Rollback: removing Codex profiles makes Codex chats refuse to start with a provider-mismatch or unknown-profile error. Their history stays readable from `transcript_path`. Reverting the code leaves the extra columns unused.

## Open Questions

Each answer changes only a mapping detail inside a decision above, not the specs or the task list. The spike (D12) answers them all.

- Does Codex ever route `item/tool/call` through its own approval or elicitation, and what timeout applies to dynamic calls?
- Are dynamic tools restored on `thread/resume`, and how does resume behave when the tool set changed (D6 fallback)?
- Is `.git` writable under `workspace-write` with the common dir as a writable root?
- Do localhost-binding tests pass inside the sandbox with network on?
- How do `dynamicToolCall` and `commandExecution` items appear in `thread/read` and in rollout rows for replay?
- Which retry signal marks a non-final limit event: a `willRetry`-style flag on the `error` notification, or only HTTP status?
