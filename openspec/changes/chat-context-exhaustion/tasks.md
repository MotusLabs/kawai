# Tasks

Groups 1–3 depend on nothing else and may land as their own PR. Group 5's usage block uses `dispatch-worker-choice`'s capacity read once that change has landed (design D6).

## 1. Failed results are failures

- [x] 1.1 Add optional `isError` and `terminalReason` to `turn_completed` in `src/shared/chat.ts`, and a shared `turnSucceeded(event)`. Verify unit tests for success, `is_error` under success, a non-success subtype, and old events without the fields.
- [x] 1.2 Set both fields in `ChatSessionDriver.handleResult`, and emit `error` naming the text and reason whenever `!turnSucceeded`. Verify a driver test that replays the incident frames (`subtype: success`, `is_error: true`, `terminal_reason: blocking_limit`, `<synthetic>` reply) and expects a failed completion plus an error event.
- [x] 1.3 Switch every success reader to `turnSucceeded`: the manager's `turnEnded` and `turnEnds.record` calls, and `TurnUsageTracker`. Verify tests where a `chat_turn_ends` row is `ok=0`, the `chat_turn_usage` outcome is failed, and limit outcomes see an unsuccessful turn.
- [x] 1.4 Map `isApiErrorMessage` assistant records to error events in `transcriptReplay.ts`. Verify a replay test with a recorded `Prompt is too long` reply.
- [x] 1.5 Confirm the morning summary and process metrics no longer count such turns. Verify `workspaceRead` and metrics tests with one failed-by-flag turn.

## 2. The context-exhausted flag

- [x] 2.1 Add the numbered migration for `chat_sessions.context_exhausted_at` and `context_exhausted_reason`, and thread them through `ChatSessionRecord` and the session wire type. Verify that `schemaBaselinePin.test.ts` gains the delta and that the db round-trip tests pass.
- [x] 2.2 Set the flag on a failed turn with a reason in `EXHAUSTING_REASONS`, and clear it on a compaction notice or a successful turn. Verify manager tests for each terminal reason (flagging and not), for persistence across restart, archive and restore, and for both clear paths.
- [ ] 2.3 Show the navigator badge and the chat header row (reason plus the `/compact` hint), both disappearing when the flag clears. Verify component tests and a `dev-browser` screenshot of a flagged fixture session.

## 3. Mail and routing respect the flag

- [x] 3.1 Exclude flagged sessions from group-mail eligibility while they still count toward caps, and list them in cap and no-eligible waiting reasons. Verify dispatcher tests: a longest-idle flagged member is skipped, and a `max: 1` group with a flagged member waits with the member named.
- [x] 3.2 Refuse direct mail and replies to a flagged session in `TeamMailbox.send`/`reply` and the human composer, before any restore. Verify mailbox tests where an agent reply and a human send are refused naming the flag, and an archived flagged session is not restored.
- [x] 3.3 Refuse Retry of a session-addressed `context-exhausted` dead letter while the session is flagged, and let a group-addressed one requeue as today. Verify `retryMessage` tests for both.
- [x] 3.4 Add the Mailbox label for `context-exhausted` in `waitingLabels.ts`. Verify the label test.

## 4. The exhaustion outcome

- [x] 4.1 Add `MailboxStore.deadLetterDelivered` (`delivered` → `dead`, with its history event), and expose the session's active work from `LimitOutcomes`. Verify store tests for the event row and the refusal from other states.
- [x] 4.2 Implement `contextExhaustion.ts` (design D4) and call it after `settleRecipient` for a flagged turn, skipping `LimitOutcomes.turnEnded`'s limit resolution. In one transaction it:
  - dead-letters the turn's mail, whether `delivered` or still `claimed`;
  - dead-letters queued direct mail to the session;
  - releases its parked work to the group;
  - marks a spawned member's pending release with reason `context-exhausted`.

  Verify by an integration test replaying the incident: the go mail ends `dead`/`context-exhausted`, a parked item returns to its group, and no `profile_limit_events` row is written.
- [x] 4.3 Confirm the pending release archives through readiness and journals on the task, waits for a running background task, survives a restart, and never touches human-created sessions. Verify member-release tests for those four cases.

## 5. Decision note and attention

- [x] 5.1 Build and send the decision note (recipient resolution, self-sender, tag, task, normal priority, once per episode) with the spec's facts. Use the capacity read when present, else today's per-profile usage and cooldown. Verify tests:
  - the note reaches the lead for a lead-dispatched task;
  - nothing is sent when the dispatcher is the human, archived, killed, or flagged;
  - the body lists the dropped id, digest, claim commit, HEAD (or "unknown"), acknowledgement state, and each provider's usage and cooldown;
  - a repeated evaluation sends no second note.
- [x] 5.2 Project the `context-exhausted` attention item (identity, owner, cause, impact, next action, resolution rules) in `workspaceRead.ts`, and render it. Verify read-model tests for each resolution path (newer dispatch, task closed, retry or discard, flag cleared, kill), the needs-you case for a human-created session, and one toast per episode.
- [x] 5.3 Update AGENTS.md (the success predicate, the flag, the exhaustion outcome, the note, the attention item) and the system prompt's mailbox note, so agents know what a `context-exhausted` note asks of them. Verify the prompt snapshot test, and that the doc names only shipped fields.

## 6. Integration

- [ ] 6.1 End-to-end on the development fixture: add a fixture turn that returns the incident's result frames, dispatch group task mail to a spawned member, and observe:
  - the failed turn and error row;
  - the flag badge;
  - the `context-exhausted` dead letter;
  - the member archived;
  - the lead's note;
  - the attention item, which resolves after a new dispatch.

  Verify with recorded screenshots, and that `bun run lint && bun run typecheck && bun run test` pass.

## Workflow follow-up

- Archive after review. If `dispatch-worker-choice` lands later, re-check D6's usage block against it before archiving.
