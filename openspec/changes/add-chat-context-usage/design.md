# Design

## Context

See `proposal.md` — Why for the motivation. Three constraints shape the
approach.

The chat driver already receives everything the meter needs and throws it
away. `handleAssistant` reads `message.message.content` and ignores
`message.message.usage`; `handleSystem` turns `compact_boundary` into a
`'Context compacted'` notice and ignores the `compact_metadata` beside it.

The naive "sum the usage" reading is wrong, and not by a rounding error. A
single mimo session's `result.usage` / `modelUsage` totals reach 11.3M tokens
against a 200k window — those fields are cumulative across the whole
streaming session, not the current window. Only the **per-request** usage on
an assistant frame is window occupancy.

Context size is not like live activity (`ChatActivity`, deliberately
ephemeral per designs D1–D6 of `add-chat-activity-indicator`). It is a slow
fact about the session that has to survive restart and archive, so it needs a
persisted home like `approvalPolicy`, while still riding the snapshot so a
reconnecting client sees it immediately.

## Goals / Non-Goals

**Goals:**
- One number per chat session that answers "how close to compaction am I",
  correct for profile-configured windows.
- Updates during a turn, not only at turn end.
- Survives restart, resume, archive, and restore.
- Cheap enough to update constantly: no extra process round trips.

**Non-Goals:**
- A `/context` breakdown card. The stored reading is shaped so categories can
  be added later without a migration to the meter's own fields.
- Replacing the `'Context compacted'` notice, which stays as-is.
- Any change to terminal (tmux) session rendering.
- Precise billing-grade token accounting.

## Decisions

### D1. Source: per-assistant-frame usage, not `result.usage` and not a control request

The meter reads `message.message.usage` off each assistant frame and takes
`input + cache_read + cache_creation + output` of the **latest** frame as the
current window. Empirically this tracks reality: in one captured session the
per-request figure climbed 30k → 166k against a 200k window, and auto-compaction
reported `pre_tokens: 168253` — agreement to about 1%.

*Why not `result.usage` / `modelUsage` sums:* cumulative lifetime traffic
(see Context). Useless as a window.

*Why not `getContextUsage({ detail: 'summary' })` as the source:* it returns
the right answer (`totalTokens`, `rawMaxTokens`, `percentage`) but is a
control request against a live `Query`. The driver is lazy — it does not spawn
until the first send — so a restored chat would show nothing until the user
talks to it, and a failed or unsupported request leaves no reading at all.
The passive stream is already there on every request.

*Rejected alternative: active polling.* Extra round trips and a dependency on
a live process for a number the stream already carries.

### D2. Denominator: `modelUsage[*].contextWindow`, accepting its one known blind spot

The window token count comes from the resolved model usage's `contextWindow`,
which is the model's believed limit. That is the denominator for mimo (200k,
no override) and for `glm-5.3[1m]` (1M model with a matching 1M
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`).

The blind spot: `rawMaxTokens` from `getContextUsage` is the **resolved
autocompact window**, which is the model limit *or* a smaller
compaction-policy window. If a profile ever sets
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` below its model's limit, the meter would
understate fullness until an active call corrected it. No profile does that
today, and the knob is operator configuration, so this is accepted rather than
solved. When the drill-down later calls `getContextUsage`, it should adopt
`rawMaxTokens` as the denominator as a correction.

*Why not hardcode 200k:* GLM's window is 1M. That is the case the proposal
calls out.

### D3. Compaction adopts `post_tokens` immediately

On `compact_boundary`, the driver reads `compact_metadata.post_tokens` and
publishes that as the new reading, keeping the existing `'Context compacted'`
notice. `trigger: 'auto' | 'manual'` is recorded but does not change the
meter; both paths drop it.

*Why not wait for the next request:* the notice already tells the user
something happened. A meter that says "94%" while the notice says "compacted"
is worse than no meter.

*Fallback:* if `compact_metadata` is absent (older CLI), keep the last
reading and let the next request correct it. Never emit a zero.

### D4. Persistence lives on `chat_sessions`, delivery rides the snapshot

Four columns added with the existing additive-migration pattern used for
`archived_at` and `approval_policy`: `context_tokens`, `context_window`,
`context_pct`, `context_at`. A single JSON column was considered and rejected
— the meter needs three stable numbers now, and a JSON blob trades a trivial
future migration for awkward queries and untyped reads. If the drill-down
later needs categories, those can be a separate column or table.

`chat-snapshot` gains a `contextUsage` field beside `activity`. Older clients
ignore unknown fields, so this is additive exactly like the chat messages
themselves (`src/shared/types.ts` already documents that convention).

*Rejected alternative: deriving the reading from replayed transcript events on
attach.* Transcript replay does not carry per-request usage today, and making
it would push token counts into the conversation history for a value better
kept as session state.

### D5. Live updates are coalesced; writes are throttled to turn boundaries

A long turn can emit hundreds of assistant frames — 340 in the captured
session. Broadcasting and persisting each one is waste.

- **Broadcast:** keep the latest reading in memory and send it on the next
  connection flush, exactly as `ChatConnections` already does for activity
  (`activityBatches`, "latest value per connection and session"). The meter
  is a single current value, never a sequenced event, so it does not enter the
  transcript, get a sequence number, or replay.
- **Persist:** write on `turn_completed`, on `compact_boundary`, and on
  driver death. In-memory holds the fresher value between writes; `getSnapshot`
  prefers in-memory and falls back to the stored column.

### D6. Subagent frames are ignored

The driver already routes with `isSubagentFrame(message)` for activity. Usage
on a `parent_tool_use_id` frame is a Task subagent's request, not the
main-loop window that compacts. The same guard applies to the usage reader.

### D7. No reading is a state, not a zero

`contextUsage: ChatContextUsage | null`. Null renders nothing in the header.
A zero would claim the conversation is empty, which is never true once a
request has run and is not yet known before the first one.

## Risks / Trade-offs

- **Denominator blind spot (D2)** → Accepted. Documented above; the later
  `getContextUsage` drill-down corrects it. Until a profile sets
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` below its model limit, the two agree.
- **`compact_metadata` missing on older CLIs** → Keep the last reading; the
  next request corrects it (D3). The Claude Code baseline is pinned well
  ahead of the field, so this is a fallback rather than a live path.
- **Percentages over 100%** → The window can be exceeded before compaction
  fires. Render it; clamping hides a real problem. Callers must not assume
  `pct <= 100`.
- **`message.usage` on streamed blocks is documented as "not final"** → It is
  not final for the *message* (one content block of a larger turn). For prompt
  size it is the request that produced the block, which is what we want. We
  take the latest frame's figure rather than any single message's "final" one.
- **Reading moves during a turn, so two clients can briefly disagree** →
  Coalescing (D5) makes this a flush-boundary artifact of at most one batch,
  same as activity today.
- **DB writes on a high-traffic session** → Throttled to turn boundaries (D5);
  a session that runs many short turns writes a few rows per turn, not per
  frame.

## Migration Plan

Additive columns via `ALTER TABLE ... ADD COLUMN`, matching the
`archived_at` / `approval_policy` migration guard in `src/server/db.ts`.
Existing chat sessions simply have no reading until their next model request,
which is the correct "not yet measured" state (D7). No backfill.

Rollback is dropping the columns and the snapshot field; nothing else reads
them.

## Open Questions

None that change the specs, this approach, or the task breakdown. Label
wording and the meter's near-window color threshold are visual polish to
settle in the component, not architecture.
