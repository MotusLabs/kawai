# Tasks

Every oracle below is planned work for the implementation; none is coded or
passed by this proposal. Test files named here do not exist yet. Each
Verify bullet names the oracle ids it covers and the mutant it must kill;
the result maps each oracle id to a test title and a killed mutant.

## 1. Bind the oracles before production code

- [ ] 1.1 Journal the mechanism challenge note (`docs/agent-collaboration.md`, "Challenge the mechanism before substantial coding") covering D3's in-transaction transition, D4's store-level stale hook, D6's in-transaction wakeup, and D7's sweep, and record the Lead's proceed/revise decision. Verify: the note id and the Lead's decision are in the task journal before any file under `src/` changes.
- [ ] 1.2 Commit A1: tables H, W, F and S with their inputs and every output `?`, plus the U1–U4 and W-U1 unreachable list, in `openspec/changes/owner-publication-handoff/oracles-blind.md`. Verify: the commit touches only that file and every output cell reads `?`.
- [ ] 1.3 Have an advisor from another model family fill the outputs from the delta specs alone; commit A2 with the author's outputs, diff the two readings, and resolve each disagreement in the design's tables. Verify: the diff and each resolution are journaled; design.md's tables equal the resolved readings.
- [ ] 1.4 Record the Lead's binding of the resolved oracles. Verify: a journal note names the binding commit; no production commit precedes it.

## 2. Handoff schema and store

- [ ] 2.1 Add `src/server/team/taskHandoffSchema.ts` (D1's tables, partial unique index, wakeup key, nullable `team_task_drafts.handoff_id`) migrated from `TaskStore`'s constructor, and `src/shared/taskHandoffs.ts` (states, canonical payload hash). Verify: `src/server/__tests__/taskHandoffSchema.test.ts` shows the migration is idempotent on a fresh and a legacy database and that a second pending insert for one task fails (U2); mutant: dropping the partial index fails it.
- [ ] 2.2 Add `src/server/team/taskHandoffStore.ts` with guarded transitions (`state IN ('open','stale')`) and the append-only event rows. Verify: table rows for U4 in `src/server/__tests__/taskHandoffStore.test.ts`; mutant: an unguarded `UPDATE` fails them.
- [ ] 2.3 Document the handoff record in `docs/architecture/tasks.md` (a new "Task publication handoffs" bullet). Verify: the bullet names the tables, states, and the D3/D4 transaction rules.

## 3. Request path

- [ ] 3.1 Add `task_request_publication` (D2, D10 limits, base-commit check with `cleanGitEnv`, request-key replay) to `taskTools.ts` and a `taskHandoffService.ts`. Verify: H1–H11 committed verbatim as table-driven tests in `src/server/__tests__/taskHandoffCommands.test.ts`; mutants: MU4-style widening of the requester right to any agent fails H5, and MU14 (replay compares only the key) fails H10's whole-row snapshot.
- [ ] 3.2 Production-path checkpoint CP1, request half: through the real chat-session composition's `kawai-team` tool server, a Lead session's request records the handoff and a stale-base request is refused. Verify: `src/server/__tests__/taskHandoffConnections.test.ts`; mutant MU9 (tool not registered) fails it. Journal the checkpoint (base/head, paths, checks) before 4.x.

## 4. Publish path

- [ ] 4.1 Add `handoffId` to `TaskPublishInput`, the in-transaction transition in the `within` callback, `task_amend { handoff_id }`, and the human commands `team-task-handoff-publish` and `team-task-handoff-load-draft` (router whitelist in `chatConnectionTypes.ts`, `src/shared/types.ts`). Verify: H12–H19 in `taskHandoffCommands.test.ts`; mutants MU1 (random publish key) fails H14 and MU4 (any agent publishes) fails H13.
- [ ] 4.2 Production-path checkpoint CP1, publish half: over the real WS connection, the human publishes the handoff from 3.2 as revision 2, one notice reaches the claimed holder, one message reaches the requester, and a resent command replays. Verify: `taskHandoffConnections.test.ts`; mutant MU9 (command missing from the whitelist) fails it. Journal the checkpoint.

## 5. Staleness, closing, and dispositions

- [ ] 5.1 Add D4's stale hook in `TaskStore.publish` and the close hook in the status transaction, and `task_settle_publication` plus the human `team-task-handoff-decline` command. Verify: H20–H27 in `taskHandoffCommands.test.ts`; mutants MU2 (stale hook removed) fails H20 and MU13 (close hook removed) fails H27.
- [ ] 5.2 Prove neutral events settle nothing: decision answer, own call and override (`DecisionService`), notes, mail, elapsed time, archival and exhaustion. Verify: H28 rows and property P3 (seed `0x0A11CE03`, 200 cases) in `src/server/__tests__/taskHandoffProperties.test.ts`; mutant MU5 (a card decision publishes the handoff) fails both.

## 6. Wakeups

- [ ] 6.1 Add D6's in-transaction system message and wakeup row for `published`, `declined`, `stale` and `closed`, with recipient resolution (live requester, else its group). Verify: rows for each transition and recipient case in `src/server/__tests__/taskHandoffWakeups.test.ts`, and property P1 (seed `0x0A11CE01`, 400 cases) in `taskHandoffProperties.test.ts`; mutants MU10 (wakeup key dropped) fails P1 and MU7 (liveness always live) fails the gone-requester row.

## 7. Restart reconciliation

- [ ] 7.1 Add D7's startup sweep and its `docs/recovery-matrix.md` row citing the test below. Verify: H29–H31 and model-based property P4 (seed `0x0A11CE04`, 200 cases, a crash at each named transaction boundary, H as reference model) in `src/server/__tests__/taskHandoffRecovery.integration.test.ts`; `recoveryMatrix.test.ts` resolves the new row; mutant MU3 (transition after commit) fails P4.
- [ ] 7.2 Add the H completeness test that expands the axes against H1–H31 and U1–U4 in `src/server/__tests__/taskHandoffCompleteness.test.ts`. Verify: it fails when one row is removed from the table (journal that negative control).

## 8. Attention

- [ ] 8.1 Add `handoffAttention.ts` with `handoffPhase` from `src/shared/taskHandoffs.ts`, the `kawai` attention owner kind, and link anchors. Verify: W1–W11 committed verbatim in `src/server/__tests__/taskHandoffAttention.test.ts`; mutants MU6 (only `open` kept) fails W3/W4 and MU7 fails W2.
- [ ] 8.2 Resolve fixes-requested owners per table F in `attentionAcceptance.ts`. Verify: F1–F5 in `taskHandoffAttention.test.ts`, and the existing `src/server/__tests__/teamWorkspaceRead.test.ts` acceptance rows still pass; mutant MU7 fails F2–F5.
- [ ] 8.3 Suppress `amendItems` for a task with a pending handoff. Verify: S3 and S4 rows in `src/server/__tests__/teamWorkspacePlanAttention.test.ts` (existing "after Amend" test unchanged and passing); mutant MU12 fails S3.
- [ ] 8.4 Add properties P2 (seed `0x0A11CE02`, 400 cases) and P6 (seed `0x0A11CE06`, 200 cases). Verify: both pass in `taskHandoffProperties.test.ts`, P2 with table W as the reference model; mutant MU6 fails P2.
- [ ] 8.5 Update `docs/architecture/team-page.md` for the two attention kinds and the `kawai` owner. Verify: the bullet names W's owners and next actions.

## 9. Supervision

- [ ] 9.1 Add the `owner-publication` wait (appended last in `stageWaits`), the loader's `handoff` facts, and `holderGone` on stall items and the report. Verify: S1, S2, S5 and S6 in `src/server/__tests__/supervisionOwnerPublication.test.ts`; mutant MU8 (wait not appended) fails S1.
- [ ] 9.2 Add property P5 (seed `0x0A11CE05`, 200 cases) comparing scheduler admission, parallel counts, dependency waits and slot holder with and without handoffs. Verify: it passes; mutant MU11 (the wait frees the slot) fails it.
- [ ] 9.3 Production-path checkpoint CP2 through the real supervision monitor and loader: archived holder plus open handoff reads `owner-publication`, no stall-alert row, W2 and no Lead stall item. Verify: `supervisionOwnerPublication.test.ts`; mutant MU8 fails it. Journal the checkpoint.
- [ ] 9.4 Update `docs/architecture/plan-supervision.md` for the wait and `holderGone`. Verify: the bullet names the append-only position and that the scheduler never reads the wait.

## 10. Agent reads and guidance

- [ ] 10.1 Add `handoffs` rows and `handoff_id` to `task_get` (`taskReadWindows.ts`), the pending-handoff line in delivered task context (`taskContext.ts`), and the guidance in `teamPrompt.ts` and the `decision_ask` description. Verify: `src/server/__tests__/taskHandoffRead.test.ts` covers bounded rows, the whole read, team scoping, and that the delivered direction stays the published revision's; mutant: rendering the handoff text as the direction fails it.

## 11. Human surface

- [ ] 11.1 Add the handoff panel (`TaskPublicationHandoff*.tsx`) in `TeamTaskDetail.tsx`, reusing `TaskDirectionEditor.tsx`'s diff and contract view, with **Publish prepared revision**/**Publish and notify**, **Edit before publishing** (replace confirmation) and **Decline** (reason required), and `teamTaskStore.ts` commands with client command keys. Verify: `src/client/__tests__/taskPublicationHandoff.test.tsx` covers each action's request payload and key, the replace confirmation, and the disabled states for stale and ended handoffs; mutant: sending the publish without the handoff id fails it.
- [ ] 11.2 Verify the panel and the attention links in a real browser against a disposable checkout, database and spare port using CI's fixture setup (never `bun run test:e2e` against live data). Verify: screenshots or a Playwright run log attached to the journal.

## 12. Integration

- [ ] 12.1 Run `bun run check` on the clean committed head with the pinned Bun and `scripts/verify-result.ts --commit <head> --coverage <map>`, with the map citing each oracle id's test title and killed mutant. Verify: both exit codes and the map are in the result.

## Scenario-to-test plan

Planned files are relative to `src/server/__tests__/` unless stated; every
row is future work.

| Spec requirement (scenarios) | Oracle ids | Planned test file |
| --- | --- | --- |
| task-publication-handoffs › Task authors may request an owner publication (3) | H1, H5, H6 | `taskHandoffCommands.test.ts`, `taskHandoffConnections.test.ts` |
| › A request is validated before it is recorded (5) | H2, H3, H4, H7 | `taskHandoffCommands.test.ts` |
| › A handoff records its exact provenance (2) | H1, H7 | `taskHandoffCommands.test.ts` |
| › Requests are idempotent under a request key (2) | H10, H11 | `taskHandoffCommands.test.ts` |
| › A task has at most one pending handoff (2) | H8, H9, U2 | `taskHandoffCommands.test.ts`, `taskHandoffSchema.test.ts` |
| › A handoff is never a revision (2) | H1, H19 | `taskHandoffRead.test.ts`, `taskHandoffCommands.test.ts` |
| › The publisher publishes a handoff with one action (3) | H12, H13 | `taskHandoffCommands.test.ts`, `taskHandoffConnections.test.ts` |
| › Editing before publishing still fulfills the handoff (2) | H17, H18 | `taskHandoffCommands.test.ts`, `src/client/__tests__/taskPublicationHandoff.test.tsx` |
| › A handoff is published at most once (2) | H14, H15, P1 | `taskHandoffCommands.test.ts`, `taskHandoffProperties.test.ts` |
| › Another publication makes a pending handoff stale (2) | H20, H21, H8 | `taskHandoffCommands.test.ts` |
| › A handoff ends only by an explicit disposition (3) | H22, H24, H27 | `taskHandoffCommands.test.ts` |
| › Answers, time, and archival never settle a handoff (2) | H28, P3 | `taskHandoffProperties.test.ts` |
| › Each disposition wakes the next actor once (3) | D6 rows, P1 | `taskHandoffWakeups.test.ts` |
| › Handoffs survive restart and reconcile once (2) | H29–H31, P4 | `taskHandoffRecovery.integration.test.ts` |
| › Agents read a task's handoffs (2) | A8 rows | `taskHandoffRead.test.ts` |
| team-workspace › The attention queue lists what needs a human or is waiting on an agent (11) | F1–F5; existing rows | `taskHandoffAttention.test.ts`, `teamWorkspaceRead.test.ts` |
| › The attention queue lists pending publication handoffs (6) | W1–W4, W11 | `taskHandoffAttention.test.ts` |
| › A published handoff stays visible until its holder acknowledges (5) | W5–W10 | `taskHandoffAttention.test.ts` |
| plan-supervision › A pending publication handoff is a named wait (4) | S1, S2, P5 | `supervisionOwnerPublication.test.ts` |
| › A pending handoff stands for the post-Amend item (3) | S3, S4 | `teamWorkspacePlanAttention.test.ts` |
| › A stall names a gone holder (1) | S5 | `supervisionOwnerPublication.test.ts` |

Each covering test carries its `// @covers:` annotation when it is written.

## Workflow follow-up

- Archive the change after review and acceptance, adding `@covers` annotations for every ADDED and MODIFIED scenario the archive leaves in the main specs.
- Verify the archived main specs pass `openspec validate --strict`.
