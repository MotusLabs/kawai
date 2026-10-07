# Proposal

## Why

The chat Debug panel lists every captured protocol frame as its own row. With
partial messages enabled, one streamed response produces hundreds of
`stream_event · content_block_delta` frames. A real 35k-frame session had runs
of up to 858 consecutive deltas, which buries the frames a user is actually
looking for (control requests, results, lifecycle) under scroll. Collapsing
those runs makes the panel readable without dropping any frame.

## What Changes

- Consecutive frames with the same direction and message type show as one
  group row in the Debug panel. The row shows the count, the sequence range,
  and the time range.
- Expanding a group lists its member frames as today's rows. Each member still
  expands to pretty JSON and copies its exact raw line.
- Thinking deltas alternate with `system · thinking_tokens` frames, so a
  `thinking_tokens` frame does not break a delta run. It is counted inside the
  group and stays in sequence order when the group is expanded. Without this,
  thinking, about 75% of the frames in the sample session, would never group.
- A frame that has no matching neighbour renders as a plain row, as it does
  today.
- A group that is still receiving frames grows in place instead of adding a
  row per frame, and its expanded or collapsed state survives live updates and
  "Load older".
- An expanded group offers "Copy all", which copies its members' raw lines in
  sequence order, one per line.

Not changing: capture, storage, the wire messages between server and client,
paging, and the 5000-frame client cap. Grouping is display-only.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-debug`: adds a requirement that consecutive frames of the same type
  are shown as one expandable group in the debug view.

## Impact

- `src/client/utils/chatWireFrames.ts`: a pure grouping helper next to
  `frameLabel`.
- `src/client/components/chat/ChatDebugPanel.tsx`: renders groups, plus the
  expanded state for groups and members.
- Tests: `src/client/__tests__/chatWireFrames.test.ts` and the debug view tests
  in `src/client/__tests__/chatComponents.test.tsx`.
- No server, protocol, or storage changes.
