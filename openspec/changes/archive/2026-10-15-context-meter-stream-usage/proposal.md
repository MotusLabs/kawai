# Proposal

## Why

Chat sessions on GLM profiles (Z.ai's Anthropic-compatible endpoint) never
show the context meter. Only 1 of 40 `glm`/`glm-flash` sessions in the live
database has ever stored a reading, compared with 27/45 for `default` and 8/9
for `mimo`. GLM's stream sends `message_start.usage` as
`{input_tokens: 0, output_tokens: 0}` and puts the real per-request numbers
only in `message_delta.usage`. Claude Code builds its `assistant` frames from
`message_start`, so every one of them carries zeros. A wire log for
`chat-812b4222…` has 91 of 91 top-level assistant frames at zero. The driver
reads used tokens only from those frames, and the tracker drops a zero sum.
Used tokens therefore stay unknown and the meter never renders, even though
the context-usage report already supplies the threshold (967000).

## What Changes

- The driver reads per-request usage from the partial-message stream as well
  as from assistant frames. It merges `message_start` usage and later
  `message_delta` usage for the same message field by field. A delta field
  that is absent, null, or zero keeps the value from `message_start`, so a
  partial delta (for example, output tokens only) never lowers the reading.
- The merged sum goes to the existing context tracker as that request's used
  count. The latest request still wins (D1), and subagent stream events stay
  excluded (D6).
- Delta usage is read whatever the turn state, matching assistant-frame usage,
  so trailing frames after an interrupt still measure the live context.
- There are no changes to the threshold sources, persistence, the wire
  protocol, or the client meter.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: the requirement "Context usage tracks the conversation as
  it grows" gains scenarios for usage that arrives only with a request's final
  stream delta, and for a partial delta that must not lower the reading.

## Impact

- `src/server/chat/ChatSessionDriver.ts`: `handlePartial` / stream-event usage
  capture, with a per-message usage merge before the `activeTurnId` gate.
- `src/server/chat/contextUsage.ts`: a pure, SDK-free merge helper beside
  `sumRequestUsage`.
- Tests: `src/server/__tests__/chatContextUsage.test.ts` and
  `src/server/__tests__/chatSessionDriver.test.ts`, using frame shapes copied
  from the GLM, MiMo, and Anthropic wire captures.
- No database, protocol, or client changes. Existing Anthropic and MiMo
  readings are unchanged because their `message_start` usage is already
  complete and the merge never lowers it.
