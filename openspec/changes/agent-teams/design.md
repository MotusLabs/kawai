# Design

## Context

Chat sessions are driven by `ChatSessionDriver`: user turns are pushed into a `TurnQueue` that the SDK `query()` consumes in streaming-input mode. A push during an in-flight turn is read by Claude Code at the next tool boundary — it steers the running turn — so "normal messages never interrupt" cannot be implemented by pushing early. `interrupt()` already aborts the turn and cancels pending approval/question cards. Session status (`working` / `permission` / `waiting`) is derived in the driver; `chat-session-spawned-subagents` extends `working` to cover running background workers. Profile catalogs already use the `.kawai/` layered-file pattern (`profileCatalog.ts`).

The SDK offers `createSdkMcpServer` + `tool()` for in-process tools, and `SDKUserMessage` carries `origin: { kind: 'peer', from }` and `priority`.

## Goals / Non-Goals

**Goals:** a kawai-owned queue with deterministic delivery; no change to human-driven chat behavior; restart-safe mail; one-agent-per-message guarantees.

**Non-Goals:** cross-host teams (the `Remote` section's sessions are not members); agent-to-agent streaming or shared memory; group editing UI; per-message acknowledgements beyond delivery.

## Decisions

### D1. Kawai owns the queue; the SDK queue only receives turns at idle
The dispatcher holds every message in SQLite and pushes to the driver's `TurnQueue` only when the recipient is idle (or, for urgent direct mail, immediately after `interrupt()`). *Alternative:* push with `priority: 'later'` and let Claude Code order it — rejected: behavior of mid-turn priorities is CLI-internal, not durable across restarts, and invisible to the mailbox view.

### D2. Mailbox tools via an in-process SDK MCP server per driver
Each driver registers a `kawai-team` MCP server with `send_message`, `reply`, `schedule_message`, `list_groups`. The handler closes over the session id, so sender identity is never taken from tool input. Tools are auto-allowed (they only enqueue). *Alternative:* an HTTP MCP endpoint with per-session tokens — more moving parts, and token leakage would allow forging senders.

### D3. Delivery as a peer-origin user turn
A delivered message becomes an `SDKUserMessage` with `origin: { kind: 'peer', from: <session> }` and a compact text envelope (sender, group, priority, origin path, tags, thread id, reply instructions, body). The driver emits a new `peer_message` chat event instead of `user_message`, so the transcript row is distinct and replay can reconstruct it from the envelope. *Alternative:* plain user text — indistinguishable in replay and to the model.

### D4. Idle signal
The manager notifies the dispatcher on every status change. "Idle" = driver status `waiting`, no pending requests, no live background workers, not archived, not killed, project directory exists. The dispatcher re-checks idleness inside the claim transaction.

### D5. Atomic claim in SQLite
`team_messages(id, team_id, to_kind, to_id, from_session, from_group, origin_path, priority, tags, thread_id, in_reply_to, hop, body, state, claimed_by, claimed_at, deliver_at, created_at, delivered_at)`. Claim = `UPDATE ... SET state='claimed', claimed_by=? WHERE id=? AND state='queued'` in a transaction with the idleness re-check; the row count decides the winner. Delivered rows stay for thread lookup.

### D10. Crash-safe delivery reconciliation
Claiming is atomic, but pushing a peer turn into Claude Code is not: a crash between the push and the `delivered` write leaves a claimed row whose turn may already have run tools, so a startup sweep that blindly requeues claimed rows can deliver one message twice. Instead, every peer envelope (D3) and its `peer_message` event carry the message id — the stable delivery identity — and startup reconciles: for each `claimed` row, the recipient's persisted record (the session's kawai chat events, then its Claude Code transcript JSONL — the same sources replay and resume already use) is searched for that id. Found → delivery happened; the row is completed as `delivered` (reconciled) and never sent again. Not found → the push never reached the agent (the pushed input died with the process); the row returns to `queued`, where the existing rules apply unchanged, including dead-lettering direct mail whose recipient was killed. *Alternative:* relax the exactly-once guarantee and require idempotent retry handling in every recipient — rejected: it taxes all agents for a rare crash window, and the transcript lookup reuses machinery resume already needs.

### D6. Team identity
`team_id` = realpath of `git rev-parse --git-common-dir` for the session's project directory, cached per directory; non-repo directories use their own realpath. Group files resolve from the main working tree (parent of the common dir) layered over `~/.kawai/groups/`.

### D7. Prompt injection point
At spawn the driver uses `systemPrompt: { type: 'preset', preset: 'claude_code', append }` with the mailbox note and role body. Prompts are read at spawn only (no live reload) because the system prompt cannot change for a running process.

### D8. Urgent interrupt sequencing
Urgent direct mail: if a request is pending, mark the message `awaiting-request` and re-evaluate on `request_resolved`; otherwise claim, call `interrupt()`, wait for `turn_interrupted`, then push. Messages already queued for that agent are unaffected because they live in kawai, not the `TurnQueue` (`interrupt()` clears only the SDK-side queue).

### D9. Restore-on-reply
For an archived sender the dispatcher calls the existing restore path, then delivers once the restored agent is idle. Killed senders are detected by the session row's absence; their group comes from the message's stored `from_group`.

## Risks / Trade-offs

- [An agent ignores or misreads the envelope] → envelope is short and fixed-format; the mailbox note documents it.
- [Restore-on-reply silently revives sessions and spends tokens] → the restored session's transcript shows the reply as the reason; hop limits bound loops.
- [Agents abuse urgent] → urgent group mail never interrupts; urgent direct interrupts are visible in the transcript with the sender.
- [Group prompt files are agent-writable] → prompts apply only at spawn; this is documented. Group files cannot carry executables or credentials.
- [Crash between turn push and the `delivered` write] → D10 reconciliation; startup cost is bounded by the number of claimed rows (zero in normal operation).
- [SDK replacement] → D2/D3 depend on SDK features; `replace-claude-sdk-with-cli` must provide in-process tools and peer origin equivalents.

## Migration Plan

Additive: `group_id` column (nullable) on `chat_sessions`, new `team_messages` table. Existing sessions have no group and behave unchanged. Rollback drops the feature; the extra column and table are ignored.

## Open Questions

- Exact text of the mailbox note and envelope — tune during implementation.
