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
  correct for the autocompact reserve and for profile-configured windows.
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

### D1. Source of *used* tokens: per-assistant-frame usage, not `result.usage`

The meter reads `message.message.usage` off each assistant frame and takes
`input + cache_read + cache_creation + output` of the **latest** frame as the
current window. Empirically this tracks reality: in one captured session the
per-request figure climbed 30k → 166k against a 200k window, and auto-compaction
reported `pre_tokens: 168253` — agreement to about 1%.

*Why not `result.usage` / `modelUsage` sums:* cumulative lifetime traffic
(see Context). Useless as a window.

*Why not `getContextUsage({ detail: 'summary' })` as the source:* it returns
the right answer (`totalTokens`, `rawMaxTokens`, `percentage`) but is a
control request against a live `Query`. A restored chat with no live process
would show nothing, and a failed or unsupported request leaves no reading at
all. The passive stream is already there on every request. `getContextUsage`
does still run, but only as the threshold correction in D2.

*Rejected alternative: active polling.* Extra round trips and a dependency on
a live process for a number the stream already carries.

### D2. Denominator: the auto-compaction threshold, not the model window

The meter answers "how close to compaction am I", so it divides by the
session's **auto-compaction threshold** — the used-token count at which the
conversation would be compacted — not by `modelUsage[*].contextWindow`.

A real `/context` report on mimo shows why the two differ: 157.9k used of a
200k window reads 79%, while the autocompact reserve is 33k and auto-compaction
has been observed to fire at `pre_tokens: 168253`. Dividing by 200k reads 79%
at the moment the conversation is about to be summarised; dividing by
200k − 33k = 167k reads 95% and tells the truth. The reserve is present in
every session, not only overridden ones, so this is the common case.

Resolution order for the threshold:

1. **Observed from the context-usage report.** `getContextUsage` (or a `/context`
   command's structured `context_usage`) carries `rawMaxTokens` and a
   `buffer` category (`kind: 'buffer'`), so the threshold is
   `rawMaxTokens − buffer`. The `autoCompactThreshold` field is expected to
   carry the same number directly and is preferred when present. The agent
   starts on attach, so a live `Query` is usually available without waiting
   for a turn; when it is not, fall through.
2. **The profile's configured window.** `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from
   the resolved profile environment the server already computes
   (`PROFILE_CONTROLLED_ENV`), when it configures a smaller window than the
   model's. This is the window, not yet reserve-adjusted, so it is the right
   answer for an override and an approximation otherwise.
3. **`modelUsage[*].contextWindow`**, labelled as an approximation of the
   window rather than the threshold. Only for a session that has neither an
   observed report nor a profile override.

*Why not `modelUsage.contextWindow` alone:* it is the model's believed limit
and ignores both the autocompact reserve and any profile override. The
reserve is 16.5% in the observed report, so this understates fullness in
**every** session; an override understates it further, to the point the meter
reads 20% when compaction is imminent.

*Rejected alternative: reporting window fullness instead.* `/context` already
prints `used / rawMaxTokens`, so a second meter showing the same 79% would be
redundant. The chat header exists to warn about compaction, and that is the
other number.

*Calling `getContextUsage` is a light control request, not a poll.* It runs
on attach and at turn boundaries, following the `interrupt` precedent of
holding a live `Query` handle and calling a control method on it. It is not
the source of the used-token count (D1) and it is not polled per frame.

### D3. Compaction adopts `post_tokens` when it is present

On `compact_boundary`, the driver reads `compact_metadata.post_tokens` and
publishes that as the new reading, keeping the existing `'Context compacted'`
notice. `trigger: 'auto' | 'manual'` is recorded but does not change the
meter; both paths drop it.

`compact_metadata` is required on the boundary frame but `post_tokens` is
optional — only `trigger` and `pre_tokens` are required — so a frame carrying
no post-compaction size is a real case, not a theoretical one.

- `post_tokens` present and a finite number → publish it as the new reading.
- `compact_metadata` absent, `post_tokens` absent, or the value non-finite →
  retain the previous reading and let the next request correct it.

*Why not wait for the next request:* the notice already tells the user
something happened. A meter that says "94%" while the notice says "compacted"
is worse than no meter.

*Never invent a reading.* Undefined, `NaN`, and a zero standing in for
"unknown" are all forbidden; the meter keeps its last known value instead
(D7).

### D4. Persistence lives on `chat_sessions`, delivery rides the snapshot

Four columns added with the existing additive-migration pattern used for
`archived_at` and `approval_policy`: `context_tokens`, `context_threshold`,
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

- **Threshold source may be briefly approximate (D2)** → A session with no
  live `Query` and no profile override meters against the model window until
  the first observed report. Labelled as such; the next attach or turn
  corrects it. Better than blocking the meter on a control request.
- **`autoCompactThreshold` units need confirming against a live report** →
  D2 prefers the field when present and falls back to
  `rawMaxTokens − buffer`, which is known-correct from a real `/context`
  report. The task that wires it pins this down with a fixture from a real
  report rather than assuming.
- **`compact_metadata` present but `post_tokens` missing** → Keep the last
  reading; the next request corrects it (D3). Also covers metadata absent
  entirely on older CLIs. The Claude Code baseline is pinned well ahead of
  the field, so this is a fallback rather than a live path.
- **Percentages over 100%** → The threshold can be exceeded before compaction
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
