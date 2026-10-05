# Design

## Context

Today every session is a tmux window: `session-create` →
`SessionManager.createWindow()` → registry broadcast → terminal attach via an
`ITerminalProxy`, with status inferred by log polling (`logPoller`,
`statusInference`) and broadcast through `SessionRegistry`. `SessionRegistry.replaceSessions()`
is called from tmux discovery and replaces the whole session map, so anything
that is not a tmux window would be dropped on the next refresh. The WebSocket
protocol (`ClientMessage` / `ServerMessage` in `src/shared/types.ts`) is a
discriminated union that clients already tolerate additions to (the workspace
messages were added the same way).

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) provides the engine
Claude Code runs on, as a library: `query()` in streaming-input mode yields a
long-lived control surface (`interrupt()`, per-turn streaming) plus a
`canUseTool` callback for approvals, and sessions remain resumable by session
id (transcripts under `~/.claude/projects/`, respecting `CLAUDE_CONFIG_DIR`).

Two sources were studied while writing this design and are the reference for
SDK behavior quoted below: Anthropic's official `simple-chatapp` example
(`server/ai-client.ts`, `server/session.ts` in
`anthropics/claude-agent-sdk-demos`) and the Agent SDK agent-loop
documentation (`code.claude.com/docs/en/agent-sdk/agent-loop`).

## Goals / Non-Goals

**Goals:**

- Chat sessions as a first-class session kind, coexisting with terminal sessions.
- Reuse the existing registry/session-list/WebSocket plumbing; additive only.
- Event-derived status with zero log parsing for chat sessions.
- A driver boundary simple enough that a Codex driver (`codex exec --json` /
  app-server) can slot in later.

**Non-Goals:**

- Codex or other agent drivers (boundary only, no implementation).
- Remote hosts, hibernate/wake, or worktree integration for chat sessions.
- Replacing terminal sessions; migrating existing sessions.
- Rendering SDK partial token deltas with per-keystroke fidelity targets.

## Decisions

### D1: Session model — additive `kind`, chat sessions held in a separate registry map
`Session` gains `kind?: 'terminal' | 'chat'` (absent = terminal) and
`tmuxWindow` becomes optional; `sessionsEqualForBroadcast` learns both fields.
`SessionRegistry` keeps chat sessions in their own map that
`replaceSessions()` (tmux discovery) never touches; `getAll()` merges the two,
`updateSession`/removal work across both. This avoids discovery clobbering
chat sessions without threading "keep these ids" through the tmux refresh path.
Chat session ids: `chat-<uuid>`; `agentType: 'claude'` so existing icons,
labels, and sorting work unchanged.

### D2: One long-lived driver per chat session (streaming-input `query()`)
`ChatSessionDriver` (`src/server/chat/`) owns one `query()` call whose prompt
is an async iterable of user turns — the same shape as the demo's
`MessageQueue` fed to `query({ prompt: queue })`, which validates the pattern.
That mode keeps `interrupt()` and avoids re-paying CLI startup per turn.
Alternative rejected: one-shot `query()` with `resume:` per message
(process-per-turn) — simpler failure semantics but no mid-session interrupt
and slower turns. After a server restart the driver is reconstructed with
`resume: <sdkSessionId>` on the first sent message; the SDK subprocess is
spawned lazily at first turn, not at session create, so creating a session
never blocks on process startup. The SDK import is dynamic
(`await import`) so a broken/missing install disables the feature instead of
crashing the server. The SDK call is injected as a `queryFactory` for tests,
mirroring the `SpawnFn` injection convention in `src/server/terminal/`.

Loop lifecycle rules (from the agent-loop docs): a `result` message ends a
**turn**, not the session — the driver iterates the stream to completion and
must tolerate trailing events (e.g. `prompt_suggestion`) that arrive after a
`result`. In streaming-input mode the session survives per-turn error results
(`error_max_turns`, `error_during_execution`, …); only a session crash emits a
final error result and exits the process, which is the sole condition that
marks the driver dead. The SDK session id is available on the init system
message (before the first result), so it is captured at first-turn start and
persisted immediately. User messages pushed mid-turn queue into the stream and
surface as user messages inside the running turn.

Option parity with a terminal `claude` session in the project directory —
the inverse of the demo's choices, which are demo-scoped: `systemPrompt: { type: "preset", preset: "claude_code" }`
explicitly selects the Claude Code preset (omitting it uses the SDK minimal prompt), no `allowedTools` restriction,
`settingSources: ["user", "project", "local"]` so CLAUDE.md/skills/config
load, `permissionMode: "default"` (the documented mode for interactive apps
with a `canUseTool` callback; absent callback means deny, so ours is always
provided), and `model`/`maxTurns`/`maxBudgetUsd` left unset for parity
(configurability is a follow-up).

### D3: Wire protocol — additive chat messages, batched events
Extend `session-create` with optional `kind` (absent = terminal).
New client messages: `chat-attach {sessionId}`, `chat-detach {sessionId}`,
`chat-answer {sessionId, requestId, answers}`, `chat-send {sessionId, text}`, `chat-interrupt
{sessionId}`, `chat-approval {sessionId, requestId, decision}`. New server
message: `chat-events {sessionId, events: ChatEvent[]}` — an ordered batch of
typed events (`turn_started`, `user_message`, `assistant_text`,
`assistant_delta`, `tool_call`, `tool_result`, `approval_request`, `question_request`, `request_resolved`,
`turn_completed`, `turn_interrupted`, `notice`, `error`). Lifecycle continues
to flow through the existing `session-created` / `session-update` /
`session-removed` messages. Event mapping follows the SDK's shapes: each SDK
assistant message carries **one content block** (blocks live at
`message.message.content`; consecutive blocks sharing a message id form one
response), SDK user messages yield `user_message`/`tool_result` events, and
`turn_completed` carries the result's `subtype`, `total_cost_usd`, and
`num_turns` (final text only on `success`). A `notice` kind covers
`compact_boundary` (context compacted) and informational system messages.
Assistant deltas are coalesced per connection per event-loop turn (reusing
the `outputCoalescer` idea, much smaller cap) so token streaming doesn't
flood the client. `ChatEvent` lives in a new `src/shared/chat.ts` rather than
growing `types.ts`.

Each event has a stable event id and message/tool correlation ids; live events
also have a monotonically increasing per-session sequence. `chat-attach`
subscribes the connection and returns `chat-snapshot {sessionId, events,
pendingRequests, status, throughSequence}` before buffered live events newer
than that sequence. Snapshot capture and subscription form one serialized
boundary in the manager; live events generated during history loading are
buffered. The snapshot replaces client state, includes unfinished live text
and all currently pending approvals/questions, and replayed history is read-only.
The client ignores repeated event ids/sequences and reconciles final assistant
text with streamed deltas rather than appending it twice. `chat-detach` removes
the subscription without stopping the agent. These rules apply to reloads and
multiple browsers; only subscribed clients receive conversation content.

### D4: Status derived in the driver, applied via the registry
Driver derives status from state: any pending approval/question → permission;
otherwise an in-flight turn → working; otherwise → waiting. Resolving a
request recomputes status immediately, remaining in permission if another
request is pending. Turn completion, interruption, and per-turn error results
clear turn state. The driver calls `registry.updateSession`
immediately — matching the existing immediate-working-on-Enter semantics
exempt from the 30s bucket cadence. Per D2, per-turn error results do not end
a streaming session, so they return the session to waiting (with an `error`/
`notice` event in the transcript); only a process crash marks it dead. Chat
sessions never enter log polling; their entries in discovery are excluded
(D6).

### D5: Persistence — minimal row in SQLite, history replay from SDK transcripts
A new `chat_sessions` table (id, name, projectPath, sdkSessionId, status,
createdAt, lastActivityAt) created via the existing `CREATE TABLE IF NOT EXISTS`
pattern in `db.ts`. On restart, rows are loaded into the registry as idle chat
sessions; the first `chat-send` resumes the SDK conversation. History replay
parses the SDK transcript JSONL for that `sdkSessionId` into read-only
`ChatEvent`s on attach. Fallback if the transcript is missing/unparseable:
render a "history unavailable" notice and preserve any live state. A parser
failure with an existing SDK-readable transcript may still permit resume; a
missing transcript cannot be resumed using an id alone. Before resume, validate
availability and handle SDK resume failures with a session-scoped actionable
error, keeping the row and id intact and sending no message to a fresh session.
Recovery is to restore the transcript and retry, or explicitly create a new
chat session. Never silently replace the conversation. Sessions created but
never started have no SDK id and start a fresh conversation normally. We do not duplicate conversation
content into our own DB.

### D6: Discovery dedup — exclude chat transcripts
Log discovery/agent-session matching skips transcript files whose session id
belongs to a live or stored chat session (the driver manager exposes the set
of `sdkSessionId`s). One chat session, one UI entry.

### D7: Approvals and questions — cancellable promise bridge over `canUseTool`
`canUseTool` resolves a promise stored under `requestId`; the WS
`chat-approval` message resolves it (`allow` → `{behavior:'allow'}` with
unchanged input; `deny` → `{behavior:'deny', message}`), and each callback's `options.signal` cancels its pending request. Stop clears
queued unsent messages and cancels all pending requests for the interrupted
turn before returning to waiting; kill/shutdown also settle all outstanding
callbacks and stop the subprocess. Resolution/cancellation is idempotent,
removes the request, and broadcasts `request_resolved` with its outcome to
all subscribers. Late or duplicate answers cannot execute a tool twice; the
first valid answer wins and stale responses receive a session-scoped error.
Pending requests survive browser disconnects, but callbacks cannot survive a
server restart: restored history marks them cancelled, and any new request
on resume gets a new id. The approval card shows tool name + summarized arguments (full JSON behind a
disclosure).

`AskUserQuestion` is handled separately: emit `question_request` with question
text, options, and multi-select flags; render choices and free-text answers;
validate `chat-answer` against the pending questions and return
`{behavior: 'allow', updatedInput: {...input, answers}}` in the pinned SDK's
expected shape. Its cancellation, replay, and multi-client rules match tool
approvals. Ordinary Allow/Deny cards do not answer questions.

### D8: Client — chat view + store slice, terminal untouched
`NewSessionModal` gains a session-kind selector; chat kind hides command
presets and host picker (local only). `App.tsx` renders `ChatView`
(`src/client/components/chat/`) instead of `Terminal` when the active session
is a chat session: message list (markdown via the existing `react-markdown`
stack), tool activity entries, approval cards, question forms, composer, stop button. A new
`chatStore` holds per-session transcripts and pending approvals, fed from
`chat-events`; it replays from the server's history response on attach.

### D9: Auth and gating
Creation is refused unless the server can authenticate: `ANTHROPIC_API_KEY`
in the environment, or CLI credentials under `CLAUDE_CONFIG_DIR`. The key is
server-side only and never sent to the client. A startup/first-use probe
(dynamic import + tiny metadata query) verifies the SDK works on Bun; failure
disables creation with an actionable error rather than degrading mid-session.

## Risks / Trade-offs

- [Bun is not an officially documented SDK runtime] → dynamic import +
  first-use probe; failure disables the feature with an actionable message;
  terminal sessions unaffected. Fallback path if permanently broken: drive
  `claude -p --input-format stream-json` from the same driver interface.
- [SDK API churn (`query()` surface is recent)] → pin an exact SDK version;
  all SDK types confined to the driver module.
- [Reference demo covers only the core loop (queue → `query()` →
  assistant/user/result mapping); approvals, `interrupt()`, partial-message
  streaming, and resume are doc-verified but not demo-exercised] → task 5.2's
  real-SDK walkthrough validates each before the change ships.
- [`canUseTool` never times out] → approvals persist by design (spec);
  SDK cancellation signals plus stop/kill/shutdown settlement prevent stuck callbacks.
- [Transcript JSONL is not a public contract] → parser is best-effort with
  graceful fallback (D5); unknown lines ignored.
- [One resident subprocess per chat session] → acceptable at current scale
  (personal dashboard); lazy spawn on first turn limits idle cost.
- [Delta flooding from `includePartialMessages`] → per-connection turn
  coalescing (D3); if still noisy, drop to final-message-only without protocol
  changes (delta events simply stop being emitted).

## Migration Plan

All changes are additive: new optional `Session` fields, new union members,
new table, new components. Deploy is safe with older clients (they ignore
unknown message types). Rollback: revert the deploy; `chat_sessions` rows and
SDK transcripts are inert data; terminal sessions were never touched.

## Open Questions

- Coalescing window for assistant deltas (one turn vs ~50–100 ms timer) —
  tune during implementation; protocol already supports both.
- Whether the chat composer should support image/file attachments — defer to
  a follow-up change; the protocol would extend `chat-send`, not change.
