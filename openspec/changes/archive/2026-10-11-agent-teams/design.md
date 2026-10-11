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
A delivered message becomes an `SDKUserMessage` with `origin: { kind: 'peer', from: <session> }` and a compact text envelope (sender, group, priority, origin path, tags, thread id, reply instructions, body). The driver emits a new `peer_message` chat event instead of `user_message`, so the transcript row is distinct and replay can reconstruct it from the envelope. The event fires at submission, exactly as `user_message` does today: it is display state, not delivery evidence — only D10's transcript boundary acknowledges receipt. *Alternative:* plain user text — indistinguishable in replay and to the model.

### D4. Idle signal
The manager notifies the dispatcher on every status change. "Idle" = driver status `waiting`, no pending requests, no live background workers, not archived, not killed, project directory exists. The dispatcher re-checks idleness inside the claim transaction.

### D5. Atomic claim in SQLite
`team_messages(id, team_id, to_kind, to_id, from_session, from_group, origin_path, priority, tags, thread_id, in_reply_to, hop, body, state, claimed_by, claimed_at, deliver_at, created_at, delivered_at)`. Claim = `UPDATE ... SET state='claimed', claimed_by=? WHERE id=? AND state='queued'` in a transaction with the idleness re-check; the row count decides the winner. Delivered rows stay for thread lookup.

### D10. Crash-safe delivery: receipt boundary and reconciliation
Submission is not receipt. The row records three durable facts in order. (1) `claimed` — D5's atomic claim. (2) `pushed_at` — written immediately before the `TurnQueue` push: the queue may buffer the input before the SDK consumes it, and the driver's `peer_message` event (like today's `user_message`) is emitted at submission for display only — neither is delivery evidence; `pushed_at` just bounds the recovery window. (3) `delivered_at` — the acknowledgement boundary: a well-formed row in the recipient's Claude Code transcript JSONL containing the message id. That boundary is sound because the transcript is the CLI's own durable conversation record — `--resume` reconstructs the conversation from it, and kawai already tails it live for titles and replays it on attach — so the CLI writes an input row before executing the turn it triggers; work executed ⇒ row present. The contrapositive licenses requeue: no well-formed row carrying the id ⇒ the turn never executed ⇒ requeueing delivers it exactly once. (A kawai-side crash cannot lose a row the CLI already wrote; only machine-level data loss can, which D10 treats as uncertainty below.)

Reconciliation runs live and at startup. Live: the dispatcher watches the recipient's transcript for the id — the same directory/inode re-arming watch the title watcher uses — and sets `delivered_at` on first sighting, so the uncertain window is bounded by the in-flight turn. Startup: rows with `pushed_at` set and no `delivered_at` get the same lookup — found → `delivered`; absent and the transcript ends cleanly → `queued`, where the existing rules apply unchanged, including dead-lettering direct mail whose recipient was killed.

Uncertain receipt is held, never reassigned. When receipt can be neither confirmed nor refuted — the transcript is missing, unreadable, or ends in a malformed (possibly torn) row — the row becomes `state='uncertain'`: out of automatic delivery and reassignment, surfaced in the mailbox view, resolved by the human. The only retry goes to the same recipient and stamps the envelope with a possible-duplicate notice instructing the agent to treat an already-seen message id as a no-op; discard is explicit. *Alternative:* relax the exactly-once guarantee and require idempotent handling in every recipient — rejected: it taxes all agents for a rare crash window, and the transcript watch reuses machinery resume already needs.

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
- [Crash between turn push and the `delivered` write] → D10 reconciliation; startup cost is bounded by the number of pushed claims (zero in normal operation). A torn or unreadable transcript holds the claim as `uncertain` for the human instead of requeueing it.
- [SDK replacement] → D2/D3 depend on SDK features; `replace-claude-sdk-with-cli` must provide in-process tools and peer origin equivalents.

## Migration Plan

Additive: `group_id` column (nullable) on `chat_sessions`, new `team_messages` table. Existing sessions have no group and behave unchanged. Rollback drops the feature; the extra column and table are ignored.

## Open Questions

- Exact text of the mailbox note and envelope — tune during implementation.
