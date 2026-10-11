# Proposal

## Why

A Claude Code chat session is no longer a single conversation. The `Agent` tool spawns workers that run in the background, outlive the turn, and can fan out several at once — three concurrent `Explore`/`Plan` agents in a real session in this workspace. kawai still renders one linear transcript, so the fleet is invisible after its launch receipt: the `Agent` tool_result is deliberately empty ("You know nothing about its results"), the session reports `waiting` while workers run for minutes, and the workers' own tool traffic arrives as flat top-level `tool_call` events indistinguishable from the parent's, then disappears on reconnect. The parent model is explicitly told not to read a worker's transcript, so kawai is the only party that can show the user what those workers are doing. The wire already carries the whole story (`task_started` / `task_progress` / `task_updated` / `task_notification`, and per-worker JSONL under the session's `subagents/` directory); the driver drops every bit of it.

## What Changes

- Give each spawned worker an identity in the chat event stream keyed by its spawning `Agent` tool call, and stop emitting a worker's own tool calls and text as top-level transcript entries — except the `Agent`/`Task` calls that spawn its children, which stay so nested workers have a row.
- Render that `Agent` tool call as a **worker summary row** — agent type, description, live status, elapsed time, last tool name, and a depth badge — instead of a collapsed tool card. Expanding the row shows the worker's own transcript, read from its on-disk JSONL while it runs and after it ends.
- Persist a worker's outcome on the row when it settles (`completed` / `failed` / `stopped` plus the one-line summary the parent received), so the row survives server restart, reconnect, and archive.
- Show a slim **live strip** above the transcript listing every running worker while any is in flight, so the fleet is glanceable without expanding anything.
- Keep a chat session's status `working` while any background worker is still running, even after `turn_completed`. The composer keeps accepting messages throughout — background work exists precisely so the user can hand over more work.
- Keep worker rows in archived chats, read-only and still expandable.

Non-goals for this change: per-task stop affordances and `perTaskStopAffordance` interrupt semantics; attributing approval/question cards to the worker that raised them; AI-generated progress summaries (`agentProgressSummaries`); token/usage counts on rows; a foreground-vs-background distinction on rows.

## Capabilities

### New Capabilities

- `chat-session-workers`: how a chat session surfaces the agents it spawned — worker identity and lifecycle, the worker summary row, the live strip, reading a worker's body from its on-disk transcript, persisted outcomes, nested spawns, and the exclusion of worker inner traffic from the parent transcript.

### Modified Capabilities

- `chat-sessions`: the status requirement changes — `working` now covers a running background worker as well as an in-flight turn, so a session with live workers is no longer reported as `waiting`.

## Impact

- Server: `src/server/chat/ChatSessionDriver.ts` (consume `task_*` and `background_tasks_changed` frames currently dropped by the unknown-frame default; stop emitting subagent `tool_call`/`tool_result`), `ChatSessionManager.ts` (hold the live worker roster, include it in snapshots, persist outcomes), `ChatConnections.ts` (fan out roster updates), `transcriptReplay.ts`, `developmentFixture.ts`.
- Shared: `src/shared/chat.ts` (worker roster types), `src/shared/types.ts` (`chat-workers` message, `chat-snapshot.workers`, worker fields on the `Agent` tool-call event). Additive except that worker inner tool calls leave the transcript.
- Client: `src/client/components/chat/` (worker row rendering inside `ChatMessages.tsx`, a new live-strip component), `src/client/stores/chatStore.ts`, `ChatView.tsx`.
- Storage: no schema change. Worker bodies are read from the existing `~/.claude/projects/<dir>/<sessionId>/subagents/agent-<id>.jsonl` and `agent-<id>.meta.json`; worker identity and outcomes persist in a `chat-workers/` sidecar beside `agentboard.db`, mirroring `chat-wire/`.
- The activity indicator's "Running Task…" row is unchanged and continues to ignore subagent frames.
