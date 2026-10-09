# Design

## Context

See proposal.md for motivation and specs/chat-session-workers/spec.md for the required behavior.

- `ChatSessionDriver.handleSdkMessage` already receives every `task_started`, `task_progress`, `task_updated`, `task_notification`, and `background_tasks_changed` frame. They fall into the unknown-frame `default: return`, so nothing reaches the client.
- A worker's own tool_use/tool_result blocks arrive as ordinary `assistant` / `user` frames whose `parent_tool_use_id` is the spawning `Agent` call's id. `handleAssistant` / `handleUser` emit them as top-level `tool_call` / `tool_result` events today — that is the flattening. `forwardSubagentText` is left at its default (`false`), so worker text and thinking do not arrive at all.
- Worker bodies already live on disk at `~/.claude/projects/<dir>/<sdkSessionId>/subagents/agent-<agentId>.jsonl`, with `agent-<agentId>.meta.json` beside it (`agentType`, `description`, `toolUseId`, `spawnDepth`, `requestShape`). `logDiscovery` already skips a `subagents` directory, so these files are not double-counted as sessions.
- The `Agent` tool call is already a sequenced `tool_call` ChatEvent whose `toolCallId` is the same id `task_started`/`task_notification` carry as `tool_use_id`. That id is the natural join key.
- Status is computed in `ChatSessionDriver.refreshStatus` from `activeTurnId` and pending requests only. `turn_completed` clears `activeTurnId`, which is why a session with live workers reports `waiting`.
- `chat-snapshot` already carries `pendingRequests` and `activity` beside the sequenced event log. `ChatConnections` already fans out a non-sequenced `chat-activity` message. The worker roster is the same shape of thing, but a set rather than a single value.
- `resolveDataDir()` is the directory beside `agentboard.db`; `chat-wire/` is already a per-session sidecar there.

## Goals / Non-Goals

**Goals:**
- One join key (`toolCallId`) ties the transcript row, the live roster, the on-disk body, and the persisted outcome together.
- Worker state that is live stays off the sequenced event stream; only the settled outcome is durable.
- The mapping from task frames to roster state is a pure reducer beside `chatActivity.ts`, so the direct-CLI transport can reuse it.

**Non-Goals:**
- Stopping individual workers, or changing what an interrupt does to background tasks.
- Attributing approval/question cards to the worker that raised them.
- Streaming a worker's body into the chat event stream at all.
- A foreground/background distinction on rows, or usage counters.

## Decisions

### D1. The `Agent` `tool_call` event is the row anchor

No new "worker created" event. The existing `tool_call` with `tool === 'Agent' || tool === 'Task'` is the row: its `toolCallId` is the worker id, and its `input` already carries `subagent_type` and `description`, which `toolCallLabel` already extracts. The client renders that event as a worker row and falls back to a plain collapsed tool card when no roster entry exists for it (spawn never got off the ground, or history predates this change).

*Alternative:* a distinct `worker_spawned` event after the tool call. Rejected: two entries per spawn, and the second has to restate identity the first already carries.

### D2. Worker identity lives on the row; live state rides a roster channel

```ts
// src/shared/chat.ts
export type ChatWorkerStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface ChatWorker {
  /** The spawning Agent tool call's id. */
  workerId: string
  /** SDK task handle; needed later for per-task stop. */
  taskId?: string
  agentType?: string
  description?: string
  /** 1 for a top-level spawn; omit when unknown. */
  depth?: number
  status: ChatWorkerStatus
  /**
   * Whether the worker is known to be running right now. Distinct from
   * `status`: `running` + `live: false` is the gap after the worker has left
   * the background set and before its notification has landed.
   */
  live: boolean
  /** Most recent tool the worker ran. */
  lastTool?: string
  /** Milliseconds since the spawn when the message was sent. */
  elapsedMs: number
  /** Settled workers only. */
  summary?: string
}
```

New server message `{ type: 'chat-workers'; sessionId; workers: ChatWorker[] }` carrying the full set, and `workers: ChatWorker[]` on `chat-snapshot`. Both additive.

*Why a full-set message rather than deltas:* `background_tasks_changed` is documented as a level signal — "replace your set with each payload rather than pairing edges, so a missed bookend cannot wedge a stale running indicator". The roster is a level signal for the same reason. The client replaces its running set wholesale and merges in the settled rows it already holds. The **server's** roster is still built from the edge stream (D3); the level message below only prunes it.

*Alternative:* make workers sequenced `ChatEvent`s. Rejected: last-tool and elapsed churn on every task frame would flood the event log, be replayed as history, and need dedup on reconnect — exactly the problems the activity channel already solved.

### D3. Pure reducer `src/server/chat/chatWorkers.ts`

`reduceWorkers(state, input) → state`, SDK-free, frames matched structurally. The driver feeds it where it already handles messages and calls a new `onWorkers(workers)` option when the projection changes.

**The roster is built from the edge stream only** — `tool_call`, `task_started`, `task_progress`, `task_updated`, `task_notification`. That stream covers foreground and background workers alike and carries `tool_use_id`, the key that joins a worker to its row.

**Liveness and outcome are separate fields.** `live` says whether the worker is running right now and drives the strip and the `working` status. `status` is the outcome, written only by an authoritative edge. That separation is what makes the reducer immune to frame ordering.

| Input | Result |
|---|---|
| `tool_call` for Agent/Task | ensure a row keyed by `toolCallId`, `status: running`, `live: true` |
| `task_started` | fill `taskId`, `agentType`, `description`, `depth`; `status: running`, `live: true` |
| `task_progress` | update `lastTool` (and `description` if the frame renames it) |
| `task_updated` `patch.status` | map onto `ChatWorkerStatus`; clear `live` when it settles |
| `task_notification` | **always** write its status and `summary`, clearing `live`; overwrites a provisional state |
| `background_tasks_changed` | set `live` from membership only (see below); never writes `status` |
| `process_end` (driver death, interrupt, archive, kill) | write `stopped` for any worker still without an outcome |

**`background_tasks_changed` is a liveness set, never an outcome source.** Its payload is `tasks: { task_id, task_type, description, ambient? }[]` — no `tool_use_id`, so it joins by `task_id` only — and it lists *background* tasks only, so it is never a roster source: replacing the roster with it would drop every foreground spawn and every identity field.

It also must not settle anything. Its documentation says ordering against the `task_started`/`task_notification` bookends is unspecified and that "**in practice the level precedes them**", so on a normal completion the set drops the task *before* the notification carrying `completed` arrives. Settling from the set would write `stopped` first and lock that in, discarding the real outcome when it lands.

So the set writes `live` and nothing else. Membership is authoritative for background liveness — which is precisely what it is documented as ("consumers that only need 'is background work running' should replace their set with each payload") and what stops a missed notification from wedging a running indicator. Foreground workers are never in the set; their `live` comes from the edges and clears on settle or `process_end`.

A worker in the gap (`status: running`, `live: false`) is absent from the strip and does not hold the session at `working`, while its row still reads running until the notification lands and writes the outcome. The gap is one frame wide in practice.

A `task_started` with no `tool_use_id` cannot be joined to a row; it is tracked only for background liveness and renders nowhere.

Unknown `task_type`s and `ambient: true` / `skip_transcript: true` tasks are dropped — they are housekeeping, not activity the user asked for.

### D4. Subagent frames are excluded by frame kind, not by a blanket `parent_tool_use_id` test — with a carve-out for nested spawns

The existing `isSubagentFrame` helper keys on `parent_tool_use_id != null`. That field means different things per frame type: on `assistant`/`user` frames it means "from a subagent", but on `tool_progress` it means "heartbeat for tool X" — every such frame in the captured wire logs is a parent Bash heartbeat. Narrow the exclusion to `handleAssistant` and `handleUser` only, and name it for what it tests (subagent *content* frames). `handlePartial` / `handleSystem` keep ignoring those frames for activity as they do now.

**Nested spawns need their `Agent` call kept.** A worker's own `Agent`/`Task` tool_use arrives as a subagent content frame (`forwardSubagentText: false` still forwards tool_use/tool_result blocks). Dropping it would leave a depth-2 worker with no row anchor, which D1 and the summary-row requirement both depend on. So the exclusion drops a worker's traffic **except** `Agent`/`Task` tool_use blocks and their tool_results, which are emitted as top-level events exactly like the parent's and become that nested worker's row. Everything else a worker runs stays out of the parent transcript.

### D5. The worker body is read from disk on expand

A new WS request (`chat-worker-transcript`, `sessionId` + `workerId`) resolves the worker's `subagents/agent-<id>.jsonl` via the session's `sdkSessionId`, parses complete JSONL records, and returns them. The client fetches on first expand and caches per worker in the chat store.

Reading while the worker runs is safe because Claude Code appends whole records: parse line by line and drop a trailing partial line. That is the only concurrent-read hazard.

*Why not stream it:* the proposal's chosen option. The event stream stays small and the body of record is the file Claude Code already writes; expand works live and after settle with one code path.

*Alternative:* `getSubagentMessages` from the SDK. Rejected: it ties the reader to the SDK import that `replace-claude-sdk-with-cli` is removing, and the JSONL shape is stable and already parsed by `transcriptReplay`'s sibling helpers.

### D6. Every worker persists at spawn; running entries are recovered as `stopped`

A worker's settled status and summary are not recoverable after a restart: `task_notification` is a stream frame, and the parent's `tool_result` for a background spawn is only a launch receipt. Persist one JSON file per chat session at `resolveDataDir()/chat-workers/<sessionId>.json`, mirroring `chat-wire/`, holding one record per worker: `workerId`, `taskId`, `agentType`, `description`, `depth`, `status`, `summary`.

**Write on spawn, rewrite on every settle.** Persisting only settled workers would lose a worker that was still running when the server died: `process_end` never fires on a crash, so nothing would record it and its row would fall back to a plain tool card with no outcome. With the record written at spawn, a restart finds it still marked `running` and recovers it as `stopped` — the row stays visible and truthful, and the session cannot report it as running.

*Alternative:* a `chat_sessions` JSON column. Rejected: a migration for a value that is a per-session append-only list, and `chat-wire/` already set the sidecar precedent. *Alternative:* derive status from the subagent JSONL. Rejected: `failed` vs `stopped` and the one-line summary are not derivable from the file. *Alternative:* settle running workers only in `process_end`. Rejected: that is exactly the crash gap.

### D7. Status extension lives in `refreshStatus`

`working` while `activeTurnId` is set **or** any worker is **live**; `permission` still wins over `working`. `waiting` only when both are clear. Liveness, not `status`, is what holds the session: a worker in the completion gap has already left the background set, so it must not keep the session at `working`. The composer is untouched — it already accepts messages while `working`.

### D8. The live strip and the row are thin views over one source

A `ChatWorkersStrip.tsx` above the transcript lists `workers.filter(w => w.live)`. `ChatMessages` renders `tool_call` events for Agent/Task as `ChatWorkerRow.tsx`, joining on `workerId` for live fields and on the settled sidecar/snapshot row for outcomes. The strip hides when the filtered list is empty or the chat is archived; the row renders in archived chats from its persisted outcome. Depth badge comes from `depth`; omit it when unknown.

### D9. Development fixture

`developmentFixture.ts` gets a keyword-triggered turn that emits an `Agent` `tool_call`, `task_started`, a couple of `task_progress` frames with `last_tool_name`, a `background_tasks_changed` that drops the task *before* the `task_notification` carrying its summary, and one subagent `tool_use` that must **not** appear in the transcript. That exercises the row, the strip, the exclusion, the completion gap, and the settled outcome without a model.

## Risks / Trade-offs

- [`task_*` and `parent_tool_use_id` are Claude Code stream-JSON details, not stable SDK API] → The reducer ignores unknown fields and task types; a missing frame degrades a row to coarser state (no last-tool, no summary), never to an error. Tests pin frame shapes copied from real wire captures and from `sdk.d.ts`.
- [Reading a JSONL while Claude Code appends to it] → Parse complete lines only; drop a trailing partial line. If the file is missing entirely, the expanded row says the body is unavailable.
- [A crash bypasses `process_end`, so running workers would otherwise be lost] → Every worker is persisted at spawn (D6). A restart reads entries still marked `running` and recovers them as `stopped`, so the row survives and the session cannot report a dead worker as running.
- [`background_tasks_changed` is not emitted at startup, carries no `tool_use_id`, and arrives before the bookends it describes] → It is never a roster source and never writes an outcome (D3); it only sets `live`, joined by `task_id`. Rows and identity come from the edge stream, and the sidecar restores them across restarts.
- [A `task_notification` can be lost, leaving a worker with no outcome] → The level set still clears `live`, so the strip and the `working` status cannot wedge; the row may read running without an outcome until `process_end` writes `stopped`. Degraded in the label, correct in the status.
- [The row shows less than the raw `tool_call` did (the tool input JSON)] → Expanding shows the worker's whole transcript, which is the input's purpose. The raw input remains in the Debug panel's wire log.
