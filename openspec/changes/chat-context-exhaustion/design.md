# Design

## Context

See proposal.md (Why) for the incident.

**Code paths, as observed on master `090d36d8`:**
- **Driver.** `ChatSessionDriver.handleResult` builds `turn_completed` from `message.subtype` alone. It emits `error` only for a non-success subtype, and ignores `is_error` and `terminal_reason`, though the SDK types carry both: `TerminalReason` names `prompt_too_long`, `blocking_limit`, and `rapid_refill_breaker` among others.
- **Manager fan-out on `turn_completed`.** `ChatSessionManager` calls:
  - `teamMail.settleRecipient`, which marks pushed claims delivered;
  - `teamMail.turnEnded(sessionId, subtype === 'success')`, which runs limit outcomes;
  - `turnEnds.record(..., subtype === 'success')`;
  - `TurnUsageTracker`, whose `ok` comes from `subtype === 'success'` in `chatTurnUsageStore.ts`.
- **Mailbox.** `MailboxStore.deadLetter` allows `queued`, `claimed`, `awaiting-request`, and `spawning` only. `retryMessage` requeues a dead letter to its original address and refuses killed recipients. `TeamMailbox.send` restores an archived direct recipient.
- **Member release.** Release rows are task-bound, durable `team_member_releases` rows. They are evaluated in the dispatcher's `beginCycle` through the one `readiness` definition, with `releaseNow` for immediate archives.
- **Attention.** Items are projected in `workspaceRead.ts`. `AttentionKind` is open-ended, `(string & {})`.
- **CLI 2.1.302 (read from the binary, not run).**
  - The pre-flight block skips compaction requests.
  - Manual and automatic compaction retry a too-long summary request up to three times, dropping the oldest messages each time.
  - A failed automatic compaction appends `· automatic compaction failed: …` to the error text.
  - `rapid_refill_breaker` is the "autocompact thrashing" stop, grouped with the context limits.

## Goals / Non-Goals

**Goals:**
- One success predicate that every reader uses.
- An exhaustion outcome that reuses mailbox, release, and attention machinery, without a new message state.

**Non-Goals:**
- Preventing exhaustion: context-meter warnings, auto-compaction policy, or a session-length limit.
- Sending `/compact` automatically.
- Changing limit outcomes for provider limits.
- A tool for agents to compact or restart peers.

## Decisions

### D1. One success predicate
- **Wire.** `turn_completed` gains optional `isError` and `terminalReason` (additive in `src/shared/chat.ts`). A shared `turnSucceeded(event)` is `subtype === 'success' && !isError`.
- **Readers.** The manager fan-out, `TurnUsageTracker`, `turnEnds.record`, and `turnEnded` all call it. Old stored events lack `isError`, so they read as before.
- **Driver.** It emits `error` when `!turnSucceeded`. The message is the result text plus the reason, e.g. `Prompt is too long (blocking_limit)`. `finalText` stays only on success.
- Rejected: rewriting `subtype` to an error subtype. It would misstate what the SDK said and break the debug view's fidelity.

### D2. Replay maps API-error replies
`transcriptReplay.ts` turns an assistant record with `isApiErrorMessage: true` into an error event, so a reloaded chat shows the failure the live chat showed.

### D3. The flag lives on `chat_sessions`
- **Storage.** One numbered migration (the next free number at landing) adds `context_exhausted_at TEXT NULL` and `context_exhausted_reason TEXT NULL`. `ChatSessionRecord` and the session wire type gain `contextExhausted?: { at, reason }`.
- **Set.** On a failed `turn_completed` whose `terminalReason` is in `EXHAUSTING_REASONS = ['prompt_too_long', 'blocking_limit', 'rapid_refill_breaker']`.
- **Cleared.** On the driver's compaction notice (`notice` of kind `compacted`), or on a `turn_completed` that succeeds.
- **Restart.** Nothing re-derives the flag at startup; the column is the truth.

### D4. The exhaustion outcome runs after mail settlement, beside limit outcomes
- **Module.** A new `src/server/team/contextExhaustion.ts`, not a branch inside `LimitOutcomes`, because nothing of the limit policy applies (see the context-exhaustion-recovery spec). The manager calls it after `settleRecipient`, for a flagged turn. In one transaction it:
  1. dead-letters the message this turn delivered — the work `LimitOutcomes` tracks as active for the session, read through an exported accessor — to `dead` with reason `context-exhausted`. The message is `delivered`, or still `claimed` when its transcript receipt has not been confirmed yet; `deadLetter` already covers `claimed`. A narrow `MailboxStore.deadLetterDelivered(id, reason)` transition covers `delivered`, so the general `deadLetter` keeps its states;
  2. dead-letters queued direct mail to the session (`deadLetterDirectTo`, reason `context-exhausted`);
  3. releases parked work the session holds to its group (`store.release`, replacing the resume);
  4. for a spawned member with a task, marks a pending release with reason `context-exhausted`.
- **After commit.** It sends the decision note (D6). The dispatcher's next `beginCycle` archives the member once ready, journaling as member release does.
- **Order with limit outcomes.** A flagged turn does not also call `LimitOutcomes.turnEnded` with a pending limit event. The exhaustion outcome supersedes it, because the work is already settled.

### D5. Sending and retrying respect the flag
- **Send.** `TeamMailbox.send`, `reply`, and the human composer refuse a session target that is flagged, before the restore step, so mail never revives a flagged archived session.
- **Retry.** `retryMessage` gains a `recipientFlagged` host check for session-addressed dead letters with reason `context-exhausted`.
- **Group mail.** A group-addressed retry requeues as today, and D7's eligibility rule keeps it off the flagged member.

### D6. The decision note
- **Recipient.** The outstanding assignment's `created_by` agent session, else the task creator's session. It is skipped when that is the human, killed, archived, or flagged.
- **Sender.** The note follows the precedent of kawai's resume and handoff notes: `fromSession` is the recipient itself, `tags: ['context-exhausted']`, the task id, normal priority. A reply therefore never targets the flagged session.
- **Body.** The facts listed in the spec. The progress digest and claim commit come from `LimitOutcomes`' digest and the message's `claimCommit`. HEAD comes from `git rev-parse HEAD` in the session's worktree; if that fails it reads "unknown". The acknowledgement comes from `team_task_acknowledgements`.
- **Usage block.** Provider usage and cooldowns come from `dispatch-worker-choice`'s capacity read. Without that change, this block is the per-profile usage and cooldown kawai holds today.
- **Replay safety.** It is sent once per flagged episode, keyed by session and flag time.

### D7. Routing eligibility
- **Eligibility.** The dispatcher's member eligibility treats a flagged session like a parked one, so it is not a candidate. It still counts in `buildCandidates`' live counts until archived.
- **Waiting reason.** `no-eligible-member` and cap constraints list the flagged member in `sessionIds` with detail `context-exhausted`.

### D8. Attention item
- **Shape.** Kind `context-exhausted`, source id `<sessionId>:<flaggedAt>`, so a later episode is a new identity and toasts again.
- **Owner.** The note's recipient (waiting on agents), else the human (needs you).
- **Resolution.** It is derived at read time from the session flag and the dead letter's state, against the task's newest assignment `created_at`. Nothing is stored, matching the read model's rule.

### D9. UI
- **Navigator.** A badge "Context exhausted".
- **Chat header.** A row in the header's task/paused slot with the reason and the hint "Run /compact or start a new session".
- **Mailbox.** A label for the dead-letter code: "The recipient's context was exhausted; the message was not processed".

## Risks / Trade-offs

- [A turn fails with an exhausting reason after real work was done] → The note carries the digest and HEAD, and the worktree keeps the changes. The dispatcher decides whether a fresh member inspects them first; the instruction template from forwards ("inspect first") is reused in the note.
- [The CLI changes terminal-reason names] → `terminalReason` is stored verbatim. Unknown reasons never flag, so the failure mode is today's behavior plus a correct failed turn.
- [`/compact` may itself fail on a proxied provider] → The flag stays, and the human can still kill the session or redispatch. Kawai never retries compaction.
- [Refusing replies to a flagged sender surprises an agent] → The refusal names the flag and points to the task's dispatcher, which already holds the decision note.
- [Auto-release removes the "compact and continue" option for spawned members] → This is the human's chosen trade-off. Restore plus `/compact` remains available, since the flag survives the restore and clears on the compaction boundary.

## Migration Plan

- **Migration.** One numbered migration adds the two nullable session columns. Old rows read as not flagged.
- **Wire.** The fields are additive, so older clients ignore them.
- **Rollback.** Restore the pre-migration backup. The database-safety rules refuse an older build on a newer database.
- **Landing.**
  - D1–D3 (the success predicate, replay, the flag and its display) do not depend on `dispatch-worker-choice` and may land first.
  - D6's usage block uses the capacity read once that change has landed.
