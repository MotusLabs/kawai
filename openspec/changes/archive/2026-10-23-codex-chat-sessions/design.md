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
- **The profile catalog has no runtime.** `profileCatalog.ts` validates entries against `ENTRY_FIELDS = {label, model, executable, env}` and an `ANTHROPIC_*`-only env allowlist.
- **Codex facts below come from `codex app-server generate-ts --experimental`, run against the installed codex-cli 0.163.0 (the §1 spike baseline; see Spike results).**
  - Transport is JSON-RPC over stdio: `initialize` with `capabilities.experimentalApi`, then `thread/start`/`thread/resume`, `turn/start`/`turn/interrupt`.
  - Notifications include `item/started|completed`, `item/agentMessage/delta`, `item/reasoning/*`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, and `turn/completed` with `TurnError.codexErrorInfo`.
  - Server requests are `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, and `item/tool/call` for dynamic tools.
  - `ThreadStartParams` takes `cwd`, `approvalPolicy`, `sandbox`, `config`, `developerInstructions`, `ephemeral`, and (experimental) `dynamicTools`. `ThreadResumeParams` has no `dynamicTools`, and the binary stores them per thread (`thread_dynamic_tools`).
  - `Thread.path` is the rollout file. Its user turns are `response_item` rows with `payload.type: "message"` and `role: "user"`.

## Goals / Non-Goals

**Goals:**

- Claude chats behave exactly as before: the driver extraction is a refactor with its existing tests unchanged.
- The Codex driver feeds the same `ChatEvent`, activity, status, pending-request, context-usage, usage, limit, and wire-log outputs, so the client, mailbox, staffing, and routing never branch on runtime.
- Codex protocol drift surfaces at upgrade time (generated types, version gate, registration refusal), not as silent runtime misbehavior.

**Non-Goals:**

- Slash commands for Codex beyond the client-side `/clear`, `/reset`, `/new`. Codex skills are not mapped into the `/` menu in this change. The command state reports `unavailable` for Codex chats.
- Background-task rosters, workers, and the subagent strip for Codex. Codex `collabAgentToolCall` and `subAgentActivity` items render as ordinary tool calls.
- A per-profile Codex executable. `KAWAI_CODEX_PATH` / `PATH` is server-wide.

## Decisions

### D1: A runtime-neutral driver contract, Claude first

Introduce `ChatAgentDriver` in `src/server/chat/provider/driver.ts`. It is the subset of today's public driver surface the manager and mailbox use:

- `start`, `send`, `deliver(envelope)`, `interrupt`, `kill`, `shutdown`
- `resolveApproval`, `answerQuestion`, `onApprovalPolicyChanged`, `setProjectPath`
- `getPendingRequests`, `getSeenToolCallIds`, `getWorkers`, `getBackgroundTasks`, `getCommandState`, `isDead`
- `getBackgroundTaskRecords`, `getTaskOutput`, `stopTask`: the background-task methods the manager calls for the task roster, `chat-task-output`, and `chat-task-stop`. Codex has no background tasks (Non-Goals), so its driver returns no records, `null` output, and `false` from stop.

Output callbacks are a runtime-neutral `ChatDriverCallbacks` type. These are today's `on*` options minus the SDK-typed ones. `ChatSessionDriver` implements the contract unchanged. `TurnQueue` becomes generic over its item type. `sessionMailbox` and `ChatSessionManager` hold `ChatAgentDriver`.

`createChatDriver(record.runtime, deps)` picks the class from the chat's stored runtime. The Claude-only extras (`setClaudeExecutablePath`, the experimental usage pull, `getContextUsage`) move behind optional capability methods the manager probes for.

*Alternative:* a parallel Codex code path in the manager with `if runtime` branches. Rejected because every later feature would grow two branches and the mailbox would still be Claude-typed.

The refactor lands first as its own commit with no behavior change, which keeps the review honest.

### D2: One app-server child per chat, own JSON-RPC client

`appServerClient.ts` spawns `<codex> app-server`, frames newline-delimited JSON-RPC, and routes the three message kinds:

- responses go to pending request ids
- notifications go to a handler
- server requests go to a handler whose result becomes the reply

Every inbound and outbound line goes through the existing `ChatWireRecorder`, so the Debug panel captures Codex chats. Its frame labels know only Claude's frame types, though: a JSON-RPC line has no `type` and would read as `json` under a "Claude" direction. `chatWireFrames.ts` therefore labels JSON-RPC frames by `method`, or `response #<id>` / `error #<id>`, and its direction labels name the chat's runtime. Initialization sends `clientInfo` and `capabilities: { experimentalApi: true }`. A child exit ends the driver like a Claude process end: `onProcessEnd`, notices cleared, and pending requests cancelled. The next send respawns and resumes.

*Alternatives:*
- `@openai/codex-sdk`: rejected because it wraps `codex exec` and has no approval or question requests.
- The installed app-server daemon: rejected because it is shared, has its own lifecycle and identity, and would make kill and archive cross sessions.
- One shared app-server for all Codex chats: rejected for crash isolation and lifecycle parity with Claude.

### D3: Generated protocol types, pinned baseline, explicit gate

Vendor the output of `codex app-server generate-ts --experimental` for the baseline version under `src/server/chat/codex/protocol/`, with a `VERSION` file. Only the types the driver uses are imported.

`codexExecutable.ts` mirrors `claudeExecutable.ts`:
- resolves `KAWAI_CODEX_PATH` or `codex` on `PATH`, as a single path with no shell
- checks `--version` is at or above the baseline (0.163.0) within a bounded time
- caches success per path and mtime, and discards failures

Bumping the baseline means regenerating the types and rerunning the driver's fake-server tests plus the live smoke script (D12).

### D4: Profiles carry the runtime; Codex launch config

`profileCatalog.ts` gains `runtime` with a per-runtime field set:

- `claude`: today's fields.
- `codex`: `label`, `model`, `codexHome`, `network` (boolean, default true).
- `codexHome` and `network` follow the `executable` rule: trusted tier only — the shipped default and the user level. A project file setting either is rejected with that file's error.
- A profile id whose entries disagree on runtime across levels rejects the lower-level file.

**Runtime origin tiers.** Each profile key K has an origin: the farthest tier at which K is defined as a Claude profile. Tiers: the shipped files and the implicit `default` are 0, the user level is 1, and project `.kawai` directories are 2 and up, nearer directories higher; a directory's `providers.json` and `profiles.json` share its tier. Files merge farthest first, each directory's `providers.json` before its `profiles.json`, so the first Claude placement of K is its origin. No key with a farther Claude origin ever resolves to Codex.

- `CatalogMerger` keeps the origins apart from the holders and seeds `default` at tier 0 (`(implicit)`) — the whole `default` rule, with no special case.
- Every Claude placement — a new `providers.json` model key, a `profiles.json` one-model or reserved `profile:<id>` provider, a re-home, the implicit default — records an origin only when K has none. Re-homes and overlays move the holder, never the origin; holders carry no tier.
- A Codex entry for K at tier t:
  - K is a Codex profile: the entry overlays its label and model.
  - K has no origin: a new Codex profile.
  - The origin is tier t: only the same directory's `providers.json` can hold K, since nearer files are not merged yet. The key is released, the Codex entry's own `profiles.json` reporting the error (naming the provider and its `providers.json`, "providers.json cannot hold a Codex profile"), and K becomes Codex, holding no origin from then on.
  - The origin is farther: the entry is ignored with `<file>: profile "K" is a Codex entry here but a Claude entry in <origin file>`, and K stays Claude wherever its holder put it.
- Consequently "Codex profile under a providers.json provider" holds within one level (the user level, or one project directory); a farther `providers.json` with a nearer Codex entry is a cross-level disagreement. A user-level Codex `default` is refused, since the implicit `default` is tier 0.

Resolution returns a discriminated union: `{ runtime: 'claude', …SDK launch config }` or `{ runtime: 'codex', model?, codexHome, network }`.

A Codex profile's provider (the account/endpoint sense) derives from its resolved home: `providerOf` is `codex-home-<first 12 hex of sha256(resolved absolute home)>`, labelled `Codex` — never the path in an id or a label; several homes are told apart by their profiles' labels. A Codex profile declared as a model of a providers.json provider is refused with that file's error.

`ClaudeProfiles.ts` keeps the Claude arm. `codexProfiles.ts` builds the Codex spawn:
- `env`: the server's environment with `CODEX_HOME` set
- `-c` overrides for the sandbox (D5)

Kawai never writes into a Codex home: not `config.toml`, not exec-policy rules, not auth. It passes only `CODEX_HOME`, `-c` overrides, and thread parameters. Anything else in a home, such as a rule that allows `git`, is operator action.

`chat_sessions` gains three columns:
- `runtime TEXT NOT NULL DEFAULT 'claude'`, written at creation;
- `codex_home TEXT`, the resolved absolute Codex home, written at creation for Codex chats and null for Claude chats;
- `transcript_path TEXT`.

The manager refuses to start a chat whose stored runtime differs from its profile's current runtime. It also refuses a Codex chat whose stored home differs from the home its profile resolves to now, because the chat's thread and login live in the stored home. Resuming against another home would look for the thread where it does not exist. The refusal names neither path, since homes never reach browsers. Usage and limits (D9) key a session by its stored home, so a profile edit never moves an existing chat's usage or cooldown to another home.

The Codex thread id lives in `sdk_session_id`, so resume, the discovery exclusion, and existing queries keep working. Renaming the column is not worth a migration.

### D5: One sandbox, policy decides who answers

Each Codex chat's threads start and resume with these settings:
- `sandbox: "workspace-write"`
- `approvalPolicy: "on-request"`
- `approvalsReviewer: "user"` under both Kawai policies, overriding the Codex home's reviewer setting so every escalation reaches Kawai; Kawai decides whether to show a card or accept it
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

`team/mailboxTools.ts` gains `teamToolTable(mailbox, sessionId, services)`, returning `{ name, description, schema, handler }[]`. `createMailboxServer` (Claude) and `codexTools.ts` (Codex) both consume it, so the tool list cannot drift between runtimes. The table is built from the tools on master at implementation time. That includes the result, handoff, and findings tools that `task-results-handoffs` (PR #136) adds to `taskTools`/`mailboxTools`; a branch cut before that merge expects a textual conflict in `mailboxTools.ts` and rebuilds on top of it.

`codexTools.ts` builds one `{ type: "namespace", name: "kawai-team", tools: [...] }` `DynamicToolSpec`. Each tool's `inputSchema` comes from Zod 4's `z.toJSONSchema`.

Dispatch on `item/tool/call`:
1. Refuse unless `threadId` is the session's own thread and `namespace` is `kawai-team`.
2. Validate `arguments` with the Zod schema.
3. Run the handler.
4. Return `{ success, contentItems: [{ type: "inputText", text }] }` with the same JSON text the MCP server returns today.

Dynamic tool calls bypass Codex approval, which the spike confirmed (Spike results). The driver never raises a Kawai card for them under either policy.

If `thread/start` rejects `dynamicTools`, the start fails with a chat error, so no Codex member runs without its team tools — a malformed spec fails `thread/start` with a JSON-RPC error and creates no thread (spike-verified). On resume the stored per-thread tools are used; the spike confirmed they are restored, so no fresh-thread fallback exists.

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

A `fileChange` item can change several files. Its `Edit`-like input carries every changed path: `file_path` holds the first, and `paths` holds all of them. `ProgressDigest` (`team/routing/handoff.ts`) reads only `file_path`, `notebook_path`, and `path` today, so it also learns to read a `paths` string array. A forwarded handoff then lists every file a Codex member changed.

### D8: Receipts and replay from the rollout file

`thread/start` and `thread/resume` return `Thread.path`. The driver stores it through a new `onTranscriptPath` callback into `transcript_path`, as soon as it is known.

`team/receipt.ts` keeps `transcriptReceipt`/`reconcileMailbox` and takes the row parser per runtime: `receiptMessageId` (Claude) or `codexReceiptMessageId`. The Codex parser accepts only `type: "response_item"`, `payload.type: "message"`, `role: "user"` rows whose `text` or `input_text` block parses as an envelope, so AGENTS.md user rows never match. The Codex reader reads the stored `transcript_path` plus every `rollout-*-<threadId>.jsonl` under `<codex_home>/sessions` — a walk at most four levels deep that never follows a symlink, and a directory it cannot list holds the receipt uncertain. A found envelope wins: a delivered row is a receipt even when another line of its own file fails to parse (a torn tail); only an absent envelope beside a torn tail stays uncertain. Absence requeues only under the proven-reader rule — some file of the thread holds a recognized envelope row and the stored path is named for the thread — every other absence holds as uncertain. `transcriptFor` returns `transcript_path` for Codex chats.

Replay has one source (decision 2, M3): `codexRollout.ts` parses the rollout file (`response_item` messages, function calls and outputs, `event_msg` items) into the same replay entries `transcriptReplay.ts` produces, for a live driver and for archived or unloaded chats alike. `thread/read` is not used: its `includeTurns` flag is deprecated on the 0.163.0 baseline, and a second source would add a second row-id scheme. A paginated `thread/turns/list` + `thread/items/list` fallback for an unreadable rollout stays a recorded follow-up that needs 8.2 evidence.

Replay emits the turn boundaries a live turn emits, `turn_completed` included. History readers such as `team-workspace`'s finished-turn bucket, which reads persisted turn-end events, therefore count Codex turns. Row ids are `codex-r<line index>-<first 8 hex characters of sha256(line)>`: stable while the file only grows, and a row rewritten under the same path gets a new id, so a client's older `beforeId` reads stale and it re-attaches plain. An unreadable rollout memoizes the "history unavailable" notice marked retryable: the manager retries it on a later load, and only while no live turn could be duplicated by the re-read — the memo is taken before a driver start, so live events must stay ahead of the replay.

Live receipts keep working. Today the title watcher's tail also confirms mail: `watchReceipt` calls `watchSessionTitle`, whose line handler runs `receiptMessageId`. For a Codex chat that tail follows `transcript_path` and parses rows with `codexReceiptMessageId`. Only the title half is skipped, because Codex chat names come from Kawai. Pushed mail therefore settles as soon as its rollout row lands, not only at turn end or startup reconciliation.

`logPoller`'s chat exclusion set already holds every chat's `sdk_session_id`. The Codex log matcher has to honor `excludeSessionIds` against `session_meta.id`, so a Codex chat rollout in `~/.codex/sessions` never becomes a terminal session.

### D9: Usage and limits keyed by Codex home

`codexUsage.ts` normalizes `RateLimitSnapshot` into the existing `ChatUsageReport`:
- one window per `primary`/`secondary`
- `usedPercent`, `resetsAt`
- a label from `windowDurationMins` (300 → 5-hour, 10080 → weekly) plus `limitName`
- status `limited` when `rateLimitReachedType` is set

Reports are cached per Codex home, keyed by the home's provider id (`codex-home-<12 hex>`, D4 — the hash of the resolved absolute home), so every Codex profile and session on that home shares them. The fill-in uses `account/rateLimits/read` on the session's app-server when its home holds nothing.

`codexLimits.ts` maps limit signals:
- A `turn/completed` whose `codexErrorInfo` is `usageLimitExceeded`, `rateLimitExceeded`, `sessionBudgetExceeded`, or `serverOverloaded` becomes a final `ChatLimitSignal`.
- An item `error` notification marked as retrying becomes a non-final signal.
- The reset is the latest known `resetsAt` among all applicable exhausted windows in the latest snapshot, else none (the 1 h default then applies). For example, if the five-hour and weekly windows are both exhausted and reset in 1 hour and 2 days respectively, the cooldown and any parked-work resume use the 2-day reset. A non-exhausted window does not extend the cooldown.

Each signal also carries its scope:
- `usageLimitExceeded`, `rateLimitExceeded`, and `serverOverloaded` belong to the login or plan, so they are login-scoped.
- `sessionBudgetExceeded` names a session or thread budget, not the shared plan, so it is session-scoped. Cooling the home for it would park unrelated members. The spike could not observe it without spending the account budget, so it stays session-scoped (Spike results).

The manager records a login-scoped event once, with the stored home's provider id (`codex-home-<12 hex>`) as its provider; the shared cooldown (providers-and-workers D8, `cooldownFor`) then cools every profile on that home. No per-profile fan-out rows are written. A session-scoped event is recorded for the session's own profile only, with no provider. Cooldown, park, release, forward, and the urgent-mail refusal then work unchanged.

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

The first task is a scripted spike against the baseline, recorded in this design before driver work continues; its answers are the Spike results section at the end of this document. A `scripts/codex-smoke.ts`, run by hand and not in CI, exercises start, a dynamic tool call, an approval round-trip, a question round-trip, interrupt, and resume against a real Codex. It is rerun on every baseline bump. CI uses a fake app-server that replays recorded JSON-RPC transcripts.

### D13: Outbound-audit parity (R5)

`CodexSessionDriver` feeds every `commandExecution` item, and every external MCP tool call, to `OutboundObserver` (`src/server/outbound/observer.ts`) — the same classifier, withholding, and redaction pipeline a Claude agent's Bash and MCP calls pass through. Observation only: the feed never blocks, delays, or denies a tool call. `kawai-team` dynamic-tool calls are exempt (the mailbox already records them), and a `fileChange` is not a send. `developerInstructions` carries `SECURITY_NOTE_BODY`, rendered from the same destinations configuration the Claude prompt uses.

## Risks / Trade-offs

- **[Risk] `dynamicTools` is experimental and could change or disappear in a Codex release.** → Mitigation:
  - The baseline is pinned with generated types.
  - Registration refusal fails the start loudly.
  - The smoke script runs on each bump.
  - The HTTP-MCP design is documented as the fallback (D6 alternative).
- **[Risk] `.git` may be read-only under `workspace-write` even with a writable-root override, so commits from linked worktrees escalate.** → Mitigation: the spike checks this. If it holds, members get one card or auto-accept per commit, and an operator can add a `git` exec-policy rule to the Codex home (Kawai never writes one, D4). Both are acceptable; neither changes the specs' sandbox requirement.
- **[Trade-off] Manual Codex chats ask less than manual Claude chats,** because commands inside the sandbox run without a card. → Mitigation: this is accepted (exploration decision) and documented in CLAUDE.md, so the policy label is not misread.
- **[Risk] With network on, auto-accept means a Codex member can reach the network and escalate freely.** → Mitigation: this matches Claude auto today. Profiles can set `network: false`.
- **[Risk] Rollout rows may be written later than the turn push (buffering), briefly making receipts look absent.** → Mitigation: reconciliation already runs only at turn end, failure, archive, kill, and startup, and Codex flushes by turn end. The spike confirms this; otherwise reconciliation waits for `turn/completed`.
- **[Risk] The driver extraction touches the most central server file.** → Mitigation: it is a separate first commit with no behavior change, and the existing driver and manager tests must pass unmodified.
- **[Trade-off] Codex profiles that share a home cool down together, but Claude profiles that share a login still do not.** → Mitigation: this is accepted as a known gap (proposal non-goals). Codex shares one cooldown per home through the home's provider id (D9); no fan-out code exists.
- **[Risk] A secret Codex answer is masked on the question card only.** → History replay renders the `request_user_input` output as a tool row (`codexRollout.ts`), and the raw protocol capture (`appServerClient.ts`; the chat Debug panel and the chat-wire log) records the response frame — both show what crossed the wire unmasked. Accepted as a known limitation; follow-up: redact secret answers in replayed tool rows and the wire capture. The spec claims masking of the question card only.

## Migration Plan

- The `runtime`, `codex_home`, and `transcript_path` columns are additive (default `claude` / null / null). Existing chats restore as Claude.
- No Codex profile ships in `config/profiles.default.json`. Operators add one to `~/.kawai/profiles.json`, so nothing changes for installations without Codex.
- Rollback: removing Codex profiles makes Codex chats refuse to start with a runtime-mismatch or unknown-profile error. Their history stays readable from `transcript_path`. Reverting the code leaves the extra columns unused.

## Spike results

The §1 spike ran `scripts/codex-smoke.ts` against the installed codex-cli
**0.163.0** (the design was drafted against 0.162.1; the baseline moves to
0.163.0, whose generated types are vendored). The scrubbed transcript is
`src/server/chat/codex/__fixtures__/smoke-transcript.jsonl`. Answers to the
former Open Questions:

- **Baseline (R6).** 0.162.1 → 0.163.0: generate-ts ran on 0.163.0, the
  version gate checks against it, and the smoke transcript records it.
- **Dynamic-call approval and timeout.** `item/tool/call` arrives as a plain
  server request; no approval or elicitation precedes it (verified on a fresh
  thread and a resumed thread). Kawai answers it synchronously over the
  request; no timeout surfaced at millisecond latency, so handlers must
  answer promptly. A malformed registration (bad tool name) fails
  `thread/start` itself with a JSON-RPC error (`-32600`, "dynamic tool name
  must match ^[a-zA-Z0-9_-]+$"), before any turn and with no thread created —
  the refused-registration path is a start failure, exactly as D6 requires.
- **Tool restoration on resume.** Restored: a fresh process's
  `thread/resume` served a `kawai-team` call on the resumed thread with no
  re-registration (`thread/resume` takes no `dynamicTools`; the stored set is
  used). D6's fresh-thread fallback is dead code on this baseline and stays
  unwired.
- **`.git` writability.** Unanswerable on the smoke host: the sandbox never
  initializes there (next bullet), so every command escalates with reason
  "sandbox failed to initialize" — the observed git commit escalation was
  that, not a writable-root verdict. The D5 config is still sent (the
  `thread/start` response echoes `writableRoots`), and on hosts where the
  sandbox does initialize the design's mitigations stand (accept the
  escalation, or an operator's `git` exec-policy rule; Kawai never writes
  one). The escalation reason is distinguishable text the driver can surface.
- **Sandbox initialization on this host.** bwrap cannot create user
  namespaces (`unshare --user` → EPERM), so every sandboxed command fails
  init and escalates; accepted commands run unsandboxed. Under manual that is
  a card per command; under auto Kawai accepts and the command runs without
  the workspace-write guard. Recorded here because this host is where the
  manual team run (8.2) happens.
- **localhost binding.** The bind itself succeeded (`bind 200` on
  `127.0.0.1`) — but outside the sandbox, for the same reason as above.
  Inside a working sandbox: untested on this host; network-on profiles should
  not rely on it until verified on such a host.
- **Replay shapes.** Replay reads the rollout alone (M3); the `thread/read`
  shapes below are recorded only for the possible paginated fallback.
  `thread/read` (`includeTurns: true`) returns
  `thread.turns[]` whose items are typed: `userMessage`, `agentMessage` (with
  `phase`, `questions`, `delivery`), `commandExecution` (command, cwd,
  aggregatedOutput, exitCode, status), `dynamicToolCall` (namespace, tool,
  arguments, contentItems, success), `reasoning`, `sleep`. The rollout file's
  rows: `session_meta` (id), `response_item:message` (user and assistant —
  the receipt rows), `response_item:custom_tool_call`(+`_output`) for dynamic
  tool calls, `response_item:function_call`(+`_output`) for commands,
  `response_item:reasoning`, and `event_msg` rows (`task_started`,
  `item_completed`, `token_count`, `task_complete`, `turn_aborted` for an
  interrupt), plus `turn_context`, `token_usage_record`, `world_state`.
- **The retry signal.** The `error` notification
  (`ErrorNotification{error, willRetry, threadId, turnId}`) carries
  `willRetry: boolean` — a non-final attempt. A turn's final failure is
  `turn/completed` with `turn.status: "failed"` and `turn.error`. No live
  error occurred in the spike; the shape is definitive from the pinned
  version's generated types.
- **`sessionBudgetExceeded` scope.** Not observed — establishing it would
  spend the account budget, which the spike rules forbid. It stays
  session-scoped (D9), cooling only the session's own profile.
- **Questions arrive async (D5/D7 mapping note).** On 0.163.0 the model asks
  through an `agentMessage` item carrying `questions: [{ title, options }]`
  and `delivery: "async"`, then sleeps (`sleep` items) waiting for the
  answer; the answer is `turn/start` input added to the active turn, after
  which the same turn completes. The blocking
  `item/tool/requestUserInput` server request exists in the protocol but
  never fired. The driver therefore maps BOTH: an async question item raises
  the question card and `answerQuestion` delivers the answers as
  `turn/start` input; a blocking `requestUserInput` is answered over its
  request as designed. Questions are never auto-answered under either
  policy.
- **Envelope shapes.** `turn/started` and `turn/completed` carry
  `{ threadId, turn: { id, status, error, items } }`.
  `account/rateLimits/read` returns
  `{ ordinaryUsageAllowed, rateLimits: RateLimitSnapshot }`; window
  `resetsAt` is epoch **seconds** (D9 converts to ISO). The `thread/start`
  response echoes the applied sandbox, and a resumed thread's
  `writableRoots` accumulate the previous ones (merge, not replace) — kawai
  always sends its own set and ignores the accumulation.
