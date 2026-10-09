# Design

## Context

See `proposal.md` for why the current tool rows are too loud, and
`specs/chat-sessions/spec.md` for the behavior this design has to produce.

Constraints that shape the approach:

- `src/shared/chat.ts` already links a `tool_call` and its `tool_result` with
  a shared `toolCallId` on `ChatToolEventBase`. Nothing needs to change on the
  wire.
- The client transcript is an ordered `ChatEvent[]` in
  `src/client/stores/chatStore.ts`, rendered by
  `src/client/components/chat/ChatMessages.tsx`. Label text comes from the
  pure helpers in
  `src/client/components/chat/toolCallLabel.ts`.
- Reconnect snapshots deliver history as the same event list, so a call and
  its result can arrive in the same list whether they were streamed live or
  replayed.

## Goals / Non-Goals

**Goals:**

- One collapsed transcript row per tool use, short enough to scan a long run
  without the tool chrome competing with assistant prose.
- Keep label derivation a pure, unit-testable function of `(tool, input)`.
- Preserve expand-to-evidence: full input and full output stay one click away.

**Non-Goals:**

- Folding events on the server or changing `ChatEvent`.
- A density setting (proposal defers it).
- Touching approval cards, the live activity row, or terminal previews.

## Decisions

### 1. Pair call and result in the view, keyed by `toolCallId`

`ChatMessages` walks the event list once, grouping a `tool_call` and its later
`tool_result` into one entry. The React key becomes `toolCallId` rather than
each event's `id`, so the row is stable when the result lands.

*Why not server-side folding?* The two-event shape is load-bearing: the
activity reducer, the wire log, reconnect snapshots, and SDK transcript
replay all speak in separate call and result events. Collapsing them would
either fork those consumers or force a protocol change for a display concern.

*Why not a `Map` built once in the store?* The store is the ordered history;
grouping is a rendering decision. Keeping it in the view means the store
stays a dumb append log and the pairing rule is testable alongside the other
label tests.

### 2. Label is `<toolName>(<handle>)`, handle from a pure table

`toolCallLabel.ts` keeps its `TOOL_DETAILS` table and its pure entry point,
dropping `lineDelta`, `join` composition, and `toolResultDetail`. Bash becomes
a single field with a fallback (`description`, else `command`) rather than a
composed pair.

*Why drop the composition?* `description` is intent and `command` is
mechanism; together they paraphrase each other on one truncated line. Intent
is what the eye wants while scanning. The command is still on hover and
behind the expand.

*Why not rename the module?* The module still maps tool input to a short
label; the name stays honest and the diff stays reviewable.

### 3. Failure mark is `✗` only

The mark is rendered on the collapsed entry when the paired result has
`isError`. Successful entries carry nothing.

*Why not `✓` as well?* Success is the overwhelming majority of rows. A glyph
on every row is a new source of the density this change is removing. Silence
means fine; `✗` is the only thing worth interrupting for.

*Why on the entry rather than a status word?* A word (`failed`) re-introduces
the label padding we are deleting. The mark also has to survive truncation of
the handle, so it sits outside the truncating span.

### 4. Expand order is input, then output

The `<details>` body renders the input JSON first and the raw output below it
when a result has arrived. A call still in flight expands to the input alone.

*Why not output first?* The input is what identifies the call; the output is
the consequence. Matches the order they happened.

### 5. Orphan results still render

If a `tool_result` has no earlier `tool_call` with the same `toolCallId`
(replay edge case, partial history), the view emits one entry that expands to
the output. Silently dropping it would hide agent activity.

## Risks / Trade-offs

- **Pairing across a snapshot boundary** (call in history, result in the
  first live batch) → Grouping runs over the combined list at render time,
  not per batch, so the result attaches whenever it arrives.
- **Interrupted turns leave a call with no result** → Correct as-is: the
  entry shows the attempt and expands to the input. `turn_interrupted`
  already marks the turn itself.
- **We lose the "did it work?" glance for successes** → Accepted; the
  assistant text and the next action are the real signals. Expand is one
  click if you need it.
- **`✗` competes with the activity row's live states** → The mark is
  history-only and sits on the collapsed entry; the activity row is a
  separate last-entry element and is untouched.

## Migration Plan

Client-only. No storage, API, or dependency change. Existing transcripts
replay through the same view and pick up the new shape automatically.
Rollback is reverting the client change; nothing recorded on disk is
affected.
