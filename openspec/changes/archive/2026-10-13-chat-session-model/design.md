# Design

## Context

The chat pipeline already moves several replace-semantics session states from
driver to clients without touching the sequenced event stream: commands,
activity, context usage, workers, notifications. Context usage is the closest
twin of this feature (driver callback → manager memory → `chat_sessions`
column → snapshot field → coalesced additive push → header chip), and the spec
delta mirrors its survival requirements. The SDK reports the session's model
on every `system/init` frame (`model: string`), which the driver already
handles in `handleSystem` for the session id and terminal commands.

## Goals / Non-Goals

**Goals:**

- Show the effective model of a chat session in the chat header, following
  mid-session `/model` switches, with context-usage-grade persistence.

**Non-Goals:**

- No model picker/editor — switching models stays with the agent's own
  `/model` command (local command output already renders in the transcript).
- No model display in the navigator session list or terminal sessions.
- No alias→display-name mapping; the reported string is shown verbatim.
- No per-worker/subagent models; the badge reports the main conversation.

## Decisions

**D1 — Source: the init frame's `model` field.** The CLI emits `system/init`
at the start of every turn carrying the model actually in use, after profile
config, CLI defaults, and `/model` switches resolve. Alternatives rejected:
the profile's configured `model` (often unset, and never reflects `/model` or
CLI defaults), and `modelUsage` keys on results (cumulative per-model map — a
stale key lingers after a switch, so "latest key" is not "current model").
Capture in `handleSystem` where init is already processed. An empty or missing
string is ignored (no callback), keeping "absent" honest.

**D2 — Slow session state, not an event.** The model is replace-semantics
state like context usage, not transcript history: never a sequenced
`ChatEvent`, never replayed from the event log. Held in the manager's memory,
persisted to `chat_sessions`, delivered by snapshot plus push. Alternative —
ephemeral like activity — fails the restart/restore scenarios; alternative —
persisted event — forces ordering semantics onto replaced state and would
replay stale values into live views.

**D3 — Transport: `chat-snapshot.model` + `chat-model` push.** The snapshot
gains `model: string | null` (additive field; older clients ignore it). A new
`chat-model` message fans out to subscribed connections, coalesced per session
in the connections flush exactly like `chat-context-usage`. Sent only when the
value changes — init fires every turn, an unchanged model must not spam the
socket. Not piggybacked on `chat-context-usage`: the two states change on
different cadences and each push should mean what it says.

**D4 — Persistence: nullable `model` TEXT column on `chat_sessions`.** A
single string, so a plain column (context usage needs JSON; this does not).
Written immediately on change via the session patch path — model changes are
rare (not per-request like context readings), so no turn-boundary batching.
Read back into the session record; snapshot prefers the in-memory value and
falls back to the stored one, like context readings. A conversation reset
inside the same session does not clear it: the model is session metadata, not
a measurement of the discarded conversation (`/clear`/`/new` start a fresh
chat, which begins with no model).

**D5 — Driver/manager wiring: `onModel` callback.** New optional driver
callback `onModel?: (model: string) => void`, fired from the init branch of
`handleSystem`, only when the string is non-empty and differs from the last
fired value (the driver dedupes; the manager trusts it). The manager records
the value, patches the row, and fans out the push — mirroring its
`onContextUsage` handling. Subagent content frames are already filtered before
`handleSystem`, so only the main conversation's init sets the model; the
spawned-worker roster keeps its own streams.

**D6 — Client: transcript state + header chip.** `chatStore`'s per-session
transcript state gains `model: string | null`; the snapshot adopter and a
`chat-model` case keep it current across reconnects. `ChatView` renders it in
the header's right cluster beside the context meter as a
`text-chat-meta text-secondary` span (`data-testid="chat-model"`, full string
in the `title`). Null renders nothing. Archived chats render the snapshot's
stored value and, with no agent running, receive no pushes — inert for free.

**D7 — Dev fixture reports the model.** Corrected during implementation: the
fixture's context-usage report carries a `model` field but its turn script
never emitted a `system/init` frame, so nothing reached the capture. The
fixture now pushes an init frame (`model: 'claude-sonnet-4-5'`) at the start of
every fake turn, matching a real stream's per-turn metadata.

## Risks / Trade-offs

- [Reported string may be an alias (`sonnet`) or a full id
  (`claude-sonnet-5-5`) depending on CLI/settings] → Shown verbatim by design;
  no mapping table to drift out of date. The `title` carries the exact string.
- [No model until the first turn after create/restore] → Spec'd as absent, not
  placeholder — same stance as the context meter before the first request.
- [Wire growth] → One additive message type and one additive snapshot field;
  older clients ignore both; no changes to existing messages.

## Migration Plan

Additive DB migration (nullable column, existing rows null → no badge shown
until the session's next turn). Deploy is a normal restart; rollback leaves
the column ignored. No data backfill is possible or needed — the model is only
knowable from a live agent.
