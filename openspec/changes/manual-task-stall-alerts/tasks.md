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
  - AN5 kills "the notice does not anchor".
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

- [ ] 3.1 Add `src/server/team/taskStallNotices.ts`. It subscribes to
  `MailboxStore` and keeps the pending set. It flushes once via
  `setImmediate`, evaluating each pending task in its own `store.immediate`
  transaction (`INSERT OR IGNORE`, then the journal and creator message only
  when a row was inserted), and catches errors per task. Commit table EF
  verbatim in `src/server/__tests__/taskStallNotices.test.ts`. Verify:
  - EF1 and EF2 kill "message the human creator" and "skip the journal";
  - EF3 snapshots the rows, journal, and mail around a replayed
    evaluation, and kills "bypass the `changes === 0` guard";
  - EF4 kills "notice when not due";
  - a message enqueued inside an outer transaction that rolls back
    produces no evaluation effect.
- [ ] 3.2 Wire the module in `src/server/team/sessionMailbox.ts`, with
  `ownedByExecution` from `TaskResultService`, and unsubscribe on shutdown.
  Add test A2 through the production `SessionMailbox`: ten counted messages
  past 3 h on an agent-created task produce one row, one journal entry, and
  one `task-stall` message. Verify it kills "subscription removed".
- [ ] 3.3 Add `@covers` annotations for "The notice is journaled and sent to
  a session creator" above the tests from 3.1–3.2. Verify the coverage guard
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
  message produces no notice. Add `@covers` for the episode scenarios.
  Verify the tests and the coverage guard pass.

## 5. Docs (design Implementation contract A4)

- [ ] 5.1 Add a "Task stall notices" bullet to `docs/architecture/tasks.md`.
  Add the notice and its options to "Keep advisory checkpoints separate from
  final review" in `docs/agent-collaboration.md`. Verify that
  `reviewProtocolDocs.test.ts` and `contractDocs.test.ts` still pass.
- [ ] 5.2 Add a `docs/recovery-matrix.md` row: "The server stops between a
  task message's commit and the stall evaluation". Its mechanism is that the
  next counted message re-evaluates, and the `(task_id, anchor_at)` key
  replays. Cite the 4.2 test. Verify that `recoveryMatrix.test.ts` passes.

## 6. Integration

- [ ] 6.1 Run `bun run check` on the clean committed tree and record the
  pass in the result, with each SN, AN, and EF id mapped to its test title
  and killed mutant.

## Workflow follow-up

- Archive the change after its formal review passes, and verify that every
  scenario in `openspec/specs/task-stall-notices/spec.md` keeps an
  `@covers` annotation.
