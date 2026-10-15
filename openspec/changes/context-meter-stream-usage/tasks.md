# Tasks

## 1. Pure usage merge

- [ ] 1.1 Add an SDK-free per-request usage merge helper to `src/server/chat/contextUsage.ts` beside `sumRequestUsage` (design E1/E2). It takes the field-wise maximum of `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `output_tokens`, and ignores absent, null, non-finite, and non-positive values. Update the module header comment. Verify with new cases in `src/server/__tests__/chatContextUsage.test.ts`, using shapes copied from the wire captures: a GLM zero start followed by a complete delta gives the delta's sum; an Anthropic complete start followed by an output-only delta keeps the start's input and cache counts plus the delta's output; a MiMo start followed by a complete delta; and a start re-sent after the delta does not lower the sum.

## 2. Driver capture

- [ ] 2.1 In `src/server/chat/ChatSessionDriver.ts`, keep one per-message usage accumulator (latest message id plus merged usage), fed by top-level `message_start` and `message_delta` stream events and by assistant-frame usage. Each merge goes through the helper from 1.1, and the merged sum goes to `ChatContextTracker.readRequest`. A new message id starts a fresh accumulator. A delta with no known message id is ignored (design E1, Risks). Verify with `chatSessionDriver.test.ts` cases where a fake query streams GLM-shaped frames (zero-usage `message_start` and assistant frames, then a real `message_delta`): `onContextUsage` publishes the delta's sum against an injected context-usage report threshold. Existing context-meter driver tests still pass unchanged.
- [ ] 2.2 Run the stream-event usage capture after the `isSubagentContentFrame` check and before the `activeTurnId` gate in `handlePartial`. Track the capture's own message id, separate from `streamingMessageId` (design E3). Verify with driver tests: a subagent's `message_delta` leaves the reading unchanged, and a top-level `message_delta` arriving after the turn has ended still updates it.
- [ ] 2.3 Clear the accumulator wherever the driver applies `resetConversation` (design E4). Verify with a driver test: after a reset, a late delta for the previous message id publishes nothing, and the next request's usage publishes normally.
- [ ] 2.4 Refresh the `ChatSessionDriver.ts` header comment and the `readContextUsage` doc comment so they describe both usage sources, and verify `bun run lint && bun run typecheck` pass.

## 3. Integration check

- [ ] 3.1 Run `bun run lint && bun run typecheck && bun run test` and verify all pass.
- [ ] 3.2 On a dev server, run one turn in a GLM-profile chat. Verify that the header's context meter appears after the first model request and that the session's `context_tokens` column is non-null after the turn (read from a copy of the DB). Also run one turn on the default profile and verify its meter still reads within about 1% of the CLI's `/context` total.

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
