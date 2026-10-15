# Design

## Context

The context meter (archived change `2026-10-12-add-chat-context-usage`) takes
its *used* count from decision D1 there: the `message.message.usage` of the
latest top-level assistant frame, summed as `input + cache_read +
cache_creation + output`. `ChatContextTracker.readRequest` ignores a sum that
is not positive (D7), so a session whose assistant frames all carry zero
usage never gets a reading. See proposal.md for the GLM evidence.

Facts this design relies on, from wire captures and the SDK types:

- Claude Code copies `message_start.usage` into every assistant frame it
  emits for a message. It emits those frames before `message_delta` arrives.
- `message_delta.usage` is cumulative for the request. `MessageDeltaUsage`
  types `input_tokens`, `cache_read_input_tokens`, and
  `cache_creation_input_tokens` as `number | null`, and `output_tokens` as
  `number`. A delta can therefore be partial.
- What each source sends:

  | source | `message_start` / assistant frame | `message_delta` |
  |---|---|---|
  | Anthropic | complete input and cache counts, small output | at least the cumulative output |
  | MiMo | complete input and cache counts, output 0 | complete |
  | GLM (Z.ai) | `{input: 0, output: 0}` | complete |

- The driver already receives `stream_event` frames for every request
  (`includePartialMessages: true`). `handlePartial` handles them for activity
  and text deltas, but returns early when no turn is active.

## Goals / Non-Goals

**Goals:**

- Produce a correct per-request used count from whichever of the start or the
  delta carries it, with no per-provider switch.
- Leave Anthropic and MiMo readings exactly as they are today, apart from the
  final output tokens they now also gain.

**Non-Goals:**

- Using the `get_context_usage` report's `totalTokens`/`apiUsage` as a
  fallback for the used count (option B from the exploration). D1's reasons
  for not depending on that control call still hold.
- Changing threshold resolution, persistence cadence, the wire messages, or
  the client meter.

## Decisions

### E1. One per-message usage accumulator, fed by every usage source

The driver keeps one accumulator, keyed by the request's message id: the
latest message, plus its id. Three inputs feed it:

- `message_start`: `event.message.usage`, keyed by `event.message.id`;
- `message_delta`: `event.usage`, keyed by the id of the most recent
  `message_start` on the top-level stream;
- the assistant frame: `message.message.usage`, keyed by
  `message.message.id`.

Each input merges into the accumulator **field by field, taking the maximum**
of the stored and incoming value for each of the four counted fields. A
field that is absent, null, non-finite, or not positive contributes nothing.
After each merge, the accumulator's sum goes to `readRequest`. A new message
id starts a new accumulator, which keeps "the latest request wins" from D1.

*Why max rather than "delta overrides":* every counted field is cumulative
within one request. Max is therefore correct for a complete delta (GLM, MiMo)
and for a partial one (output only), and it is order-independent. That
matters because assistant frames carrying the start usage can arrive before
or after the delta without lowering the reading. An override would need
per-field null handling and would still lose to a later assistant frame
re-sending the start values.

*Why one accumulator rather than reading the delta separately:* two
independent `readRequest` calls for the same request would flip between the
start sum and the delta sum. One merged value per request avoids that.

*Alternative rejected: a GLM/profile switch.* Detecting the provider is
fragile, and the merge is already correct for every shape listed above.

### E2. Pure merge in `contextUsage.ts`, mapping in the driver

`contextUsage.ts` stays SDK-free. It gains a structural merge helper beside
`sumRequestUsage`, which takes the stored usage and an incoming slice and
returns the merged usage. The driver only finds the frame's message id and
usage, and calls the helper. Tests pin the frame shapes copied from the three
wire captures above, as the existing context tests do.

### E3. Usage capture runs before the turn gate, after the subagent gate

In `handlePartial`, the usage capture runs after the `isSubagentContentFrame`
check (D6: a Task tool's requests never move the parent meter) and **before**
the `activeTurnId` early return. Assistant-frame usage is read whatever the
turn state, and this matches it: trailing frames after an interrupt still
measure the live context.

The delta is keyed to its message by the most recent top-level
`message_start` id. That is the id `streamingMessageId` already tracks, but
`streamingMessageId` is only set when a turn is active. The capture therefore
keeps its own id, set before the gate. The two must not share one field, or
the transcript's id semantics would change.

### E4. A conversation reset also drops the accumulator

When `resetConversation` clears the tracker, the accumulator is cleared too.
Otherwise a late delta from the old conversation could republish a stale
reading into the new one.

## Risks / Trade-offs

- [A provider sends a cumulative field that later shrinks within a request]
  → Max keeps the larger value, which at worst over-reports by one request's
  noise. No observed provider does this.
- [Output tokens now count on Anthropic, where they were previously only the
  start's small value] → This is the D1 formula applied to complete data. The
  reading rises by the request's output, which the next request does pay for.
- [A delta arrives with no preceding `message_start` (an id is missing)] →
  Ignore it rather than guess which message it belongs to. The assistant-frame
  path still works for providers whose start usage is complete.
- [Extra work on a hot path: about 10k stream events per session] → Only
  `message_start` and `message_delta` events, roughly two per request, touch
  the accumulator. Publishing is already deduplicated by the tracker.

## Migration Plan

None. Stored readings are unchanged. GLM sessions start showing a meter on
their next model request after deploy. Rollback is a plain revert.
