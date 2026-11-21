# Tasks

Every oracle below is planned work for the implementation; none is coded or
passed by this proposal. Test files named here do not exist yet, except
`src/server/__tests__/schemaMigrations.test.ts`,
`teamWorkspaceRead.test.ts` and `teamWorkspacePlanAttention.test.ts`,
which gain rows. Each Verify bullet names the oracle ids it covers and the
mutant it must kill; the result maps each oracle id to a test title and a
killed mutant.

## 1. Bind the oracles before production code

- [ ] 1.1 Journal the mechanism challenge note (`docs/agent-collaboration.md`, "Challenge the mechanism before substantial coding") covering D3's server-written association and reserved key prefix, D4's store-level stale and close hooks, D6's in-transaction wakeup, D7's sweep and its `SessionMailbox.start()` hook, and D1's numbered migration, and record the Lead's proceed/revise decision. Verify: the note id and the Lead's decision are in the task journal before any file under `src/` changes.
- [ ] 1.2 Commit A1: every H partition, W, F and S (rows and transitions) with their inputs and every output `?`, plus U1–U7, W-U1 and the DF fixtures (seeded states and commands), in `openspec/changes/owner-publication-handoff/oracles-blind.md`. Verify: the commit touches only that file and every output cell reads `?`.
- [ ] 1.3 Have an advisor from another model family fill the outputs from the delta specs alone; commit A2 with the author's outputs, diff the two readings, and resolve each disagreement in the design's tables. Verify: the diff and each resolution are journaled; design.md's tables equal the resolved readings.
- [ ] 1.4 Record the Lead's binding of the resolved oracles. Verify: a journal note names the binding commit; no production commit precedes it.

## 2. Handoff schema and store

- [ ] 2.1 Add `taskHandoffMigration` in `src/server/team/taskHandoffSchema.ts` (D1's tables, partial unique indexes, wakeup key, nullable `team_task_drafts.handoff_id` and `team_task_revisions.handoff_id`) appended to `MIGRATIONS` in `src/server/dbSafety/migrations.ts`, never the baseline or a constructor, and `src/shared/taskHandoffs.ts` (states, canonical payload hash). Verify: `src/server/__tests__/taskHandoffMigration.test.ts` shows a fresh database and one at the previous version both reach the new version with the tables and columns, a failing `up` rolls back leaving the previous version and its `pre-migration-<n>` backup, and a second pending insert for one task fails (U2); `schemaMigrations.test.ts` still records every known version; mutants: dropping the partial index fails U2, and MU18 (migration placed in the baseline) fails the previous-version row.
- [ ] 2.2 Add `src/server/team/taskHandoffStore.ts` with guarded transitions (`state IN ('open','stale')`) and the append-only event rows. Verify: rows for U4 and U5 in `src/server/__tests__/taskHandoffStore.test.ts`; mutant: an unguarded `UPDATE` fails them.
- [ ] 2.3 Document the handoff record in `docs/architecture/tasks.md` (a new "Task publication handoffs" bullet). Verify: the bullet names the tables, states, the association as the only fulfillment proof, and the D3/D4 transaction rules.

## 3. Request path and the minimal owner-visible item

- [ ] 3.1 Add `task_request_publication` (D2, D10 limits, base-commit check with `cleanGitEnv`, request-key replay) to `taskTools.ts` and a `taskHandoffService.ts`. Verify: partition H-REQ (H1–H11, in its check order, including combined failures such as a closed task with a stale base reading H3) committed verbatim in `src/server/__tests__/taskHandoffCommands.test.ts`; mutants: widening the requester right to any agent fails H5, and MU14 (replay compares only the key) fails H10's whole-row snapshot.
- [ ] 3.2 Add the minimal W2 attention source (an `open` handoff on a task with no live agent owner) in `handoffAttention.ts`, registered in `workspaceRead.ts`. Verify: a W2 row in `src/server/__tests__/taskHandoffAttention.test.ts`; mutant: removing the registration fails CP1's snapshot assertion in 4.2.
- [ ] 3.3 Production-path checkpoint CP1, request half: through the real chat-session composition's `kawai-team` tool server, a Lead session's request records the handoff, the team workspace snapshot over the real WS connection lists W2, and a stale-base request is refused. Verify: `src/server/__tests__/taskHandoffConnections.test.ts`; mutant MU9 (tool not registered) fails it. Journal the checkpoint (base/head, paths, checks) before 4.x.

## 4. Publish path

- [ ] 4.1 Split `TaskService` publication into D3's ordinary entry (`publish`, whose first step computes the canonical key `requestKey?.trim() || undefined` once and refuses it when it starts with `handoff:` before reading the draft or any handoff, looking up a replay or writing, then uses only that key for lookup and storage, with no linked-draft exemption, and which only then attaches the draft's `handoff_id`) and the prepared entry (`publishHandoff`, which builds `handoff:<id>` and takes no caller key) over one internal routine with the in-transaction association and transition in the `within` callback; add `task_amend { handoff_id }` and the human commands `team-task-handoff-publish { handoffId }` and `team-task-handoff-load-draft` (router whitelist in `chatConnectionTypes.ts`, `src/shared/types.ts`). Verify: partitions H-PUB and H-DRAFT and row H33 in `taskHandoffCommands.test.ts`, including both collision traces (a plain ordinary publish and a linked-draft publish with H's derived key while H is open are refused by H33 and H33d; H and the draft stay unchanged), the whitespace variants (` handoff:H`, `\thandoff:H\n`, `handoff:H  `) on both entries refused with no revision, handoff or draft change, and a padded ordinary key published and stored trimmed as today (H39) and the cross-command rows (linked then prepared reads H16b; prepared then linked reads H38s), and DF6 in `taskHandoffDefensive.test.ts`; mutants: MU1 (random publish key) fails H14, MU1b (fulfillment read from the key) fails DF6, MU1c (prefix check removed) fails H33 and H33d, MU1d (linked-draft exemption) fails H33d, MU1f (prefix check on the raw key) fails the whitespace variants of H33 and H33d, MU1e (linked publish writes the derived key) fails H16b, and MU4 (any agent publishes) fails H13.
- [ ] 4.2 Production-path checkpoint CP1, publish half: over the real WS connection, the human publishes the handoff from 3.3 as revision 2, one notice reaches the claimed holder, one message reaches the requester, the next workspace snapshot no longer lists W2, a resent command replays, and an ordinary `team-task-publish` with a `handoff:` key is refused, with or without a linked draft (H33, H33d), leaving W2 listed. Verify: `taskHandoffConnections.test.ts`; mutants MU9 (command missing from the whitelist) and the W2 registration removal each fail it. Journal the checkpoint.

## 5. Staleness, closing, and dispositions

- [ ] 5.1 Add D4's stale hook in `TaskStore.publish` and the close hook in both `setStatus` and `prepareStatus` status transactions, `task_settle_publication`, and the human `team-task-handoff-decline` command. Verify: partitions H-OTHER, H-SETTLE and H-CLOSE (H20–H27, H39, H40) in `taskHandoffCommands.test.ts`; mutants: MU2 (stale hook removed) fails H20 and MU13 (close hook removed from either path) fails H27 or H28b.
- [ ] 5.2 Prove neutral events settle nothing and that an override settles a handoff only through its task's cancellation: decision answer, own call, override with and without cancelling the handoff's task (`prepareOverrideFix`), notes, mail, elapsed time, archival and exhaustion. Verify: H28 and H28b rows and property P3 (seed `0x0A11CE03`, 200 cases) in `src/server/__tests__/taskHandoffProperties.test.ts`; mutant MU5 (a card decision publishes the handoff) fails both.

## 6. Wakeups

- [ ] 6.1 Add D6's in-transaction system message and wakeup row for `published`, `declined`, `stale` and `closed`, with recipient resolution (live requester, else its group). Verify: rows for each transition and recipient case in `src/server/__tests__/taskHandoffWakeups.test.ts`, and property P1 (seed `0x0A11CE01`, 400 cases) in `taskHandoffProperties.test.ts`; mutants MU10 (wakeup key dropped) fails P1 and MU7 (liveness always live) fails the gone-requester row.

## 7. Restart reconciliation

- [ ] 7.1 Add D7's sweep and call it from `SessionMailbox.start()` after `reconcileMailbox` and before `dispatcher.release()`, with its `docs/recovery-matrix.md` row citing the CP3 test. Verify: partition H-RESTART (H29) and model-based property P4 (seed `0x0A11CE04`, 200 cases, command sequences whose states all have an empty reason set, a crash at each named transaction boundary, H as reference model, restart through `SessionMailbox.start()`, both collision traces ending with H still `open`) in `src/server/__tests__/taskHandoffRecovery.integration.test.ts`, and Table DF (DF1–DF5 through the sweep) in `src/server/__tests__/taskHandoffDefensive.test.ts`, which first classifies each fixture with the completeness classifier as excluded with its complete reason set (DF5 `{U1, U3, U5}`, DF4b `{U3, U6}`) and no H row, then asserts its repair; `recoveryMatrix.test.ts` resolves the new row; mutants MU3 (transition after commit) fails P4, MU1c fails P4's collision traces, and MU1b fails DF4a and DF4b.
- [ ] 7.2 Production-path checkpoint CP3: boot the production composition (`ChatSessionManager` starting `teamMail`) over a database seeded with DF3's fixture beside a healthy `open` handoff with a current base; after start the first reads `stale` with one wakeup mail dispatched and the second stays `open` with no mail. Verify: a CP3 test in `taskHandoffRecovery.integration.test.ts`; mutant MU17 (the sweep's call removed from `SessionMailbox.start()`) leaves the first `open` with no mail. Journal the checkpoint.
- [ ] 7.3 Add the H completeness test enumerating each partition's axis product against its rows and U1–U7 in `src/server/__tests__/taskHandoffCompleteness.test.ts`, over the full declared axis product with no tuple prefiltered: an empty reason set must match exactly one H row; a nonempty set (several reasons are valid) must match no H row and is kept whole as one excluded classification. Verify: it fails when one row is removed (gap), when two rows are made to overlap, and under MU19's negative control (a DF tuple added as an H-RESTART row overlaps `{U3}`); MU19's positive control (classifier keeps only the first reason) fails DF5's and DF4b's reason-set assertions; journal all four controls.

## 8. Attention

- [ ] 8.1 Extend `handoffAttention.ts` to every W row with `handoffPhase` from `src/shared/taskHandoffs.ts` (D5's order: task-closed, acknowledged, no-holder, delivered-awaiting-ack, notice-uncertain, notice-queued, notice-failed, not-notified), the `kawai` attention owner kind, and link anchors (W9 links the uncertain message). Verify: W1–W13 with W12d committed verbatim in `taskHandoffAttention.test.ts`, with rows for close without acknowledgement (W5), acknowledgement after a failed notice (W6), a failed notice followed by ordinary task mail delivering the revision (W12d: holder wait, no Retry notification) and an uncertain notice (W9); mutants: MU15b (delivered after failed) fails W12d, MU6 (only `open` kept) fails W3/W4, MU7 fails W2, MU15 (failed before acknowledged, or no task-closed) fails W5/W6, and MU16 (uncertain read as failed) fails W9.
- [ ] 8.2 Resolve fixes-requested owners per table F in `attentionAcceptance.ts`. Verify: F1–F5 in `taskHandoffAttention.test.ts`, and the existing `teamWorkspaceRead.test.ts` acceptance rows still pass; mutant MU7 fails F2–F5.
- [ ] 8.3 Suppress `amendItems` for a task with a pending handoff. Verify: S3 and S4 rows in `teamWorkspacePlanAttention.test.ts` (the existing "after Amend" test unchanged and passing); mutant MU12 fails S3.
- [ ] 8.4 Add properties P2 (seed `0x0A11CE02`, 400 cases), P6 (seed `0x0A11CE06`, 200 cases) and P7 (seed `0x0A11CE07`, 200 cases): P7a suppression over every history, including the always-generated publish without notify → `task_get` → acknowledge-without-delivery trace, and P7b parity only for an open task with a live claimant below the published acknowledgement, counting the new notification rows the real `TaskNotices.notify` writes with a fresh key on a database copy. Verify: all pass in `taskHandoffProperties.test.ts`, P2 with table W as the reference model; mutant MU6 fails P2, MU15 fails P6, MU15c fails P7a, and MU15b and MU16b fail P7b.
- [ ] 8.5 Update `docs/architecture/team-page.md` for the two attention kinds, the follow-up order, and the `kawai` owner. Verify: the bullet names W's owners and next actions, including the Mailbox route for an uncertain notice.

## 9. Supervision

- [ ] 9.1 Add the `owner-publication` wait (appended last in `stageWaits`), the loader's `handoff` facts, and `holderGone` on stall items and the report. Verify: S1, S2, S5, S6 and transitions S7, S9, S10 in `src/server/__tests__/supervisionOwnerPublication.test.ts`; mutant MU8 (wait not appended) fails S1 and S9.
- [ ] 9.2 Prove the post-Amend path end to end: S8 (publishing the handoff closes the diagnosis, dispatches one fix attempt naming the new revision, backstop zero, no **Publish a task revision** item) through the execution runtime's revision handling. Verify: an S8 row in `supervisionOwnerPublication.test.ts`; mutant: dropping the association-independent "any new revision closes the diagnosis" path fails it.
- [ ] 9.3 Add property P5 (seed `0x0A11CE05`, 200 cases) comparing scheduler admission, parallel counts, dependency waits and slot holder with and without handoffs. Verify: it passes; mutant MU11 (the wait frees the slot) fails it.
- [ ] 9.4 Production-path checkpoint CP2 through the real supervision monitor and loader: archived holder plus open handoff reads `owner-publication`, no stall-alert row, W2 and no Lead stall item. Verify: `supervisionOwnerPublication.test.ts`; mutant MU8 fails it. Journal the checkpoint.
- [ ] 9.5 Update `docs/architecture/plan-supervision.md` for the wait and `holderGone`. Verify: the bullet names the append-only position and that the scheduler never reads the wait.

## 10. Agent reads and guidance

- [ ] 10.1 Add `handoffs` rows and `handoff_id` to `task_get` (`taskReadWindows.ts`), the pending-handoff line in delivered task context (`taskContext.ts`), and the guidance in `teamPrompt.ts` and the `decision_ask` description. Verify: `src/server/__tests__/taskHandoffRead.test.ts` covers bounded rows, the whole read, team scoping, and that the delivered direction stays the published revision's; mutant: rendering the handoff text as the direction fails it.

## 11. Human surface

- [ ] 11.1 Add the handoff panel (`TaskPublicationHandoff*.tsx`) in `TeamTaskDetail.tsx`, reusing `TaskDirectionEditor.tsx`'s diff and contract view, with **Publish prepared revision**/**Publish and notify**, **Edit before publishing** (replace confirmation) and **Decline** (reason required), and `teamTaskStore.ts` commands with client command keys outside the reserved prefix. Verify: `src/client/__tests__/taskPublicationHandoff.test.tsx` covers each action's request payload and key, the replace confirmation, and the disabled states for stale and ended handoffs; mutant: sending the publish without the handoff id fails it.
- [ ] 11.2 Verify the panel and the attention links in a real browser against a disposable checkout, database and spare port using CI's fixture setup (never `bun run test:e2e` against live data). Verify: screenshots or a Playwright run log attached to the journal.

## 12. Integration

- [ ] 12.1 Run `bun run check` on the clean committed head with the pinned Bun and `scripts/verify-result.ts --commit <head> --coverage <map>`, with the map citing each oracle id's test title and killed mutant. Verify: both exit codes and the map are in the result.

## Review reproductions (planned rows)

The proposal review's counterexamples (findings-6e7d3c2c) are carried as
planned oracle rows; each is coded with its group's tests.

| Finding | Counterexample | Planned rows and mutants |
| --- | --- | --- |
| F1 | an ordinary publication with a handoff's derived key, then restart, marks the handoff published | H33, H34, H34r, U6, P4 collision trace; MU1b, MU1c |
| F2 | schema created outside the numbered migration, rollback claimed without the backup | task 2.1 migration rows; MU18; design Migration Plan |
| F3 | follow-up after close, Retry after acknowledgement, uncertain sent to an agent | W5, W6, W9; MU15, MU16 |
| F4 | tied refusals, unloadable stale handoff, override closing a task | H-REQ order (H3 before H2), H37, H28b, U5; S7–S10 transitions |
| F5 | CP1 without owner visibility; recovery never wired into boot | tasks 3.2, 3.3, 4.2 (W2 in CP1), CP3 with MU17 |

The second review's counterexamples (findings-0854c403; F2 and F5 there
were resolved) are carried the same way, under the reopened mechanism of
the design-reopen journal.

| Finding | Counterexample | Planned rows and mutants |
| --- | --- | --- |
| F1 | load H into the draft, edit, publish it through the ordinary route with H's reserved key; the inferred association bypassed H33 and a later prepared publish replayed the edited revision | H33d (refused before any read; H open), H16b (linked then prepared), H38s (prepared then linked), H17r; CP1 failure path; MU1c, MU1d, MU1e (tasks 4.1, 4.2) |
| F3 | R2's notice dead-letters, later task mail delivers R2 to the same claimant, no acknowledgement; the item offered Retry notification and `notify` wrote nothing | W12d (delivered-awaiting-ack ahead of uncertain and failed), P7 against the real `notify`; MU15b, MU16b (tasks 8.1, 8.4) |
| F4 | sweep rows H31a, H31b, H31c matched the same tuples as U1, U5, U3; the collision trace expected `stale` though H33 writes nothing | healthy H-RESTART is H29 only; Table DF (DF1–DF6) with its membership assertion; P4's collision traces end `open`; completeness fails on a row-and-claim overlap; MU19, MU1b (tasks 7.1–7.3) |

The third review's counterexamples (findings-7c473fea; F2 and F5 stay
resolved) are carried under the Lead's bound rules for F1, F3 and F4.

| Finding | Counterexample | Planned rows and mutants |
| --- | --- | --- |
| F1 | an ordinary or linked-draft publish with ` handoff:H` passed a raw-input prefix check, was trimmed, and was stored under the prepared key | canonical key computed once before classification, lookup and storage; H33 and H33d whitespace variants (leading space, tab/newline, trailing) refused with nothing written; padded ordinary key as today (H39); MU1f (tasks 4.1) |
| F3 | publish without notify, holder reads `task_get` and acknowledges without any delivery; global parity demanded **Notify** | P7a suppression (closed or acknowledged) over every history with that trace always generated; P7b parity only for an open task with a live claimant below the acknowledgement, counting new rows; MU15c (tasks 8.4) |
| F4 | DF5 satisfies U1, U3 and U5 at once; the completeness rule failed on "two claims" | full-product enumeration with one excluded classification keeping the whole reason set; DF reason sets asserted (DF5 `{U1, U3, U5}`, DF4b `{U3, U6}`) before repair; MU19 negative and positive controls (tasks 7.1, 7.3) |

## Scenario-to-test plan

Planned files are relative to `src/server/__tests__/` unless stated; every
row is future work.

| Spec requirement (scenarios) | Oracle ids | Planned test file |
| --- | --- | --- |
| task-publication-handoffs › Task authors may request an owner publication (3) | H1, H5, H6 | `taskHandoffCommands.test.ts`, `taskHandoffConnections.test.ts` |
| › A request is validated before it is recorded (5) | H2, H3, H4, H7 | `taskHandoffCommands.test.ts` |
| › A handoff records its exact provenance (2) | H1, H7 | `taskHandoffCommands.test.ts` |
| › Requests are idempotent under a request key (3) | H10, H11 | `taskHandoffCommands.test.ts` |
| › A task has at most one pending handoff (2) | H8, H9, U2 | `taskHandoffCommands.test.ts`, `taskHandoffMigration.test.ts` |
| › A handoff is never a revision (2) | H1, H19 | `taskHandoffRead.test.ts`, `taskHandoffCommands.test.ts` |
| › The publisher publishes a handoff with one action (3) | H12, H13 | `taskHandoffCommands.test.ts`, `taskHandoffConnections.test.ts` |
| › Editing before publishing still fulfills the handoff (4) | H17, H17r, H18, H37, H38 | `taskHandoffCommands.test.ts`, `src/client/__tests__/taskPublicationHandoff.test.tsx` |
| › A handoff is published at most once (6) | H14, H15, H16b, H33, H33d, H38s, DF6, P1 | `taskHandoffCommands.test.ts`, `taskHandoffRecovery.integration.test.ts` |
| › Another publication makes a pending handoff stale (2) | H20, H21, H8 | `taskHandoffCommands.test.ts` |
| › A handoff ends only by an explicit disposition (4) | H22, H24, H27, H28b | `taskHandoffCommands.test.ts`, `taskHandoffProperties.test.ts` |
| › Answers, time, and archival never settle a handoff (2) | H28, P3 | `taskHandoffProperties.test.ts` |
| › Each disposition wakes the next actor once (3) | D6 rows, P1 | `taskHandoffWakeups.test.ts` |
| › Handoffs survive restart and reconcile once (3) | H29, DF1–DF5, P4, CP3 | `taskHandoffRecovery.integration.test.ts`, `taskHandoffDefensive.test.ts` |
| › Agents read a task's handoffs (2) | A8 rows | `taskHandoffRead.test.ts` |
| team-workspace › The attention queue lists what needs a human or is waiting on an agent (11) | F1–F5; existing rows | `taskHandoffAttention.test.ts`, `teamWorkspaceRead.test.ts` |
| › The attention queue lists pending publication handoffs (6) | W1–W4, W13 | `taskHandoffAttention.test.ts` |
| › A published handoff stays visible until its holder acknowledges (9) | W5–W12, W12d, P7a, P7b | `taskHandoffAttention.test.ts` |
| plan-supervision › A pending publication handoff is a named wait (6) | S1, S2, S7, S9, S10, P5 | `supervisionOwnerPublication.test.ts` |
| › A pending handoff stands for the post-Amend item (3) | S3, S4, S8 | `teamWorkspacePlanAttention.test.ts`, `supervisionOwnerPublication.test.ts` |
| › A stall names a gone holder (1) | S5 | `supervisionOwnerPublication.test.ts` |

Each covering test carries its `// @covers:` annotation when it is written.

## Workflow follow-up

- Archive the change after review and acceptance, adding `@covers` annotations for every ADDED and MODIFIED scenario the archive leaves in the main specs.
- Verify the archived main specs pass `openspec validate --strict`.
