# Tasks

## 1. Stall derivation (design D1)

- [ ] 1.1 Add `src/shared/taskStall.ts` with `stallOf(input)` and the exported
  constants `STALL_MESSAGE_THRESHOLD = 10` and `STALL_ELAPSED_MS = 3 h`.
  Commit tables SN and AN verbatim as table-driven tests in
  `src/shared/__tests__/taskStall.test.ts`. Verify by running that file:
  - SN1 and the boundary rows (count exactly 10, elapsed exactly 3 h) kill
    `>=` → `>` on either threshold;
  - SN2 and SN3 kill "either threshold suffices";
  - SN5 kills "ignore the owned flag";
  - SN6 kills "notice blocked tasks";
  - AN4 kills "the anchor ignores counted reviews" and "count an uncounted
    review";
  - AN6 kills "count system mail";
  - AN5 kills "the notice does not anchor";
  - AN7 kills ">=" for ">" on the mail-after-anchor test, AN8 pins the
    tie order, and AN9 pins the skewed-row handling.
- [ ] 1.2 Add `@covers` annotations for the spec's "A stall episode is
  measured from the task's last progress" and "A notice is sent when both
  thresholds are met" scenarios above the tests from 1.1. Verify that
  `scripts/__tests__/specCoverageGuard.test.ts` passes.

## 2. Schema (design D3)

- [ ] 2.1 Add `src/server/team/taskStallSchema.ts` and register the
  `task-stall-notices` migration after `review-convergence` in
  `src/server/dbSafety/migrations.ts`. Update `schemaMigrations.test.ts` and
  `schemaBaselinePin.test.ts`. Verify that both pass and that a migrated
  copy of a pre-change database has the empty table.

## 3. Notice module and wiring (design D2, D4)

- [ ] 3.1 Add `MailboxStore.subscribeEnqueued(listener)`, called only from
  `enqueue`, and test in `src/server/__tests__/mailboxStoreEnqueued.test.ts`
  that it fires once per enqueue and never for claim, push, or delivery.
- [ ] 3.2 Add `src/server/team/taskStallNotices.ts`. It subscribes to
  `subscribeEnqueued` and keeps per-task candidate message ids. It flushes
  once via `setImmediate`, evaluating each candidate task in its own
  `store.immediate` transaction: the trigger check (a durable, counted
  candidate after the anchor), `stallOf`, then `emitStallNotice(store,
  episode)` (`INSERT OR IGNORE`, then the journal and creator message only
  when a row was inserted). Errors are caught per task. Commit tables TR
  and EF verbatim in `src/server/__tests__/taskStallNotices.test.ts`.
  Verify:
  - TR2 (10 old counted mails gathered at 40 min; at 3 h an eleventh
    enqueued inside a transaction that rolls back) kills "skip the trigger
    check";
  - TR3 (a real claim and delivery of an old message at 3 h) kills "listen
    on `subscribe`";
  - TR4 kills "Kawai mail is a candidate";
  - EF1 and EF2 kill "message the human creator" and "skip the journal";
  - EF3 hands the same derived episode to `emitStallNotice` twice,
    snapshots the rows, journal, and mail, and kills "bypass the
    `changes === 0` guard";
  - EF4 (not due, through the composition) kills "emit when not due";
  - a separate composition replay (duplicate flushes after a notice) adds
    nothing, and claims no mutant.
- [ ] 3.3 Wire the module in `src/server/team/sessionMailbox.ts`, with
  `ownedByExecution` from `TaskResultService`, and unsubscribe on shutdown.
  Add test A2 through the production `SessionMailbox`: ten counted messages
  past 3 h on an agent-created task produce one row, one journal entry, and
  one `task-stall` message. Verify it kills "subscription removed".
- [ ] 3.4 Add `@covers` annotations for "The notice is journaled and sent to
  a session creator" and the trigger scenarios above the tests from
  3.2–3.3. Verify the coverage guard
  passes.

## 4. Episodes and properties (spec "Each episode sends at most one notice")

- [ ] 4.1 Add `src/server/__tests__/taskStallProperties.test.ts` with P1 and
  P2: seed `0x57A11`, 300 cases. The sequences mix mail (some inside a
  rolled-back outer transaction), revisions, results, counted reviews, clock
  advances, duplicate listener calls, and a dropped flush. The reference
  model replays `stallOf`. Verify that both properties hold, and that a
  mutant dropping the primary key's `anchor_at` (one notice per task ever)
  fails P1 against the model.
- [ ] 4.2 Add the restart scenario: a notice is written, then a new
  `SessionMailbox` is built over the same database, and one more counted
  message produces no notice. Keep it as the post-notice restart dedupe
  test. Verify that it passes.
- [ ] 4.3 Add the dropped-flush recovery test (contract A5). Commit a
  threshold-crossing counted message with the pending flush suppressed
  (dispose the module before `setImmediate` runs). Rebuild `SessionMailbox`
  over the same database and assert zero notice rows, journal entries, and
  `task-stall` messages. Send the next counted message, and assert exactly
  one row, journal entry, and creator message whose `anchor_at` and
  `anchor_kind` are the original progress anchor. Then replay a flush and
  assert the effects are unchanged. Verify that it kills "recovery keyed on
  the notice anchor" and "skip the trigger check on the recovering
  message". Add `@covers` for the episode scenarios, and verify the coverage
  guard passes.

## 5. Docs (design Implementation contract A4)

- [ ] 5.1 Add a "Task stall notices" bullet to `docs/architecture/tasks.md`.
  Add the notice and its options to "Keep advisory checkpoints separate from
  final review" in `docs/agent-collaboration.md`. Verify that
  `reviewProtocolDocs.test.ts` and `contractDocs.test.ts` still pass.
- [ ] 5.2 Add a `docs/recovery-matrix.md` row: "The server stops between a
  task message's commit and the stall evaluation". Its mechanism is that the
  next counted message re-evaluates from the original anchor, and the
  `(task_id, anchor_at)` key guards a re-handed episode. Cite the 4.3 test. Verify that `recoveryMatrix.test.ts` passes.

## 6. Integration

- [ ] 6.1 Run `bun run check` on the clean committed tree and record the
  pass in the result, with each SN, AN, TR, and EF id mapped to its test title
  and killed mutant.

## Workflow follow-up

- Archive the change after its formal review passes, and verify that every
  scenario in `openspec/specs/task-stall-notices/spec.md` keeps an
  `@covers` annotation.
